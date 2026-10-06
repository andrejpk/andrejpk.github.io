// Diagnostic recorder for the trigger receiver: session facts, receiver events, 1 s stats,
// player events, page errors, and the last few seconds of raw microphone audio, exported as
// one JSON file (format "trigger-receiver-diag/1") that can be shared for analysis.
export const BUILD = "__BUILD__"; // replaced with a content hash when the page is built

const MAX_ENTRIES = 20000;
const entries = [];
let clock = () => null; // -> { ctx: AudioContext seconds, rx: receiver seconds } while listening
let listener = null;

const session = {
  build: BUILD,
  page: location.href.split("#")[0],
  opened: new Date().toISOString(),
  userAgent: navigator.userAgent,
  platform: navigator.userAgentData?.platform || navigator.platform,
  mobile: navigator.userAgentData?.mobile,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
};

export function setClock(fn) { clock = fn; }
export function onDiagChange(fn) { listener = fn; }

export function diag(type, data = {}) {
  entries.push({ wall: new Date().toISOString(), perf: Math.round(performance.now()), ...(clock() || {}), type, ...data });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  listener?.(entries.length);
}

addEventListener("error", (e) => diag("error", { message: e.message, source: e.filename, line: e.lineno, col: e.colno }));
addEventListener("unhandledrejection", (e) => diag("error", { message: String(e.reason?.message || e.reason) }));

// Last `seconds` of microphone samples, in receiver sample order.
export class AudioRing {
  constructor(fs, seconds) {
    this.fs = fs;
    this.buf = new Float32Array(Math.round(fs * seconds));
    this.w = 0;
    this.filled = 0;
    this.endAbs = 0; // receiver sample index just after the newest sample
  }

  push(x) {
    const n = this.buf.length;
    for (let i = 0; i < x.length; i++) {
      this.buf[this.w] = x[i];
      this.w = (this.w + 1) % n;
    }
    this.filled = Math.min(n, this.filled + x.length);
    this.endAbs += x.length;
  }

  wav() {
    const n = this.filled, out = new ArrayBuffer(44 + 2 * n), v = new DataView(out);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); str(8, "WAVEfmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, this.fs, true); v.setUint32(28, 2 * this.fs, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, 2 * n, true);
    const start = (this.w - n + this.buf.length) % this.buf.length;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, this.buf[(start + i) % this.buf.length]));
      v.setInt16(44 + 2 * i, Math.round(s * 32767), true);
    }
    return out;
  }
}

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function exportReport(ring, includeAudio) {
  const report = { format: "trigger-receiver-diag/1", session, exported: new Date().toISOString(), entries };
  if (ring && includeAudio && ring.filled) {
    report.audio = {
      note: "mono 16-bit PCM WAV of the most recent microphone input; rxStart is the receiver time of its first sample",
      sampleRate: ring.fs,
      rxStartSample: ring.endAbs - ring.filled,
      rxStart: +((ring.endAbs - ring.filled) / ring.fs).toFixed(4),
      seconds: +(ring.filled / ring.fs).toFixed(2),
      wavBase64: base64(ring.wav()),
    };
  }
  const blob = new Blob([JSON.stringify(report)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trigger-diag-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return blob.size;
}
