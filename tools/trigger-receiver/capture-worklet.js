// Forwards raw microphone samples to the page in batches, tagged with the audio-clock frame
// of the first sample so the page can map receiver sample indices to AudioContext time.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.startFrame = currentFrame + i;
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.port.postMessage({ frame: this.startFrame, samples: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
