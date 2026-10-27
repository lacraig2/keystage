// Runs on the audio thread: passes microphone audio to the page in fixed-size hops,
// stamped with the audio clock time of the hop's last sample.
const HOP = 512

class MicTap extends AudioWorkletProcessor {
	constructor() {
		super()
		this.buf = new Float32Array(HOP)
		this.n = 0
	}

	process(inputs) {
		const ch = inputs[0]
		if (!ch || !ch.length) return true
		const L = ch[0], R = ch[1]
		for (let i = 0; i < L.length; i++) {
			this.buf[this.n++] = R ? (L[i] + R[i]) / 2 : L[i]
			if (this.n === HOP) {
				const t = currentTime + (i + 1) / sampleRate
				this.port.postMessage({ samples: this.buf, t }, [this.buf.buffer])
				this.buf = new Float32Array(HOP)
				this.n = 0
			}
		}
		return true
	}
}

registerProcessor("mic-tap", MicTap)
