import { isBlack, noteName } from "./songs.js"

const COLORS = {
	R: "#35d6ff",
	L: "#ff4fd8",
	star: "#ffd23a",
	od: "#b8f8ff",
	miss: "#ff2d55",
	perfect: "#ffffff",
	great: "#7dffb0",
	good: "#ffd23a"
}
const RAIL = ["#8fb4ff", "#8fb4ff", "#3aff9a", "#ffd23a", "#ff3fa4"]
const PALETTES = [
	["#ff3fa4", "#3ad7ff"],
	["#a64bff", "#ffd23a"],
	["#3aff9a", "#ff3fa4"],
	["#ff7a2f", "#a64bff"]
]
const LOOK = 2.3 // seconds of real time visible on the highway at note speed 1
const DEPTH = 2.6 // perspective strength

function hexA(hex, a) {
	const n = parseInt(hex.slice(1), 16)
	return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
}

const glowCache = new Map()
function glow(color) {
	if (glowCache.has(color)) return glowCache.get(color)
	const c = document.createElement("canvas")
	c.width = c.height = 64
	const g = c.getContext("2d")
	const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
	grd.addColorStop(0, hexA(color, 1))
	grd.addColorStop(0.25, hexA(color, 0.55))
	grd.addColorStop(1, hexA(color, 0))
	g.fillStyle = grd
	g.fillRect(0, 0, 64, 64)
	glowCache.set(color, c)
	return c
}

const rand = (a, b) => a + Math.random() * (b - a)

export class Renderer {
	constructor(canvas, input, settings) {
		this.canvas = canvas
		this.ctx = canvas.getContext("2d")
		this.input = input
		this.settings = settings
		this.game = null
		this.particles = []
		this.popups = []
		this.banners = []
		this.keyFx = {} // p -> {color, t, wrong}
		this.shake = 0
		this.flash = 0
		this.flashColor = "#ffffff"
		this.pyro = { L: 0, R: 0 }
		this.judgement = null
		this.crowdIdle = 0.55
		this.makeCrowd()
		this.resize()
		window.addEventListener("resize", () => this.resize())
	}

	resize() {
		const dpr = Math.min(2, window.devicePixelRatio || 1)
		this.W = window.innerWidth
		this.H = window.innerHeight
		this.canvas.width = Math.round(this.W * dpr)
		this.canvas.height = Math.round(this.H * dpr)
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		this.dpr = dpr
		if (this.game) this.layout()
	}

	makeCrowd() {
		this.people = []
		for (let row = 0; row < 4; row++) {
			const n = 26 + row * 6
			for (let i = 0; i < n; i++) {
				this.people.push({
					row,
					x: (i + rand(-0.35, 0.35)) / (n - 1),
					h: rand(0.85, 1.15),
					w: rand(0.85, 1.2),
					phase: rand(0, 1),
					arms: Math.random(),
					phone: Math.random() < 0.25
				})
			}
		}
	}

	setGame(game) {
		this.game = game
		this.particles = []
		this.popups = []
		this.banners = []
		this.keyFx = {}
		this.judgement = null
		if (game) this.layout()
	}

	layout() {
		const { song } = this.game
		const { W, H } = this
		let lo = Math.max(21, song.lo - 2)
		let hi = Math.min(108, song.hi + 2)
		while (isBlack(lo)) lo--
		while (isBlack(hi)) hi++
		let whites = []
		const count = () => {
			whites = []
			for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites.push(p)
		}
		count()
		while (whites.length < 15) {
			if (whites.length % 2) lo = isBlack(lo - 1) ? lo - 2 : lo - 1
			else hi = isBlack(hi + 1) ? hi + 2 : hi + 1
			count()
		}
		this.lo = lo
		this.hi = hi
		this.whites = whites
		const kbW = Math.min(W * 0.94, whites.length * 64)
		this.kbX = (W - kbW) / 2
		this.kbW = kbW
		this.whiteW = kbW / whites.length
		this.hitY = Math.round(H * 0.8)
		this.kbH = Math.min(H - this.hitY, this.whiteW * 5.5)
		this.farY = H * 0.29
		const sFar = 1 / (1 + DEPTH)
		this.vpY = (this.farY - sFar * this.hitY) / (1 - sFar)
		this.cx = W / 2
		this.whiteIdx = {}
		whites.forEach((p, i) => (this.whiteIdx[p] = i))
	}

	keyX(p) {
		if (!isBlack(p)) return this.kbX + (this.whiteIdx[p] + 0.5) * this.whiteW
		return this.kbX + (this.whiteIdx[p - 1] + 1) * this.whiteW
	}

	keyW(p) {
		return isBlack(p) ? this.whiteW * 0.62 : this.whiteW
	}

	get look() {
		return LOOK / this.settings.noteSpeed
	}

	// z = real seconds until the note reaches the strike line
	proj(z) {
		const s = 1 / (1 + (z / this.look) * DEPTH)
		return { s, y: this.vpY + (this.hitY - this.vpY) * s }
	}

	px(x, s) {
		return this.cx + (x - this.cx) * s
	}

	// ---------------------------------------------------------------------------
	frame(now) {
		const ctx = this.ctx
		const { W, H } = this
		const g = this.game
		const time = now / 1000
		const dt = Math.min(0.05, this.lastTime ? time - this.lastTime : 0.016)
		this.lastTime = time

		// Musical clock for lights and crowd
		let beat, crowd, od
		if (g) {
			beat = g.st / g.song.beatSec - g.song.pickup
			crowd = g.crowd
			od = g.odActive
		} else {
			beat = time * 2
			crowd = this.crowdIdle
			od = false
		}
		const beatPhase = ((beat % 1) + 1) % 1
		const pulse = Math.exp(-beatPhase * 5)
		const bar = Math.floor(beat / (g ? g.song.beatsPerBar : 4))

		this.shake *= Math.pow(0.002, dt)
		this.flash *= Math.pow(0.02, dt)
		const sx = (Math.random() - 0.5) * this.shake
		const sy = (Math.random() - 0.5) * this.shake

		ctx.save()
		ctx.translate(sx, sy)
		this.drawStage(time, beat, beatPhase, pulse, bar, crowd, od)
		if (g) {
			this.drawHighway(g, pulse, od)
			this.drawNotes(g, time)
			this.drawKeyboard(g, time)
		}
		this.updatePyro(dt)
		this.drawParticles(dt)
		ctx.restore()

		if (this.flash > 0.01) {
			ctx.globalCompositeOperation = "lighter"
			ctx.fillStyle = hexA(this.flashColor, this.flash * 0.35)
			ctx.fillRect(0, 0, W, H)
			ctx.globalCompositeOperation = "source-over"
		}
		if (g) this.drawHUD(g, time, dt, pulse)
	}

	// --- Stage -------------------------------------------------------------------
	drawStage(time, beat, beatPhase, pulse, bar, crowd, od) {
		const ctx = this.ctx
		const { W, H } = this
		const u = H / 900

		const bg = ctx.createLinearGradient(0, 0, 0, H)
		bg.addColorStop(0, "#07020f")
		bg.addColorStop(0.35, "#160528")
		bg.addColorStop(0.5, "#0b0316")
		bg.addColorStop(1, "#040108")
		ctx.fillStyle = bg
		ctx.fillRect(-20, -20, W + 40, H + 40)

		const pal = od ? ["#b8f8ff", "#ffffff"] : PALETTES[((bar % PALETTES.length) + PALETTES.length) % PALETTES.length]
		const energy = 0.25 + crowd * 0.55 + pulse * 0.25 + (od ? 0.4 : 0)

		// LED wall with EQ bars
		const lx = W * 0.22, ly = H * 0.075, lw = W * 0.56, lh = H * 0.16
		ctx.fillStyle = "#0a0414"
		ctx.fillRect(lx, ly, lw, lh)
		const bars = 32
		ctx.globalCompositeOperation = "lighter"
		for (let i = 0; i < bars; i++) {
			const n = Math.sin(i * 1.7 + Math.floor(beat * 2) * 2.3) * 0.5 + 0.5
			const h = lh * (0.15 + 0.75 * n * (0.4 + 0.6 * pulse) * (0.5 + crowd * 0.5))
			const x = lx + (i / bars) * lw + 2
			const grd = ctx.createLinearGradient(0, ly + lh, 0, ly + lh - h)
			grd.addColorStop(0, hexA(pal[0], 0.55))
			grd.addColorStop(1, hexA(pal[1], 0.15))
			ctx.fillStyle = grd
			ctx.fillRect(x, ly + lh - h, lw / bars - 4, h)
		}
		ctx.globalCompositeOperation = "source-over"
		ctx.strokeStyle = "rgba(255,255,255,0.08)"
		ctx.strokeRect(lx, ly, lw, lh)

		// Truss
		const ty = H * 0.045
		ctx.fillStyle = "#1c1426"
		ctx.fillRect(0, ty - 5 * u, W, 10 * u)
		ctx.strokeStyle = "#2a2036"
		ctx.lineWidth = 1
		ctx.beginPath()
		for (let x = 0; x < W; x += 20 * u) {
			ctx.moveTo(x, ty - 5 * u)
			ctx.lineTo(x + 10 * u, ty + 5 * u)
		}
		ctx.stroke()

		// Beams
		ctx.globalCompositeOperation = "lighter"
		const fixtures = 7
		for (let i = 0; i < fixtures; i++) {
			const fx = W * (0.08 + (i / (fixtures - 1)) * 0.84)
			const col = pal[i % 2]
			const sweep = Math.sin(time * (0.5 + (i % 3) * 0.17) + i * 1.3) * 0.45 + (i - (fixtures - 1) / 2) * 0.06
			const strobe = od ? (beatPhase < 0.15 ? 1 : 0.35) : 1
			const a = Math.min(0.22, 0.06 * energy) * strobe
			const len = H * 0.75
			const ex = fx + Math.sin(sweep) * len
			const ey = ty + Math.cos(sweep) * len
			const half = W * 0.05 + 30 * u
			const nx = Math.cos(sweep) * half
			const ny = -Math.sin(sweep) * half
			const grd = ctx.createLinearGradient(fx, ty, ex, ey)
			grd.addColorStop(0, hexA(col, a * 2.2))
			grd.addColorStop(1, hexA(col, 0))
			ctx.fillStyle = grd
			ctx.beginPath()
			ctx.moveTo(fx - 4 * u, ty)
			ctx.lineTo(ex - nx, ey - ny)
			ctx.lineTo(ex + nx, ey + ny)
			ctx.lineTo(fx + 4 * u, ty)
			ctx.fill()
			const gs = (26 + 20 * pulse) * u
			ctx.globalAlpha = Math.min(1, 0.5 + energy * 0.4) * strobe
			ctx.drawImage(glow(col), fx - gs, ty - gs, gs * 2, gs * 2)
			ctx.globalAlpha = 1
		}

		// Haze near the crowd
		const haze = ctx.createLinearGradient(0, H * 0.22, 0, H * 0.5)
		haze.addColorStop(0, hexA(pal[0], 0))
		haze.addColorStop(0.5, hexA(pal[0], 0.05 + 0.05 * energy))
		haze.addColorStop(1, hexA(pal[1], 0))
		ctx.fillStyle = haze
		ctx.fillRect(0, H * 0.22, W, H * 0.28)
		ctx.globalCompositeOperation = "source-over"

		this.drawCrowd(beatPhase, pulse, crowd, pal, time)

		// Stage floor
		const fy = H * 0.455
		const floor = ctx.createLinearGradient(0, fy, 0, H)
		floor.addColorStop(0, "#120a1c")
		floor.addColorStop(1, "#050208")
		ctx.fillStyle = floor
		ctx.fillRect(-20, fy, W + 40, H - fy + 20)
		ctx.fillStyle = hexA(pal[1], 0.25 + 0.3 * pulse)
		ctx.fillRect(-20, fy, W + 40, 2 * u)

		// Speaker stacks
		for (const side of [0, 1]) {
			const sw = Math.max(60 * u, W * 0.075)
			const x = side ? W - sw : 0
			const top = H * 0.47
			ctx.fillStyle = "#0d0a12"
			ctx.fillRect(x, top, sw, H - top)
			ctx.strokeStyle = "#241b30"
			ctx.lineWidth = 2
			const cab = (H - top) / 3
			for (let k = 0; k < 3; k++) {
				const cy = top + cab * k
				ctx.strokeRect(x + 4, cy + 4, sw - 8, cab - 8)
				const r = Math.min(sw, cab) * 0.3 * (1 + 0.06 * pulse * (0.5 + crowd))
				ctx.beginPath()
				ctx.arc(x + sw / 2, cy + cab / 2, r, 0, Math.PI * 2)
				ctx.fillStyle = "#07050a"
				ctx.fill()
				ctx.stroke()
			}
		}
	}

	drawCrowd(beatPhase, pulse, crowd, pal, time) {
		const ctx = this.ctx
		const { W, H } = this
		const u = H / 900
		const jumpAmt = crowd * crowd * 14
		for (const p of this.people) {
			const s = (0.55 + p.row * 0.22) * u
			const baseY = H * (0.33 + p.row * 0.037)
			const x = p.x * W
			const bob = Math.abs(Math.sin(Math.PI * (beatPhase + p.phase * 0.25))) * jumpAmt * s + pulse * 2 * s
			const y = baseY - bob
			const bodyW = 22 * s * p.w
			const headR = 7.5 * s
			const bodyH = 30 * s * p.h
			ctx.fillStyle = `rgb(${5 + p.row * 3},${2 + p.row * 2},${10 + p.row * 4})`
			// arms
			const armsUp = p.arms < crowd - 0.35
			if (armsUp) {
				const lift = 18 * s + 6 * s * Math.sin(time * 6 + p.phase * 6)
				ctx.strokeStyle = ctx.fillStyle
				ctx.lineWidth = 4 * s
				ctx.lineCap = "round"
				ctx.beginPath()
				ctx.moveTo(x - bodyW * 0.4, y - bodyH * 0.75)
				ctx.lineTo(x - bodyW * 0.75, y - bodyH - lift)
				ctx.moveTo(x + bodyW * 0.4, y - bodyH * 0.75)
				ctx.lineTo(x + bodyW * 0.75, y - bodyH - lift)
				ctx.stroke()
				if (p.phone && crowd > 0.75) {
					ctx.globalCompositeOperation = "lighter"
					const gs = (6 + 3 * Math.sin(time * 3 + p.phase * 9)) * s
					ctx.drawImage(glow("#fff6d8"), x + bodyW * 0.75 - gs, y - bodyH - lift - gs, gs * 2, gs * 2)
					ctx.globalCompositeOperation = "source-over"
				}
			}
			ctx.beginPath()
			ctx.ellipse(x, y - bodyH * 0.4, bodyW / 2, bodyH * 0.6, 0, Math.PI, 0)
			ctx.lineTo(x + bodyW / 2, y + 40 * s)
			ctx.lineTo(x - bodyW / 2, y + 40 * s)
			ctx.fill()
			ctx.beginPath()
			ctx.arc(x, y - bodyH - headR * 0.6, headR, 0, Math.PI * 2)
			ctx.fill()
			// rim light from the stage
			ctx.strokeStyle = hexA(pal[p.row % 2], 0.18 + 0.25 * pulse * crowd)
			ctx.lineWidth = 1.2
			ctx.beginPath()
			ctx.arc(x, y - bodyH - headR * 0.6, headR, Math.PI * 1.1, Math.PI * 1.9)
			ctx.stroke()
		}
	}

	// --- Highway ---------------------------------------------------------------
	drawHighway(g, pulse, od) {
		const ctx = this.ctx
		const { kbX, kbW, hitY } = this
		const far = this.proj(this.look)
		const L0 = kbX, R0 = kbX + kbW
		const L1 = this.px(L0, far.s), R1 = this.px(R0, far.s)

		// surface
		const surf = ctx.createLinearGradient(0, far.y, 0, hitY)
		surf.addColorStop(0, "rgba(10,6,20,0.15)")
		surf.addColorStop(0.3, "rgba(12,8,26,0.78)")
		surf.addColorStop(1, "rgba(18,12,36,0.92)")
		ctx.fillStyle = surf
		ctx.beginPath()
		ctx.moveTo(L1, far.y)
		ctx.lineTo(R1, far.y)
		ctx.lineTo(R0, hitY)
		ctx.lineTo(L0, hitY)
		ctx.fill()

		// black key lanes slightly darker
		ctx.fillStyle = "rgba(0,0,0,0.28)"
		for (let p = this.lo; p <= this.hi; p++) {
			if (!isBlack(p)) continue
			const x = this.keyX(p), w = this.keyW(p) / 2
			ctx.beginPath()
			ctx.moveTo(this.px(x - w, far.s), far.y)
			ctx.lineTo(this.px(x + w, far.s), far.y)
			ctx.lineTo(x + w, hitY)
			ctx.lineTo(x - w, hitY)
			ctx.fill()
		}

		// lane separators
		ctx.lineWidth = 1
		for (let i = 0; i <= this.whites.length; i++) {
			const x = kbX + i * this.whiteW
			const p = this.whites[i]
			const strong = p !== undefined && (p % 12 === 0 || p % 12 === 5)
			ctx.strokeStyle = strong ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)"
			ctx.beginPath()
			ctx.moveTo(this.px(x, far.s), far.y)
			ctx.lineTo(x, hitY)
			ctx.stroke()
		}

		// beat lines scrolling toward you
		const { song, st, speed } = g
		const b0 = Math.ceil(st / song.beatSec - song.pickup)
		const b1 = (st + this.look * speed) / song.beatSec - song.pickup
		for (let b = b0; b <= b1; b++) {
			const t = (b + song.pickup) * song.beatSec
			const z = (t - st) / speed
			const { s, y } = this.proj(z)
			const isBar = ((b % song.beatsPerBar) + song.beatsPerBar) % song.beatsPerBar === 0
			ctx.strokeStyle = isBar ? `rgba(255,255,255,${0.22 * s})` : `rgba(255,255,255,${0.07 * s})`
			ctx.lineWidth = isBar ? 2.5 * s : 1
			ctx.beginPath()
			ctx.moveTo(this.px(L0, s), y)
			ctx.lineTo(this.px(R0, s), y)
			ctx.stroke()
		}

		// rails
		const mult = Math.min(4, 1 + Math.floor(g.combo / 10))
		const rail = od ? COLORS.od : RAIL[mult]
		ctx.globalCompositeOperation = "lighter"
		for (const [a, b] of [[L1, L0], [R1, R0]]) {
			for (const [w, al] of [[10, 0.08 + pulse * 0.08], [4, 0.25], [1.5, 0.9]]) {
				ctx.strokeStyle = hexA(rail, al)
				ctx.lineWidth = w
				ctx.beginPath()
				ctx.moveTo(a, far.y)
				ctx.lineTo(b, hitY)
				ctx.stroke()
			}
		}
		// strike line
		const sl = ctx.createLinearGradient(0, hitY - 18, 0, hitY + 4)
		sl.addColorStop(0, hexA(rail, 0))
		sl.addColorStop(1, hexA(rail, 0.35 + pulse * 0.25))
		ctx.fillStyle = sl
		ctx.fillRect(L0, hitY - 18, kbW, 22)
		ctx.globalCompositeOperation = "source-over"
	}

	noteColor(n, g) {
		if (n.judged === "miss") return COLORS.miss
		if (n.auto && g.mode !== "watch") return "#9a93b8"
		if (g.odActive) return COLORS.od
		if (n.star) return COLORS.star
		return COLORS[n.hand]
	}

	drawNotes(g, time) {
		const ctx = this.ctx
		const { st, speed, notes } = g
		const look = this.look
		this.hints = {}
		this.autoDown = {}

		// binary search: first note that could still be on screen
		let lo = 0, hi = notes.length
		const from = st - 10
		while (lo < hi) {
			const m = (lo + hi) >> 1
			if (notes[m].t < from) lo = m + 1
			else hi = m
		}
		const vis = []
		for (let i = lo; i < notes.length; i++) {
			const n = notes[i]
			if (n.t > st + look * speed) break
			if (n.t + n.d < st - 0.3 * speed) continue
			vis.push(n)
			if (n.auto && n.t <= st && st < n.t + n.d) this.autoDown[n.p] = this.noteColor(n, g)
		}

		const waitingIds = g.isWaitingNow() ? new Set(g.waiting.filter(n => !n.judged).map(n => n.id)) : null

		for (let i = vis.length - 1; i >= 0; i--) {
			const n = vis[i]
			const hitDone = n.judged && n.judged !== "miss" && n.judged !== "skip"
			if (hitDone && !n.holding) continue
			const color = this.noteColor(n, g)
			const missed = n.judged === "miss"
			const zHead = hitDone ? 0 : Math.max(missed ? -0.25 : 0, (n.t - st) / speed)
			const zTail = Math.min(look, (n.t + n.d - st) / speed)
			if (zTail < (missed ? -0.25 : 0)) continue
			const x = this.keyX(n.p)
			const w = this.keyW(n.p) * (isBlack(n.p) ? 0.95 : 0.84)
			const faded = n.auto && g.mode !== "watch"

			// sustain tail
			if (zTail - zHead > 0.08) {
				const a = this.proj(zHead), b = this.proj(zTail)
				const tw = w * 0.32
				ctx.fillStyle = hexA(color, n.holding ? 0.85 : faded ? 0.18 : missed ? 0.25 : 0.45)
				ctx.beginPath()
				ctx.moveTo(this.px(x - tw / 2, a.s), a.y)
				ctx.lineTo(this.px(x + tw / 2, a.s), a.y)
				ctx.lineTo(this.px(x + tw / 2, b.s), b.y)
				ctx.lineTo(this.px(x - tw / 2, b.s), b.y)
				ctx.fill()
				if (n.holding) {
					ctx.globalCompositeOperation = "lighter"
					ctx.fillStyle = hexA(color, 0.3 + 0.2 * Math.sin(time * 30))
					ctx.fill()
					ctx.globalCompositeOperation = "source-over"
				}
			}
			if (hitDone) continue

			// gem head
			const a = this.proj(zHead), b = this.proj(zHead + 0.075)
			const xl0 = this.px(x - w / 2, a.s), xr0 = this.px(x + w / 2, a.s)
			const xl1 = this.px(x - w / 2, b.s), xr1 = this.px(x + w / 2, b.s)
			const headW = xr0 - xl0

			if (!faded && !missed) {
				ctx.globalCompositeOperation = "lighter"
				ctx.globalAlpha = 0.55
				const gs = headW * 1.1
				ctx.drawImage(glow(color), (xl0 + xr0) / 2 - gs, (a.y + b.y) / 2 - gs * 0.6, gs * 2, gs * 1.2)
				ctx.globalAlpha = 1
				ctx.globalCompositeOperation = "source-over"
			}
			const body = ctx.createLinearGradient(0, b.y, 0, a.y)
			body.addColorStop(0, hexA(color, faded ? 0.25 : 1))
			body.addColorStop(1, hexA(color, faded ? 0.15 : 0.7))
			ctx.fillStyle = missed ? hexA(COLORS.miss, 0.35) : body
			ctx.beginPath()
			ctx.moveTo(xl1, b.y)
			ctx.lineTo(xr1, b.y)
			ctx.lineTo(xr0, a.y)
			ctx.lineTo(xl0, a.y)
			ctx.closePath()
			ctx.fill()
			if (!faded && !missed) {
				ctx.strokeStyle = "rgba(255,255,255,0.85)"
				ctx.lineWidth = Math.max(1, 2 * a.s)
				ctx.beginPath()
				ctx.moveTo(xl1, b.y)
				ctx.lineTo(xr1, b.y)
				ctx.stroke()
				if (n.star) {
					ctx.globalCompositeOperation = "lighter"
					const sp = 0.5 + 0.5 * Math.sin(time * 9 + n.id)
					ctx.globalAlpha = sp
					const gs = headW * 0.35
					ctx.drawImage(glow("#ffffff"), (xl0 + xr0) / 2 - gs, b.y - gs, gs * 2, gs * 2)
					ctx.globalAlpha = 1
					ctx.globalCompositeOperation = "source-over"
				}
			}

			// labels
			const fs = Math.min(22, headW * 0.42)
			if (!faded && !missed && fs >= 8) {
				if (this.settings.names) {
					ctx.fillStyle = "rgba(8,4,16,0.85)"
					ctx.font = `800 ${fs}px Segoe UI, sans-serif`
					ctx.textAlign = "center"
					ctx.textBaseline = "middle"
					ctx.fillText(noteName(n.p), (xl0 + xr0) / 2, (a.y + b.y) / 2 + 1)
				}
				const tag = this.noteTag(n, g)
				if (tag) {
					const r = fs * 0.55
					const fx = (xl1 + xr1) / 2, fy = b.y - r - 3 * a.s
					ctx.fillStyle = "rgba(8,4,16,0.8)"
					ctx.beginPath()
					ctx.arc(fx, fy, r, 0, Math.PI * 2)
					ctx.fill()
					ctx.strokeStyle = color
					ctx.lineWidth = 1.5
					ctx.stroke()
					ctx.fillStyle = "#fff"
					ctx.font = `700 ${r * (tag.length > 1 ? 0.95 : 1.3)}px Segoe UI, sans-serif`
					ctx.textAlign = "center"
					ctx.textBaseline = "middle"
					ctx.fillText(tag, fx, fy + 1)
				}
			}

			// approaching notes light up their key
			if (!n.auto && !missed) {
				const near = 1 - zHead / 0.7
				if (near > 0 && (!this.hints[n.p] || this.hints[n.p].v < near)) this.hints[n.p] = { v: near, color, tag: this.noteTag(n, g) }
			}
		}

		if (waitingIds) {
			for (const n of g.waiting) if (!n.judged) this.hints[n.p] = { v: 0.6 + 0.4 * Math.sin(time * 8), color: this.noteColor(n, g), tag: this.noteTag(n, g), wait: true }
		}
	}

	// --- Keyboard ------------------------------------------------------------------
	drawKeyboard(g, time) {
		const ctx = this.ctx
		const { kbX, kbW, hitY, kbH, whiteW } = this
		const held = this.input.held
		const nowS = time

		ctx.fillStyle = "#050208"
		ctx.fillRect(kbX - 6, hitY - 2, kbW + 12, kbH + 8)

		const drawKey = (p, x, w, h, black) => {
			const fx = this.keyFx[p]
			const auto = this.autoDown[p]
			const down = held.has(p) || !!auto
			const y = hitY + (down ? 3 : 0)
			let top = black ? "#2b2533" : "#f4f1fa"
			let bot = black ? "#0b0910" : "#c9c2d8"
			const grd = ctx.createLinearGradient(0, y, 0, y + h)
			grd.addColorStop(0, top)
			grd.addColorStop(1, bot)
			ctx.fillStyle = grd
			ctx.fillRect(x + 1, y, w - 2, h)

			const hint = this.hints[p]
			if (hint && !down) {
				const hg = ctx.createLinearGradient(0, y, 0, y + h)
				hg.addColorStop(0, hexA(hint.color, 0.85 * hint.v))
				hg.addColorStop(1, hexA(hint.color, 0.1 * hint.v))
				ctx.fillStyle = hg
				ctx.fillRect(x + 1, y, w - 2, h)
			}
			if (down) {
				const recent = fx && nowS - fx.t < 0.35 && !fx.wrong
				const col = recent ? fx.color : auto || (fx && fx.wrong && nowS - fx.t < 0.3 ? COLORS.miss : "#9fb3ff")
				ctx.fillStyle = hexA(col, black ? 0.85 : 0.75)
				ctx.fillRect(x + 1, y, w - 2, h)
			}
			if (fx) {
				const age = nowS - fx.t
				if (age < 0.3) {
					ctx.globalCompositeOperation = "lighter"
					ctx.fillStyle = hexA(fx.wrong ? COLORS.miss : fx.color, (1 - age / 0.3) * 0.6)
					ctx.fillRect(x + 1, y, w - 2, h)
					ctx.globalCompositeOperation = "source-over"
				}
			}
			return y
		}

		for (const p of this.whites) {
			const x = kbX + this.whiteIdx[p] * whiteW
			const y = drawKey(p, x, whiteW, kbH, false)
			const label = p % 12 === 0 ? "C" + (p / 12 - 1) : this.settings.names ? noteName(p) : ""
			if (label && whiteW > 16) {
				ctx.fillStyle = p === 60 ? "#ff3fa4" : "rgba(40,30,60,0.55)"
				ctx.font = `700 ${Math.min(14, whiteW * 0.34)}px Segoe UI, sans-serif`
				ctx.textAlign = "center"
				ctx.textBaseline = "bottom"
				ctx.fillText(label, x + whiteW / 2, y + kbH - 6)
			}
			const hint = this.hints[p]
			if (hint && hint.tag && hint.v > 0.3) this.fingerBadge(x + whiteW / 2, y + kbH * 0.55, hint, whiteW)
		}
		for (let p = this.lo; p <= this.hi; p++) {
			if (!isBlack(p)) continue
			const w = this.keyW(p)
			const x = this.keyX(p) - w / 2
			drawKey(p, x, w, kbH * 0.62, true)
			const hint = this.hints[p]
			if (hint && hint.tag && hint.v > 0.3) this.fingerBadge(x + w / 2, hitY + kbH * 0.35, hint, w * 1.4)
		}

		// glossy top edge
		ctx.fillStyle = "rgba(255,255,255,0.12)"
		ctx.fillRect(kbX, hitY, kbW, 2)
	}

	// "R3" = right hand, finger 3. The hand letter shows when both hands are in play.
	noteTag(n, g) {
		if (!this.settings.fingers) return ""
		const hand = g.hands === "both" || g.mode === "watch" ? n.hand : ""
		return hand + (n.finger || "")
	}

	fingerBadge(x, y, hint, size) {
		const ctx = this.ctx
		const r = Math.min(13, size * 0.3)
		ctx.globalAlpha = Math.min(1, hint.v * 1.4)
		ctx.fillStyle = hint.color
		ctx.beginPath()
		ctx.arc(x, y, r, 0, Math.PI * 2)
		ctx.fill()
		ctx.fillStyle = "#0b0614"
		ctx.font = `800 ${r * (hint.tag.length > 1 ? 0.9 : 1.25)}px Segoe UI, sans-serif`
		ctx.textAlign = "center"
		ctx.textBaseline = "middle"
		ctx.fillText(hint.tag, x, y + 1)
		ctx.globalAlpha = 1
	}

	// --- Particles ------------------------------------------------------------------
	spark(x, y, color, n, spd, spread = Math.PI * 0.9, size = 5, life = 0.6) {
		for (let i = 0; i < n && this.particles.length < 1500; i++) {
			const a = -Math.PI / 2 + rand(-spread / 2, spread / 2)
			const v = rand(0.3, 1) * spd
			this.particles.push({ kind: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.5, 1) * life, max: life, size: rand(0.6, 1.2) * size, color, grav: 900, drag: 2.2 })
		}
	}

	ring(x, y, color, r, life = 0.35, width = 4) {
		this.particles.push({ kind: "ring", x, y, r0: 4, r, life, max: life, color, width })
	}

	updatePyro(dt) {
		const H = this.H, W = this.W
		const u = H / 900
		for (const side of ["L", "R"]) {
			if (this.pyro[side] <= 0) continue
			this.pyro[side] -= dt
			const sw = Math.max(60 * u, W * 0.075)
			const x = side === "L" ? sw / 2 : W - sw / 2
			const y = H * 0.47
			for (let i = 0; i < 6; i++) {
				this.particles.push({ kind: "flame", x: x + rand(-sw * 0.25, sw * 0.25), y, vx: rand(-30, 30), vy: rand(-900, -600) * u, life: rand(0.35, 0.7), max: 0.7, size: rand(18, 34) * u, color: "#ffd23a", grav: 300, drag: 1.2 })
			}
			if (Math.random() < 0.5) this.spark(x, y - 40 * u, "#ffe08a", 3, 900 * u, 0.8, 4, 1.2)
		}
	}

	drawParticles(dt) {
		const ctx = this.ctx
		ctx.globalCompositeOperation = "lighter"
		const out = []
		for (const p of this.particles) {
			p.life -= dt
			if (p.life <= 0) continue
			out.push(p)
			const k = p.life / p.max
			if (p.kind === "ring") {
				const r = p.r0 + (p.r - p.r0) * (1 - k)
				ctx.strokeStyle = hexA(p.color, k * 0.9)
				ctx.lineWidth = p.width * k + 0.5
				ctx.beginPath()
				ctx.ellipse(p.x, p.y, r, r * 0.38, 0, 0, Math.PI * 2)
				ctx.stroke()
				continue
			}
			p.vy += p.grav * dt
			p.vx *= 1 - p.drag * dt
			p.vy *= 1 - p.drag * dt
			p.x += p.vx * dt
			p.y += p.vy * dt
			let color = p.color
			if (p.kind === "flame") color = k > 0.6 ? "#fff1a8" : k > 0.3 ? "#ff9a2f" : "#ff3a2f"
			const s = p.size * (p.kind === "flame" ? 0.6 + k : k)
			ctx.globalAlpha = Math.min(1, k * 1.5)
			ctx.drawImage(glow(color), p.x - s, p.y - s, s * 2, s * 2)
		}
		ctx.globalAlpha = 1
		ctx.globalCompositeOperation = "source-over"
		this.particles = out
	}

	// --- FX hooks called by the game ---------------------------------------------------
	now() {
		return performance.now() / 1000
	}

	hit(n, grade, dt) {
		if (!this.game) return
		const x = this.keyX(n.p), y = this.hitY
		const color = this.noteColor(n, this.game)
		const big = grade === "perfect"
		this.spark(x, y, color, big ? 22 : grade === "great" ? 14 : 8, big ? 700 : 500)
		if (big) this.spark(x, y, "#ffffff", 6, 400, Math.PI * 0.5, 4, 0.35)
		this.ring(x, y, color, this.whiteW * (big ? 1.3 : 0.9))
		this.keyFx[n.p] = { color, t: this.now() }
		if (this.game.mode === "watch") return
		this.judgement = {
			text: this.game.mode === "practice" ? (grade === "perfect" ? "NICE!" : "GOT IT") : grade.toUpperCase() + "!",
			sub: this.game.mode === "perform" && grade !== "perfect" ? (dt < 0 ? "EARLY" : "LATE") : "",
			color: COLORS[grade],
			t: this.now()
		}
	}

	miss(n) {
		const x = this.keyX(n.p)
		for (let i = 0; i < 6; i++) this.particles.push({ kind: "spark", x: x + rand(-8, 8), y: this.hitY, vx: rand(-40, 40), vy: rand(-80, -20), life: 0.5, max: 0.5, size: 12, color: COLORS.miss, grav: 0, drag: 3 })
		this.judgement = { text: "MISS", sub: "", color: COLORS.miss, t: this.now() }
		this.shake = Math.max(this.shake, 4)
	}

	wrong(p, target) {
		this.keyFx[p] = { color: COLORS.miss, t: this.now(), wrong: true }
		if (!target) return
		const oct = Math.round((target.p - p) / 12)
		const n = Math.abs(oct)
		this.judgement = { text: "WRONG OCTAVE", sub: `${oct > 0 ? "▲ UP" : "▼ DOWN"} ${n === 1 ? "ONE OCTAVE" : n + " OCTAVES"}`, color: "#ffb347", t: this.now() }
		this.ring(this.keyX(target.p), this.hitY, "#ffb347", this.whiteW * 1.2)
	}

	chord(notes) {
		this.shake = Math.max(this.shake, 5 + notes.length * 2)
		const xs = notes.map(n => this.keyX(n.p))
		const cx = (Math.min(...xs) + Math.max(...xs)) / 2
		this.ring(cx, this.hitY, "#ffffff", (Math.max(...xs) - Math.min(...xs)) / 2 + this.whiteW * 2, 0.45, 6)
	}

	milestone(combo) {
		this.banner(`${combo} NOTE STREAK!`, "#ffd23a")
		this.pyro.L = this.pyro.R = combo >= 50 ? 1.2 : 0.7
		this.flash = 0.5
		this.flashColor = "#ffb347"
		this.shake = Math.max(this.shake, 6)
	}

	starPhrase() {
		this.banner("STAR PHRASE!", "#ffd23a", 0.8)
	}

	phraseFail() {
		this.banner("star phrase lost", "#9a93b8", 0.6, 0.6)
	}

	overdrive() {
		this.banner("SPOTLIGHT!", "#b8f8ff", 1.3, 1.4)
		this.pyro.L = this.pyro.R = 1.6
		this.flash = 1
		this.flashColor = "#b8f8ff"
		this.shake = 14
	}

	holding(n) {
		if (Math.random() < 0.6) this.spark(this.keyX(n.p), this.hitY, this.noteColor(n, this.game), 1, 350, 0.9, 4, 0.4)
	}

	keyDown() {}

	keyFlash() {}

	banner(text, color, dur = 1.1, scale = 1) {
		this.banners.push({ text, color, t: this.now(), dur, scale })
	}

	// --- HUD --------------------------------------------------------------------------------
	drawHUD(g, time, dt, pulse) {
		const ctx = this.ctx
		const { W, H } = this
		const u = Math.min(W / 1400, H / 900) * 1.1
		const now = this.now()

		// progress bar
		const prog = Math.max(0, Math.min(1, g.st / g.song.lengthSec))
		ctx.fillStyle = "rgba(255,255,255,0.08)"
		ctx.fillRect(0, 0, W, 4)
		ctx.fillStyle = "#ff3fa4"
		ctx.fillRect(0, 0, W * prog, 4)

		// song title
		ctx.textAlign = "left"
		ctx.textBaseline = "top"
		ctx.fillStyle = "rgba(255,255,255,0.85)"
		ctx.font = `800 ${18 * u}px Segoe UI, sans-serif`
		ctx.fillText(g.song.title, 18 * u, 16 * u)
		ctx.fillStyle = "rgba(255,255,255,0.45)"
		ctx.font = `600 ${13 * u}px Segoe UI, sans-serif`
		const modeLabel = { perform: "PERFORM", practice: "PRACTICE", watch: "WATCHING" }[g.mode]
		ctx.fillText(`${modeLabel} · ${Math.round(g.speed * 100)}% speed · Esc to pause`, 18 * u, 40 * u)

		if (g.mode !== "watch") {
			// score
			ctx.textAlign = "right"
			ctx.fillStyle = "#fff"
			ctx.font = `italic 900 ${42 * u}px Segoe UI, sans-serif`
			ctx.fillText(Math.round(g.score).toLocaleString(), W - 22 * u, 14 * u)

			// multiplier badge
			const mult = g.mult()
			const base = Math.min(4, 1 + Math.floor(g.combo / 10))
			const mx = W - 60 * u, my = 110 * u, mr = 32 * u
			const mcol = g.odActive ? COLORS.od : RAIL[base]
			ctx.fillStyle = "rgba(10,5,20,0.75)"
			ctx.beginPath()
			ctx.arc(mx, my, mr, 0, Math.PI * 2)
			ctx.fill()
			ctx.strokeStyle = "rgba(255,255,255,0.12)"
			ctx.lineWidth = 6 * u
			ctx.stroke()
			const frac = base >= 4 ? 1 : (g.combo % 10) / 10
			ctx.strokeStyle = mcol
			ctx.beginPath()
			ctx.arc(mx, my, mr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
			ctx.stroke()
			ctx.fillStyle = mcol
			ctx.textAlign = "center"
			ctx.textBaseline = "middle"
			ctx.font = `italic 900 ${26 * u * (1 + pulse * 0.08)}px Segoe UI, sans-serif`
			ctx.fillText("x" + mult, mx, my + 1)

			// combo
			ctx.textAlign = "right"
			ctx.textBaseline = "top"
			ctx.fillStyle = g.combo >= 10 ? "#fff" : "rgba(255,255,255,0.5)"
			ctx.font = `900 ${22 * u}px Segoe UI, sans-serif`
			ctx.fillText(`${g.combo}`, W - 104 * u, 92 * u)
			ctx.fillStyle = "rgba(255,255,255,0.45)"
			ctx.font = `700 ${11 * u}px Segoe UI, sans-serif`
			ctx.fillText("COMBO", W - 104 * u, 118 * u)

			// overdrive meter
			const ox = W - 240 * u, oy = 156 * u, ow = 218 * u, oh = 12 * u
			ctx.fillStyle = "rgba(10,5,20,0.75)"
			ctx.fillRect(ox, oy, ow, oh)
			const odc = g.odActive ? COLORS.od : "#6fb6ff"
			ctx.globalCompositeOperation = "lighter"
			ctx.fillStyle = hexA(odc, g.odActive ? 0.7 + 0.3 * pulse : 0.75)
			ctx.fillRect(ox, oy, ow * g.od, oh)
			ctx.globalCompositeOperation = "source-over"
			ctx.strokeStyle = "rgba(255,255,255,0.25)"
			ctx.lineWidth = 1
			for (let i = 1; i < 4; i++) {
				ctx.beginPath()
				ctx.moveTo(ox + (ow * i) / 4, oy)
				ctx.lineTo(ox + (ow * i) / 4, oy + oh)
				ctx.stroke()
			}
			ctx.strokeRect(ox, oy, ow, oh)
			ctx.textAlign = "right"
			ctx.font = `800 ${11 * u}px Segoe UI, sans-serif`
			if (g.od >= 0.5 && !g.odActive) {
				ctx.fillStyle = hexA("#b8f8ff", 0.6 + 0.4 * Math.sin(time * 8))
				ctx.fillText("SPOTLIGHT READY · PRESS SUSTAIN PEDAL / SPACE", W - 22 * u, oy + oh + 6 * u)
			} else {
				ctx.fillStyle = "rgba(255,255,255,0.4)"
				ctx.fillText(g.odActive ? "SPOTLIGHT ON · DOUBLE POINTS" : "SPOTLIGHT · nail gold phrases to charge", W - 22 * u, oy + oh + 6 * u)
			}

			// crowd meter
			const cx = 26 * u, cy = H * 0.35, cw = 14 * u, ch = H * 0.3
			const cg = ctx.createLinearGradient(0, cy + ch, 0, cy)
			cg.addColorStop(0, "#ff2d55")
			cg.addColorStop(0.35, "#ffd23a")
			cg.addColorStop(1, "#3aff9a")
			ctx.fillStyle = "rgba(10,5,20,0.75)"
			ctx.fillRect(cx - 4, cy - 4, cw + 8, ch + 8)
			ctx.globalAlpha = 0.35
			ctx.fillStyle = cg
			ctx.fillRect(cx, cy, cw, ch)
			ctx.globalAlpha = 1
			const ny = cy + ch * (1 - g.crowd)
			ctx.fillStyle = cg
			ctx.fillRect(cx, ny, cw, cy + ch - ny)
			ctx.fillStyle = "#fff"
			ctx.fillRect(cx - 6, ny - 2, cw + 12, 4)
			ctx.save()
			ctx.translate(cx + cw / 2, cy + ch + 14 * u)
			ctx.fillStyle = "rgba(255,255,255,0.5)"
			ctx.font = `800 ${10 * u}px Segoe UI, sans-serif`
			ctx.textAlign = "center"
			ctx.textBaseline = "top"
			ctx.fillText("CROWD", 0, 0)
			ctx.restore()
		}

		// judgement
		const j = this.judgement
		if (j) {
			const age = now - j.t
			if (age < 0.55) {
				const k = age / 0.55
				const sc = age < 0.08 ? 0.6 + (age / 0.08) * 0.6 : 1.2 - Math.min(0.2, age)
				ctx.save()
				ctx.translate(W / 2, this.hitY - H * 0.13)
				ctx.scale(sc, sc)
				ctx.globalAlpha = 1 - k * k
				ctx.textAlign = "center"
				ctx.textBaseline = "middle"
				ctx.font = `italic 900 ${40 * u}px Segoe UI, sans-serif`
				ctx.shadowColor = j.color
				ctx.shadowBlur = 20
				ctx.fillStyle = j.color
				ctx.fillText(j.text, 0, 0)
				ctx.shadowBlur = 0
				if (j.sub) {
					ctx.font = `800 ${14 * u}px Segoe UI, sans-serif`
					ctx.fillStyle = j.sub === "EARLY" ? "#6fb6ff" : "#ff9a2f"
					ctx.fillText(j.sub, 0, 32 * u)
				}
				ctx.restore()
			}
		}

		// banners
		this.banners = this.banners.filter(b => now - b.t < b.dur)
		this.banners.forEach((b, i) => {
			const age = now - b.t
			const k = age / b.dur
			const inT = Math.min(1, age / 0.15)
			ctx.save()
			ctx.translate(W / 2 + (1 - inT) * -W * 0.3, H * 0.4 + i * 54 * u)
			ctx.scale(b.scale * (1 + 0.15 * (1 - inT)), b.scale * (1 + 0.15 * (1 - inT)))
			ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1
			ctx.textAlign = "center"
			ctx.textBaseline = "middle"
			ctx.font = `italic 900 ${46 * u}px Segoe UI, sans-serif`
			ctx.shadowColor = b.color
			ctx.shadowBlur = 30
			ctx.fillStyle = b.color
			ctx.fillText(b.text, 0, 0)
			ctx.restore()
		})

		// count-in
		if (g.st < 0 && !g.paused) {
			const step = g.song.beatSec * g.song.clickEvery
			const left = Math.ceil(-g.st / step - 1e-6)
			const n = Math.round(g.song.barSec / step)
			if (left <= n && g.song.intro === 0) {
				const ph = ((-g.st / step) % 1 + 1) % 1
				ctx.save()
				ctx.translate(W / 2, H * 0.5)
				ctx.scale(1 + ph * 0.3, 1 + ph * 0.3)
				ctx.globalAlpha = 0.3 + 0.7 * ph
				ctx.textAlign = "center"
				ctx.textBaseline = "middle"
				ctx.font = `italic 900 ${90 * u}px Segoe UI, sans-serif`
				ctx.fillStyle = "#fff"
				ctx.shadowColor = "#ff3fa4"
				ctx.shadowBlur = 40
				ctx.fillText(String(left), 0, 0)
				ctx.restore()
			} else if (g.song.intro > 0 && g.st < -0.2) {
				ctx.textAlign = "center"
				ctx.fillStyle = "rgba(255,255,255,0.7)"
				ctx.font = `800 ${20 * u}px Segoe UI, sans-serif`
				ctx.fillText(`Get ready… ${Math.ceil(-g.st / g.speed)}`, W / 2, H * 0.5)
			}
		}

		// practice: what to play
		if (g.isWaitingNow()) {
			const names = [...new Set(g.waiting.filter(n => !n.judged).map(n => noteName(n.p)))].join(" + ")
			ctx.textAlign = "center"
			ctx.textBaseline = "middle"
			ctx.font = `900 ${28 * u}px Segoe UI, sans-serif`
			ctx.fillStyle = hexA("#ffffff", 0.7 + 0.3 * Math.sin(time * 6))
			ctx.fillText(`Play ${names}`, W / 2, this.farY - 14 * u)
		}
	}
}
