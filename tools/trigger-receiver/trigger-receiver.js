// Streaming receiver for the timing-track event trigger (mfsk16f, mid and low band).
// Pure DSP and decoding, no DOM: the page feeds it microphone samples, and tests feed it files.
//
// Burst: 120 ms V-shaped chirp preamble (down f1->f0 then up f0->f1), 40 ms gap, then
// 24 symbols of 60 ms tone + 15 ms guard. Each symbol carries 4 bits; even and odd symbols use
// interleaved sets of 16 tones. 104 bits = RS(13,9) codeword over a 72-bit payload (version 2:
// 56 bits of fields + CRC-16). Tracks carry 3-4 copies; any one that passes the CRC is accepted,
// and copies that agree are averaged into one beep prediction.

export const BANDS = {
  mid: { f0: 17500, f1: 19500 },
  low: { f0: 16000, f1: 18000 },
};
const M = 16, BITS_PER_SYM = 4, SYM_DUR = 0.060, GUARD = 0.015;
const PRE_DUR = 0.120, PRE_GAP = 0.040, SKIP_S = 0.008;
const N_BITS = 104, N_SYMS = N_BITS / BITS_PER_SYM;
export const AGREE_S = 0.06; // copies of one broadcast predict the same beep (reflections: up to ~35 ms apart)
export const PRE_THRESH = 6.0;

// ---------------------------------------------------------------- GF(256), RS(12,8)
// Matches Python reedsolo.RSCodec(4): primitive polynomial 0x11d, generator 2, fcr 0.
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
const gfDiv = (a, b) => (a ? GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255] : 0);
const gfPow2 = (e) => GF_EXP[((e % 255) + 255) % 255];

const N_CW = 13, N_DATA = 9, N_ECC = 4;

function syndromes(cw) {
  // S_j = c(2^j); cw[0] is the highest-degree coefficient
  const s = new Uint8Array(N_ECC);
  for (let j = 0; j < N_ECC; j++) {
    let acc = 0;
    const a = gfPow2(j);
    for (let i = 0; i < N_CW; i++) acc = gfMul(acc, a) ^ cw[i];
    s[j] = acc;
  }
  return s;
}

// Solve sum_p e_p * X_p^j = S_j (j = 0..3) for the error values at `pos`; null if inconsistent.
function solveErrata(s, pos) {
  const k = pos.length;
  const rows = [];
  for (let j = 0; j < N_ECC; j++) {
    const r = new Uint8Array(k + 1);
    for (let c = 0; c < k; c++) r[c] = gfPow2((N_CW - 1 - pos[c]) * j);
    r[k] = s[j];
    rows.push(r);
  }
  let row = 0;
  const pivots = [];
  for (let c = 0; c < k && row < N_ECC; c++) {
    let p = row;
    while (p < N_ECC && !rows[p][c]) p++;
    if (p === N_ECC) continue;
    [rows[row], rows[p]] = [rows[p], rows[row]];
    const inv = gfDiv(1, rows[row][c]);
    for (let t = c; t <= k; t++) rows[row][t] = gfMul(rows[row][t], inv);
    for (let r2 = 0; r2 < N_ECC; r2++) {
      if (r2 !== row && rows[r2][c]) {
        const f = rows[r2][c];
        for (let t = c; t <= k; t++) rows[r2][t] ^= gfMul(f, rows[row][t]);
      }
    }
    pivots.push(c);
    row++;
  }
  for (let r2 = row; r2 < N_ECC; r2++) if (rows[r2][k]) return null; // inconsistent
  if (pivots.length < k) return null; // underdetermined
  const e = new Uint8Array(k);
  pivots.forEach((c, r) => { e[c] = rows[r][k]; });
  return e;
}

function* combos(pool, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < pool.length; i++) { acc.push(pool[i]); yield* combos(pool, k, i + 1, acc); acc.pop(); }
}

// Bounded-distance RS decode with erasures (2*errors + erasures <= 4). Returns the data bytes or null.
export function rsDecode(cwIn, erasures = []) {
  if (erasures.length > N_ECC) return null;
  const cw = Uint8Array.from(cwIn);
  const s = syndromes(cw);
  if (!erasures.length && s.every((v) => !v)) return cw.slice(0, N_DATA);
  const others = [...Array(N_CW).keys()].filter((i) => !erasures.includes(i));
  for (let e = 0; 2 * e + erasures.length <= N_ECC; e++) {
    for (const guess of combos(others, e)) {
      const pos = [...erasures, ...guess];
      const vals = solveErrata(s, pos);
      if (!vals) continue;
      // a guessed error position must actually be in error
      if (guess.some((_, gi) => !vals[erasures.length + gi])) continue;
      const out = Uint8Array.from(cw);
      pos.forEach((p, i) => { out[p] ^= vals[i]; });
      if (syndromes(out).every((v) => !v)) return out.slice(0, N_DATA);
    }
  }
  return null;
}

// ---------------------------------------------------------------- payload
const ORGS = { 1: "ijru", 2: "rsc", 3: "ddc", 4: "sau", 5: "amjrf", 6: "svgf", 7: "ajru" };
const TYPES = { 0: "sp", 1: "fs", 2: "oa" };
const DISCIPLINES = { 0: "sr", 1: "dd", 2: "wh", 3: "lr", 4: "ts", 5: "xd" };
const ABBR = "abcdefghijklmnopqrstuvwxyz01234_";

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export function crc16(bytes) {
  // CRC-16/CCITT-FALSE
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function parsePayload(b) {
  if (b.length !== N_DATA || crc16(b.slice(0, 7)) !== ((b[7] << 8) | b[8])) return null;
  let v = 0n;
  for (let i = 0; i < 7; i++) v = (v << 8n) | BigInt(b[i]);
  let pos = 56n;
  const take = (w) => { pos -= BigInt(w); return Number((v >> pos) & ((1n << BigInt(w)) - 1n)); };
  if (take(2) !== 2) return null; // payload version 2
  const org = ORGS[take(4)], type = TYPES[take(2)], discipline = DISCIPLINES[take(3)];
  let abbr = "";
  for (let i = 0; i < 4; i++) abbr += ABBR[take(5)];
  abbr = abbr.replace(/_+$/, "");
  const participants = take(4), splits = take(3), splitLength = take(9);
  const beepOffsetS = take(8) / 10;
  if (!org || !type || !discipline || splits === 0 || !abbr || abbr.includes("_")) return null;
  const timing = splits > 1 ? `${splits}x${splitLength}` : `${splitLength}`;
  return {
    code: `e.${org}.${type}.${discipline}.${abbr}.${participants}.${timing}`,
    org, type, discipline, abbr, participants, splits, splitLength,
    durationS: splits * splitLength, beepOffsetS,
  };
}

function decodeSoft(soft) {
  const bits = soft.map((x) => (x > 0 ? 1 : 0));
  const cw = new Uint8Array(N_CW);
  for (let i = 0; i < N_CW; i++) for (let j = 0; j < 8; j++) cw[i] = (cw[i] << 1) | bits[i * 8 + j];
  const byteConf = [...Array(N_CW).keys()].map((i) => Math.min(...soft.slice(i * 8, i * 8 + 8).map(Math.abs)));
  const order = [...byteConf.keys()].sort((a, b) => byteConf[a] - byteConf[b]);
  for (let k = 0; k <= 3; k++) {
    const data = rsDecode(cw, order.slice(0, k));
    const p = data && parsePayload(data);
    if (p) return { payload: p, erasures: k };
  }
  return null;
}

// ---------------------------------------------------------------- DSP helpers
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function tukey(m, alpha) {
  // scipy.signal.windows.tukey(m, alpha), symmetric
  const w = new Float64Array(m).fill(1);
  const width = Math.floor((alpha * (m - 1)) / 2);
  for (let n = 0; n <= width; n++) w[n] = 0.5 * (1 + Math.cos(Math.PI * (-1 + (2 * n) / alpha / (m - 1))));
  for (let n = m - width - 1; n < m; n++) w[n] = 0.5 * (1 + Math.cos(Math.PI * (-2 / alpha + 1 + (2 * n) / alpha / (m - 1))));
  return w;
}

function chirp(fs, dur, f0, f1) {
  const n = Math.round(dur * fs), w = tukey(n, 0.2), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    out[i] = Math.cos(2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * dur)) * t * t)) * w[i];
  }
  return out;
}

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(n));

// ---------------------------------------------------------------- band demodulator
class BandRx {
  constructor(name, fs, fftN) {
    const { f0, f1 } = BANDS[name];
    this.name = name;
    this.fs = fs;
    const half = PRE_DUR / 2;
    const a = chirp(fs, half, f1, f0), b = chirp(fs, half, f0, f1);
    this.pre = new Float64Array(a.length + b.length);
    this.pre.set(a); this.pre.set(b, a.length);
    this.preEnergy = this.pre.reduce((s, v) => s + v * v, 0);
    this.nSym = Math.round((SYM_DUR + GUARD) * fs);
    this.nOn = Math.round(SYM_DUR * fs);
    this.dataStart = this.pre.length + Math.round(PRE_GAP * fs);
    this.burstSamples = this.dataStart + N_SYMS * this.nSym;
    this.skip = Math.floor(SKIP_S * fs);
    this.segLen = this.nOn - this.skip;
    // tone references: Hann-windowed complex exponentials
    const all = [...Array(2 * M).keys()].map((i) => f0 + ((f1 - f0) * i) / (2 * M - 1));
    this.toneSets = [all.filter((_, i) => i % 2 === 0), all.filter((_, i) => i % 2 === 1)];
    const hann = Float64Array.from({ length: this.segLen }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (this.segLen - 1)));
    this.refs = this.toneSets.map((tones) => tones.map((f) => {
      const re = new Float64Array(this.segLen), im = new Float64Array(this.segLen);
      for (let n = 0; n < this.segLen; n++) {
        const ph = (-2 * Math.PI * f * n) / fs;
        re[n] = Math.cos(ph) * hann[n]; im[n] = Math.sin(ph) * hann[n];
      }
      return { re, im };
    }));
    // template spectrum (conjugated) with an in-band mask, used for analytic correlation
    this.fftN = fftN;
    const tr = new Float64Array(fftN), ti = new Float64Array(fftN);
    tr.set(this.pre);
    fft(tr, ti);
    const lo = Math.floor(((f0 - 300) / fs) * fftN), hi = Math.ceil((Math.min(f1 + 300, fs / 2 - 100) / fs) * fftN);
    this.tRe = new Float64Array(fftN); this.tIm = new Float64Array(fftN);
    for (let k = lo; k <= hi; k++) { this.tRe[k] = 2 * tr[k]; this.tIm[k] = -2 * ti[k]; } // positive freqs only, x2 = analytic
    this.pending = []; // candidate preamble positions (absolute sample index) awaiting data
    this.seen = [];    // recent candidate positions, for de-duplication
    this.decoded = []; // [start, end) of decoded bursts; data tones inside them are not preambles
  }

  // Preamble score over a window. Returns {score: Float32Array, med}.
  correlate(xRe, xIm) {
    const n = this.fftN, re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      re[k] = xRe[k] * this.tRe[k] - xIm[k] * this.tIm[k];
      im[k] = xRe[k] * this.tIm[k] + xIm[k] * this.tRe[k];
    }
    fft(re, im, true);
    const valid = n - this.pre.length + 1, mag = new Float32Array(valid);
    for (let i = 0; i < valid; i++) mag[i] = Math.hypot(re[i], im[i]) / this.preEnergy;
    const sample = Float32Array.from({ length: Math.floor(valid / 16) }, (_, i) => mag[i * 16]).sort();
    const med = sample[sample.length >> 1] + 1e-12;
    return { mag, med };
  }

  demodulate(buf, start) {
    // buf: Float32Array, start: index of the preamble start within buf
    const soft = new Array(N_BITS).fill(0), symbols = [];
    for (let k = 0; k < N_SYMS; k++) {
      const s = start + this.dataStart + k * this.nSym + this.skip;
      const refs = this.refs[k % 2];
      const e = refs.map(({ re, im }) => {
        let ar = 0, ai = 0;
        for (let n = 0; n < this.segLen; n++) { const v = buf[s + n]; ar += re[n] * v; ai += im[n] * v; }
        return Math.hypot(ar, ai);
      });
      let best = 0, second = -1;
      for (let i = 1; i < M; i++) if (e[i] > e[best]) best = i;
      for (let i = 0; i < M; i++) if (i !== best && (second < 0 || e[i] > e[second])) second = i;
      const conf = (e[best] - e[second]) / (e[best] + e[second] + 1e-12);
      symbols.push({ value: best, conf });
      for (let j = 0; j < BITS_PER_SYM; j++) soft[k * BITS_PER_SYM + j] = ((best >> (BITS_PER_SYM - 1 - j)) & 1 ? 1 : -1) * conf;
    }
    return { soft, symbols };
  }
}

// ---------------------------------------------------------------- start-beep detector
// Port of embed.find_start_beep: 20 ms Hann frames, tonal ratio of 578.3 Hz (+ 3rd harmonic)
// against 200-3000 Hz, fire on the first frame starting a 10-frame run with >= 8 tonal frames.
class BeepDetector {
  constructor(fs) {
    this.fs = fs;
    this.n = Math.floor(0.02 * fs);
    const df = fs / this.n, f = 578.3;
    const bins = (lo, hi) => { const out = []; for (let k = 0; k * df < fs / 2; k++) if (k * df > lo && k * df < hi) out.push(k); return out; };
    this.toneBins = new Set([...bins(f - 40, f + 40), ...bins(3 * f - 45, 3 * f + 45)]);
    this.bandBins = bins(200, 3000);
    this.win = Float64Array.from({ length: this.n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n)); // periodic Hann, as scipy.stft
    this.cos = this.bandBins.map((k) => Float64Array.from({ length: this.n }, (_, i) => Math.cos((2 * Math.PI * k * i) / this.n) * this.win[i]));
    this.sin = this.bandBins.map((k) => Float64Array.from({ length: this.n }, (_, i) => Math.sin((2 * Math.PI * k * i) / this.n) * this.win[i]));
  }

  tonal(buf, centre) {
    const s = centre - (this.n >> 1);
    let tone = 0, band = 1e-12;
    this.bandBins.forEach((k, bi) => {
      let a = 0, b = 0;
      const c = this.cos[bi], si = this.sin[bi];
      for (let i = 0; i < this.n; i++) { const v = buf[s + i]; a += c[i] * v; b += si[i] * v; }
      const p = a * a + b * b;
      band += p;
      if (this.toneBins.has(k)) tone += p;
    });
    return tone / band > 0.4;
  }

  // Sub-frame onset: 5 ms sliding DFT magnitude of the 578.3 Hz fundamental around the frame
  // detection; the onset is where the envelope first reaches half its early plateau (the first
  // 60 ms of tone, so later reverberant build-up does not drag it late).
  refine(buf, coarse) {
    const fs = this.fs, w = 2 * Math.PI * 578.3 / fs, L = Math.round(0.005 * fs);
    const a = Math.max(0, coarse - Math.round(0.08 * fs)), b = Math.min(buf.length, coarse + Math.round(0.2 * fs));
    const n = b - a, cr = new Float64Array(n + 1), ci = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { cr[i + 1] = cr[i] + buf[a + i] * Math.cos(w * (a + i)); ci[i + 1] = ci[i] - buf[a + i] * Math.sin(w * (a + i)); }
    const env = new Float64Array(n - L + 1);
    for (let i = 0; i < env.length; i++) env[i] = Math.hypot(cr[i + L] - cr[i], ci[i + L] - ci[i]);
    // rough edge: first crossing of a quarter of the overall maximum, then the early plateau after it
    let mx = 0;
    for (const v of env) mx = Math.max(mx, v);
    let edge = env.findIndex((v) => v > 0.25 * mx);
    if (edge < 0) return coarse;
    let plateau = 0;
    for (let i = edge; i < Math.min(env.length, edge + Math.round(0.06 * fs)); i++) plateau = Math.max(plateau, env[i]);
    let i = Math.max(0, edge - L);
    while (i < env.length && env[i] < 0.5 * plateau) i++;
    // Measured against sample-exact onsets of the IJRU beep, the half-height crossing of this
    // window lands on the onset itself (adding L/2 for an ideal step read 2.5 ms late)
    return a + i;
  }

  // Search frames centred at multiples of n within [fromIdx, toIdx] (buf-relative). Returns centre index or null.
  find(buf, fromIdx, toIdx) {
    const first = Math.ceil(Math.max(fromIdx, this.n) / this.n);
    const last = Math.floor(Math.min(toIdx, buf.length - this.n) / this.n);
    const on = [];
    for (let i = first; i <= last; i++) on.push(this.tonal(buf, i * this.n));
    for (let i = 0; i + 10 <= on.length; i++) {
      if (on[i] && on.slice(i, i + 10).filter(Boolean).length >= 8) return this.refine(buf, (first + i) * this.n);
    }
    return null;
  }
}

// ---------------------------------------------------------------- streaming receiver
export class TriggerReceiver {
  constructor(fs, { keepSeconds = 12 } = {}) {
    this.fs = fs;
    this.fftN = nextPow2(Math.round(2.5 * fs)); // correlation window
    this.bands = Object.keys(BANDS).map((b) => new BandRx(b, fs, this.fftN));
    this.keep = Math.max(Math.round(keepSeconds * fs), this.fftN + Math.round(4 * fs));
    this.buf = new Float32Array(this.keep);
    this.len = 0;            // valid samples in buf
    this.total = 0;          // absolute index of the sample after the last one received
    this.lastCorrTotal = 0;
    this.beep = new BeepDetector(fs);
    this.armed = [];         // decoded events waiting for their start beep
    this.levels = {};        // latest preamble score per band, for display
  }

  push(chunk) {
    const n = chunk.length;
    if (this.len + n > this.keep) {
      const drop = this.len + n - this.keep;
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
    }
    this.buf.set(chunk, this.len);
    this.len += n;
    this.total += n;
  }

  abs2rel(a) { return a - (this.total - this.len); }

  // Run detection; returns an array of events ({type: "preamble" | "decode" | "decode-failed" | "beep" | "beep-missed", ...}).
  process() {
    const events = [];
    if (this.len >= this.fftN && this.total - this.lastCorrTotal >= Math.round(0.25 * this.fs)) {
      this.lastCorrTotal = this.total;
      const off = this.len - this.fftN, winAbs = this.total - this.fftN;
      const re = new Float64Array(this.fftN), im = new Float64Array(this.fftN);
      for (let i = 0; i < this.fftN; i++) re[i] = this.buf[off + i];
      fft(re, im);
      for (const b of this.bands) {
        const { mag, med } = b.correlate(re, im);
        let peak = 0;
        for (let i = 0; i < mag.length; i++) peak = Math.max(peak, mag[i] / med);
        this.levels[b.name] = peak;
        const L = b.pre.length;
        // accept a peak only once its whole +-L neighbourhood is visible, so a sidelobe
        // cannot win before the true peak arrives; duplicates across passes are dropped below
        for (let i = 0; i + L < mag.length; i++) {
          const sc = mag[i] / med;
          if (sc < PRE_THRESH) continue;
          let isMax = true;
          for (let j = Math.max(0, i - L); j < Math.min(mag.length, i + L); j++) if (mag[j] > mag[i]) { isMax = false; break; }
          if (!isMax) continue;
          const abs = winAbs + i;
          if (b.seen.some((s) => Math.abs(s - abs) < L)) continue;
          b.seen.push(abs);
          b.pending.push({ abs, score: sc });
          events.push({ type: "preamble", band: b.name, abs, score: sc });
        }
        b.seen = b.seen.filter((s) => s > this.total - this.keep);
        b.decoded = b.decoded.filter(([, e]) => e > this.total - this.keep);
        // decode candidates whose burst is complete
        b.pending = b.pending.filter((c) => {
          const rel = this.abs2rel(c.abs);
          if (rel < 0) return false;
          if (b.decoded.some(([s, e]) => c.abs > s && c.abs < e)) return false;
          if (rel + b.burstSamples + 16 > this.len) return true;
          const { soft, symbols } = b.demodulate(this.buf, rel);
          const res = decodeSoft(soft);
          const burstEndAbs = c.abs + b.burstSamples;
          if (res) {
            b.decoded.push([c.abs, burstEndAbs]);
            const ev = {
              type: "decode", band: b.name, abs: c.abs, score: c.score, burstEndAbs,
              predictedBeepAbs: burstEndAbs + Math.round(res.payload.beepOffsetS * this.fs),
              payload: res.payload, erasures: res.erasures, symbols,
            };
            events.push(ev);
            this.arm(ev);
          } else {
            events.push({ type: "decode-failed", band: b.name, abs: c.abs, score: c.score, symbols });
          }
          return false;
        });
      }
    }
    // start beep: only inside the window the payload predicts
    this.armed = this.armed.filter((a) => {
      const lo = a.predictedBeepAbs - Math.round(0.5 * this.fs), hi = a.predictedBeepAbs + Math.round(1.0 * this.fs);
      if (this.total < hi + Math.round(0.25 * this.fs)) return true;
      const hit = this.beep.find(this.buf, this.abs2rel(lo), this.abs2rel(hi) + Math.round(0.2 * this.fs));
      if (hit !== null) {
        const beepAbs = hit + (this.total - this.len); // fractional sample index
        events.push({ type: "beep", decodes: a.decodes, payload: a.payload, beepAbs, predictedBeepAbs: a.predictedBeepAbs,
          errorMs: ((beepAbs - a.predictedBeepAbs) / this.fs) * 1000 });
      } else {
        events.push({ type: "beep-missed", decodes: a.decodes, payload: a.payload, predictedBeepAbs: a.predictedBeepAbs });
      }
      return false;
    });
    return events;
  }

  // Group decodes that agree (same code, same predicted beep; any copy, either band) into one
  // armed window, ev.group; its prediction is the mean of the copies.
  arm(ev) {
    const tol = Math.round(AGREE_S * this.fs);
    const same = this.armed.find((a) => a.payload.code === ev.payload.code && Math.abs(a.predictedBeepAbs - ev.predictedBeepAbs) < tol);
    if (same) {
      // every agreeing copy refines the prediction: use their mean
      same.decodes.push(ev);
      same.predictedBeepAbs = Math.round(same.decodes.reduce((t, d) => t + d.predictedBeepAbs, 0) / same.decodes.length);
      ev.agrees = true;
      ev.group = same;
      return;
    }
    // a different code (or a beep far from any armed one) within a few seconds is a conflict
    const near = Math.round(3 * this.fs);
    if (this.armed.some((a) => Math.abs(a.predictedBeepAbs - ev.predictedBeepAbs) < near)) ev.conflict = true;
    ev.group = { payload: ev.payload, predictedBeepAbs: ev.predictedBeepAbs, decodes: [ev] };
    this.armed.push(ev.group);
  }
}
