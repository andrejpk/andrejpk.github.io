// Offline check of trigger-receiver.js: feeds raw float32 captures listed in a cases.json
// ([{file, fs, code, track, band, cond}], code null for negatives) through the receiver in
// 4096-sample chunks and reports decodes and beep-prediction error.
//   node tools/trigger-receiver/test-receiver.mjs /path/to/cases.json
import { readFileSync } from "node:fs";
import { TriggerReceiver } from "./trigger-receiver.js";
const cases = JSON.parse(readFileSync(process.argv[2] || "/tmp/rxtest/cases.json"));
let pass = 0, fail = 0, fp = 0, t0 = Date.now();
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
  const ok = dec.length >= 1 && wrong.length === 0;
  ok ? pass++ : fail++;
  const preds = dec.map(e => `${(e.burstEndAbs/c.fs).toFixed(2)}+${e.payload.beepOffsetS}=${(e.predictedBeepAbs/c.fs).toFixed(3)}${e.erasures?`(er${e.erasures})`:""}`).join(" ");
  const bm = beeps.map(b => `${(b.beepAbs/c.fs).toFixed(3)} err ${b.errorMs.toFixed(0)}ms`).join(", ");
  console.log(`${ok?"ok  ":"FAIL"} ${c.track} ${c.band} ${c.cond} ${c.fs}: ${dec.length} decodes, ${failed} failed [${preds}] beep: ${bm || evs.filter(e=>e.type==="beep-missed").length+" missed"}${c.beep?` (py beep ${c.beep.toFixed(3)})`:""}`);
}
console.log(`\npass ${pass}, fail ${fail}, false decodes on unmodified tracks ${fp}, ${((Date.now()-t0)/1000).toFixed(1)}s`);
