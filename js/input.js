// Unified note input: Web MIDI devices, a microphone listening to any piano, and the
// computer keyboard. Every event carries a performance.now()-based timestamp in ms.
import { audio } from "./audio.js"
import { NoteListener } from "./pitch.js"

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ";": 16 }

export class Input {
	constructor() {
		this.handlers = { on: [], off: [], pedal: [], devices: [], mic: [] }
		this.held = new Set()
		this.devices = []
		this.octave = 4
		this.keyHeld = new Map()
		this.mic = null // { stream, node, listener } while listening
		this.initMidi()
		this.initKeyboard()
	}

	listen(type, fn) {
		this.handlers[type].push(fn)
		return () => (this.handlers[type] = this.handlers[type].filter(f => f !== fn))
	}

	emit(type, ...args) {
		for (const fn of this.handlers[type]) fn(...args)
	}

	stamp(ts, exact) {
		const now = performance.now()
		if (exact) return ts
		// MIDI timestamps share performance.now()'s timebase in Chromium; guard against oddities.
		return ts > 0 && ts <= now + 5 && ts > now - 500 ? ts : now
	}

	noteOn(p, vel, ts, exact) {
		this.held.add(p)
		this.emit("on", p, vel, this.stamp(ts, exact))
	}

	noteOff(p, ts, exact) {
		this.held.delete(p)
		this.emit("off", p, this.stamp(ts, exact))
	}

	// --- Microphone ------------------------------------------------------------------
	get micOn() {
		return !!this.mic
	}

	// Mic notes are decided ~60 ms after the key is struck (stamped with the strike time),
	// so the game waits that much longer before calling a note missed.
	get latency() {
		return this.mic ? 0.09 : 0
	}

	get offsetKey() {
		return this.mic ? "micOffset" : "offset"
	}

	// cancelEcho: let the browser remove the game's own sound (for speakers, not headphones)
	async enableMic({ cancelEcho = true } = {}) {
		if (this.mic) return
		if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use a microphone here (it needs https or localhost).")
		audio.ensure()
		const ctx = audio.ctx
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: cancelEcho, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
		})
		await ctx.audioWorklet.addModule(new URL("./mic.worklet.js", import.meta.url))
		const src = ctx.createMediaStreamSource(stream)
		const node = new AudioWorkletNode(ctx, "mic-tap")
		const sink = ctx.createGain()
		sink.gain.value = 0
		src.connect(node).connect(sink).connect(ctx.destination)
		const listener = new NoteListener(ctx.sampleRate)
		node.port.onmessage = e => {
			const { samples, t } = e.data
			// audio clock -> performance clock (the output timestamp is steadier than currentTime),
			// minus the output latency it includes and a little for the input buffer
			const o = ctx.getOutputTimestamp?.()
			const ts = o?.performanceTime
				? o.performanceTime + (t - o.contextTime) * 1000 - (ctx.outputLatency || ctx.baseLatency || 0) * 1000 - 10
				: performance.now() - (ctx.currentTime - t) * 1000 - 10
			for (const ev of listener.push(samples, ts)) {
				if (ev.type === "on") this.noteOn(ev.p, ev.vel, ev.ts, true)
				else this.noteOff(ev.p, ev.ts, true)
			}
			this.emit("mic", listener.level)
		}
		this.mic = { stream, src, node, sink, listener }
		this.emit("devices", this.devices)
	}

	disableMic() {
		if (!this.mic) return
		const { stream, src, node, sink, listener } = this.mic
		stream.getTracks().forEach(t => t.stop())
		node.port.onmessage = null
		src.disconnect()
		node.disconnect()
		sink.disconnect()
		for (const p of listener.held.keys()) this.noteOff(p, performance.now(), true)
		this.mic = null
		this.emit("devices", this.devices)
	}

	// The game tells the listener what it expects and what it's playing itself.
	setExpect(fn) {
		if (this.mic) this.mic.listener.expect = fn || (() => [])
	}

	gamePlayed(p, perfMs) {
		if (!this.mic) return
		const h = this.mic.listener.heard
		h.push({ p, ts: perfMs })
		while (h.length && h[0].ts < perfMs - 3000) h.shift()
	}

	async initMidi() {
		if (!navigator.requestMIDIAccess) {
			this.midiError = "This browser has no Web MIDI. Use Chrome or Edge."
			this.emit("devices", [])
			return
		}
		try {
			this.access = await navigator.requestMIDIAccess()
		} catch (e) {
			this.midiError = "MIDI access was blocked. Allow it in the address bar's site settings, then reload."
			this.emit("devices", [])
			return
		}
		const attach = () => {
			this.devices = []
			for (const inp of this.access.inputs.values()) {
				inp.onmidimessage = e => this.onMessage(e)
				this.devices.push(inp.name)
			}
			this.emit("devices", this.devices)
		}
		this.access.onstatechange = attach
		attach()
	}

	onMessage(e) {
		const [st, a, b] = e.data
		const kind = st & 0xf0
		if (kind === 0x90 && b > 0) this.noteOn(a, b / 127, e.timeStamp)
		else if (kind === 0x80 || (kind === 0x90 && b === 0)) this.noteOff(a, e.timeStamp)
		else if (kind === 0xb0 && a === 64) this.emit("pedal", b >= 64)
	}

	initKeyboard() {
		window.addEventListener("keydown", e => {
			if (e.target.tagName === "INPUT") return
			if (e.code === "Space") {
				e.preventDefault()
				if (!e.repeat) this.emit("pedal", true)
				return
			}
			const k = e.key.toLowerCase()
			if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
			if (k === "z") return (this.octave = Math.max(1, this.octave - 1))
			if (k === "x") return (this.octave = Math.min(7, this.octave + 1))
			if (k in KEYMAP) {
				const p = (this.octave + 1) * 12 + KEYMAP[k]
				this.keyHeld.set(k, p)
				this.noteOn(p, 0.8, e.timeStamp)
			}
		})
		window.addEventListener("keyup", e => {
			if (e.code === "Space") return this.emit("pedal", false)
			const k = e.key.toLowerCase()
			const p = this.keyHeld.get(k)
			if (p !== undefined) {
				this.keyHeld.delete(k)
				this.noteOff(p, e.timeStamp)
			}
		})
	}
}
