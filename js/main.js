import { audio } from "./audio.js"
import { Input } from "./input.js"
import { Renderer } from "./render.js"
import { Game } from "./game.js"
import { SONGS } from "./songs.js"
import { parseMidi, defaultPlayerParts, songFromMidi } from "./midi.js"
import { loadRecordingSongs, saveRecording, deleteRecording, loadRecording, readSongPack, addHistory } from "./library.js"
import { importRecording } from "./audioimport.js"

const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]

window.addEventListener("error", e => showError(e.message))
window.addEventListener("unhandledrejection", e => showError(e.reason?.message || String(e.reason)))
function showError(msg) {
	console.error(msg)
	let el = $("#err")
	if (!el) {
		el = document.createElement("pre")
		el.id = "err"
		el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99;color:#ff6b8b;background:#000c;padding:8px;margin:0;font-size:12px;max-width:90vw;white-space:pre-wrap"
		document.body.appendChild(el)
	}
	el.textContent += msg + "\n"
}

// --- Persistence (best effort: private windows may block storage) ---------------
const store = {
	get(k, d) {
		try {
			const v = localStorage.getItem("keystage." + k)
			return v === null ? d : JSON.parse(v)
		} catch {
			return d
		}
	},
	set(k, v) {
		try {
			localStorage.setItem("keystage." + k, JSON.stringify(v))
			return true
		} catch {
			return false
		}
	}
}

const settings = Object.assign({ names: true, fingers: true, echo: false, noteSpeed: 1, offset: 0, micOffset: 0, mic: false, micEcho: true, crowd: !matchMedia("(pointer: coarse)").matches }, store.get("settings", {}))
const saveSettings = () => store.set("settings", settings)

const input = new Input()
const renderer = new Renderer($("#stage"), input, settings)
let game = null
let lastConfig = null

// --- Screens --------------------------------------------------------------------------
function show(name) {
	$$(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name))
	// In a game (no menu showing), offer pause and the Spotlight for touch screens.
	const playing = !!(name === "none" && game && !game.finished)
	document.body.classList.toggle("playing", playing)
	$("#corner").hidden = !playing && name !== "title"
	$("#btn-pause").hidden = !playing
	$("#btn-spot").hidden = !playing || game.mode === "watch"
}
$$("[data-goto]").forEach(b => b.addEventListener("click", () => show(b.dataset.goto)))

// --- MIDI status --------------------------------------------------------------------------
input.listen("devices", devs => {
	const el = $("#midi-status")
	if (input.micOn) {
		el.textContent = "🎤 Listening to your piano" + (devs.length ? " (MIDI works too)" : "")
		el.className = "pill ok"
	} else if (devs.length) {
		el.textContent = "🎹 " + devs.join(", ") + " connected"
		el.className = "pill ok"
	} else {
		el.textContent = input.midiError || "No MIDI keyboard found. Plug one in, or use your computer keyboard."
		el.className = "pill warn"
	}
})

// --- Microphone ----------------------------------------------------------------------------
async function setMic(on) {
	const btn = $("#btn-mic")
	try {
		if (on) {
			btn.disabled = true
			btn.textContent = "🎤 Allow the microphone…"
			await input.enableMic({ cancelEcho: settings.micEcho })
		} else input.disableMic()
		settings.mic = on
		saveSettings()
	} catch (e) {
		showMicError(e)
	}
	btn.disabled = false
	btn.textContent = input.micOn ? "Stop microphone" : "🎤 No MIDI? Use a microphone"
	$("#mic-meter").hidden = !input.micOn
	$("#mic-heard").textContent = input.micOn ? "play a note…" : ""
}
function showMicError(e) {
	const el = $("#midi-status")
	el.textContent = e.name === "NotAllowedError" ? "Microphone blocked. Allow it in the address bar's site settings." : e.name === "NotFoundError" ? "No microphone found." : "Microphone problem: " + e.message
	el.className = "pill warn"
}
$("#btn-mic").onclick = () => setMic(!input.micOn)
input.listen("mic", level => ($("#mic-meter > div").style.width = Math.round(level * 100) + "%"))
const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
let heard = []
input.listen("on", p => {
	if (!input.micOn || game) return
	heard = [...heard.slice(-4), NAMES[p % 12] + (Math.floor(p / 12) - 1)]
	$("#mic-heard").textContent = "heard " + heard.join(" ")
})
// Turn the microphone back on after a reload (browsers need a click before audio can start).
if (settings.mic) window.addEventListener("pointerdown", () => !input.micOn && setMic(true), { once: true, capture: true })

$("#btn-play").onclick = () => {
	audio.ensure()
	renderSongList()
	show("songs")
}
$("#btn-calibrate").onclick = () => {
	$("#cal-mic").hidden = !input.micOn
	show("calibrate")
}

// --- Settings ----------------------------------------------------------------------------
$("#btn-settings").onclick = () => {
	$("#set-names").checked = settings.names
	$("#set-fingers").checked = settings.fingers
	$("#set-echo").checked = settings.echo
	$("#set-notespeed").value = settings.noteSpeed
	$("#set-offset").value = Math.round(settings[input.offsetKey])
	$("#set-micecho").checked = settings.micEcho
	$("#set-crowd").checked = settings.crowd
	show("settings")
}
$("#set-names").onchange = e => ((settings.names = e.target.checked), saveSettings())
$("#set-fingers").onchange = e => ((settings.fingers = e.target.checked), saveSettings())
$("#set-crowd").onchange = e => ((settings.crowd = e.target.checked), saveSettings())
$("#set-echo").onchange = e => ((settings.echo = e.target.checked), saveSettings())
$("#set-notespeed").oninput = e => ((settings.noteSpeed = +e.target.value), saveSettings())
$("#set-offset").onchange = e => ((settings[input.offsetKey] = +e.target.value || 0), saveSettings())
$("#set-micecho").onchange = async e => {
	settings.micEcho = e.target.checked
	saveSettings()
	if (input.micOn) {
		input.disableMic()
		await setMic(true)
	}
}

// --- Song library ------------------------------------------------------------------------
let library = [] // imported songs
function loadLibrary() {
	library = []
	for (const entry of store.get("library", [])) {
		try {
			const parsed = parseMidi(b64ToBuf(entry.b64))
			library.push(songFromMidi(parsed, entry))
		} catch (e) {
			console.warn("Could not load", entry.title, e)
		}
	}
}
loadLibrary()
let recordings = [] // songs made from real recordings (IndexedDB)
const loadRecordings = async () => (recordings = await loadRecordingSongs())
loadRecordings().then(() => $("#screen-songs").classList.contains("active") && renderSongList())
const allSongs = () => [...SONGS, ...library, ...recordings]

const sel = Object.assign({ song: "mary", mode: "perform", hands: "R", speed: 1, arr: "full", genre: "all" }, store.get("sel", {}))
const inGenre = s => sel.genre === "all" || (sel.genre === "mine" ? !s.builtin : (s.genre || []).includes(sel.genre))
const best = store.get("best", {})

function renderSongList() {
	const list = $("#song-list")
	list.innerHTML = ""
	if (!allSongs().some(s => s.id === sel.song)) sel.song = SONGS[0].id
	const shown = allSongs()
		.filter(inGenre)
		.sort((a, b) => !!a.builtin === !!b.builtin ? (a.level || 0) - (b.level || 0) : a.builtin ? -1 : 1)
	if (!shown.length) list.innerHTML = `<p class="hint">${sel.genre === "mine" ? "Songs you import show up here. Try 🔎 Find songs." : "No songs here yet."}</p>`
	for (const s of shown) {
		const card = document.createElement("button")
		card.className = "song-card" + (s.id === sel.song ? " on" : "")
		const b = best[s.id]
		const stars = s.level ? "★".repeat(s.level) + "☆".repeat(5 - s.level) : s.recording ? "🎧 real recording" : "♫ imported"
		card.innerHTML = `<div class="t"></div><div class="a"></div><div class="d">${stars}</div><div class="b"></div>`
		card.querySelector(".t").textContent = s.title
		card.querySelector(".a").textContent = s.builtin ? `${s.artist} · ${s.blurb}` : s.blurb
		card.querySelector(".b").textContent = b ? `Best: ${"★".repeat(b.stars)} ${b.score.toLocaleString()}` : "Not played yet"
		if (!s.builtin) {
			const del = document.createElement("span")
			del.className = "del"
			del.textContent = "×"
			del.title = "Remove from setlist"
			del.onclick = e => {
				e.stopPropagation()
				if (!confirm(`Remove "${s.title}" from your setlist?`)) return
				if (s.recId) {
					deleteRecording(s.recId).then(loadRecordings).then(renderSongList)
					return
				}
				store.set("library", store.get("library", []).filter(x => x.id !== s.id))
				loadLibrary()
				renderSongList()
			}
			card.appendChild(del)
		}
		card.onclick = () => {
			sel.song = s.id
			renderSongList()
		}
		list.appendChild(card)
	}
	syncOptions()
}

function currentSong() {
	return allSongs().find(s => s.id === sel.song) || SONGS[0]
}

function syncOptions() {
	const song = currentSong()
	if (!song.hands.includes(sel.hands) && !(sel.hands === "both" && song.hands.length === 2)) sel.hands = song.hands[0]
	for (const [id, key] of [["#opt-mode", "mode"], ["#opt-hands", "hands"], ["#opt-speed", "speed"], ["#opt-arr", "arr"], ["#opt-genre", "genre"]]) {
		$$(id + " button").forEach(b => {
			b.classList.toggle("on", String(sel[key]) === b.dataset.v)
			if (key === "hands") b.disabled = b.dataset.v === "both" ? song.hands.length < 2 : !song.hands.includes(b.dataset.v)
		})
	}
	const other = sel.hands === "both" ? "" : ` The game plays your ${sel.hands === "R" ? "left" : "right"} hand for you.`
	$("#mode-desc").textContent =
		(sel.mode === "perform"
			? "Perform: the band keeps rocking. Hit notes on time to build your combo and win the crowd."
			: "Practice: the song waits for you at every note. No band, no pressure. Learn where your fingers go.") +
		(song.hands.length > 1 ? other : "")
	store.set("sel", sel)
}

for (const [id, key] of [["#opt-mode", "mode"], ["#opt-hands", "hands"], ["#opt-speed", "speed"], ["#opt-arr", "arr"], ["#opt-genre", "genre"]]) {
	$$(id + " button").forEach(b =>
		b.addEventListener("click", () => {
			sel[key] = key === "speed" ? +b.dataset.v : b.dataset.v
			if (key === "genre") renderSongList()
			else syncOptions()
		})
	)
}

// --- Game lifecycle --------------------------------------------------------------------
let starting = false
async function startGame(mode = sel.mode) {
	if (starting) return
	audio.ensure()
	if (game) endGame()
	lastConfig = { mode, simplified: sel.arr === "simple" }
	const song = currentSong()
	let recording = null
	if (song.recording && mode !== "practice") {
		starting = true
		try {
			recording = await loadRecording(song, sel.speed, t => msg(t))
			msg("")
		} catch (e) {
			msg("Couldn't load that recording: " + e.message)
			return
		} finally {
			starting = false
		}
	}
	game = new Game({
		song,
		mode,
		hands: sel.hands,
		speed: sel.speed,
		simplified: sel.arr === "simple",
		settings,
		input,
		fx: renderer
	})
	game.onFinish = onFinish
	game.recording = recording
	renderer.setGame(game)
	game.start()
	show("none")
	if (matchMedia("(pointer: coarse)").matches && innerHeight > innerWidth) toast("Tip: turn your phone sideways for bigger keys.", 4000)
}

function endGame() {
	if (game) game.destroy()
	game = null
	renderer.setGame(null)
}

$("#btn-start").onclick = () => startGame()
$("#btn-watch").onclick = () => startGame("watch")

function togglePause() {
	if (!game || game.finished) return
	if (game.paused) {
		show("none")
		game.resume()
	} else {
		game.pause()
		show("pause")
	}
}
window.addEventListener("keydown", e => e.key === "Escape" && togglePause())
$("#btn-pause").onclick = togglePause
$("#btn-spot").onclick = () => game?.activateOverdrive()

// --- Full screen ----------------------------------------------------------------------------
let toastTimer = 0
function toast(html, ms = 6000) {
	const el = $("#toast")
	el.innerHTML = html
	el.hidden = false
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => (el.hidden = true), ms)
}
$("#toast").onclick = () => ($("#toast").hidden = true)
const standalone = () => matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches || navigator.standalone
if (standalone()) $("#btn-fs").hidden = true
$("#btn-fs").onclick = async () => {
	const el = document.documentElement
	const fsEl = document.fullscreenElement || document.webkitFullscreenElement
	if (fsEl) return (document.exitFullscreen || document.webkitExitFullscreen).call(document)
	const req = el.requestFullscreen || el.webkitRequestFullscreen
	if (!req) {
		// iPhone Safari has no full-screen mode for pages; a home-screen app does.
		toast("For full screen on iPhone: tap <b>Share</b> then <b>Add to Home Screen</b>, and open Keystage from there.", 9000)
		return
	}
	try {
		await req.call(el, { navigationUI: "hide" })
		// Phones play best sideways; Android allows locking that in full screen.
		if (matchMedia("(pointer: coarse)").matches) await screen.orientation?.lock?.("landscape").catch(() => {})
	} catch {
		toast("Full screen isn't available here. Try your browser's menu, or add Keystage to your home screen.")
	}
}
document.addEventListener("fullscreenchange", () => ($("#btn-fs").textContent = document.fullscreenElement ? "✕" : "⛶"))

// --- Touch the on-screen keys to play ---------------------------------------------------------
const touches = new Map() // pointerId -> pitch
$("#stage").addEventListener("pointerdown", e => {
	const p = renderer.keyAt(e.clientX, e.clientY)
	if (p === null || !game || game.mode === "watch") return
	e.preventDefault()
	audio.ensure()
	touches.set(e.pointerId, p)
	if (!settings.echo) audio.piano(audio.now, p, 0.6, 0.7, audio.keys)
	input.noteOn(p, 0.7, e.timeStamp)
})
const lift = e => {
	const p = touches.get(e.pointerId)
	if (p === undefined) return
	touches.delete(e.pointerId)
	input.noteOff(p, e.timeStamp)
}
$("#stage").addEventListener("pointerup", lift)
$("#stage").addEventListener("pointercancel", lift)
window.addEventListener("blur", () => {
	if (game && !game.finished && !game.paused && game.mode === "perform") {
		game.pause()
		show("pause")
	}
})
$("#btn-resume").onclick = () => {
	show("none")
	game.resume()
}
$("#btn-restart").onclick = () => startGame(lastConfig.mode)
$("#btn-quit").onclick = () => {
	endGame()
	renderSongList()
	show("songs")
}

function onFinish(r) {
	const g = game
	if (g.mode === "watch") {
		endGame()
		renderSongList()
		show("songs")
		return
	}
	const song = g.song
	addHistory({
		at: new Date().toISOString(),
		song: song.id,
		title: song.title,
		mode: g.mode,
		hands: g.hands,
		speed: g.speed,
		simplified: lastConfig.simplified,
		score: r.score,
		accuracy: Math.round(r.accuracy * 1000) / 1000,
		stars: r.stars,
		maxCombo: r.maxCombo,
		counts: r.counts,
		tendency: r.tendency,
		weak: r.weak,
		octaveSlips: r.octaveSlips
	})
	$("#res-title").textContent = g.mode === "practice" ? "Practice complete" : r.stars >= 4 ? "ENCORE!" : r.stars >= 3 ? "Great show!" : "Show's over"
	$("#res-stars").innerHTML = [1, 2, 3, 4, 5].map(i => `<span class="s${i <= r.stars ? " lit" : ""}" style="animation-delay:${i * 0.15}s">★</span>`).join("")
	$("#res-score").textContent = g.mode === "practice" ? Math.round(r.accuracy * 100) + "% first try" : r.score.toLocaleString()

	let isBest = false
	if (g.mode === "perform") {
		const prev = best[song.id]
		if (!prev || r.score > prev.score) {
			best[song.id] = { score: r.score, stars: Math.max(r.stars, prev?.stars || 0) }
			store.set("best", best)
			isBest = !!prev || r.score > 0
		}
	}
	$("#res-best").classList.toggle("show", isBest)

	const c = r.counts
	const rows =
		g.mode === "practice"
			? [["Notes", r.total], ["First try", c.perfect], ["Needed a retry", c.good], ["Wrong keys", c.extra]]
			: [["Accuracy", Math.round(r.accuracy * 100) + "%"], ["Best streak", r.maxCombo], ["Perfect", c.perfect], ["Great", c.great], ["Good", c.good], ["Missed", c.miss], ["Wrong keys", c.extra], ["Speed", Math.round(g.speed * 100) + "%"]]
	$("#res-grid").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join("")

	const tips = []
	if (g.mode === "perform" && r.accuracy < 0.6) tips.push("Tough one! Try Practice mode, or drop the speed to 70%.")
	if (r.tendency === "early") tips.push("You're rushing a little. Listen to the drums and let the notes come to you.")
	if (r.tendency === "late") tips.push("You're a bit behind the beat. If it feels right to you, run Calibrate.")
	if (r.octaveSlips >= 3) tips.push(`${r.octaveSlips} notes were in the wrong octave. Middle C is the C nearest the middle of your keyboard (often under the brand name).`)
	if (r.weak.length) tips.push(`Trickiest keys: ${r.weak.join(", ")}.`)
	if (r.accuracy >= 0.9 && g.speed < 1) tips.push(`You've got this at ${Math.round(g.speed * 100)}%. Try it faster!`)
	if (g.mode === "practice" && r.accuracy >= 0.85) tips.push("You know the notes. Time to Perform it!")
	if (r.stars === 5 && g.mode === "perform" && g.speed >= 1) tips.push("Flawless. Try both hands next!")
	$("#res-tip").textContent = tips.slice(0, 2).join(" ")
	show("results")
}
$("#btn-res-retry").onclick = () => startGame(lastConfig.mode)
$("#btn-res-songs").onclick = () => {
	endGame()
	renderSongList()
	show("songs")
}

// --- Import ------------------------------------------------------------------------------
function bufToB64(buf) {
	let s = ""
	const b = new Uint8Array(buf)
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
	return btoa(s)
}
function b64ToBuf(b64) {
	const s = atob(b64)
	const b = new Uint8Array(s.length)
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
	return b.buffer
}
const isMidi = buf => buf.byteLength > 14 && new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === "MThd"
const msg = t => ($("#import-msg").textContent = t)

let pending = null // { buf, parsed, title, chosen:Set }

function openPartPicker(buf, title) {
	let parsed
	try {
		parsed = parseMidi(buf)
	} catch (e) {
		msg("That file doesn't look like a valid MIDI file: " + e.message)
		return
	}
	if (!parsed.parts.length) return msg("That MIDI file has no notes.")
	pending = { buf, parsed, chosen: new Set(defaultPlayerParts(parsed)) }
	$("#imp-title").textContent = "Choose your part"
	$("#imp-links").innerHTML = ""
	$("#imp-parts-wrap").style.display = ""
	$("#btn-imp-save").style.display = ""
	$("#imp-name").value = title.replace(/\.(mid|midi)$/i, "").replace(/[_-]+/g, " ").trim()
	renderParts()
	show("import")
}

function renderParts() {
	const box = $("#imp-parts")
	box.innerHTML = ""
	for (const p of pending.parsed.parts) {
		const b = document.createElement("button")
		b.className = "pick" + (pending.chosen.has(p.id) ? " on" : "")
		const lo = Math.min(...p.notes.map(n => n.p)), hi = Math.max(...p.notes.map(n => n.p))
		b.innerHTML = `<span class="word"></span><span class="meta"></span>`
		b.querySelector(".word").textContent = (pending.chosen.has(p.id) ? "🎹 " : "") + p.label
		b.querySelector(".meta").textContent = p.drums ? `${p.notes.length} hits · band` : `${p.instrument} · ${p.notes.length} notes · ${lo}–${hi}`
		b.disabled = p.drums
		b.onclick = () => {
			if (pending.chosen.has(p.id)) pending.chosen.delete(p.id)
			else {
				if (pending.chosen.size >= 2) pending.chosen.delete([...pending.chosen][0])
				pending.chosen.add(p.id)
			}
			renderParts()
		}
		box.appendChild(b)
	}
}

$("#btn-imp-cancel").onclick = () => {
	pending = null
	show("songs")
}
$("#btn-imp-save").onclick = () => {
	if (!pending || !pending.chosen.size) return
	const entry = { id: "imp-" + Date.now().toString(36), title: $("#imp-name").value.trim() || "Imported song", b64: bufToB64(pending.buf), playerParts: [...pending.chosen] }
	try {
		songFromMidi(pending.parsed, entry) // validate
	} catch (e) {
		return alert(e.message)
	}
	const lib = store.get("library", [])
	lib.push(entry)
	if (!store.set("library", lib)) msg("Couldn't save to your browser's storage, so it will only last this session.")
	else msg(`Added "${entry.title}".`)
	loadLibrary()
	if (!library.some(s => s.id === entry.id)) library.push(songFromMidi(pending.parsed, entry))
	sel.song = entry.id
	pending = null
	renderSongList()
	show("songs")
}

$("#btn-import-file").onclick = () => $("#import-file").click()
$("#import-file").onchange = async e => {
	const f = e.target.files[0]
	e.target.value = ""
	if (f) importFile(f)
}

const isAudio = f => /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm)$/i.test(f.name) || (/^audio\//.test(f.type) && !/midi/.test(f.type))

async function importFile(f) {
	if (/\.keystage$/i.test(f.name)) return importPack(f)
	// Trust the contents over the name or type (Windows calls .mid files "audio/mid").
	const head = new Uint8Array(await f.slice(0, 4).arrayBuffer())
	const isMidi = String.fromCharCode(...head) === "MThd" || /\.(mid|midi|kar)$/i.test(f.name)
	if (!isMidi && isAudio(f)) return openRecordingImport(f)
	openPartPicker(await f.arrayBuffer(), f.name)
}

// --- Import a recording ------------------------------------------------------------------------
let recJob = null // { file, abort }
function openRecordingImport(file) {
	recJob = { file, abort: null }
	$("#rec-file").textContent = file.name
	$("#rec-title").value = file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim()
	$("#rec-artist").value = ""
	$("#rec-form").style.display = ""
	$("#rec-progress").style.display = "none"
	$("#btn-rec-go").disabled = false
	show("recording")
}
$("#btn-rec-cancel").onclick = () => {
	recJob?.abort?.abort()
	recJob = null
	show("songs")
}
$("#btn-rec-go").onclick = async () => {
	if (!recJob || recJob.abort) return
	const job = recJob
	job.abort = new AbortController()
	$("#rec-form").style.display = "none"
	$("#rec-progress").style.display = ""
	$("#btn-rec-go").disabled = true
	const started = performance.now()
	try {
		const entry = await importRecording(job.file, {
			title: $("#rec-title").value.trim(),
			artist: $("#rec-artist").value.trim(),
			solo: $("#rec-solo").checked,
			signal: job.abort.signal,
			onStatus: ({ pct, msg: m }) => {
				$("#rec-bar").style.width = Math.round(pct * 100) + "%"
				$("#rec-msg").textContent = m
			}
		})
		await saveRecording(entry)
		await loadRecordings()
		sel.song = "rec-" + entry.id
		sel.genre = "all"
		msg(`Added "${entry.title}": ${entry.notes.length} notes at about ${Math.round(entry.bpm)} BPM, made in ${Math.round((performance.now() - started) / 1000)}s. Try Watch it first!`)
		recJob = null
		renderSongList()
		show("songs")
	} catch (e) {
		if (e.name === "AbortError") return
		$("#rec-msg").textContent = "That didn't work: " + e.message
		$("#btn-rec-go").disabled = false
		job.abort = null
	}
}

async function importPack(f) {
	msg("Reading song pack…")
	try {
		const entry = await readSongPack(f)
		await saveRecording(entry)
		await loadRecordings()
		sel.song = "rec-" + entry.id
		msg(`Added "${entry.title}" with its real recording.`)
	} catch (e) {
		msg("Couldn't add that song pack: " + e.message)
	}
	renderSongList()
	show("songs")
}

// --- Find songs on other sites ------------------------------------------------------------------
// All free without an account. Sites without a search page are searched through DuckDuckGo.
const site = (domain, extra = "") => q => `https://duckduckgo.com/?q=${encodeURIComponent(`site:${domain} ${extra}`)}+${q}`
const SOURCES = [
	["BitMidi", "Over 100,000 MIDI files: pop, rock, games, TV.", q => `https://bitmidi.com/search?q=${q}`],
	["FreeMIDI", "Pop and rock hits, sorted by artist.", site("freemidi.org")],
	["Online Sequencer", "Fan-made versions of pop, film and game music. Click Download → MIDI.", site("onlinesequencer.net")],
	["MIDIWorld", "Classic rock, pop and classical.", site("midiworld.com")],
	["Mutopia Project", "Free classical sheet music, each with a MIDI file.", site("mutopiaproject.org")],
	["piano-midi.de", "Classical piano with each hand on its own track.", () => "https://www.piano-midi.de/midicoll.htm"]
]
function renderSources() {
	const q = encodeURIComponent($("#find-q").value.trim())
	const box = $("#find-sources")
	box.innerHTML = ""
	for (const [name, about, url] of SOURCES) {
		const a = document.createElement("a")
		a.className = "pick"
		a.href = url(q)
		a.target = "_blank"
		a.rel = "noopener"
		a.innerHTML = `<span class="word"></span><span class="meta"></span>`
		a.querySelector(".word").textContent = name + " ↗"
		a.querySelector(".meta").textContent = about
		box.appendChild(a)
	}
}
$("#btn-find").onclick = () => {
	renderSources()
	show("find")
	$("#find-q").focus()
}
$("#find-q").oninput = renderSources

async function fetchBytes(url) {
	try {
		const r = await fetch(url)
		if (r.ok) return { buf: await r.arrayBuffer(), type: r.headers.get("content-type") || "", final: r.url || url }
	} catch {
		/* probably CORS: fall through to the local proxy */
	}
	// Only the local test server has this proxy; on a static host, sites that block cross-site downloads can't be fetched.
	const r = await fetch("/fetch?url=" + encodeURIComponent(url)).catch(() => null)
	if (!r || r.status === 404 || r.status === 405) throw new Error("that site doesn't allow it. Download the file and drop it here instead.")
	if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`)
	return { buf: await r.arrayBuffer(), type: r.headers.get("content-type") || "", final: r.headers.get("x-final-url") || url }
}

async function importUrl(url) {
	url = url.trim()
	if (!/^https?:\/\//i.test(url)) return msg("Paste a full link starting with http:// or https://")
	msg("Fetching…")
	let res
	try {
		res = await fetchBytes(url)
	} catch (e) {
		return msg("Couldn't fetch that link: " + e.message)
	}
	if (isMidi(res.buf)) {
		msg("")
		return openPartPicker(res.buf, decodeURIComponent(new URL(res.final).pathname.split("/").pop() || "Imported"))
	}
	// A web page: look for links to MIDI files on it.
	const html = new TextDecoder().decode(res.buf)
	const found = new Map()
	for (const m of html.matchAll(/(?:href|src|data-url)\s*=\s*["']([^"']+?\.midi?(?:\?[^"']*)?)["']/gi)) {
		try {
			const abs = new URL(m[1].replace(/&amp;/g, "&"), res.final).href
			found.set(abs, decodeURIComponent(abs.split("/").pop().split("?")[0]))
		} catch {}
	}
	if (!found.size) return msg("No MIDI file at that link, and no links to .mid files on that page. Try the direct download link.")
	msg("")
	$("#imp-title").textContent = `Found ${found.size} MIDI file${found.size > 1 ? "s" : ""}`
	$("#imp-parts-wrap").style.display = "none"
	$("#btn-imp-save").style.display = "none"
	const box = $("#imp-links")
	box.innerHTML = ""
	for (const [href, name] of found) {
		const b = document.createElement("button")
		b.className = "pick"
		b.innerHTML = `<span class="word"></span>`
		b.querySelector(".word").textContent = name
		b.title = href
		b.onclick = () => {
			show("songs")
			importUrl(href)
		}
		box.appendChild(b)
	}
	show("import")
}
$("#btn-import-url").onclick = () => importUrl($("#import-url").value)
$("#import-url").addEventListener("keydown", e => e.key === "Enter" && importUrl(e.target.value))

// drag & drop anywhere outside gameplay
let dragDepth = 0
window.addEventListener("dragenter", e => {
	if (game) return
	e.preventDefault()
	dragDepth++
	$("#drop-hint").classList.add("show")
})
window.addEventListener("dragleave", () => {
	if (--dragDepth <= 0) $("#drop-hint").classList.remove("show")
})
window.addEventListener("dragover", e => e.preventDefault())
window.addEventListener("drop", async e => {
	e.preventDefault()
	dragDepth = 0
	$("#drop-hint").classList.remove("show")
	if (game) return
	const f = [...e.dataTransfer.files].find(f => /\.(midi?|keystage)$/i.test(f.name)) || e.dataTransfer.files[0]
	if (f) {
		renderSongList()
		importFile(f)
		return
	}
	const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")
	if (url) {
		renderSongList()
		show("songs")
		importUrl(url.split("\n")[0])
	}
})

// --- Calibration ----------------------------------------------------------------------------
$("#btn-cal-start").onclick = () => {
	audio.ensure()
	const bpm = 100
	const beat = 60 / bpm
	const N = 16
	const map = audio.clockMap()
	const t0 = audio.now + 0.8
	const clicks = []
	for (let i = 0; i < N; i++) {
		const ct = t0 + i * beat
		audio.click(ct, i % 4 === 0, audio.sfx)
		const perf = map.perfT + (ct - map.ctxT) * 1000
		clicks.push(perf)
		setTimeout(() => {
			$("#cal-pulse").classList.add("beat")
			setTimeout(() => $("#cal-pulse").classList.remove("beat"), 90)
		}, perf - performance.now())
	}
	const taps = []
	const off = input.listen("on", (p, v, ts) => taps.push(ts))
	$("#cal-result").textContent = "Listen… tap along"
	$("#btn-cal-start").disabled = true
	setTimeout(() => {
		off()
		$("#btn-cal-start").disabled = false
		const diffs = []
		for (const tap of taps) {
			let bestD = Infinity
			clicks.forEach((c, i) => {
				if (i >= 4 && Math.abs(tap - c) < Math.abs(bestD)) bestD = tap - c
			})
			if (Math.abs(bestD) < 250) diffs.push(bestD)
		}
		if (diffs.length < 6) {
			$("#cal-result").textContent = "Not enough taps caught. Try again!"
			return
		}
		diffs.sort((a, b) => a - b)
		const med = diffs[Math.floor(diffs.length / 2)]
		const spread = diffs[Math.floor(diffs.length * 0.8)] - diffs[Math.floor(diffs.length * 0.2)]
		settings[input.offsetKey] = Math.round(med)
		saveSettings()
		$("#cal-result").textContent = `Offset set to ${settings[input.offsetKey]} ms` + (spread > 60 ? " (taps were uneven, so maybe run it again)" : " ✓")
	}, clicks[N - 1] - performance.now() + 700)
}

// --- Main loop ------------------------------------------------------------------------------
function frame() {
	const now = performance.now()
	if (game) game.update(now)
	renderer.frame(now)
	requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// ?watch=<songId> jumps straight into watch mode (handy for demos and testing)
const params = new URLSearchParams(location.search)
if (params.get("watch")) {
	sel.song = params.get("watch")
	sel.hands = "both"
	startGame("watch")
}
