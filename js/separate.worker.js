// Pulls the piano out of a stereo mix with Demucs (htdemucs_6s), running in the browser via
// onnxruntime-web: on the graphics card through WebGPU when available, otherwise on the CPU.
// Follows the approach of huggingface.co/spaces/kramp/audio-split (MIT).
//
// in:  { type: "separate", channels: [Float32Array L, Float32Array R], sampleRate: 44100 }
// out: { type: "progress", pct, msg } ... then { type: "done", piano: [L, R] } or { type: "error", message }

const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.bundle.min.mjs"
const MODEL = "https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/0c850a01007f48d94900b21b49a0d0ae1a17239f/htdemucs_6s.onnx"
const MODEL_BYTES = 284797240
const CACHE = "keystage-models-v1"
const N = 343980 // samples per segment (7.8 s at 44.1 kHz)
const OVERLAP = Math.floor(N / 4)
const STRIDE = N - OVERLAP
const PIANO = 5 // stems: drums, bass, other, vocals, guitar, piano

const say = (pct, msg) => postMessage({ type: "progress", pct, msg })

async function loadModel() {
	let cache = null
	try {
		cache = await caches.open(CACHE)
		const hit = await cache.match(MODEL)
		if (hit) return new Uint8Array(await hit.arrayBuffer())
	} catch {
		/* Cache Storage unavailable: download every time */
	}
	const r = await fetch(MODEL)
	if (!r.ok) throw new Error(`Couldn't download the separation model (HTTP ${r.status})`)
	const total = +r.headers.get("content-length") || MODEL_BYTES
	const bytes = new Uint8Array(total)
	const reader = r.body.getReader()
	let got = 0, shown = -1
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		if (got + value.length > bytes.length) throw new Error("The model download was larger than expected")
		bytes.set(value, got)
		got += value.length
		const mb = Math.floor(got / 1e6)
		if (mb !== shown && mb % 5 === 0) {
			shown = mb
			say((got / total) * 0.3, `Downloading the separation model, first time only (${mb} of ${Math.round(total / 1e6)} MB)…`)
		}
	}
	const model = got === bytes.length ? bytes : bytes.slice(0, got)
	try {
		await cache?.put(MODEL, new Response(model.slice(0), { headers: { "Content-Type": "application/octet-stream" } }))
	} catch {
		/* not enough storage to keep it: fine, it just downloads again next time */
	}
	return model
}

async function separate([L, R]) {
	say(0, "Loading the separation model…")
	const [ort, model] = await Promise.all([import(ORT), loadModel()])
	ort.env.wasm.numThreads = 1 // no SharedArrayBuffer needed, so it works on any static host
	say(0.3, "Starting the separation model…")
	const opts = { graphOptimizationLevel: "disabled" } // the model is pre-optimized; this avoids a memory spike
	let session, gpu = false
	if (navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))) {
		try {
			session = await ort.InferenceSession.create(model, { ...opts, executionProviders: ["webgpu"] })
			gpu = true
		} catch (e) {
			console.warn("WebGPU unavailable, using the CPU", e)
		}
	}
	session ??= await ort.InferenceSession.create(model, { ...opts, executionProviders: ["wasm"] })
	// Smaller graphics cards can run out of memory (or lose the device) partway through:
	// switch to the CPU and redo the same part.
	const run = async feeds => {
		try {
			return await session.run(feeds)
		} catch (e) {
			if (!gpu) throw e
			console.warn("WebGPU failed, switching to the CPU", e)
			gpu = false
			await session.release?.().catch(() => {})
			session = await ort.InferenceSession.create(model, { ...opts, executionProviders: ["wasm"] })
			return await session.run(feeds)
		}
	}

	const total = L.length
	const pL = new Float32Array(total), pR = new Float32Array(total), weight = new Float32Array(total)
	const win = new Float32Array(N)
	for (let i = 0; i < N; i++) win[i] = i < OVERLAP ? (i + 1) / OVERLAP : i >= N - OVERLAP ? (N - i) / OVERLAP : 1
	const segments = Math.max(1, Math.ceil(Math.max(0, total - OVERLAP) / STRIDE))
	const x = new Float32Array(2 * N)
	for (let k = 0, start = 0; start < total; k++, start += STRIDE) {
		const where = gpu ? "on your graphics card" : "on your CPU (slower)"
		say(0.3 + (k / segments) * 0.7, `Separating the piano from the band ${where}: part ${k + 1} of ${segments}…`)
		const len = Math.min(N, total - start)
		x.fill(0)
		x.set(L.subarray(start, start + len), 0)
		x.set(R.subarray(start, start + len), N)
		const out = await run({ [session.inputNames[0]]: new ort.Tensor("float32", x, [1, 2, N]) })
		const stems = out[session.outputNames[0]].data
		const baseL = (PIANO * 2) * N, baseR = (PIANO * 2 + 1) * N
		for (let i = 0; i < len; i++) {
			const w = win[i], sL = stems[baseL + i], sR = stems[baseR + i]
			if (Number.isFinite(sL) && Number.isFinite(sR)) {
				pL[start + i] += sL * w
				pR[start + i] += sR * w
				weight[start + i] += w
			}
		}
		for (const t of Object.values(out)) t.dispose?.()
		if (start + N >= total) break
	}
	for (let i = 0; i < total; i++) {
		if (weight[i] > 1e-8) {
			pL[i] /= weight[i]
			pR[i] /= weight[i]
		}
	}
	await session.release?.()
	return [pL, pR]
}

onmessage = async e => {
	if (e.data.type !== "separate") return
	try {
		const piano = await separate(e.data.channels)
		postMessage({ type: "done", piano }, piano.map(c => c.buffer))
	} catch (err) {
		postMessage({ type: "error", message: err.message || String(err) })
	}
}
