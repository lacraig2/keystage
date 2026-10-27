import { audio } from "./audio.js"
import { simplify, noteName } from "./songs.js"

// Hit windows in real seconds (generous: beginner friendly).
export const WINDOWS = { perfect: 0.05, great: 0.095, good: 0.155 }
const POINTS = { perfect: 100, great: 80, good: 50 }
const WEIGHT = { perfect: 1, great: 0.85, good: 0.6, miss: 0 }
const CROWD = { perfect: 0.02, great: 0.016, good: 0.01, miss: -0.07, wrong: -0.03 }
const MILESTONES = [10, 25, 50, 100, 150, 200, 300, 400, 500]
const LOOKAHEAD = 1.2 // seconds of audio scheduled ahead

export class Game {
	/**
	 * mode: "perform" | "practice" | "watch"
	 * hands: "R" | "L" | "both"
	 */
	constructor({ song, mode, hands, speed, simplified, settings, input, fx }) {
		this.song = song
		this.mode = mode
		this.hands = hands
		this.speed = speed
		this.settings = settings
		this.input = input
		this.fx = fx

		const plays = n => mode !== "watch" && (hands === "both" || n.hand === hands)
		let src = song.notes.map(n => ({ ...n }))
		if (simplified) {
			// Only simplify the player's hand(s); the band still plays the full accompaniment.
			const mine = simplify(src.filter(plays), song.beatSec)
			src = [...mine, ...src.filter(n => !plays(n))].sort((a, b) => a.t - b.t || a.p - b.p)
		}
		this.notes = src.map((n, i) => ({ ...n, id: i, auto: !plays(n), judged: null, holding: false, star: false }))
		this.playable = this.notes.filter(n => !n.auto)

		this.assignPhrases()

		this.score = 0
		this.combo = 0
		this.maxCombo = 0
		this.counts = { perfect: 0, great: 0, good: 0, miss: 0, extra: 0 }
		this.octaveSlips = 0
		this.offsets = []
		this.missByPitch = {}
		this.crowd = 0.6
		this.od = 0
		this.odActive = false
		this.finished = false
		this.paused = false
		this.waiting = null
		this.recording = null // {backing, guide} AudioBuffers for songs made from a real recording
		this.tracks = []

		this.missIdx = 0
		this.backIdx = 0
		this.autoIdx = 0
		this.holds = new Set()
		this.unsubs = [
			input.listen("on", (p, v, ts) => this.onNoteOn(p, v, ts)),
			input.listen("off", (p, ts) => this.onNoteOff(p, ts)),
			input.listen("pedal", down => down && this.activateOverdrive())
		]
		// A microphone hears better knowing which notes are due.
		input.setExpect?.(ts => this.expectedAt(ts))
	}

	expectedAt(perfMs) {
		if (this.mode === "watch" || this.paused || this.finished) return []
		if (this.mode === "practice") {
			const first = this.waiting?.[0] || this.playable.find(n => !n.judged)
			return first ? this.playable.filter(n => !n.judged && Math.abs(n.t - first.t) < 0.05).map(n => n.p) : []
		}
		const t = this.stAt(perfMs - this.offset)
		const win = (WINDOWS.good + 0.05) * this.speed
		const out = []
		for (const n of this.playable) {
			if (n.t > t + win) break
			if (!n.judged && n.t > t - win) out.push(n.p)
		}
		return out
	}

	get offset() {
		return this.settings[this.input.offsetKey || "offset"] || 0
	}

	get beatSec() {
		return this.song.beatSec
	}

	assignPhrases() {
		const { song } = this
		const len = song.barSec * 2
		const origin = song.pickup * song.beatSec
		const phrases = new Map()
		for (const n of this.playable) {
			const idx = Math.floor((n.t - origin + 1e-3) / len)
			n.phrase = idx
			if (!phrases.has(idx)) phrases.set(idx, [])
			phrases.get(idx).push(n)
		}
		this.phrases = phrases
		// Every 4th two-bar phrase with enough notes glows gold.
		for (const [idx, ns] of phrases) {
			if (idx % 4 === 2 && ns.length >= 3) for (const n of ns) n.star = true
		}
		this.phraseFailed = new Set()
	}

	// --- Clock ------------------------------------------------------------------
	start() {
		audio.ensure()
		audio.newRun()
		audio.startCrowd()
		audio.setBandBoost(false)
		const lead = -Math.max(this.song.intro, this.song.barSec)
		this.begin(lead)
	}

	begin(fromSt) {
		const now = performance.now()
		this.countIn = { from: Math.max(fromSt, -this.song.barSec), to: 0 }
		if (this.mode === "practice") {
			this.st = fromSt - 0.4 * this.speed
			this.lastNow = now
		} else {
			this.perfZero = now + 400 - (fromSt * 1000) / this.speed
			this.st = this.stAt(now)
		}
		this.resyncPointers(fromSt)
		this.scheduleCountIn(fromSt, now)
		this.startTracks(fromSt)
	}

	// The real recording (minus the piano) plays as the band. In watch mode you also hear the
	// original piano; playing one hand, you get it quietly as a guide.
	startTracks(fromSt) {
		this.stopTracks()
		if (!this.recording || this.mode === "practice") return
		const { offset } = this.song.recording
		const from = Math.max(fromSt, -offset)
		const when = audio.perfToCtx(this.songToPerf(from))
		const at = (offset + from) / this.speed // stretched buffers are already slowed down
		const { backing, guide } = this.recording
		if (backing) this.tracks.push(audio.track(backing, when, at))
		// A solo-piano recording has no band, so its piano is the only guide.
		// (Not with a microphone: it would hear the guide playing your notes for you.)
		const level = this.mode === "watch" ? 1 : this.hands === "both" || this.input.micOn ? 0 : backing ? 0.35 : 0.5
		if (guide && level) this.tracks.push(audio.track(guide, when, at, level))
	}

	stopTracks() {
		for (const s of this.tracks) {
			try {
				s.stop(audio.now + 0.1)
			} catch {}
		}
		this.tracks = []
	}

	stAt(perfMs) {
		return ((perfMs - this.perfZero) / 1000) * this.speed
	}

	songToPerf(t) {
		if (this.mode === "practice") return this.lastNow + ((t - this.st) * 1000) / this.speed
		return this.perfZero + (t * 1000) / this.speed
	}

	resyncPointers(fromSt) {
		const b = this.song.backing
		this.backIdx = 0
		while (this.backIdx < b.length && b[this.backIdx].t < fromSt) this.backIdx++
		this.autoIdx = 0
		while (this.autoIdx < this.notes.length && this.notes[this.autoIdx].t < fromSt) this.autoIdx++
	}

	scheduleCountIn(fromSt, now) {
		if (this.song.intro >= this.song.barSec) return
		const map = audio.clockMap()
		const step = this.song.beatSec * this.song.clickEvery
		const n = Math.round(this.song.barSec / step)
		for (let k = n; k >= 1; k--) {
			const t = -k * step
			if (t < fromSt - 1e-6) continue
			const perf = this.mode === "practice" ? now + 400 + ((t - fromSt) * 1000) / this.speed : this.songToPerf(t)
			audio.click(audio.perfToCtx(perf, map), k === n)
		}
	}

	pause() {
		if (this.finished || this.paused) return
		this.paused = true
		this.pauseSt = this.st
		audio.stopRun()
		this.stopTracks()
		audio.setCrowd(0)
		for (const n of this.holds) n.holding = false
		this.holds.clear()
	}

	resume() {
		if (!this.paused) return
		this.paused = false
		audio.newRun()
		// Rewind one bar so you can find your place again; notes already judged stay judged.
		const from = Math.max(this.pauseSt - this.song.barSec * 1.5, this.pauseSt < 0 ? this.pauseSt : -this.song.barSec)
		this.begin(Math.min(this.pauseSt, from))
	}

	destroy() {
		this.unsubs.forEach(u => u())
		this.input.setExpect?.(null)
		audio.stopRun()
		this.stopTracks()
		audio.stopCrowd()
	}

	// --- Frame update -----------------------------------------------------------
	update(now) {
		if (this.paused || this.finished) return
		const prev = this.st
		if (this.mode === "practice") this.advancePractice(now)
		else this.st = this.stAt(now)
		const dSt = Math.max(0, this.st - prev)

		this.scheduleAudio()
		if (this.mode === "perform") this.checkMisses()
		if (this.mode === "watch") this.autoPlay()
		this.updateHolds(dSt)

		if (this.odActive) {
			this.od -= dSt / (this.beatSec * 32)
			if (this.od <= 0) {
				this.od = 0
				this.odActive = false
				audio.setBandBoost(false)
				this.fx.overdriveEnd?.()
			}
		}
		audio.setCrowd(this.crowd)
		if (this.st > this.song.lengthSec + 1.8) this.finish()
	}

	scheduleAudio() {
		const map = audio.clockMap()
		const horizon = this.mode === "practice" ? this.st : this.st + LOOKAHEAD * this.speed
		const ctxAt = t => Math.max(audio.now, audio.perfToCtx(this.songToPerf(t), map))
		const sp = this.speed
		const b = this.song.backing
		// Practice mode keeps the band quiet so you can concentrate.
		if (this.mode !== "practice") {
			while (this.backIdx < b.length && b[this.backIdx].t <= horizon) {
				const e = b[this.backIdx++]
				const t = ctxAt(e.t)
				const v = e.v ?? 1
				if (e.p !== undefined) this.input.gamePlayed?.(e.p, this.songToPerf(e.t))
				for (const q of e.ps || []) this.input.gamePlayed?.(q, this.songToPerf(e.t))
				switch (e.kind) {
					case "kick": audio.kick(t, undefined, v); break
					case "snare": audio.snare(t, undefined, v); break
					case "hat": audio.hat(t, undefined, v); break
					case "bells": audio.bells(t, undefined, v); break
					case "crash": audio.crash(t, audio.run.band, v); break
					case "bass": audio.bass(t, e.p, e.d / sp); break
					case "pad": audio.pad(t, e.ps, e.d / sp); break
					case "note": audio.piano(t, e.p, e.d / sp, v, audio.run.band); break
				}
			}
		}
		// The hand you are not playing is played for you.
		while (this.autoIdx < this.notes.length && this.notes[this.autoIdx].t <= horizon) {
			const n = this.notes[this.autoIdx++]
			if (n.auto && !(this.recording && this.mode !== "practice")) {
				audio.piano(ctxAt(n.t), n.p, n.d / sp, this.mode === "watch" ? 0.8 : 0.45)
				this.input.gamePlayed?.(n.p, this.songToPerf(n.t))
			}
		}
	}

	advancePractice(now) {
		const dt = Math.min(0.1, (now - this.lastNow) / 1000)
		this.lastNow = now
		let next = this.st + dt * this.speed
		if (!this.waiting) {
			const first = this.playable.find(n => !n.judged)
			if (first) this.waiting = this.playable.filter(n => !n.judged && n.t - first.t < 0.05)
		}
		if (this.waiting && next >= this.waiting[0].t) next = this.waiting[0].t
		this.st = next
	}

	isWaitingNow() {
		return this.mode === "practice" && this.waiting && this.st >= this.waiting[0].t - 1e-6
	}

	checkMisses() {
		const late = (WINDOWS.good + (this.input.latency || 0)) * this.speed
		const ps = this.playable
		while (this.missIdx < ps.length && ps[this.missIdx].t < this.st - late) {
			const n = ps[this.missIdx++]
			if (!n.judged) this.miss(n)
		}
	}

	autoPlay() {
		for (const n of this.notes) {
			if (n.judged || n.t > this.st) continue
			if (n.t < this.st - 0.3) {
				n.judged = "skip"
				continue
			}
			this.hit(n, "perfect", 0)
			this.fx.keyFlash?.(n.p, 0.25)
		}
	}

	updateHolds(dSt) {
		for (const n of this.holds) {
			const keyDown = this.mode === "watch" || this.input.held.has(n.p)
			if (!keyDown || this.st >= n.t + n.d) {
				n.holding = false
				n.holdDone = this.st >= n.t + n.d - this.beatSec * 0.25
				this.holds.delete(n)
				continue
			}
			this.score += (dSt / this.beatSec) * 12 * this.mult()
			this.fx.holding?.(n)
		}
	}

	// --- Input ------------------------------------------------------------------
	onNoteOn(p, vel, ts) {
		if (this.settings.echo && !this.input.micOn) audio.piano(audio.now, p, 0.6, vel, audio.keys)
		this.fx.keyDown?.(p)
		if (this.paused || this.finished || this.mode === "watch") return
		if (this.mode === "practice") return this.practiceInput(p)

		const t = this.stAt(ts - this.offset)
		const win = WINDOWS.good * this.speed
		let best = null
		for (const n of this.playable) {
			if (n.t > t + win) break
			if (n.judged || n.p !== p || n.t < t - win) continue
			if (!best || Math.abs(n.t - t) < Math.abs(best.t - t)) best = n
		}
		if (!best) return this.wrong(p)
		const dt = (t - best.t) / this.speed // negative = early
		const a = Math.abs(dt)
		this.hit(best, a <= WINDOWS.perfect ? "perfect" : a <= WINDOWS.great ? "great" : "good", dt)
	}

	practiceInput(p) {
		const w = this.waiting
		if (w && this.st >= w[0].t - 0.4 * this.speed) {
			const n = w.find(x => !x.judged && x.p === p)
			if (n) {
				this.hit(n, n.slipped ? "good" : "perfect", 0)
				if (w.every(x => x.judged)) this.waiting = null
				return
			}
			for (const x of w) x.slipped = true
		}
		this.wrong(p)
	}

	onNoteOff(p) {
		for (const n of this.holds) if (n.p === p && this.mode !== "watch") n.holding = false
	}

	activateOverdrive() {
		if (this.odActive || this.od < 0.5 || this.paused || this.finished) return
		this.odActive = true
		audio.crash()
		audio.whoosh()
		audio.setBandBoost(true)
		this.fx.overdrive?.()
	}

	// --- Scoring ------------------------------------------------------------------
	mult() {
		const base = Math.min(4, 1 + Math.floor(this.combo / 10))
		return this.odActive ? base * 2 : base
	}

	hit(n, grade, dt) {
		n.judged = grade
		n.hitSt = this.st
		this.counts[grade]++
		this.combo++
		this.maxCombo = Math.max(this.maxCombo, this.combo)
		this.score += POINTS[grade] * this.mult()
		if (this.mode === "perform") this.offsets.push(dt)
		this.crowd = Math.min(1, this.crowd + CROWD[grade])
		if (n.d >= this.beatSec * 0.9 && this.mode !== "practice") {
			n.holding = true
			this.holds.add(n)
		}
		this.fx.hit?.(n, grade, dt)

		const chord = this.playable.filter(x => Math.abs(x.t - n.t) < 0.03)
		if (chord.length >= 2 && chord.every(x => x.judged && x.judged !== "miss")) this.fx.chord?.(chord)

		this.checkPhrase(n)
		if (MILESTONES.includes(this.combo)) {
			this.fx.milestone?.(this.combo)
			audio.cheer(Math.min(1.5, 0.6 + this.combo / 100))
		}
	}

	checkPhrase(n) {
		if (!n.star || this.phraseFailed.has(n.phrase)) return
		const ns = this.phrases.get(n.phrase)
		if (ns.every(x => x.judged && x.judged !== "miss")) {
			this.od = Math.min(1, this.od + 0.25)
			this.fx.starPhrase?.(this.od)
		}
	}

	miss(n) {
		n.judged = "miss"
		this.counts.miss++
		this.combo = 0
		this.crowd = Math.max(0, this.crowd + CROWD.miss)
		this.missByPitch[n.p] = (this.missByPitch[n.p] || 0) + 1
		if (n.star && !this.phraseFailed.has(n.phrase)) {
			this.phraseFailed.add(n.phrase)
			this.fx.phraseFail?.()
		}
		audio.missDip()
		this.fx.miss?.(n)
	}

	wrong(p) {
		this.counts.extra++
		this.crowd = Math.max(0, this.crowd + CROWD.wrong)
		const target = this.octaveTarget(p)
		if (target) this.octaveSlips++
		this.fx.wrong?.(p, target)
	}

	// The right note name in the wrong octave: the nearby note it was meant for, if any.
	octaveTarget(p) {
		const practice = this.mode === "practice"
		const win = WINDOWS.good * 2 * this.speed
		for (const n of practice ? this.waiting || [] : this.playable) {
			if (!practice && n.t > this.st + win) break
			if (n.judged || n.p === p || (n.p - p) % 12 !== 0) continue
			if (practice || Math.abs(n.t - this.st) <= win) return n
		}
		return null
	}

	finish() {
		this.finished = true
		audio.stopRun(this.recording ? 0.5 : 0.02)
		audio.stopCrowd()
		this.unsubs.forEach(u => u())
		this.onFinish?.(this.results())
	}

	results() {
		const total = this.playable.length || 1
		const c = this.counts
		const sum = c.perfect * WEIGHT.perfect + c.great * WEIGHT.great + c.good * WEIGHT.good
		const accuracy = this.mode === "practice" ? c.perfect / total : sum / (total + c.extra * 0.5)
		const stars = accuracy >= 0.95 ? 5 : accuracy >= 0.85 ? 4 : accuracy >= 0.7 ? 3 : accuracy >= 0.5 ? 2 : 1
		const offs = this.offsets.filter(o => Math.abs(o) > WINDOWS.perfect * 0.5)
		const mean = offs.length >= 4 ? offs.reduce((a, b) => a + b, 0) / offs.length : 0
		const weak = Object.entries(this.missByPitch)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 2)
			.filter(([, k]) => k >= 2)
			.map(([p]) => noteName(+p))
		return {
			score: Math.round(this.score),
			accuracy,
			stars,
			maxCombo: this.maxCombo,
			counts: { ...c },
			total,
			tendency: mean < -0.02 ? "early" : mean > 0.02 ? "late" : null,
			weak,
			octaveSlips: this.octaveSlips
		}
	}
}
