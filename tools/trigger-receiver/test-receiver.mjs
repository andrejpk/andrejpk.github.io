// Offline check of trigger-receiver.js: feeds raw float32 captures listed in a cases.json
// ([{file, fs, code, track, band, cond}], code null for negatives) through the receiver in
// 4096-sample chunks and reports decodes and beep-prediction error.
//   node tools/trigger-receiver/test-receiver.mjs /path/to/cases.json
import { readFileSync } from "node:fs";
import { TriggerReceiver } from "./trigger-receiver.js";
const cases = JSON.parse(readFileSync(process.argv[2] || "/tmp/rxtest/cases.json"));
let pass = 0, fail = 0, fp = 0, t0 = Date.now();
const stats = { pred: {}, det: {}, edge: {}, wrong: 0 };
for (const c of cases) {
  const raw = readFileSync(c.file);
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const rx = new TriggerReceiver(c.fs);
  const evs = [];
  for (let i = 0; i < x.length; i += 4096) { rx.push(x.subarray(i, i + 4096)); evs.push(...rx.process()); }
  const dec = evs.filter(e => e.type === "decode"), beeps = evs.filter(e => e.type === "beep");
  const failed = evs.filter(e => e.type === "decode-failed").length;
  const wrong = dec.filter(e => e.payload.code !== c.code);
  if (c.code === null) {
    fp += dec.length;
    console.log(`${c.track} ${c.cond}: decodes=${dec.length} preambles=${evs.filter(e=>e.type==="preamble").length}`);
    continue;
  }
  stats.wrong += wrong.length;
  if (c.edge) {
    // edge of range: decoding may fail, but nothing wrong may be accepted
    const e = (stats.edge[c.cond] ||= { n: 0, decoded: 0, copies: 0 });
    e.n++; e.decoded += dec.length > wrong.length ? 1 : 0; e.copies += dec.length - wrong.length;
    if (wrong.length) { fail++; console.log(`WRONG ${c.track} ${c.band} ${c.cond}: ${wrong.map((w) => w.payload.code).join(", ")}`); }
    continue;
  }
  const ok = dec.length >= 1 && wrong.length === 0;
  ok ? pass++ : fail++;
  const preds = dec.map(e => `${(e.burstEndAbs/c.fs).toFixed(2)}+${e.payload.beepOffsetS}=${(e.predictedBeepAbs/c.fs).toFixed(3)}${e.erasures?`(er${e.erasures})`:""}`).join(" ");
  const bm = beeps.map(b => `${(b.beepAbs/c.fs).toFixed(3)} err ${b.errorMs.toFixed(1)}ms`).join(", ");
  if (c.truth !== undefined) {
    // against the true arrival: each copy's prediction, and the beep detector itself
    for (const d of dec) (stats.pred[c.cond] ||= []).push(d.predictedBeepAbs / c.fs - c.truth);
    for (const b of beeps) (stats.det[c.cond] ||= []).push(b.beepAbs / c.fs - c.truth);
  }
  console.log(`${ok?"ok  ":"FAIL"} ${c.track} ${c.band} ${c.cond} ${c.fs}: ${dec.length} decodes, ${failed} failed [${preds}] beep: ${bm || evs.filter(e=>e.type==="beep-missed").length+" missed"}${c.beep?` (py beep ${c.beep.toFixed(3)})`:""}`);
}
console.log(`\npass ${pass}, fail ${fail}, false decodes on unmodified tracks ${fp}, ${((Date.now()-t0)/1000).toFixed(1)}s`);
const summ = (v) => { const a = v.map((x) => x * 1000).sort((p, q) => p - q), abs = a.map(Math.abs).sort((p, q) => p - q);
  return `n ${a.length}, median ${a[a.length >> 1].toFixed(1)} ms, |err| p90 ${abs[Math.floor(abs.length * 0.9)].toFixed(1)} ms, max ${abs[abs.length - 1].toFixed(1)} ms`; };
for (const [k, v] of Object.entries(stats.pred)) console.log(`prediction vs true arrival, ${k}: ${summ(v)}`);
for (const [k, v] of Object.entries(stats.det)) console.log(`beep detector vs true arrival, ${k}: ${summ(v)}`);
for (const [k, e] of Object.entries(stats.edge)) console.log(`edge ${k}: decoded in ${e.decoded}/${e.n} plays, ${(e.copies / e.n).toFixed(1)} copies per play`);
console.log(`wrong decodes accepted: ${stats.wrong}`);
