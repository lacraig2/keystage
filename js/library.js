// Songs made from real recordings, plus play history, stored in this browser (IndexedDB).
// Keystage is a static site, so there is no server: a recording's band and piano tracks are
// kept as audio blobs next to the song data.
import { finalizeSong } from "./songs.js"
import { assignHands, suggestFingers } from "./hands.js"
import { audio } from "./audio.js"

// --- IndexedDB -----------------------------------------------------------------------------
let dbp = null
function db() {
	dbp ??= new Promise((resolve, reject) => {
		const req = indexedDB.open("keystage", 1)
		req.onupgradeneeded = () => {
			req.result.createObjectStore("recordings", { keyPath: "id" })
			req.result.createObjectStore("history", { autoIncrement: true })
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	return dbp
}

async function tx(store, mode, fn) {
	const d = await db()
	return new Promise((resolve, reject) => {
		const t = d.transaction(store, mode)
		const req = fn(t.objectStore(store))
		t.oncomplete = () => resolve(req?.result)
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error || new Error("Storage was full or blocked"))
	})
}

// Ask the browser not to clear our storage under disk pressure (best effort).
export const persist = () => navigator.storage?.persist?.().catch(() => false)

// --- Recording songs --------------------------------------------------------------------------
// A recording entry: { id, title, artist, bpm, beatsPerBar, downbeat, notes:[{t,d,p,v}], backing:Blob, guide:Blob }
export async function saveRecording(entry) {
	await tx("recordings", "readwrite", s => s.put(entry))
	persist()
}

export async function deleteRecording(id) {
	await tx("recordings", "readwrite", s => s.delete(id))
}

export async function loadRecordingSongs() {
	try {
		const all = await tx("recordings", "readonly", s => s.getAll())
		const out = []
		for (const e of all || []) {
			try {
				out.push(songFromRecording(e))
			} catch (err) {
				console.warn("Could not load", e.title, err)
			}
		}
		return out
	} catch (e) {
		console.warn("Recording library unavailable", e)
		return []
	}
}

const INTRO_MAX = 15 // seconds of recording to play before the first note

export function songFromRecording(e) {
	const beatSec = 60 / e.bpm
	const bpb = e.beatsPerBar || 4
	const first = Math.min(...e.notes.map(n => n.t))
	const notes = e.notes.map(n => ({ t: n.t - first, d: n.d, p: n.p, finger: 0 }))
	assignHands(notes)
	suggestFingers(notes)
	return finalizeSong({
		id: "rec-" + e.id,
		recId: e.id,
		title: e.title,
		artist: e.artist || "",
		level: 0,
		blurb: (e.artist ? e.artist + " · " : "") + "real recording",
		bpm: e.bpm,
		beatSec,
		beatsPerBar: bpb,
		intro: Math.min(first, INTRO_MAX),
		pickup: ((((e.downbeat - first) / beatSec) % bpb) + bpb) % bpb,
		drums: "recording",
		notes,
		recording: { offset: first, backing: e.backing, guide: e.guide } // offset: file time of song time 0
	})
}

const bufferCache = new WeakMap() // Blob -> {1: AudioBuffer, 0.7: stretched, ...}

// Decodes (and for slower speeds, time-stretches) a song's recording. Returns {backing, guide}.
export async function loadRecording(song, speed, onStatus = () => {}) {
	const get = async blob => {
		if (!blob) return null
		if (!bufferCache.has(blob)) bufferCache.set(blob, {})
		const c = bufferCache.get(blob)
		if (!c[1]) {
			onStatus("Loading the recording…")
			c[1] = await audio.ctx.decodeAudioData(await blob.arrayBuffer())
		}
		if (!c[speed]) {
			onStatus(`Slowing the band down to ${Math.round(speed * 100)}%…`)
			await new Promise(r => setTimeout(r, 30)) // let the message paint
			c[speed] = audio.stretch(c[1], speed)
		}
		return c[speed]
	}
	const { backing, guide } = song.recording
	return { backing: await get(backing), guide: await get(guide) }
}

// --- Song packs ---------------------------------------------------------------------------------
// A .keystage file is a zip holding song.json plus its audio (backing.ogg, piano.ogg).
export async function readSongPack(file) {
	const files = await unzip(await file.arrayBuffer())
	const meta = files["song.json"]
	if (!meta) throw new Error("That pack has no song.json")
	const info = JSON.parse(new TextDecoder().decode(meta))
	const blob = name => (files[name] ? new Blob([files[name]], { type: "audio/ogg" }) : null)
	return {
		id: (info.id || info.title || "song").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) + "-" + Date.now().toString(36),
		title: info.title,
		artist: info.artist || "",
		bpm: info.bpm,
		beatsPerBar: info.beatsPerBar || 4,
		downbeat: info.downbeat || 0,
		notes: info.notes,
		backing: blob(info.files?.backing || "backing.ogg"),
		guide: blob(info.files?.guide || "piano.ogg")
	}
}

// Minimal zip reader: stored (uncompressed) entries, plus deflate via DecompressionStream.
async function unzip(buf) {
	const v = new DataView(buf)
	let eocd = buf.byteLength - 22
	while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--
	if (eocd < 0) throw new Error("That file isn't a Keystage song pack")
	const count = v.getUint16(eocd + 10, true)
	let p = v.getUint32(eocd + 16, true)
	const out = {}
	for (let i = 0; i < count; i++) {
		const method = v.getUint16(p + 10, true)
		const size = v.getUint32(p + 20, true)
		const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true)
		const local = v.getUint32(p + 42, true)
		const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen))
		const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
		const raw = new Uint8Array(buf, start, size)
		if (method === 0) out[name] = raw
		else if (method === 8) out[name] = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer())
		p += 46 + nameLen + extra + comment
	}
	return out
}

// --- History ------------------------------------------------------------------------------
export async function addHistory(entry) {
	try {
		await tx("history", "readwrite", s => s.add(entry))
	} catch (e) {
		console.warn("History not saved", e)
	}
}

export async function getHistory() {
	try {
		return (await tx("history", "readonly", s => s.getAll())) || []
	} catch {
		return []
	}
}
