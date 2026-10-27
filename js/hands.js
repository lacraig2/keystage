// Hand assignment and suggested fingering for imported music (built-in songs are fingered by hand).
// Both work on note groups: notes that start together (within 30 ms) are one chord.

const POS = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6] // keyboard position in white-key units
const pos = p => Math.floor(p / 12) * 7 + POS[p % 12]

function groups(notes) {
	const out = []
	for (const n of [...notes].sort((a, b) => a.t - b.t || a.p - b.p)) {
		const g = out[out.length - 1]
		if (g && n.t - g[0].t < 0.03) g.push(n)
		else out.push([n])
	}
	return out
}

// Split one part between the hands. Each hand has a center that follows what it plays;
// every chord is cut at the point closest to both centers, without stretching a hand past an octave.
export function assignHands(notes) {
	let lc = 48, rc = 67
	for (const g of groups(notes)) {
		let best = null
		for (let k = 0; k <= g.length; k++) {
			const L = g.slice(0, k), R = g.slice(k)
			let cost = 0
			for (const n of L) cost += Math.abs(n.p - lc)
			for (const n of R) cost += Math.abs(n.p - rc)
			for (const h of [L, R]) if (h.length) cost += Math.max(0, h[h.length - 1].p - h[0].p - 12) * 6
			if (!best || cost < best.cost) best = { cost, k }
		}
		const L = g.slice(0, best.k), R = g.slice(best.k)
		L.forEach(n => (n.hand = "L"))
		R.forEach(n => (n.hand = "R"))
		const mean = h => h.reduce((s, n) => s + n.p, 0) / h.length
		if (L.length) lc = lc * 0.6 + mean(L) * 0.4
		if (R.length) rc = rc * 0.6 + mean(R) * 0.4
		lc = Math.min(lc, rc - 7)
	}
	return notes
}

// Five-finger positions: the hand stays put while notes fit under it. When one doesn't,
// it moves to the position that covers the most of the next few notes.
export function suggestFingers(notes) {
	for (const hand of ["L", "R"]) {
		const gs = groups(notes.filter(n => n.hand === hand))
		const finger = (anchor, p) => Math.round(hand === "R" ? pos(p) - anchor : anchor - pos(p)) + 1
		const fits = (anchor, g) => g.every(n => { const f = finger(anchor, n.p); return f >= 1 && f <= 5 })
		let anchor = null // thumb position
		gs.forEach((g, i) => {
			if (anchor === null || !fits(anchor, g)) {
				const edge = hand === "R" ? Math.floor(pos(g[0].p)) : Math.ceil(pos(g[g.length - 1].p))
				const ahead = gs.slice(i + 1, i + 7)
				let best = null
				for (let s = 0; s < 5; s++) {
					const a = hand === "R" ? edge - s : edge + s
					if (!fits(a, g)) continue
					const score = ahead.filter(x => fits(a, x)).length * 10 - (anchor === null ? s : Math.abs(a - anchor))
					if (!best || score > best.score) best = { a, score }
				}
				anchor = best ? best.a : edge
			}
			// Chords too wide for one position still get ordered fingers.
			const fs = g.map(n => Math.max(1, Math.min(5, finger(anchor, n.p))))
			const up = hand === "R" ? 1 : -1
			for (let k = 1; k < fs.length; k++) if ((fs[k] - fs[k - 1]) * up <= 0) fs[k] = fs[k - 1] + up
			if (fs.some(f => f < 1 || f > 5)) {
				const base = hand === "R" ? 1 : Math.min(5, g.length)
				fs.forEach((_, k) => (fs[k] = Math.max(1, Math.min(5, base + k * up))))
			}
			g.forEach((n, k) => (n.finger = fs[k]))
		})
	}
	return notes
}
