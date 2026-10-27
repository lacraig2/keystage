// Standard MIDI File parser + conversion into a playable Keystage song.
import { finalizeSong } from "./songs.js"
import { assignHands, suggestFingers } from "./hands.js"

const GM = [
	"Piano", "Bright Piano", "Electric Grand", "Honky-tonk", "E.Piano 1", "E.Piano 2", "Harpsichord", "Clavinet",
	"Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
	"Drawbar Organ", "Perc Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Bandoneon",
	"Nylon Guitar", "Steel Guitar", "Jazz Guitar", "Clean Guitar", "Muted Guitar", "Overdrive Guitar", "Distortion Guitar", "Guitar Harmonics",
	"Acoustic Bass", "Finger Bass", "Pick Bass", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
	"Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato", "Harp", "Timpani",
	"Strings", "Slow Strings", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
	"Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass", "Synth Brass 1", "Synth Brass 2",
	"Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
	"Piccolo", "Flute", "Recorder", "Pan Flute", "Bottle", "Shakuhachi", "Whistle", "Ocarina",
	"Square Lead", "Saw Lead", "Calliope", "Chiff", "Charang", "Voice Lead", "Fifths Lead", "Bass+Lead",
	"New Age Pad", "Warm Pad", "Polysynth", "Choir Pad", "Bowed Pad", "Metallic Pad", "Halo Pad", "Sweep Pad",
	"Rain", "Soundtrack", "Crystal", "Atmosphere", "Brightness", "Goblins", "Echoes", "Sci-fi",
	"Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
	"Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
	"Fret Noise", "Breath", "Seashore", "Bird", "Telephone", "Helicopter", "Applause", "Gunshot"
]

export function parseMidi(buffer) {
	const v = new DataView(buffer)
	let pos = 0
	const str = n => {
		let s = ""
		for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(pos + i))
		pos += n
		return s
	}
	const u32 = () => ((pos += 4), v.getUint32(pos - 4))
	const u16 = () => ((pos += 2), v.getUint16(pos - 2))
	const u8 = () => v.getUint8(pos++)
	const vlq = () => {
		let n = 0
		for (let i = 0; i < 4; i++) {
			const b = u8()
			n = (n << 7) | (b & 0x7f)
			if (!(b & 0x80)) break
		}
		return n
	}

	if (str(4) !== "MThd") throw new Error("Not a MIDI file")
	const hlen = u32()
	const format = u16()
	const ntrks = u16()
	let ppq = u16()
	if (ppq & 0x8000) ppq = 480 // SMPTE timing is rare; approximate
	pos = 8 + hlen

	const tempos = [] // {tick, uspq}
	const timeSigs = []
	const tracks = []

	for (let ti = 0; ti < ntrks && pos < v.byteLength; ti++) {
		while (pos < v.byteLength - 8 && str(4) !== "MTrk") pos += u32() // skip alien chunks
		const len = u32()
		const end = pos + len
		let tick = 0
		let status = 0
		const trk = { name: "", notes: [], programs: {} }
		const open = {} // "ch:p" -> [ {tick, vel} ]
		while (pos < end) {
			tick += vlq()
			let b = u8()
			if (b < 0x80) {
				pos-- // running status
				b = status
			} else if (b < 0xf0) status = b
			if (b === 0xff) {
				const type = u8()
				const l = vlq()
				if (type === 0x51) tempos.push({ tick, uspq: (v.getUint8(pos) << 16) | (v.getUint8(pos + 1) << 8) | v.getUint8(pos + 2) })
				else if (type === 0x58) timeSigs.push({ tick, num: v.getUint8(pos) })
				else if (type === 0x03 && !trk.name) {
					const p0 = pos
					trk.name = str(l).replace(/\0/g, "").trim()
					pos = p0
				}
				pos += l
				continue
			}
			if (b === 0xf0 || b === 0xf7) {
				pos += vlq()
				continue
			}
			const kind = b & 0xf0
			const ch = b & 0x0f
			if (kind === 0x90 || kind === 0x80) {
				const p = u8()
				const vel = u8()
				const key = ch + ":" + p
				if (kind === 0x90 && vel > 0) (open[key] ||= []).push({ tick, vel })
				else {
					const on = open[key]?.shift()
					if (on) trk.notes.push({ ch, p, vel: on.vel, start: on.tick, end: tick })
				}
			} else if (kind === 0xc0) {
				const prog = u8()
				if (trk.programs[ch] === undefined) trk.programs[ch] = prog
			} else if (kind === 0xd0) pos += 1
			else pos += 2 // a0 b0 e0
		}
		pos = end
		tracks.push(trk)
	}
	if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 })
	tempos.sort((a, b) => a.tick - b.tick)

	// tick -> seconds through the tempo map
	const segs = []
	let sec = 0
	for (let i = 0; i < tempos.length; i++) {
		const t = tempos[i]
		if (i > 0) sec += ((t.tick - tempos[i - 1].tick) * tempos[i - 1].uspq) / 1e6 / ppq
		segs.push({ tick: t.tick, sec, uspq: t.uspq })
	}
	const toSec = tick => {
		let s = segs[0]
		for (const x of segs) if (x.tick <= tick) s = x
		return s.sec + ((tick - s.tick) * s.uspq) / 1e6 / ppq
	}

	// Split every track by channel so format-0 files still yield separate parts.
	const parts = []
	tracks.forEach((trk, ti) => {
		const byCh = {}
		for (const n of trk.notes) (byCh[n.ch] ||= []).push(n)
		for (const ch of Object.keys(byCh)) {
			const notes = byCh[ch].map(n => ({ t: toSec(n.start), d: Math.max(0.05, toSec(n.end) - toSec(n.start)), p: n.p, vel: n.vel / 127 }))
			const drums = +ch === 9
			const program = trk.programs[ch] ?? 0
			const label = trk.name || (drums ? "Drums" : GM[program]) || `Track ${ti + 1}`
			parts.push({
				id: parts.length,
				label: Object.keys(byCh).length > 1 ? `${label} (ch ${+ch + 1})` : label,
				instrument: drums ? "Drums" : GM[program],
				drums,
				program,
				notes,
				avg: notes.reduce((a, n) => a + n.p, 0) / notes.length
			})
		}
	})

	return {
		format,
		bpm: Math.round(60e6 / tempos[0].uspq),
		beatsPerBar: timeSigs[0]?.num || 4,
		parts
	}
}

// Guess which part(s) the player wants: piano tracks first, else the busiest melodic part.
export function defaultPlayerParts(parsed) {
	const melodic = parsed.parts.filter(p => !p.drums)
	const pianos = melodic.filter(p => p.program <= 7).sort((a, b) => b.notes.length - a.notes.length)
	// Some files double the piano on a second track; pick a different part as the other hand.
	if (pianos.length >= 1) return pianos.filter((p, i) => i === 0 || overlap(p.notes, pianos[0].notes) < 0.5).slice(0, 2).map(p => p.id)
	return melodic.sort((a, b) => b.notes.length - a.notes.length).slice(0, 1).map(p => p.id)
}

// Fraction of notes in a that also appear in b (same pitch, same moment).
function overlap(a, b) {
	if (!a.length) return 0
	const keys = new Set(b.map(n => n.p + ":" + Math.round(n.t * 20)))
	return a.filter(n => keys.has(n.p + ":" + Math.round(n.t * 20))).length / a.length
}

const DRUM_MAP = { 35: "kick", 36: "kick", 37: "snare", 38: "snare", 39: "snare", 40: "snare", 42: "hat", 44: "hat", 46: "hat", 49: "crash", 51: "hat", 52: "crash", 55: "crash", 57: "crash", 59: "hat" }

export function songFromMidi(parsed, { id, title, playerParts }) {
	const chosen = parsed.parts.filter(p => playerParts.includes(p.id))
	let notes = []
	const doubled = chosen.length >= 2 && overlap(chosen[0].notes, chosen[1].notes) >= 0.5
	if (doubled) {
		// The same music on two tracks: play it once, split between the hands.
		const merged = []
		for (const n of chosen.flatMap(p => p.notes)) if (!merged.some(m => m.p === n.p && Math.abs(m.t - n.t) < 0.03)) merged.push({ ...n })
		notes = assignHands(merged.sort((a, b) => a.t - b.t))
	} else if (chosen.length >= 2) {
		// Two parts: higher one is the right hand.
		const [hi, lo] = [...chosen].sort((a, b) => b.avg - a.avg)
		notes = [...hi.notes.map(n => ({ ...n, hand: "R" })), ...lo.notes.map(n => ({ ...n, hand: "L" }))]
	} else if (chosen.length === 1) {
		notes = assignHands(chosen[0].notes.map(n => ({ ...n })))
	}
	if (!notes.length) throw new Error("That part has no notes")

	const backing = []
	const mine = chosen.flatMap(p => p.notes)
	for (const part of parsed.parts) {
		if (playerParts.includes(part.id) || (!part.drums && overlap(part.notes, mine) >= 0.5)) continue
		for (const n of part.notes) {
			if (part.drums) {
				const kind = DRUM_MAP[n.p]
				if (kind) backing.push({ t: n.t, kind, v: n.vel })
			} else if (part.program >= 32 && part.program <= 39) backing.push({ t: n.t, kind: "bass", p: n.p, d: n.d })
			else backing.push({ t: n.t, kind: "note", p: n.p, d: n.d, v: n.vel * 0.5 })
		}
	}
	backing.sort((a, b) => a.t - b.t)

	// Shift so the player's first note is at t=0; any band intro before it plays at negative time.
	const first = Math.min(...notes.map(n => n.t))
	const beatSec = 60 / parsed.bpm
	const shift = -first
	notes.forEach(n => (n.t += shift))
	const shiftedBacking = backing.map(e => ({ ...e, t: e.t + shift })).filter(e => e.t >= -30)
	const intro = shiftedBacking.length ? Math.max(0, -shiftedBacking[0].t) : 0

	return finalizeSong({
		id,
		title,
		artist: "Imported",
		level: 0,
		blurb: chosen.map(p => p.label).join(" + "),
		bpm: parsed.bpm,
		beatSec,
		beatsPerBar: parsed.beatsPerBar,
		intro,
		// Beat grid phase: align to the original bar lines.
		pickup: (((shift / beatSec) % parsed.beatsPerBar) + parsed.beatsPerBar) % parsed.beatsPerBar,
		drums: parsed.parts.some(p => p.drums && !playerParts.includes(p.id)) ? "midi" : "none",
		notes: suggestFingers(notes.map(({ t, d, p, hand }) => ({ t, d, p, hand, finger: 0 }))),
		backing: shiftedBacking
	})
}
