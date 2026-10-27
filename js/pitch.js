// Hears piano notes in microphone audio, so any acoustic piano can play the game.
//
// Feed it audio in hops of HOP samples; it returns note on/off events. How it works:
// 1. Onsets: a jump in log spectral energy (spectral flux) marks a key being struck.
// 2. Pitches: a few hops later, compare the spectrum to the one just before the onset. Only the
//    new energy is left, so notes still ringing from before don't confuse it. Pick the pitch
//    whose harmonics explain the most of that new energy, remove its harmonics, and repeat for
//    chords (iterative harmonic subtraction with spectral smoothing, after Klapuri).
// 3. The song helps: notes the game expects need less evidence, and pitches the game itself
//    just played through the speakers (the other hand, the bass) are ignored unless expected.
// 4. Releases: a note counts as held until its harmonics fade or drop sharply (the damper).

export const HOP = 512
const N_FLUX = 2048
const N_PITCH = 4096
const LO = 21, HI = 108 // A0..C8
const MAX_F = 6000 // ignore harmonics above this
// Count partials all the way up, so a low note's salience includes everything its octave has.
const MAX_H = 20

// --- FFT (radix 2, in place) -----------------------------------------------------------
const ffts = new Map()
function fftPlan(n) {
	if (ffts.has(n)) return ffts.get(n)
	const rev = new Uint32Array(n)
	const bits = Math.log2(n)
	for (let i = 0; i < n; i++) {
		let r = 0
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
		rev[i] = r
	}
	const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2)
	for (let i = 0; i < n / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / n)
		sin[i] = -Math.sin((2 * Math.PI * i) / n)
	}
	const win = new Float32Array(n)
	for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
	const plan = { n, rev, cos, sin, win, re: new Float32Array(n), im: new Float32Array(n) }
	ffts.set(n, plan)
	return plan
}

// Magnitude spectrum (n/2 bins) of the last n samples of the ring buffer.
function magnitudes(ring, end, plan, out) {
	const { n, rev, cos, sin, win, re, im } = plan
	const size = ring.length
	for (let i = 0; i < n; i++) {
		const j = rev[i]
		re[j] = ring[(end - n + i + size) % size] * win[i]
		im[j] = 0
	}
	for (let len = 2; len <= n; len <<= 1) {
		const half = len >> 1, step = n / len
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < half; k++) {
				const c = cos[k * step], s = sin[k * step]
				const a = i + k, b = a + half
				const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
				re[b] = re[a] - tr
				im[b] = im[a] - ti
				re[a] += tr
				im[a] += ti
			}
		}
	}
	for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k], im[k])
	return out
}

const hz = p => 440 * Math.pow(2, (p - 69) / 12)

export class NoteListener {
	constructor(sampleRate) {
		this.sr = sampleRate
		this.ring = new Float32Array(16384)
		this.pos = 0 // total samples written
		this.hop = 0
		this.fluxPlan = fftPlan(N_FLUX)
		this.pitchPlan = fftPlan(N_PITCH)
		this.binHz = sampleRate / N_PITCH
		this.prevLog = new Float32Array(N_FLUX / 2)
		this.fluxBins = Math.min(N_FLUX / 2, Math.round((MAX_F * N_FLUX) / sampleRate))
		this.fluxHist = []
		this.spectra = [] // recent pitch spectra, newest last: {hop, mag}
		this.pending = [] // onsets waiting for their pitch decision
		this.noise = 0 // background level (RMS): the quietest moments of the last few seconds
		this.rmsHist = []
		this.lastOnsetHop = -99
		this.held = new Map() // p -> {peak, hist[], onHop}
		this.recent = new Map() // p -> hop of the last note-on
		this.expect = () => [] // set by the game: pitches it expects around time ts
		this.heard = [] // {p, ts} sounds the game played itself
		this.level = 0 // for a meter, 0..1
		this.sensitivity = 1
		this.debug = null // set to an array to log every pitch decision (tests/replay.html)
		this.hopMs = (HOP / sampleRate) * 1000
		// Timing: hops between onset and decision, and how far the flux peak trails the real attack.
		this.decideHops = Math.max(3, Math.round((0.06 * sampleRate) / HOP))
		this.onsetLagMs = ((N_FLUX * 0.3) / sampleRate) * 1000
		this.harmonics = []
		for (let p = LO; p <= HI; p++) {
			const f0 = hz(p)
			// Piano strings are slightly stiff, so upper partials run sharp (inharmonicity).
			const B = p < 60 ? 0.0003 : 0.0003 * Math.pow(2, (p - 60) / 12)
			const hs = []
			for (let h = 1; h <= MAX_H; h++) {
				const f = h * f0 * Math.sqrt(1 + B * h * h)
				if (f > MAX_F) break
				const tol = Math.pow(2, (h >= 5 ? 50 : 35) / 1200)
				let lo = Math.floor(f / tol / this.binHz), hi = Math.ceil((f * tol) / this.binHz)
				if (hi - lo < 2) (lo = Math.round(f / this.binHz) - 1), (hi = lo + 2)
				hs.push({ h, lo: Math.max(1, lo), hi: Math.min(N_PITCH / 2 - 1, hi) })
			}
			this.harmonics[p] = hs
			// The first harmonic high enough that neighbouring semitones land in different bins.
			const ref = Math.max(0, hs.findIndex(x => (x.h * f0 * 0.0595) / this.binHz >= 1.5))
			hs.refs = hs.slice(ref, ref + 2).map(x => ({ x, f: x.h * f0 * Math.sqrt(1 + B * x.h * x.h) }))
		}
	}

	// tsMs: performance.now() time of the last sample in this hop
	push(samples, tsMs) {
		const events = []
		const size = this.ring.length
		let sum = 0
		for (let i = 0; i < samples.length; i++) {
			this.ring[(this.pos + i) % size] = samples[i]
			sum += samples[i] * samples[i]
		}
		this.pos += samples.length
		this.hop++
		const rms = Math.sqrt(sum / samples.length)
		this.level = Math.min(1, Math.max(0, (Math.log10(rms + 1e-6) + 3.5) / 3))
		this.rmsHist.push(rms)
		if (this.rmsHist.length > 280) this.rmsHist.shift() // ~3 s
		if (this.hop % 16 === 0) this.noise = [...this.rmsHist].sort((a, b) => a - b)[Math.floor(this.rmsHist.length * 0.05)]
		if (this.pos < N_PITCH) return events
		const end = this.pos % size

		// 1. onset strength
		const mag = magnitudes(this.ring, end, this.fluxPlan, new Float32Array(N_FLUX / 2))
		let flux = 0, rise = 0, total = 0
		for (let k = 2; k < this.fluxBins; k++) {
			const l = Math.log(1 + 1000 * mag[k])
			const d = l - this.prevLog[k]
			if (d > 0) flux += d
			this.prevLog[k] = l
			const m0 = this.prevMag ? this.prevMag[k] : 0
			if (mag[k] > m0) rise += mag[k] - m0
			total += m0
		}
		this.prevMag = mag
		// Log flux catches soft notes; the linear rise check ignores dampers and decays,
		// which wobble the quiet bins without adding any real energy.
		if (rise < 0.15 * total) flux = Math.min(flux, 1)
		this.fluxHist.push({ flux, rms, ts: tsMs })
		if (this.fluxHist.length > 40) this.fluxHist.shift()

		const spec = magnitudes(this.ring, end, this.pitchPlan, new Float32Array(N_PITCH / 2))
		this.spectra.push({ hop: this.hop, mag: spec })
		if (this.spectra.length > 16) this.spectra.shift()

		// A peak one hop ago that stands out from the recent background is an onset.
		const H = this.fluxHist, n = H.length
		if (n >= 8) {
			const prev = H[n - 2]
			const sorted = H.slice(0, n - 2).map(x => x.flux).sort((a, b) => a - b)
			const med = sorted[Math.floor(sorted.length / 2)]
			const thr = med * 2.5 + 15 / this.sensitivity
			const loud = Math.max(prev.rms, H[n - 1].rms) > Math.max(0.001, this.noise * 1.5) / this.sensitivity
			if (loud && prev.flux > thr && prev.flux >= H[n - 3].flux && prev.flux >= H[n - 1].flux) {
				const o = { hop: this.hop - 1, ts: prev.ts - this.onsetLagMs, strength: prev.flux / thr }
				const last = this.pending[this.pending.length - 1]
				if (this.hop - 1 - this.lastOnsetHop >= 5) this.pending.push(o)
				else if (last && last.hop === this.lastOnsetHop && o.strength > last.strength * 1.5) Object.assign(last, o)
				else o.hop = this.lastOnsetHop
				this.lastOnsetHop = o.hop
			}
		}

		// 2. pitch decisions
		while (this.pending.length && this.hop - this.pending[0].hop >= this.decideHops) {
			const o = this.pending.shift()
			const before = this.spectra.find(s => s.hop >= o.hop - 4) || this.spectra[0]
			for (const { p, s } of this.pitches(spec, before.mag, o.ts)) {
				// The same key again within ~150 ms is the same strike seen twice.
				const last = this.recent.get(p)
				if (last !== undefined && (this.hop - last) * this.hopMs < 150) continue
				if (this.held.has(p)) events.push({ type: "off", p, ts: o.ts - 1 })
				this.recent.set(p, this.hop)
				this.held.set(p, { peak: 0, hist: [], onHop: this.hop })
				events.push({ type: "on", p, vel: Math.min(1, 0.35 + 0.15 * Math.log2(1 + s)), ts: o.ts })
			}
		}

		// 3. releases
		for (const [p, h] of this.held) {
			const e = this.partialEnergy(spec, p)
			h.peak = Math.max(h.peak, e)
			h.hist.push(e)
			if (h.hist.length > 8) h.hist.shift()
			const age = this.hop - h.onHop
			const dropped = h.hist.length >= 7 && e < 0.3 * h.hist[0]
			if (age > 4 && (e < 0.08 * h.peak || dropped || age * this.hopMs > 12000)) {
				this.held.delete(p)
				events.push({ type: "off", p, ts: tsMs - this.hopMs * 3 })
			}
		}
		return events
	}

	// Is there a spectral peak right on this note (within ~45 cents), rather than a neighbour's
	// partial bleeding into its window?
	centered(R, p) {
		// Two harmonics are checked, since one may be shared with a note that was already ringing.
		return this.harmonics[p].refs.some(({ x, f: want }) => {
			let k = -1, m = 0
			for (let i = Math.max(1, x.lo - 2); i <= Math.min(R.length - 2, x.hi + 2); i++) if (R[i] > m) (m = R[i]), (k = i)
			if (k < 0) return false
			const a = R[k - 1], b = R[k], c = R[k + 1]
			const shift = a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0
			return Math.abs(1200 * Math.log2(((k + shift) * this.binHz) / want)) < 45
		})
	}

	// Is bin k close (within ~40 cents) to one of note p's partials, however high?
	isPartialOf(k, p) {
		const f = k * this.binHz, f0 = hz(p)
		const B = p < 60 ? 0.0003 : 0.0003 * Math.pow(2, (p - 60) / 12)
		for (let h = Math.max(1, Math.floor(f / f0 / 1.05)); h <= Math.ceil(f / f0) + 1; h++) {
			if (Math.abs(1200 * Math.log2(f / (h * f0 * Math.sqrt(1 + B * h * h)))) < 40) return true
		}
		return false
	}

	partialEnergy(spec, p) {
		let e = 0
		for (const { lo, hi } of this.harmonics[p].slice(0, 4)) {
			let m = 0
			for (let k = lo; k <= hi; k++) if (spec[k] > m) m = spec[k]
			e += m
		}
		return e
	}

	// New energy since just before the onset, explained as a few piano notes.
	pitches(now, before, ts) {
		const nb = now.length
		const R = new Float32Array(nb)
		const top = Math.min(nb, Math.round(MAX_F / this.binHz))
		let noise = 0
		for (let k = 1; k < top; k++) {
			R[k] = Math.max(0, now[k] - before[k])
			noise += R[k]
		}
		noise /= top
		const expected = new Set(this.expect(ts))
		const heard = this.heard.filter(x => ts - x.ts > -60 && ts - x.ts < 180).map(x => x.p)
		const found = []
		const skip = new Set()
		const peaks = new Float32Array(MAX_H + 1)
		// Sounds the game just made itself (other hand, bass) aren't the player: take them out first.
		for (const q of heard) {
			if (expected.has(q) || q < LO || q > HI) continue
			const f0 = hz(q)
			for (let h = 1; h * f0 < MAX_F; h++) {
				const c = (h * f0 * Math.sqrt(1 + 0.0004 * h * h)) / this.binHz
				for (let k = Math.max(1, Math.floor(c * 0.98) - 1); k <= Math.min(nb - 1, Math.ceil(c * 1.02) + 1); k++) R[k] = 0
			}
		}
		let first = 0
		// The octave below an expected note really sounding (odd harmonics present) means the
		// player hit the wrong octave: don't let its even harmonics pass for the expected note.
		// Odd partials that belong to other expected notes (a chord's fifth is the octave below's
		// third partial) don't count as evidence.
		const wrongOctave = q => {
			if (q - 12 < LO || expected.has(q - 12)) return false
			this.salience(R, q - 12, peaks)
			const hs = this.harmonics[q - 12]
			const others = [...expected].filter(e => e !== q)
			const own = i => (others.some(e => this.isPartialOf((hs[i].lo + hs[i].hi) / 2, e)) ? 0 : peaks[i])
			const odd = own(0) + own(2) + own(4)
			return odd > 0.5 * (peaks[1] + peaks[3] + peaks[5]) && odd > 0
		}
		for (let tries = 0; tries < 12 && found.length < 6; tries++) {
			const pass1 = tries < expected.size
			let best = -1, bestS = 0
			for (let p = LO; p <= HI; p++) {
				if (skip.has(p) || (pass1 && !expected.has(p))) continue
				if (pass1 && wrongOctave(p)) continue
				const s = this.salience(R, p, peaks)
				if (s > bestS && this.centered(R, p)) (bestS = s), (best = p)
			}
			if (best < 0) {
				if (pass1) continue
				break
			}
			if (!pass1 && first && bestS < first * 0.12) break
			skip.add(best)
			this.salience(R, best, peaks)
			const hs = this.harmonics[best]
			let odd = 0, even = 0, top = 0
			hs.forEach((x, i) => {
				x.h % 2 ? (odd += peaks[i]) : (even += peaks[i])
				top = Math.max(top, peaks[i])
			})
			const isExpected = expected.has(best)
			const fundamental = q => peaks.slice(0, Math.min(3, Math.ceil(250 / hz(q)))).reduce((a, b) => a + b, 0)
			// Striking a key that's still ringing (pedal down) barely raises its fundamental.
			const restrike = isExpected && this.held.has(best)
			// A real note shows up across its first few partials, not in one or two stray places.
			const low = peaks.slice(0, Math.min(4, hs.length))
			const spread = low.filter(v => v >= 0.15 * top).length >= Math.min(2, low.length)
			// Most of an unexpected note's evidence must be its own: a note whose partials all sit on
			// partials of notes already found (an octave up, an octave and a fifth...) is just overtones.
			let own = 0
			hs.forEach((x, i) => {
				if (!found.some(f => this.isPartialOf((x.lo + x.hi) / 2, f.p))) own += peaks[i]
			})
			// Deep bass is hard to resolve, so an unexpected low note needs much stronger evidence.
			const deep = !isExpected && best < 41
			const floor = (noise * Math.sqrt(hs.length) * (isExpected ? 4 : deep ? 12 : 7)) / this.sensitivity
			const checks = {
				floor: bestS > floor && bestS > 1e-3 / this.sensitivity,
				rel: !first || bestS / first > (isExpected ? 0.15 : deep ? 0.6 : 0.3),
				// A real note has energy at its own fundamental. Phone mics hear little below ~250 Hz,
				// so a low note's first two or three partials count together.
				// A ghost an octave below a chord has nothing at all at its fundamental; a real note
				// above the deep bass still shows a little, even through a phone.
				fund: restrike || (fundamental(best) >= (isExpected ? 0.08 : 0.1) * top && (best < 41 || peaks[0] >= (isExpected ? 0.03 : 0.05) * top)),
				spread: isExpected || spread,
				// ...and at its odd harmonics, not just where an octave above has partials.
				odd: odd > (isExpected ? 0.25 : 0.5) * even,
				heard: isExpected || !heard.some(q => q === best || Math.abs(q - best) === 12),
				own: isExpected || own >= 0.4 * bestS,
			}
			const ok = Object.values(checks).every(Boolean)
			this.debug?.push({ ts, p: best, s: +(bestS / Math.max(floor, 1e-9)).toFixed(2), rel: first ? +(bestS / first).toFixed(2) : 1, ok, failed: Object.keys(checks).filter(k => !checks[k]).join(","), peaks: [...peaks.slice(0, hs.length)].map(v => +(v / (top || 1)).toFixed(2)) })
			if (!ok) continue
			first ||= bestS
			found.push({ p: best, s: bestS / Math.max(floor, 1e-9) })
			// Subtract this note's harmonics, smoothed so a note an octave up can still show through.
			hs.forEach((x, i) => {
				const a = peaks[i]
				if (a <= 0) return
				const nbr = [i > 0 ? peaks[i - 1] : null, i + 1 < hs.length ? peaks[i + 1] : null].filter(v => v !== null)
				const smooth = nbr.length ? Math.min(a, nbr.reduce((u, v) => u + v, 0) / nbr.length) : a
				for (let k = x.lo; k <= x.hi; k++) R[k] *= 1 - smooth / a
			})
		}
		return found
	}

	// Sum of harmonic peaks, each measured above its local background so broadband noise
	// (the hammer's thump, room noise) doesn't add up into a phantom low note.
	salience(R, p, peaks) {
		let s = 0
		this.harmonics[p].forEach((x, i) => {
			let m = 0, bg = 0, nb = 0
			for (let k = x.lo; k <= x.hi; k++) if (R[k] > m) m = R[k]
			for (let k = Math.max(1, x.lo - 3); k < x.lo; k++) (bg += R[k]), nb++
			for (let k = x.hi + 1; k <= Math.min(R.length - 1, x.hi + 3); k++) (bg += R[k]), nb++
			peaks[i] = Math.max(0, m - (nb ? bg / nb : 0))
			s += peaks[i]
		})
		return s
	}
}
