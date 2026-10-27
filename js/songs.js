// Songs are authored as compact strings: "E4:1:3" = note E4, 1 beat long, finger 3.
// "-:2" is a 2-beat rest. "C4+E4:2" plays a chord. "|" marks a bar line: it's checked (see songWarnings)
// so a typo in a rhythm shows up as a failing test instead of a song that drifts off the beat.
// Fingers are optional: a hand written without any gets suggested fingering (hands.js).
// Built-in songs must be public domain or original, since they ship with the game.
import { suggestFingers } from "./hands.js"

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

export const noteName = p => NAMES[p % 12]
export const isBlack = p => [1, 3, 6, 8, 10].includes(p % 12)

function parsePitch(s) {
	const m = /^([A-G])(#|b)?(-?\d)$/.exec(s)
	if (!m) throw new Error("Bad pitch " + s)
	let p = NOTE_INDEX[m[1]] + (m[3] * 1 + 1) * 12
	if (m[2] === "#") p++
	if (m[2] === "b") p--
	return p
}

const warnings = []
export const songWarnings = () => warnings

function seq(str, hand, bar = null) {
	const notes = []
	let beat = 0
	for (const tok of str.split(/\s+/)) {
		if (!tok) continue
		if (tok === "|") {
			const off = bar ? (beat - bar.pickup) / bar.beatsPerBar : 0
			if (Math.abs(off - Math.round(off)) > 1e-6) warnings.push(`${bar.id} ${hand}: bar line at beat ${beat} is off the bar grid`)
			continue
		}
		const [pitches, len, finger] = tok.split(":")
		const d = parseFloat(len)
		if (pitches !== "-") {
			for (const ps of pitches.split("+")) {
				notes.push({ beat, dur: d, p: parsePitch(ps), hand, finger: finger ? +finger : 0 })
			}
		}
		beat += d
	}
	return notes
}

const rep = (s, n) => Array(n).fill(s).join(" ")

// --- Mary Had a Little Lamb -------------------------------------------------
const maryRH = `
E4:1:3 D4:1:2 C4:1:1 D4:1:2 | E4:1:3 E4:1:3 E4:2:3 | D4:1:2 D4:1:2 D4:2:2 | E4:1:3 G4:1:5 G4:2:5 |
E4:1:3 D4:1:2 C4:1:1 D4:1:2 | E4:1:3 E4:1:3 E4:1:3 E4:1:3 | D4:1:2 D4:1:2 E4:1:3 D4:1:2 | C4:4:1 |`
const maryLH = `C3:4:5 | C3:4:5 | G3:4:1 | C3:4:5 | C3:4:5 | C3:4:5 | G3:4:1 | C3:4:5 |`

// --- Ode to Joy ---------------------------------------------------------------
const odeA = `E4:1:3 E4:1:3 F4:1:4 G4:1:5 | G4:1:5 F4:1:4 E4:1:3 D4:1:2 | C4:1:1 C4:1:1 D4:1:2 E4:1:3 |`
const odeRH = `
${odeA} E4:1.5:3 D4:0.5:2 D4:2:2 |
${odeA} D4:1.5:2 C4:0.5:1 C4:2:1 |
D4:1:2 D4:1:2 E4:1:3 C4:1:1 | D4:1:2 E4:0.5:3 F4:0.5:4 E4:1:3 C4:1:1 |
D4:1:2 E4:0.5:3 F4:0.5:4 E4:1:3 D4:1:2 | C4:1:1 D4:1:2 -:2 |
${odeA} D4:1.5:2 C4:0.5:1 C4:2:1 |`
const odeLH = `
C3:4:5 | G3:4:1 | C3:4:5 | G3:4:1 |
C3:4:5 | G3:4:1 | C3:4:5 | G3:2:1 C3:2:5 |
G3:4:1 | C3:4:5 | G3:4:1 | C3:2:5 G3:2:1 |
C3:4:5 | G3:4:1 | C3:4:5 | G3:2:1 C3:2:5 |`

// --- Für Elise (opening, beat = sixteenth note) ------------------------------
const eliseRun = `E5:1 D#5:1 E5:1 B4:1 D5:1 C5:1`
const eliseRH1 = `
${eliseRun} | A4:2 -:1 C4:1 E4:1 A4:1 | B4:2 -:1 E4:1 G#4:1 B4:1 | C5:2 -:1 E4:1 E5:1 D#5:1 |
${eliseRun} | A4:2 -:1 C4:1 E4:1 A4:1 | B4:2 -:1 E4:1 C5:1 B4:1 |`
const eliseRH = `E5:1 D#5:1 ${eliseRH1} A4:4 E5:1 D#5:1 | ${eliseRH1} A4:6`
const eliseLH1 = `
-:6 | A2:1 E3:1 A3:1 -:3 | E2:1 E3:1 G#3:1 -:3 | A2:1 E3:1 A3:1 -:3 |
-:6 | A2:1 E3:1 A3:1 -:3 | E2:1 E3:1 G#3:1 -:3 |`
const eliseLH = `-:2 ${eliseLH1} A2:1 E3:1 A3:1 -:3 | ${eliseLH1} A2:1 E3:1 A3:1 -:3`

// --- First Gig (original riff, A minor five-finger position) -----------------
const gigVerse = `
A4:1:1 A4:0.5:1 C5:0.5:3 E5:1:5 D5:1:4 | C5:1:3 C5:0.5:3 D5:0.5:4 C5:1:3 A4:1:1 |
E5:1.5:5 D5:0.5:4 C5:1:3 D5:1:4 | B4:1:2 B4:0.5:2 C5:0.5:3 D5:2:4 |`
const gigChorus = `
E5:0.5:5 E5:0.5:5 E5:0.5:5 D5:0.5:4 C5:1:3 A4:1:1 | C5:0.5:3 C5:0.5:3 C5:0.5:3 B4:0.5:2 A4:2:1 |
E5:0.5:5 D5:0.5:4 C5:0.5:3 D5:0.5:4 E5:1:5 E5:1:5 | D5:1:4 C5:1:3 B4:2:2 |`
const gigRH = `${gigVerse} ${gigVerse} ${gigChorus} ${gigChorus} A4:4:1`

// --- Twinkle, Twinkle (the tune Mozart wrote variations on) -----------------
const twinkleRH = `
C4:1 C4:1 G4:1 G4:1 | A4:1 A4:1 G4:2 | F4:1 F4:1 E4:1 E4:1 | D4:1 D4:1 C4:2 |
G4:1 G4:1 F4:1 F4:1 | E4:1 E4:1 D4:2 | G4:1 G4:1 F4:1 F4:1 | E4:1 E4:1 D4:2 |
C4:1 C4:1 G4:1 G4:1 | A4:1 A4:1 G4:2 | F4:1 F4:1 E4:1 E4:1 | D4:1 D4:1 C4:2 |`
const twinkleChords = "C F:C F:C G:C C:F C:G C:F C:G C F:C F:C G:C"

// --- Four Chord Anthem (original) ----------------------------------------------
const anthemVerse = `
E4:1 E4:1 G4:1 E4:1 | D4:1 D4:1 D4:2 | C4:1 E4:1 C4:1 E4:1 | F4:4 |
E4:0.5 E4:0.5 E4:1 G4:1 E4:1 | D4:1 G4:1 D4:2 | E4:1 D4:1 C4:1 E4:1 | F4:2 D4:2 |`
const anthemChorus = `
G4:1 G4:1 G4:1 E4:1 | G4:1 F4:1 D4:2 | E4:1 E4:1 E4:1 C4:1 | F4:2 E4:1 D4:1 |
G4:1 G4:1 G4:1 E4:1 | G4:1 F4:1 D4:2 | E4:1 D4:1 C4:1 D4:1 | D4:4 |`
const anthemChords = "C G Am F C G Am F:G C G Am F C G Am G"

// --- Night Drive (original) -------------------------------------------------------
const driveRiff = `
A4:0.5 C5:0.5 D5:0.5 E5:1 D5:0.5 C5:0.5 A4:0.5 | G4:0.5 A4:0.5 C5:0.5 D5:1 C5:0.5 A4:1 |
A4:0.5 C5:0.5 D5:0.5 E5:1 G5:0.5 E5:0.5 D5:0.5 | E5:1.5 D5:0.5 C5:1 D5:1 |`
const driveChorus = `
E5:1 E5:0.5 G5:1 E5:0.5 D5:1 | C5:1 C5:0.5 D5:1 C5:0.5 A4:1 |
G4:0.5 A4:0.5 C5:1 D5:1 E5:1 | D5:3 -:1 |`

// --- In the Hall of the Mountain King (Grieg), rock arrangement ---------------
const kingA = `
A3:0.5 B3:0.5 C4:0.5 D4:0.5 E4:0.5 C4:0.5 E4:1 | D#4:0.5 B3:0.5 D#4:1 D4:0.5 A#3:0.5 D4:1 |
A3:0.5 B3:0.5 C4:0.5 D4:0.5 E4:0.5 C4:0.5 E4:0.5 A4:0.5 | G4:0.5 E4:0.5 C4:0.5 E4:0.5 G4:2 |`
const kingB = `
E4:0.5 F#4:0.5 G4:0.5 A4:0.5 B4:0.5 G4:0.5 B4:1 | A#4:0.5 F#4:0.5 A#4:1 A4:0.5 F4:0.5 A4:1 |
E4:0.5 F#4:0.5 G4:0.5 A4:0.5 B4:0.5 G4:0.5 B4:0.5 E5:0.5 | D5:0.5 B4:0.5 G4:0.5 B4:0.5 D5:2 |`

// --- Minuet in G (Petzold, long credited to Bach) ------------------------------
const minuetA = `
D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | D5:1 G4:1 G4:1 | E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | G5:1 G4:1 G4:1 |
C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 |`
const minuetRH = `
${minuetA} F#4:1 G4:0.5 A4:0.5 B4:0.5 G4:0.5 | A4:3 |
${minuetA} A4:1 B4:0.5 A4:0.5 G4:0.5 F#4:0.5 | G4:3 |`
const minuetLH = `
G3:2 A3:1 | B3:3 | C4:3 | B3:3 | A3:3 | G3:3 | D4:1 B3:1 G3:1 | D4:1 D3:0.5 C4:0.5 B3:0.5 A3:0.5 |
B3:2 A3:1 | G3:1 B3:1 G3:1 | C4:3 | B3:1 C4:0.5 B3:0.5 A3:0.5 G3:0.5 | A3:2 F#3:1 | G3:2 B3:1 | C4:1 D4:1 D3:1 | G3:2 G2:1 |`

// --- Canon in D (Pachelbel) ---------------------------------------------------------
const canonHigh = `F#5:2 E5:2 | D5:2 C#5:2 | B4:2 A4:2 | B4:2 C#5:2 |`
const canonRH = `
${canonHigh}
D5:2 C#5:2 | B4:2 A4:2 | G4:2 F#4:2 | G4:2 E4:2 |
D4:1 F#4:1 A4:1 G4:1 | F#4:1 D4:1 F#4:1 E4:1 | D4:1 B3:1 D4:1 A4:1 | G4:1 B4:1 A4:1 G4:1 |
${canonHigh} D5:4 |`
const canonChords = "D:A Bm:F#m G:D G:A"

// --- Jingle Bells (chorus) -----------------------------------------------------------
const jingleChorus = (end1, end2) => `
E4:1 E4:1 E4:2 | E4:1 E4:1 E4:2 | E4:1 G4:1 C4:1.5 D4:0.5 | E4:4 |
F4:1 F4:1 F4:1.5 F4:0.5 | F4:1 E4:1 E4:1 E4:0.5 E4:0.5 | ${end1} | ${end2} |`
const jingleRH = `
${jingleChorus("E4:1 D4:1 D4:1 E4:1", "D4:2 G4:2")}
${jingleChorus("G4:1 G4:1 F4:1 D4:1", "C4:4")}`
const jingleChords = "C C C C F C D G C C C C F C G C"

// --- We Wish You a Merry Christmas -----------------------------------------------------
const wishVerse = end => `
G4:1 G4:0.5 A4:0.5 G4:0.5 F#4:0.5 | E4:1 E4:1 E4:1 | A4:1 A4:0.5 B4:0.5 A4:0.5 G4:0.5 | F#4:1 D4:1 D4:1 |
B4:1 B4:0.5 C5:0.5 B4:0.5 A4:0.5 | G4:1 E4:1 D4:0.5 D4:0.5 | E4:1 A4:1 F#4:1 | ${end} |`
const wishRH = `D4:1 | ${wishVerse("G4:2 D4:1")} ${wishVerse("G4:3")}`
const wishChords = "G C A D B Em C:D G"

// --- Deck the Halls ---------------------------------------------------------------------
const deckA = `G4:1.5 F4:0.5 E4:1 D4:1 | C4:1 D4:1 E4:1 C4:1 |`
const deckFa = `D4:0.5 E4:0.5 F4:0.5 D4:0.5 E4:1.5 D4:0.5 | C4:1 B3:1 C4:2 |`
const deckRH = `
${deckA} ${deckFa}
${deckA} ${deckFa}
D4:1.5 E4:0.5 F4:1 D4:1 | E4:1.5 F4:0.5 G4:1 D4:1 | E4:0.5 F#4:0.5 G4:1 A4:0.5 B4:0.5 C5:1 | B4:1 A4:1 G4:2 |
${deckA} A4:0.5 A4:0.5 A4:0.5 A4:0.5 G4:1.5 F4:0.5 | E4:1 D4:1 C4:2 |`
const deckChords = "C C G C:G:C:C C C G C:G:C:C G C G D:G C C F:G C:G:C:C"

// --- Silent Night ---------------------------------------------------------------------------
const silentRH = `
G4:1.5 A4:0.5 G4:1 | E4:3 | G4:1.5 A4:0.5 G4:1 | E4:3 | D5:2 D5:1 | B4:3 | C5:2 C5:1 | G4:3 |
A4:2 A4:1 | C5:1.5 B4:0.5 A4:1 | G4:1.5 A4:0.5 G4:1 | E4:3 | A4:2 A4:1 | C5:1.5 B4:0.5 A4:1 | G4:1.5 A4:0.5 G4:1 | E4:3 |
D5:2 D5:1 | F5:1.5 D5:0.5 B4:1 | C5:3 | E5:3 | C5:1 G4:1 E4:1 | G4:1.5 F4:0.5 D4:1 | C4:3 |`
const silentChords = "C C C C G G C C F F C C F F C C G G C C C G C"

// --- Shchedryk / Carol of the Bells (Leontovych, 1914), rock arrangement ----------------------------------
const bellsLow = rep("C5:1 B4:0.5 C5:0.5 A4:1 |", 4)
const bellsHigh = rep("E5:1 D5:0.5 E5:0.5 C5:1 |", 4)
const bellsFall = `A5:1 G5:1 F5:1 | E5:1 D5:1 C5:1 | D5:1 E5:1 D5:1 | A4:3 |`
const bellsRH = `${bellsLow} ${bellsLow} ${bellsHigh} ${bellsHigh} ${bellsFall} ${bellsFall} ${bellsLow} ${bellsLow} A4:3 |`
const bellsChords = "Am G F G Am G F G Am C F G Am C F G F C Dm Am F C Dm Am Am G F G Am G F G Am"

const DEFS = [
	{
		id: "mary",
		title: "Mary Had a Little Lamb",
		artist: "Traditional",
		level: 1,
		genre: ["starter"],
		blurb: "Five fingers, five notes. Thumb on middle C.",
		bpm: 96,
		beatsPerBar: 4,
		drums: "soft",
		chords: rep("C C G C C C G C", 2),
		rh: rep(maryRH, 2),
		lh: rep(maryLH, 2)
	},
	{
		id: "ode",
		title: "Ode to Joy",
		artist: "Beethoven",
		level: 2,
		genre: ["classical"],
		blurb: "The classic. Watch for the dotted rhythms.",
		bpm: 100,
		beatsPerBar: 4,
		drums: "rock",
		chords: "C G C G C G C G:C G C G C:G C G C G:C",
		rh: odeRH,
		lh: odeLH
	},
	{
		id: "gig",
		title: "First Gig",
		artist: "Keystage Original",
		level: 3,
		genre: ["rock"],
		blurb: "A minor rock riff. Syncopation and speed.",
		bpm: 112,
		beatsPerBar: 4,
		drums: "rock",
		chords: rep("Am F C G", 4) + " Am",
		rh: gigRH
	},
	{
		id: "elise",
		title: "Für Elise",
		artist: "Beethoven",
		level: 4,
		genre: ["classical"],
		blurb: "The famous opening. Hands take turns.",
		bpm: 260, // sixteenth notes per minute
		beatsPerBar: 6,
		clickEvery: 2,
		pickup: 2,
		drums: "none",
		rh: eliseRH,
		lh: eliseLH
	},
	{
		id: "twinkle",
		title: "Twinkle, Twinkle",
		artist: "Traditional (Mozart's theme)",
		level: 1,
		genre: ["starter", "classical"],
		blurb: "The tune Mozart wrote twelve variations on. One stretch to A.",
		bpm: 100,
		beatsPerBar: 4,
		drums: "soft",
		chords: twinkleChords,
		rh: twinkleRH,
		lh: "roots"
	},
	{
		id: "anthem",
		title: "Four Chord Anthem",
		artist: "Keystage Original",
		level: 1,
		genre: ["starter", "rock"],
		blurb: "Your first rock song. Thumb on C, the band does the rest.",
		bpm: 112,
		beatsPerBar: 4,
		drums: "rock",
		chords: `${anthemChords} ${anthemChords} C`,
		rh: `${anthemVerse} ${anthemChorus} ${anthemVerse} ${anthemChorus} C4:4 |`
	},
	{
		id: "jingle",
		title: "Jingle Bells",
		artist: "James Lord Pierpont",
		level: 1,
		genre: ["christmas", "starter"],
		blurb: "Sleigh bells on. Mostly E, F and G.",
		bpm: 112,
		beatsPerBar: 4,
		drums: "jingle",
		chords: jingleChords,
		rh: jingleRH,
		lh: "roots"
	},
	{
		id: "deck",
		title: "Deck the Halls",
		artist: "Traditional Welsh",
		level: 2,
		genre: ["christmas"],
		blurb: "Fa la la! Quick runs of four notes.",
		bpm: 108,
		beatsPerBar: 4,
		drums: "jingle",
		chords: deckChords,
		rh: deckRH,
		lh: "roots"
	},
	{
		id: "wish",
		title: "We Wish You a Merry Christmas",
		artist: "Traditional English",
		level: 2,
		genre: ["christmas"],
		blurb: "Three beats to a bar. Starts on a pickup note.",
		bpm: 132,
		beatsPerBar: 3,
		pickup: 1,
		drums: "jingle",
		chords: `${wishChords} ${wishChords}`,
		rh: wishRH,
		lh: "roots"
	},
	{
		id: "silent",
		title: "Silent Night",
		artist: "Franz Gruber",
		level: 2,
		genre: ["christmas"],
		blurb: "Slow and gentle. Hold the long notes.",
		bpm: 84,
		beatsPerBar: 3,
		drums: "soft",
		chords: silentChords,
		rh: silentRH,
		lh: "roots"
	},
	{
		id: "canon",
		title: "Canon in D",
		artist: "Pachelbel",
		level: 2,
		genre: ["classical"],
		blurb: "Long, slow notes over the famous bass line.",
		bpm: 72,
		beatsPerBar: 4,
		drums: "none",
		chords: rep(canonChords, 4) + " D",
		rh: canonRH,
		lh: "roots"
	},
	{
		id: "minuet",
		title: "Minuet in G",
		artist: "Christian Petzold",
		level: 3,
		genre: ["classical"],
		blurb: "A dance in three. Both hands have real tunes.",
		bpm: 110,
		beatsPerBar: 3,
		drums: "none",
		rh: minuetRH,
		lh: minuetLH
	},
	{
		id: "king",
		title: "Hall of the Mountain King",
		artist: "Grieg (rock arrangement)",
		level: 3,
		genre: ["rock", "classical"],
		blurb: "Sneaky eighth notes over a heavy band.",
		bpm: 126,
		beatsPerBar: 4,
		drums: "heavy",
		chords: rep("Am B:Bb Am C", 2) + " " + rep("Em F#:F Em G", 2) + " " + rep("Am B:Bb Am C", 2) + " Am",
		rh: `${kingA} ${kingA} ${kingB} ${kingB} ${kingA} ${kingA} A3+C4+E4:4 |`,
		lh: "roots"
	},
	{
		id: "bells",
		title: "Shchedryk (Carol of the Bells)",
		artist: "Leontovych (rock arrangement)",
		level: 3,
		genre: ["christmas", "rock"],
		blurb: "The ringing four-note pattern over a heavy band in three.",
		bpm: 150,
		beatsPerBar: 3,
		drums: "heavy",
		chords: bellsChords,
		rh: bellsRH,
		lh: "roots"
	},
	{
		id: "drive",
		title: "Night Drive",
		artist: "Keystage Original",
		level: 4,
		genre: ["rock"],
		blurb: "Pentatonic riffs while your left hand keeps the pulse.",
		bpm: 120,
		beatsPerBar: 4,
		drums: "rock",
		chords: rep("Am G F G", 2) + " " + rep("Am F C G", 2) + " Am G F G Am",
		rh: `${driveRiff} ${driveRiff} ${driveChorus} ${driveChorus} ${driveRiff} A4:4 |`,
		lh: "pulse"
	}
]

const CHORD_ROOT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
function chordTones(name) {
	const m = /^([A-G])(#|b)?(m)?$/.exec(name)
	const root = CHORD_ROOT[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0)
	return { root, tones: [root, root + (m[3] ? 3 : 4), root + 7] }
}

// Drum patterns by style and beats per bar, as beat positions within the bar.
const DRUMS = {
	rock: { 4: { kick: [0, 2, 2.5], snare: [1, 3], hat: "eighths" }, 3: { kick: [0], snare: [1, 2], hat: "eighths" } },
	heavy: { 4: { kick: [0, 0.5, 2, 2.5], snare: [1, 3], hat: "eighths", crashEvery: 4 }, 3: { kick: [0, 1.5], snare: [1, 2], hat: "eighths", crashEvery: 4 } },
	soft: { 4: { kick: [0], hat: "beats", soft: true }, 3: { kick: [0], hat: [1, 2], soft: true } },
	jingle: { 4: { kick: [0, 2], snare: [1, 3], bells: "eighths", soft: true }, 3: { kick: [0], bells: "eighths", soft: true } }
}

// Left hands made from the chords: "roots" holds each chord's root, "pulse" plays it on every beat.
function chordHand(def, pickup) {
	const out = []
	def.chords.split(/\s+/).filter(Boolean).forEach((bar, bi) => {
		const parts = bar.split(":")
		const len = def.beatsPerBar / parts.length
		parts.forEach((name, k) => {
			const r = (chordTones(name).root + 12) % 12
			const p = r + 48 <= 52 ? r + 48 : r + 36 // F2..E3
			const beat = pickup + bi * def.beatsPerBar + k * len
			const step = def.lh === "pulse" ? 1 : len
			for (let b = 0; b < len - 1e-6; b += step) out.push({ beat: beat + b, dur: step, p, hand: "L", finger: 0 })
		})
	})
	return out
}

// Backing events are what the band plays: { t, kind: kick|snare|hat|crash|bells|bass|pad|note, p, ps, d, v }
function buildBacking(def, beatSec, pickup, lastBeat) {
	const out = []
	const at = beat => beat * beatSec
	if (def.chords) {
		def.chords.split(/\s+/).filter(Boolean).forEach((bar, bi) => {
			const parts = bar.split(":")
			const len = def.beatsPerBar / parts.length
			parts.forEach((name, k) => {
				const beat = pickup + bi * def.beatsPerBar + k * len
				const { root, tones } = chordTones(name)
				out.push({ t: at(beat), kind: "pad", ps: tones.map(x => 53 + ((x + 19) % 12)) /* voiced within F3..E4 */, d: len * beatSec })
				const step = def.drums === "rock" || def.drums === "heavy" ? 0.5 : def.beatsPerBar === 3 ? len : Math.min(2, len)
				for (let b = 0; b < len - 1e-6; b += step) {
					out.push({ t: at(beat + b), kind: "bass", p: 36 + ((root + 12) % 12), d: step * beatSec * 0.9 })
				}
			})
		})
	}
	const style = DRUMS[def.drums]?.[def.beatsPerBar]
	if (style) {
		const on = (list, x) => (list === "eighths" ? true : list === "beats" ? x % 1 === 0 : (list || []).includes(x))
		const v = style.soft ? 0.7 : 1
		for (let b = pickup; b < lastBeat; b += 0.5) {
			const inBar = (b - pickup) % def.beatsPerBar
			const bar = Math.round((b - pickup - inBar) / def.beatsPerBar)
			if (on(style.kick, inBar)) out.push({ t: at(b), kind: "kick", v })
			if (style.snare && on(style.snare, inBar)) out.push({ t: at(b), kind: "snare", v: style.soft ? 0.45 : 1 })
			if (style.hat && on(style.hat, inBar)) out.push({ t: at(b), kind: "hat", v: (inBar % 1 ? 0.6 : 1) * v })
			if (style.bells && on(style.bells, inBar)) out.push({ t: at(b), kind: "bells", v: inBar % 1 ? 0.55 : 0.9 })
			if (style.crashEvery && inBar === 0 && bar > 0 && bar % style.crashEvery === 0) out.push({ t: at(b), kind: "crash", v: 0.5 })
		}
		out.push({ t: at(pickup), kind: "crash", v: 0.6 })
	}
	return out.sort((a, b) => a.t - b.t)
}

// Shared finishing step for built-in and imported songs. Notes must have t, d, p, hand.
export function finalizeSong(song) {
	song.notes.sort((a, b) => a.t - b.t || a.p - b.p)
	song.notes.forEach((n, i) => (n.id = i))
	const end = Math.max(...song.notes.map(n => n.t + n.d))
	return {
		clickEvery: 1,
		pickup: 0,
		intro: 0,
		backing: [],
		...song,
		hands: ["R", "L"].filter(h => song.notes.some(n => n.hand === h)),
		barSec: song.beatSec * song.beatsPerBar,
		lengthSec: end,
		lo: Math.min(...song.notes.map(n => n.p)),
		hi: Math.max(...song.notes.map(n => n.p))
	}
}

function compile(def) {
	const beatSec = 60 / def.bpm
	const pickup = def.pickup || 0
	const bar = { id: def.id, beatsPerBar: def.beatsPerBar, pickup }
	const lh = def.lh === "roots" || def.lh === "pulse" ? chordHand(def, pickup) : seq(def.lh || "", "L", bar)
	const raw = [...seq(def.rh || "", "R", bar), ...lh]
	for (const hand of ["R", "L"]) {
		const hs = raw.filter(n => n.hand === hand)
		if (hs.length && hs.every(n => !n.finger)) suggestFingers(hs.map(n => Object.assign(n, { t: n.beat * beatSec })))
	}
	const lastBeat = Math.max(...raw.map(n => n.beat + n.dur))
	return finalizeSong({
		...def,
		builtin: true,
		pickup,
		clickEvery: def.clickEvery || 1,
		beatSec,
		notes: raw.map(n => ({ t: n.beat * beatSec, d: n.dur * beatSec, p: n.p, hand: n.hand, finger: n.finger })),
		backing: buildBacking(def, beatSec, pickup, lastBeat)
	})
}

export const SONGS = DEFS.map(compile)

// "Simplified" arrangement: one note at a time per hand (melody top / bass bottom),
// and no two notes in the same hand closer than an eighth note.
export function simplify(notes, beatSec) {
	const out = []
	for (const hand of ["R", "L"]) {
		const hs = notes.filter(n => n.hand === hand).sort((a, b) => a.t - b.t)
		let last = -Infinity
		for (let i = 0; i < hs.length; ) {
			let j = i
			while (j < hs.length && hs[j].t - hs[i].t < 0.04) j++
			const group = hs.slice(i, j)
			const pick = group.reduce((a, b) => (hand === "R" ? (b.p > a.p ? b : a) : b.p < a.p ? b : a))
			if (pick.t - last >= beatSec * 0.5 - 0.01) {
				out.push(pick)
				last = pick.t
			}
			i = j
		}
	}
	return out.sort((a, b) => a.t - b.t)
}
