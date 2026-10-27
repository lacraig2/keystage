// Turn a recording into a playable song, entirely in the browser:
//   1. separate.worker.js (Demucs htdemucs_6s via onnxruntime-web) pulls out the piano.
//   2. The band is the original mix minus that piano, so it sounds like the record.
//   3. Basic Pitch (Spotify, TensorFlow.js) writes down the piano's notes: those are yours to play.
//   4. A small beat tracker finds the tempo and bar lines for the highway.
// The heavy models load from CDNs on first use and the browser caches them.

const BASIC_PITCH = "https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1"
const SR = 44100

export const PIANO_ONLY = "piano" // the recording is solo piano: skip separation

// onStatus({ stage, pct, msg }) — pct is 0..1 for the whole job.
export async function importRecording(file, { title, artist, solo = false, onStatus, signal }) {
	const status = (stage, pct, msg) => onStatus?.({ stage, pct, msg })
	status("decode", 0, "Decoding the recording…")
	const mix = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await file.arrayBuffer())
	const L = mix.getChannelData(0)
	const R = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L
	if (mix.duration > 12 * 60) throw new Error("That recording is over 12 minutes. Try a single song.")

	let piano, band
	if (solo) {
		piano = [L, R]
		band = null
	} else {
		piano = await separatePiano([L, R], (p, msg) => status("separate", 0.02 + p * 0.68, msg), signal)
		band = [new Float32Array(L.length), new Float32Array(L.length)]
		for (let i = 0; i < L.length; i++) {
			band[0][i] = L[i] - piano[0][i]
			band[1][i] = R[i] - piano[1][i]
		}
	}
	signal?.throwIfAborted()

	status("transcribe", 0.72, "Listening to the piano and writing down the notes…")
	const notes = await transcribe(piano, p => status("transcribe", 0.72 + p * 0.22, "Listening to the piano and writing down the notes…"))
	if (notes.length < 8) throw new Error("Hardly any piano notes were found in that recording")
	signal?.throwIfAborted()

	status("beat", 0.95, "Finding the beat…")
	const { bpm, downbeat } = findBeat(band || piano)

	status("save", 0.98, "Saving…")
	const guide = toWav([piano[0], piano[1]], SR)
	return {
		id: (title || "song").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) + "-" + Date.now().toString(36),
		title: title || "Imported recording",
		artist: artist || "",
		bpm,
		beatsPerBar: 4,
		downbeat,
		notes,
		backing: band ? toWav(band, SR) : null,
		guide
	}
}

// --- Separation (in a worker so the page stays responsive) ---------------------------------
function separatePiano(channels, onProgress, signal) {
	return new Promise((resolve, reject) => {
		const w = new Worker(new URL("./separate.worker.js", import.meta.url), { type: "module" })
		const stop = () => {
			w.terminate()
			reject(new DOMException("Cancelled", "AbortError"))
		}
		signal?.addEventListener("abort", stop, { once: true })
		w.onmessage = e => {
			const m = e.data
			if (m.type === "progress") onProgress(m.pct, m.msg)
			else if (m.type === "done") {
				signal?.removeEventListener("abort", stop)
				w.terminate()
				resolve(m.piano)
			} else if (m.type === "error") {
				w.terminate()
				reject(new Error(m.message))
			}
		}
		w.onerror = e => reject(new Error(e.message || "The separation worker failed to start"))
		const copy = channels.map(c => c.slice())
		w.postMessage({ type: "separate", channels: copy, sampleRate: SR }, copy.map(c => c.buffer))
	})
}

// --- Transcription (Basic Pitch) ---------------------------------------------------------------
let bp = null
async function transcribe([L, R], onProgress) {
	const lib = await import(`${BASIC_PITCH}/+esm`)
	bp ??= new lib.BasicPitch(`${BASIC_PITCH}/model/model.json`)

	// Basic Pitch wants mono at 22050 Hz.
	const len = Math.ceil((L.length * 22050) / SR)
	const oc = new OfflineAudioContext(1, len, 22050)
	const src = oc.createBuffer(2, L.length, SR)
	src.copyToChannel(L, 0)
	src.copyToChannel(R, 1)
	const node = oc.createBufferSource()
	node.buffer = src
	node.connect(oc.destination)
	node.start()
	const mono = (await oc.startRendering()).getChannelData(0)

	const frames = [], onsets = [], contours = []
	await bp.evaluateModel(
		mono,
		(f, o, c) => {
			frames.push(...f)
			onsets.push(...o)
			contours.push(...c)
		},
		p => onProgress(p)
	)
	// onset 0.6 / frame 0.35 / at least 7 frames (~80 ms), piano range only
	const poly = lib.outputToNotesPoly(frames, onsets, 0.6, 0.35, 7, true, 4186, 27.5, true)
	const events = lib.noteFramesToTime(lib.addPitchBendsToNoteEvents(contours, poly))
	return cleanNotes(
		events.map(e => ({ t: e.startTimeSeconds, d: e.durationSeconds, p: e.pitchMidi, v: e.amplitude })).filter(n => n.p >= 21 && n.p <= 108 && n.v >= 0.25 && n.d >= 0.06)
	)
}

// Merge stutters: a pitch re-struck while it's still sounding, very soon after it started.
export function cleanNotes(notes) {
	notes.sort((a, b) => a.t - b.t || a.p - b.p)
	const out = [], last = {}
	for (const n of notes) {
		const prev = last[n.p]
		if (prev && n.t < prev.t + prev.d - 0.02 && n.t - prev.t < 0.12) {
			prev.d = Math.max(prev.d, n.t + n.d - prev.t)
			continue
		}
		const r = { t: +n.t.toFixed(4), d: +n.d.toFixed(4), p: n.p, v: +n.v.toFixed(3) }
		out.push(r)
		last[n.p] = r
	}
	return out
}

// --- Beat tracking -------------------------------------------------------------------------------
// Onset strength = rise in loudness per ~11.6 ms frame. Tempo from its autocorrelation (preferring
// 80-160 BPM), beat phase by comb filtering, downbeat = strongest of the four beat positions.
export function findBeat([L, R], sr = SR) {
	const hop = Math.round(sr * 0.0116), fps = sr / hop
	const n = Math.floor(L.length / hop)
	const env = new Float32Array(n)
	let prev = 0
	for (let f = 0; f < n; f++) {
		let e = 0
		for (let i = f * hop; i < (f + 1) * hop; i++) e += L[i] * L[i] + R[i] * R[i]
		const loud = Math.log(1e-6 + e / hop)
		env[f] = Math.max(0, loud - prev)
		prev = loud
	}
	// remove the slowly varying part so autocorrelation sees the pulses
	const mean = env.reduce((a, b) => a + b, 0) / (n || 1)
	for (let f = 0; f < n; f++) env[f] = Math.max(0, env[f] - mean)

	let best = { score: -1, lag: fps / 2 }
	for (let bpm = 60; bpm <= 190; bpm += 0.5) {
		const lag = (60 / bpm) * fps
		let s = 0
		for (let f = 0; f + lag * 4 < n; f += 2) s += env[f] * (env[Math.round(f + lag)] + 0.5 * env[Math.round(f + 2 * lag)] + 0.25 * env[Math.round(f + 4 * lag)])
		s *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2)) // prior around 120 BPM
		if (s > best.score) best = { score: s, lag, bpm }
	}
	if (!best.bpm) return { bpm: 120, downbeat: 0 }

	const P = best.lag
	let phase = 0, phaseScore = -1
	for (let ph = 0; ph < P; ph++) {
		let s = 0
		for (let f = ph; f < n; f += P) s += env[Math.round(f)]
		if (s > phaseScore) (phaseScore = s), (phase = ph)
	}
	const byBeat = [0, 0, 0, 0]
	for (let k = 0, f = phase; f < n; k++, f += P) byBeat[k % 4] += env[Math.round(f)]
	const down = byBeat.indexOf(Math.max(...byBeat))
	return { bpm: Math.round(best.bpm * 10) / 10, downbeat: (phase + down * P) / fps }
}

// --- WAV encoding (16-bit) ----------------------------------------------------------------------
export function toWav(channels, sampleRate) {
	const ch = channels.length, n = channels[0].length
	const out = new DataView(new ArrayBuffer(44 + n * ch * 2))
	const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
	str(0, "RIFF")
	out.setUint32(4, 36 + n * ch * 2, true)
	str(8, "WAVEfmt ")
	out.setUint32(16, 16, true)
	out.setUint16(20, 1, true)
	out.setUint16(22, ch, true)
	out.setUint32(24, sampleRate, true)
	out.setUint32(28, sampleRate * ch * 2, true)
	out.setUint16(32, ch * 2, true)
	out.setUint16(34, 16, true)
	str(36, "data")
	out.setUint32(40, n * ch * 2, true)
	for (let i = 0, o = 44; i < n; i++) {
		for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, channels[c][i])) * 32767, true)
	}
	return new Blob([out.buffer], { type: "audio/wav" })
}
