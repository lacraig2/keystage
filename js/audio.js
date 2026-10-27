// All sound is synthesized with WebAudio, so there are no samples to load.
// Timing model: the game thinks in performance.now() milliseconds. audio.perfToCtx()
// converts a performance time into the AudioContext time at which a sound must be
// scheduled so that it is *heard* at that moment.

const mtof = m => 440 * Math.pow(2, (m - 69) / 12)

export class AudioEngine {
	constructor() {
		this.ctx = null
	}

	ensure() {
		if (this.ctx) {
			if (this.ctx.state === "suspended") this.ctx.resume()
			return
		}
		const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" }))

		this.comp = ctx.createDynamicsCompressor()
		this.comp.threshold.value = -14
		this.comp.ratio.value = 4
		this.comp.connect(ctx.destination)

		// Band output runs through a lowpass so misses can "muffle" the band.
		this.bandFilter = ctx.createBiquadFilter()
		this.bandFilter.type = "lowpass"
		this.bandFilter.frequency.value = 18000
		this.bandFilter.Q.value = 0.7
		this.bandFilter.connect(this.comp)

		this.bandGain = ctx.createGain()
		this.bandGain.gain.value = 0.9
		this.bandGain.connect(this.bandFilter)

		this.sfx = ctx.createGain()
		this.sfx.gain.value = 0.7
		this.sfx.connect(this.comp)

		this.keys = ctx.createGain()
		this.keys.gain.value = 0.55
		this.keys.connect(this.comp)

		const len = ctx.sampleRate * 2
		this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
		const d = this.noise.getChannelData(0)
		for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1

		this.run = null
		this.crowd = null
	}

	get now() {
		return this.ctx.currentTime
	}

	clockMap() {
		const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null
		if (ts && ts.performanceTime > 0) return { ctxT: ts.contextTime, perfT: ts.performanceTime }
		const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0
		return { ctxT: this.ctx.currentTime, perfT: performance.now() + lat * 1000 }
	}

	perfToCtx(perfMs, map = this.clockMap()) {
		return map.ctxT + (perfMs - map.perfT) / 1000
	}

	// A "run" is a bus that all scheduled band notes go through, so they can be cut at once.
	newRun() {
		this.stopRun()
		const g = this.ctx.createGain()
		g.connect(this.bandGain)
		const k = this.ctx.createGain()
		k.connect(this.keys)
		this.run = { band: g, keys: k }
		return this.run
	}

	stopRun(fade = 0.02) {
		if (!this.run) return
		const { band, keys } = this.run
		const t = this.now
		for (const g of [band, keys]) {
			g.gain.setTargetAtTime(0, t, fade)
			setTimeout(() => g.disconnect(), fade * 15000)
		}
		this.run = null
	}

	env(g, t, peak, attack, decay, hold = 0) {
		g.gain.setValueAtTime(0.0001, t)
		g.gain.exponentialRampToValueAtTime(peak, t + attack)
		if (hold) g.gain.setValueAtTime(peak, t + attack + hold)
		g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay)
	}

	noiseSrc(t, dur) {
		const s = this.ctx.createBufferSource()
		s.buffer = this.noise
		s.start(t, Math.random() * 1.5, dur + 0.05)
		return s
	}

	// --- Drums ---------------------------------------------------------------
	kick(t, out = this.run.band, vol = 1) {
		const o = this.ctx.createOscillator()
		const g = this.ctx.createGain()
		o.frequency.setValueAtTime(150, t)
		o.frequency.exponentialRampToValueAtTime(42, t + 0.12)
		this.env(g, t, 0.9 * vol, 0.002, 0.3)
		o.connect(g).connect(out)
		o.start(t)
		o.stop(t + 0.4)
	}

	snare(t, out = this.run.band, vol = 1) {
		const n = this.noiseSrc(t, 0.25)
		const f = this.ctx.createBiquadFilter()
		f.type = "bandpass"
		f.frequency.value = 1800
		f.Q.value = 0.8
		const g = this.ctx.createGain()
		this.env(g, t, 0.5 * vol, 0.002, 0.18)
		n.connect(f).connect(g).connect(out)
		const o = this.ctx.createOscillator()
		const og = this.ctx.createGain()
		o.frequency.setValueAtTime(220, t)
		o.frequency.exponentialRampToValueAtTime(140, t + 0.08)
		this.env(og, t, 0.3 * vol, 0.002, 0.1)
		o.connect(og).connect(out)
		o.start(t)
		o.stop(t + 0.2)
	}

	hat(t, out = this.run.band, vol = 1, open = false) {
		const n = this.noiseSrc(t, open ? 0.3 : 0.06)
		const f = this.ctx.createBiquadFilter()
		f.type = "highpass"
		f.frequency.value = 7500
		const g = this.ctx.createGain()
		this.env(g, t, 0.18 * vol, 0.001, open ? 0.25 : 0.045)
		n.connect(f).connect(g).connect(out)
	}

	// Sleigh bells: a shimmer of bright noise plus a few inharmonic jingles.
	bells(t, out = this.run.band, vol = 1) {
		const n = this.noiseSrc(t, 0.2)
		const f = this.ctx.createBiquadFilter()
		f.type = "bandpass"
		f.frequency.value = 9000
		f.Q.value = 1.5
		const g = this.ctx.createGain()
		this.env(g, t, 0.16 * vol, 0.002, 0.13)
		n.connect(f).connect(g).connect(out)
		for (const hz of [5274, 6620, 7900]) {
			const o = this.ctx.createOscillator()
			const og = this.ctx.createGain()
			o.frequency.value = hz * (0.99 + Math.random() * 0.02)
			this.env(og, t + Math.random() * 0.012, 0.025 * vol, 0.001, 0.09)
			o.connect(og).connect(out)
			o.start(t)
			o.stop(t + 0.15)
		}
	}

	crash(t = this.now, out = this.sfx, vol = 1) {
		const n = this.noiseSrc(t, 1.6)
		const f = this.ctx.createBiquadFilter()
		f.type = "highpass"
		f.frequency.value = 4000
		const g = this.ctx.createGain()
		this.env(g, t, 0.35 * vol, 0.003, 1.5)
		n.connect(f).connect(g).connect(out)
	}

	click(t, accent, out = this.run ? this.run.band : this.sfx) {
		const o = this.ctx.createOscillator()
		const g = this.ctx.createGain()
		o.type = "square"
		o.frequency.value = accent ? 1800 : 1200
		this.env(g, t, accent ? 0.25 : 0.15, 0.001, 0.04)
		o.connect(g).connect(out)
		o.start(t)
		o.stop(t + 0.08)
	}

	// --- Pitched -------------------------------------------------------------
	bass(t, midi, dur, out = this.run.band) {
		const o = this.ctx.createOscillator()
		const f = this.ctx.createBiquadFilter()
		const g = this.ctx.createGain()
		o.type = "sawtooth"
		o.frequency.value = mtof(midi)
		f.type = "lowpass"
		f.frequency.setValueAtTime(900, t)
		f.frequency.exponentialRampToValueAtTime(220, t + Math.min(dur, 0.3))
		this.env(g, t, 0.42, 0.005, Math.max(0.08, dur * 0.9))
		o.connect(f).connect(g).connect(out)
		o.start(t)
		o.stop(t + dur + 0.1)
	}

	pad(t, midis, dur, out = this.run.band) {
		const f = this.ctx.createBiquadFilter()
		f.type = "lowpass"
		f.frequency.value = 1400
		const g = this.ctx.createGain()
		g.gain.setValueAtTime(0.0001, t)
		g.gain.exponentialRampToValueAtTime(0.07, t + 0.08)
		g.gain.setValueAtTime(0.07, t + dur - 0.08)
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05)
		f.connect(g).connect(out)
		for (const m of midis) {
			for (const det of [-7, 7]) {
				const o = this.ctx.createOscillator()
				o.type = "sawtooth"
				o.frequency.value = mtof(m)
				o.detune.value = det
				o.connect(f)
				o.start(t)
				o.stop(t + dur + 0.1)
			}
		}
	}

	piano(t, midi, dur = 0.5, vel = 0.8, out = this.run ? this.run.keys : this.keys) {
		const freq = mtof(midi)
		const g = this.ctx.createGain()
		const decay = Math.min(2.5, Math.max(0.35, dur * 1.3)) * (midi > 72 ? 0.7 : 1)
		this.env(g, t, 0.35 * vel, 0.004, decay)
		const f = this.ctx.createBiquadFilter()
		f.type = "lowpass"
		f.frequency.setValueAtTime(Math.min(12000, freq * 8), t)
		f.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 1.5), t + decay)
		f.connect(g).connect(out)
		const partials = [
			["triangle", 1, 1],
			["sine", 2, 0.35],
			["sine", 3, 0.12]
		]
		for (const [type, mult, amp] of partials) {
			const o = this.ctx.createOscillator()
			const og = this.ctx.createGain()
			o.type = type
			o.frequency.value = freq * mult
			og.gain.value = amp
			o.connect(og).connect(f)
			o.start(t)
			o.stop(t + decay + 0.1)
		}
	}

	// --- Recordings -------------------------------------------------------------
	// Plays part of a recording on the current run's band bus (so misses muffle it and pausing cuts it).
	track(buffer, when, offset, gain = 1, out = this.run.band) {
		const s = this.ctx.createBufferSource()
		s.buffer = buffer
		const g = this.ctx.createGain()
		g.gain.value = gain
		s.connect(g).connect(out)
		const late = Math.max(0, this.now - when)
		if (offset + late < buffer.duration) s.start(when + late, offset + late)
		return s
	}

	// WSOLA time-stretch: slows a recording down without lowering its pitch.
	stretch(buf, speed) {
		const N = 2048, Hs = N / 4, Ha = Hs * speed, tol = 256, L = N / 2
		const inLen = buf.length, outLen = Math.ceil(inLen / speed)
		const chans = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c))
		const mono = new Float32Array(inLen)
		for (const c of chans) for (let i = 0; i < inLen; i++) mono[i] += c[i] / chans.length
		const outs = chans.map(() => new Float32Array(outLen + N))
		const norm = new Float32Array(outLen + N)
		const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
		let prev = 0
		for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
			let pos = Math.min(Math.round(k * Ha), inLen - N)
			const target = prev + Hs
			if (k > 0 && pos > 0 && target + L < inLen) {
				// pick the nearby frame that continues the previous one most smoothly
				let best = -Infinity, bestPos = pos
				for (let d = -tol; d <= tol; d += 4) {
					const p = pos + d
					if (p < 0 || p + N > inLen) continue
					let s = 0
					for (let i = 0; i < L; i += 8) s += mono[p + i] * mono[target + i]
					if (s > best) (best = s), (bestPos = p)
				}
				pos = bestPos
			}
			if (pos < 0) break
			for (let i = 0; i < N; i++) {
				const w = win[i]
				norm[o + i] += w
				for (let c = 0; c < chans.length; c++) outs[c][o + i] += chans[c][pos + i] * w
			}
			prev = pos
		}
		const out = this.ctx.createBuffer(chans.length, outLen, buf.sampleRate)
		for (let c = 0; c < chans.length; c++) {
			const d = out.getChannelData(c)
			for (let i = 0; i < outLen; i++) d[i] = norm[i] > 1e-3 ? outs[c][i] / norm[i] : 0
		}
		return out
	}

	// --- Feedback --------------------------------------------------------------
	missDip() {
		const t = this.now
		const fq = this.bandFilter.frequency
		fq.cancelScheduledValues(t)
		fq.setValueAtTime(fq.value, t)
		fq.exponentialRampToValueAtTime(380, t + 0.03)
		fq.exponentialRampToValueAtTime(18000, t + 0.55)
		// sour clunk
		const o = this.ctx.createOscillator()
		const o2 = this.ctx.createOscillator()
		const g = this.ctx.createGain()
		o.type = o2.type = "sawtooth"
		o.frequency.value = 98
		o2.frequency.value = 104
		this.env(g, t, 0.12, 0.003, 0.18)
		o.connect(g)
		o2.connect(g)
		g.connect(this.sfx)
		o.start(t)
		o2.start(t)
		o.stop(t + 0.25)
		o2.stop(t + 0.25)
	}

	setBandBoost(on) {
		const t = this.now
		this.bandGain.gain.setTargetAtTime(on ? 1.15 : 0.9, t, 0.1)
	}

	cheer(intensity = 1) {
		const t = this.now
		const dur = 1.2 + intensity * 1.2
		const n = this.noiseSrc(t, dur)
		const f = this.ctx.createBiquadFilter()
		f.type = "bandpass"
		f.frequency.value = 1100
		f.Q.value = 0.6
		const g = this.ctx.createGain()
		g.gain.setValueAtTime(0.0001, t)
		g.gain.exponentialRampToValueAtTime(0.22 * intensity, t + 0.25)
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
		// "voices": wobble the band center
		const lfo = this.ctx.createOscillator()
		const lg = this.ctx.createGain()
		lfo.frequency.value = 5.5
		lg.gain.value = 250
		lfo.connect(lg).connect(f.frequency)
		lfo.start(t)
		lfo.stop(t + dur)
		n.connect(f).connect(g).connect(this.sfx)
	}

	whoosh() {
		const t = this.now
		const n = this.noiseSrc(t, 0.9)
		const f = this.ctx.createBiquadFilter()
		f.type = "bandpass"
		f.Q.value = 1.2
		f.frequency.setValueAtTime(300, t)
		f.frequency.exponentialRampToValueAtTime(3000, t + 0.25)
		f.frequency.exponentialRampToValueAtTime(500, t + 0.9)
		const g = this.ctx.createGain()
		this.env(g, t, 0.4, 0.05, 0.8)
		n.connect(f).connect(g).connect(this.sfx)
	}

	// Continuous crowd murmur whose level follows the crowd meter.
	startCrowd() {
		if (this.crowd) return
		const n = this.ctx.createBufferSource()
		n.buffer = this.noise
		n.loop = true
		const f = this.ctx.createBiquadFilter()
		f.type = "bandpass"
		f.frequency.value = 700
		f.Q.value = 0.5
		const g = this.ctx.createGain()
		g.gain.value = 0
		n.connect(f).connect(g).connect(this.sfx)
		n.start()
		this.crowd = { n, g }
	}

	setCrowd(level) {
		if (!this.crowd) return
		this.crowd.g.gain.setTargetAtTime(0.008 + level * level * 0.04, this.now, 0.3)
	}

	stopCrowd() {
		if (!this.crowd) return
		this.crowd.g.gain.setTargetAtTime(0, this.now, 0.2)
		const n = this.crowd.n
		setTimeout(() => n.stop(), 800)
		this.crowd = null
	}
}

export const audio = new AudioEngine()
