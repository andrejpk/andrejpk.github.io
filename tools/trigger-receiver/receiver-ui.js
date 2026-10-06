// Microphone front end for trigger-receiver.js: capture, spectrum analyzer, waterfall,
// decoded payload, beep prediction, and a click scheduled at the predicted beep.
import { TriggerReceiver, BANDS, PRE_THRESH } from "./trigger-receiver.js";

const $ = (id) => document.getElementById(id);
const BAND_COLOR = { mid: "#22d3ee", low: "#e879f9" };
const NAMES = {
  org: { ijru: "IJRU", rsc: "Rope Skipping Canada", ddc: "DDC", sau: "Skipping Australia", amjrf: "AMJRF", svgf: "Swedish Gymnastics Federation", ajru: "Asian Jump Rope Union" },
  type: { sp: "Speed", fs: "Freestyle", oa: "Overall" },
  discipline: { sr: "Single Rope", dd: "Double Dutch", wh: "Wheel", lr: "Long Rope", ts: "Team Show", xd: "Cross-Discipline" },
  event: { srss: "Single Rope Speed Sprint", srse: "Single Rope Speed Endurance", srtu: "Single Rope Triple Unders",
    srsr: "Single Rope Speed Relay", srdr: "Single Rope Double Unders Relay", ddsr: "Double Dutch Speed Relay", ddss: "Double Dutch Speed Sprint" },
};

let S = null; // running state

// ------------------------------------------------------------------ audio
async function start() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot open the microphone (needs HTTPS and a modern browser).");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.5;
  analyser.minDecibels = -125;
  analyser.maxDecibels = -25;
  source.connect(analyser).connect(mute);
  const node = new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  source.connect(node).connect(mute);
  const track = stream.getAudioTracks()[0];
  S = {
    ctx, stream, track, analyser, node, queue: [], frameOffset: 0,
    rx: new TriggerReceiver(ctx.sampleRate),
    freq: new Float32Array(analyser.frequencyBinCount), peak: new Float32Array(analyser.frequencyBinCount).fill(-200),
    armed: null, clickSrc: null, lastPreamble: {},
  };
  node.port.onmessage = (e) => S.queue.push(e.data);
  S.timer = setInterval(pump, 100);
  S.raf = requestAnimationFrame(draw);
  showInfo();
  setStatus("listening", "Listening… play a track near the microphone");
  $("rx-start").textContent = "Stop listening";
  if (ctx.sampleRate < 40000) logRow("warn", `Sample rate is ${ctx.sampleRate} Hz; the trigger bands (16–19.5 kHz) need 44.1 kHz or more.`);
  const st = track.getSettings();
  if (st.echoCancellation || st.noiseSuppression || st.autoGainControl) {
    logRow("warn", "The browser kept some voice processing on (echo cancellation, noise suppression or auto gain); decoding may suffer.");
  }
}

function stop() {
  if (!S) return;
  clearInterval(S.timer);
  cancelAnimationFrame(S.raf);
  S.stream.getTracks().forEach((t) => t.stop());
  S.ctx.close();
  S = null;
  $("rx-start").textContent = "Start listening";
  setStatus("off", "Microphone off");
}

function pump() {
  if (!S) return;
  while (S.queue.length) {
    const { frame, samples } = S.queue.shift();
    S.frameOffset = frame - S.rx.total; // receiver sample index -> AudioContext frame
    S.rx.push(samples);
  }
  for (const ev of S.rx.process()) handle(ev);
}

const absToCtxTime = (abs) => (abs + S.frameOffset) / S.ctx.sampleRate;
const rxSeconds = (abs) => (abs / S.ctx.sampleRate).toFixed(2);

function latencies() {
  const input = S.track.getSettings().latency || 0;
  const output = (S.ctx.outputLatency || 0) + (S.ctx.baseLatency || 0);
  return { input, output };
}

// ------------------------------------------------------------------ click at the predicted beep
function clickBuffer(ctx) {
  const n = Math.round(0.03 * ctx.sampleRate), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate, env = Math.min(1, t / 0.0005) * Math.exp(-t / 0.006);
    d[i] = 0.7 * env * (Math.sin(2 * Math.PI * 3150 * t) + 0.5 * Math.sin(2 * Math.PI * 4720 * t));
  }
  return b;
}

function playClick(when) {
  const ctx = S ? S.ctx : (playClick.ctx ||= new AudioContext());
  const src = ctx.createBufferSource();
  src.buffer = clickBuffer(ctx);
  src.connect(ctx.destination);
  src.start(when ?? 0);
  return src;
}

function scheduleClick(predAbs) {
  if (!$("rx-click-on").checked) return null;
  const { input, output } = latencies();
  const trim = Number($("rx-trim").value) / 1000;
  const when = absToCtxTime(predAbs) - input - output + trim;
  if (when < S.ctx.currentTime + 0.05) return null;
  if (S.clickSrc) { try { S.clickSrc.stop(); } catch { /* already played */ } }
  S.clickSrc = playClick(when);
  return when;
}

// ------------------------------------------------------------------ events
function handle(ev) {
  if (ev.type === "preamble") {
    S.lastPreamble[ev.band] = performance.now();
    return;
  }
  if (ev.type === "decode-failed") {
    // speech, the square-wave beep's harmonics and the other band's tones all look a bit like
    // a preamble; they are rejected by RS + CRC, so only count them unless asked to show them
    S.rejected = (S.rejected || 0) + 1;
    $("rx-rejected").textContent = S.rejected;
    if ($("rx-verbose").checked) {
      marker(ev.band, "?", 0.5);
      logRow("dim", `${ev.band}: preamble-like signal at ${rxSeconds(ev.abs)} s (score ${ev.score.toFixed(0)}), no valid payload`);
    }
    return;
  }
  if (ev.type === "decode") {
    const p = ev.payload;
    marker(ev.band, "✓", 1);
    showPayload(ev);
    // average the predictions of every agreeing copy; reschedule the click
    const a = S.rx.armed.find((x) => x.decodes.includes(ev));
    const preds = a ? a.decodes.map((d) => d.predictedBeepAbs) : [ev.predictedBeepAbs];
    const predAbs = a ? a.predictedBeepAbs : ev.predictedBeepAbs; // mean of agreeing copies
    S.armed = { code: p.code, predAbs, copies: preds.length };
    const when = scheduleClick(predAbs);
    setStatus("armed", `Armed: ${NAMES.event[p.abbr] || p.abbr.toUpperCase()} — beep predicted`);
    const note = ev.conflict ? " ⚠ disagrees with another decode" : ev.agrees ? " (agrees with earlier copy)" : "";
    logRow("ok", `${ev.band}: <code>${p.code}</code>, burst ended ${rxSeconds(ev.burstEndAbs)} s, offset ${p.beepOffsetS.toFixed(1)} s → beep at ${rxSeconds(ev.predictedBeepAbs)} s`
      + `${ev.erasures ? `, ${ev.erasures} byte erasure${ev.erasures > 1 ? "s" : ""}` : ""}${note}`
      + `${!$("rx-click-on").checked ? "" : when === null ? " (too late to schedule the tick)" : `; tick scheduled${preds.length > 1 ? ` at the mean of ${preds.length} predictions` : ""}`}`);
    return;
  }
  if (ev.type === "beep") {
    const err = ev.errorMs;
    $("rx-beep-err").textContent = `${err >= 0 ? "+" : ""}${err.toFixed(0)} ms`;
    $("rx-beep-err").className = Math.abs(err) <= 60 ? "good" : "warnc";
    setStatus("beep", `Start beep heard ${err >= 0 ? "+" : ""}${err.toFixed(0)} ms from the prediction`);
    marker("beep", "♪", 1);
    logRow("ok", `start beep detected at ${rxSeconds(ev.beepAbs)} s, ${err >= 0 ? "+" : ""}${err.toFixed(0)} ms from prediction (${ev.decodes.length} cop${ev.decodes.length > 1 ? "ies" : "y"})`);
    S.armed = null;
    return;
  }
  if (ev.type === "beep-missed") {
    setStatus("listening", "No start beep heard near the prediction; listening…");
    logRow("warn", `no start beep found near the predicted ${rxSeconds(ev.predictedBeepAbs)} s`);
    S.armed = null;
  }
}

function showPayload(ev) {
  const p = ev.payload;
  $("rx-code").textContent = p.code;
  const timing = p.splits > 1 ? `${p.splits} × ${p.splitLength} s (${p.durationS} s)` : p.splitLength ? `${p.splitLength} s` : "open-ended";
  const rows = [
    ["Event", `${NAMES.event[p.abbr] || p.abbr.toUpperCase()}`],
    ["Organisation", NAMES.org[p.org] || p.org],
    ["Type · discipline", `${NAMES.type[p.type] || p.type} · ${NAMES.discipline[p.discipline] || p.discipline}`],
    ["Participants", p.participants],
    ["Timing", timing],
    ["Beep offset", `${p.beepOffsetS.toFixed(1)} s after the burst`],
    ["Band · score", `<span style="color:${BAND_COLOR[ev.band]}">${ev.band}</span> · ${ev.score.toFixed(0)}× noise`],
  ];
  $("rx-fields").innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  $("rx-symbols").innerHTML = ev.symbols.map((s) => {
    const a = Math.max(0.12, Math.min(1, s.conf * 1.6));
    return `<span style="background:color-mix(in srgb, ${BAND_COLOR[ev.band]} ${Math.round(a * 100)}%, transparent)" title="confidence ${s.conf.toFixed(2)}">${s.value.toString(16)}</span>`;
  }).join("");
  $("rx-beep-err").textContent = "—";
  $("rx-beep-err").className = "";
}

function setStatus(kind, text) {
  const el = $("rx-status");
  el.dataset.kind = kind;
  $("rx-status-text").textContent = text;
}

function logRow(kind, html) {
  const t = S ? S.ctx.currentTime.toFixed(1).padStart(6) : "";
  const row = document.createElement("div");
  row.className = `rx-log-row ${kind}`;
  row.innerHTML = `<span class="t">${t}</span> ${html}`;
  const log = $("rx-log");
  log.prepend(row);
  while (log.children.length > 60) log.lastChild.remove();
}

function showInfo() {
  const st = S.track.getSettings();
  const { input, output } = latencies();
  const flag = (v) => (v ? "on" : "off");
  $("rx-info").textContent = `${S.ctx.sampleRate} Hz · mic ${st.deviceId ? (S.track.label || "default") : "default"} · `
    + `echo cancel ${flag(st.echoCancellation)}, noise supp. ${flag(st.noiseSuppression)}, auto gain ${flag(st.autoGainControl)} · `
    + `latency in ${(input * 1000).toFixed(0)} ms / out ${(output * 1000).toFixed(0)} ms (compensated for the click)`;
}

// ------------------------------------------------------------------ drawing
const MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
const LUT = Array.from({ length: 256 }, (_, i) => {
  const x = (i / 255) * (MAGMA.length - 1), k = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - k;
  return MAGMA[k].map((c, j) => Math.round(c + (MAGMA[k + 1][j] - c) * f));
});
const markers = [];
function marker(band, label, alpha) { markers.push({ band, label, alpha, fresh: true }); }

function fitCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
  return false;
}

function draw() {
  if (!S) return;
  S.raf = requestAnimationFrame(draw);
  S.analyser.getFloatFrequencyData(S.freq);
  drawSpectrum();
  drawWaterfall();
  drawMeters();
  drawCountdown();
}

function drawSpectrum() {
  const c = $("rx-spectrum"), g = c.getContext("2d");
  fitCanvas(c);
  const W = c.width, H = c.height, nyq = S.ctx.sampleRate / 2, split = 12000;
  const xOf = (f) => (f < split ? 0.38 * W * (f / split) : 0.38 * W + 0.62 * W * ((f - split) / (nyq - split)));
  const yOf = (db) => H - ((db - S.analyser.minDecibels) / (S.analyser.maxDecibels - S.analyser.minDecibels)) * (H - 18) - 16;
  g.clearRect(0, 0, W, H);
  for (const [name, { f0, f1 }] of Object.entries(BANDS)) {
    g.fillStyle = BAND_COLOR[name] + "22";
    g.fillRect(xOf(f0), 0, xOf(f1) - xOf(f0), H - 16);
    g.fillStyle = BAND_COLOR[name];
    g.font = `${11 * devicePixelRatio}px ui-monospace, monospace`;
    g.fillText(name, xOf(f0) + 4, (name === "mid" ? 14 : 28) * devicePixelRatio);
  }
  g.strokeStyle = "#ffffff14";
  g.fillStyle = "#8b949e";
  g.font = `${10 * devicePixelRatio}px ui-monospace, monospace`;
  for (const f of [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000]) {
    if (f > nyq) continue;
    const x = xOf(f);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 16); g.stroke();
    g.fillText(`${f / 1000}k`, x + 2, H - 4);
  }
  const n = S.freq.length, binHz = nyq / n;
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, "#0ea5e955"); grad.addColorStop(0.6, "#a855f7aa"); grad.addColorStop(1, "#f472b6");
  g.beginPath();
  g.moveTo(0, H - 16);
  for (let i = 1; i < n; i++) {
    const db = Math.max(S.analyser.minDecibels, S.freq[i]);
    S.peak[i] = Math.max(db, S.peak[i] - 0.4);
    g.lineTo(xOf(i * binHz), yOf(db));
  }
  g.lineTo(W, H - 16);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  for (let i = 1; i < n; i++) g.lineTo(xOf(i * binHz), yOf(S.peak[i]));
  g.strokeStyle = "#fde68a99";
  g.lineWidth = devicePixelRatio;
  g.stroke();
}

function drawWaterfall() {
  const c = $("rx-waterfall"), g = c.getContext("2d");
  if (fitCanvas(c)) { g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); }
  const W = c.width, H = c.height, step = Math.max(1, Math.round(2 * devicePixelRatio));
  const nyq = S.ctx.sampleRate / 2, fLo = 12000, fHi = Math.min(21500, nyq), n = S.freq.length, binHz = nyq / n;
  g.drawImage(c, -step, 0);
  const col = g.createImageData(step, H);
  for (let y = 0; y < H; y++) {
    const f = fHi - ((fHi - fLo) * y) / (H - 1), i = Math.min(n - 1, Math.round(f / binHz));
    const v = Math.max(0, Math.min(255, Math.round(((S.freq[i] + 120) / 75) * 255)));
    const [r, gg, b] = LUT[v];
    for (let x = 0; x < step; x++) { const o = (y * step + x) * 4; col.data[o] = r; col.data[o + 1] = gg; col.data[o + 2] = b; col.data[o + 3] = 255; }
  }
  g.putImageData(col, W - step, 0);
  for (const m of markers.filter((m) => m.fresh)) {
    m.fresh = false;
    const color = m.band === "beep" ? "#facc15" : BAND_COLOR[m.band];
    g.globalAlpha = m.alpha;
    g.fillStyle = color;
    g.fillRect(W - step, 0, step, H);
    g.font = `bold ${13 * devicePixelRatio}px ui-monospace, monospace`;
    g.fillText(m.label, W - step - 12 * devicePixelRatio, 16 * devicePixelRatio);
    g.globalAlpha = 1;
  }
  markers.length = 0;
  // band guides
  g.setLineDash([4 * devicePixelRatio, 6 * devicePixelRatio]);
  for (const [name, { f0, f1 }] of Object.entries(BANDS)) {
    g.strokeStyle = BAND_COLOR[name] + "55";
    for (const f of [f0, f1]) {
      const y = ((fHi - f) / (fHi - fLo)) * (H - 1);
      g.beginPath(); g.moveTo(W - step, y); g.lineTo(W, y); g.stroke();
    }
  }
  g.setLineDash([]);
}

function drawMeters() {
  for (const band of Object.keys(BANDS)) {
    const v = S.rx.levels[band] || 0, el = $(`rx-meter-${band}`);
    const pct = Math.max(0, Math.min(100, (Math.log10(Math.max(1, v)) / Math.log10(300)) * 100));
    el.querySelector(".fill").style.width = `${pct}%`;
    el.querySelector(".val").textContent = `${v.toFixed(1)}×`;
    const hot = performance.now() - (S.lastPreamble[band] || 0) < 600;
    el.classList.toggle("hot", hot || v >= PRE_THRESH);
  }
}

function drawCountdown() {
  const el = $("rx-countdown");
  if (!S.armed) { el.textContent = "—"; return; }
  const left = absToCtxTime(S.armed.predAbs) - S.ctx.currentTime;
  el.textContent = left > 0 ? `${left.toFixed(1)} s` : "now";
}

// ------------------------------------------------------------------ controls
$("rx-start").addEventListener("click", async () => {
  if (S) { stop(); return; }
  try { await start(); } catch (e) { setStatus("error", `Could not start the microphone: ${e.message}`); }
});
$("rx-test-click").addEventListener("click", () => playClick());
const trim = $("rx-trim");
trim.value = localStorage.getItem("rx-trim") || "0";
const showTrim = () => { $("rx-trim-val").textContent = `${trim.value > 0 ? "+" : ""}${trim.value} ms`; };
trim.addEventListener("input", () => { localStorage.setItem("rx-trim", trim.value); showTrim(); });
showTrim();
// per-band threshold tick on the meters
for (const band of Object.keys(BANDS)) {
  $(`rx-meter-${band}`).querySelector(".tick").style.left = `${(Math.log10(PRE_THRESH) / Math.log10(300)) * 100}%`;
}
