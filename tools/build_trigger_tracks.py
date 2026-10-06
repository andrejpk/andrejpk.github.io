"""Build the unlisted trigger-tracks page for andrejpk.github.io: the IJRU timing-track test
builds from the experiment's make_tracks.py, with players and downloads.

This page must not link back to the experiment report (the report links here, not the
other way round).

Run make_tracks.py in the experiment first, then:
  python3 tools/build_trigger_tracks.py <experiment dir> <output dir>
"""
import csv
import html
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
RECEIVER = Path(__file__).parent / "trigger-receiver"
release = src / "out" / "tracks_release"
(out / "mp3").mkdir(parents=True, exist_ok=True)
(out / "wav").mkdir(parents=True, exist_ok=True)

with open(release / "manifest.csv") as f:
    builds = list(csv.DictReader(f))
CHECKS = ("clean", "gym_15m_snr5", "gym_25m_snr0")
verified = all(b[f"decoded_{c}"] == "True" for b in builds for c in CHECKS)
if not verified:
    sys.exit("refusing to publish: a build failed verification in manifest.csv")

tracks = {}
for b in builds:
    for ext in ("mp3", "wav"):
        shutil.copyfile(release / f"{b['track']}_trigger_{b['band']}.{ext}",
                        out / ext / f"{b['track']}_trigger_{b['band']}.{ext}")
    title = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=title", "-of", "csv=p=0",
                            release / f"{b['track']}_trigger_{b['band']}.mp3"],
                           capture_output=True, text=True, check=True).stdout.strip()
    tracks.setdefault(b["track"], {"title": title, "code": b["code"], "beep": b["beep_s"]})[b["band"]] = b


def mb(p):
    return f"{p.stat().st_size / 1e6:.1f} MB"


def cell(tn, band):
    stem = f"{tn}_trigger_{band}"
    return f"""<td>
  <audio controls preload="none" src="mp3/{stem}.mp3"></audio>
  <div class="dl"><a href="mp3/{stem}.mp3" download>MP3</a> ({mb(out / 'mp3' / f'{stem}.mp3')}) ·
  <a href="wav/{stem}.wav" download>WAV</a> ({mb(out / 'wav' / f'{stem}.wav')})</div>
</td>"""


rows = "\n".join(f"""<tr><th>{html.escape(t['title'])}<br><span class="sub">{tn} · beep at {float(t['beep']):.1f} s</span><br>
<code>{html.escape(t['code'])}</code></th>
{cell(tn, 'mid')}
{cell(tn, 'low')}</tr>""" for tn, t in tracks.items())

zips = {}
for band in ("mid", "low"):
    z = out / f"ijru-trigger-tracks-{band}-mp3.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_STORED) as zf:
        for tn in tracks:
            name = f"{tn}_trigger_{band}.mp3"
            # fixed timestamp so an unchanged rebuild does not rewrite the zip in git
            zf.writestr(zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)), (out / "mp3" / name).read_bytes())
    zips[band] = z

for js in ("trigger-receiver.js", "capture-worklet.js", "receiver-ui.js"):
    shutil.copyfile(RECEIVER / js, out / js)

RECEIVER_HTML = """
<section class="rx" id="receiver">
  <div class="rx-head">
    <h2>Listen for the trigger</h2>
    <div class="rx-controls">
      <button id="rx-start" class="primary">Start listening</button>
      <button id="rx-test-click">Test click</button>
      <label class="chk"><input type="checkbox" id="rx-click-on" checked> click at predicted beep</label>
      <label class="trim">trim <input type="range" id="rx-trim" min="-300" max="300" step="5" value="0"> <span id="rx-trim-val">0 ms</span></label>
    </div>
  </div>
  <p class="rx-hint">Turns on this device's microphone and decodes the trigger live. Play a track on this
  device or on another one nearby (speaker, not headphones). When a trigger decodes, this page plays a short
  high <em>tick</em> at the predicted start beep, so you can hear how well the prediction lines up with the
  track's own beep; use <em>trim</em> to correct for your device's audio delay. Nothing leaves your device.</p>
  <div class="rx-status" id="rx-status" data-kind="off"><span class="dot"></span><span id="rx-status-text">Microphone off</span></div>
  <canvas id="rx-spectrum" class="rx-spectrum"></canvas>
  <div class="rx-wf-wrap"><canvas id="rx-waterfall" class="rx-waterfall"></canvas>
    <div class="rx-wf-axis"><span style="top:15.8%">20k</span><span style="top:36.8%">18k</span><span style="top:57.9%">16k</span><span style="top:78.9%">14k</span></div></div>
  <div class="rx-grid">
    <div class="rx-card">
      <h3>Preamble detector</h3>
      <div class="rx-meter" id="rx-meter-mid"><span class="name" style="color:#22d3ee">mid</span><div class="bar"><div class="fill"></div><div class="tick"></div></div><span class="val">0×</span></div>
      <div class="rx-meter" id="rx-meter-low"><span class="name" style="color:#e879f9">low</span><div class="bar"><div class="fill"></div><div class="tick"></div></div><span class="val">0×</span></div>
      <h3>Start beep</h3>
      <div class="rx-big"><span class="lbl">in</span> <span id="rx-countdown">—</span></div>
      <div class="rx-big"><span class="lbl">error</span> <span id="rx-beep-err">—</span></div>
      <div class="rx-small">rejected candidates: <span id="rx-rejected">0</span>
        <label class="chk"><input type="checkbox" id="rx-verbose"> show</label></div>
    </div>
    <div class="rx-card rx-payload">
      <h3>Decoded payload</h3>
      <div class="rx-code" id="rx-code">waiting for a trigger…</div>
      <table id="rx-fields"></table>
      <div class="rx-symbols" id="rx-symbols"></div>
    </div>
  </div>
  <div class="rx-log" id="rx-log"></div>
  <div class="rx-info" id="rx-info"></div>
</section>
<script type="module" src="receiver-ui.js"></script>
"""

CSS = """
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  max-width:1100px;margin:0 auto;padding:24px;color:#1f2328;background:#fff}
code{background:#f6f8fa;padding:.1em .35em;border-radius:4px;font-size:85%}
table{border-collapse:collapse;margin:1em 0;width:100%} th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top}
thead th{text-align:left} tbody th{text-align:left;font-weight:600;width:30%}
.sub{font-weight:400;color:#59636e;font-size:14px} audio{width:100%;height:36px} .dl{font-size:13px;margin-top:4px}
.scroll{overflow-x:auto} .note{background:#fff8c5;border:1px solid #d4a72c66;padding:8px 12px;border-radius:6px;font-size:14px}
.rx{background:#070b12;color:#d6deeb;border:1px solid #1f2a3a;border-radius:14px;padding:16px 18px 12px;margin:1.5em 0;
  box-shadow:0 0 0 1px #0b1220,0 10px 40px #0007;font-size:14px}
.rx h2{margin:0;font-size:18px;letter-spacing:.02em;color:#e6edf3} .rx h3{margin:0 0 8px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7d8aa0}
.rx-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.rx-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.rx button{font:inherit;border:1px solid #2b3a52;background:#0f1726;color:#d6deeb;border-radius:8px;padding:6px 12px;cursor:pointer}
.rx button.primary{background:linear-gradient(135deg,#0891b2,#7c3aed);border-color:transparent;color:#fff;font-weight:600}
.rx label{color:#9fb0c8;font-size:13px;display:flex;align-items:center;gap:6px} .rx input[type=range]{width:110px;accent-color:#a78bfa}
.rx-hint{color:#8a97ab;font-size:13px;margin:10px 0}
.rx-status{display:flex;align-items:center;gap:10px;font-weight:600;padding:8px 12px;border-radius:8px;background:#0d1524;margin-bottom:10px}
.rx-status .dot{width:10px;height:10px;border-radius:50%;background:#475569}
.rx-status[data-kind=listening] .dot{background:#22c55e;box-shadow:0 0 10px #22c55e;animation:rxpulse 1.6s infinite}
.rx-status[data-kind=armed]{background:#1e1036} .rx-status[data-kind=armed] .dot{background:#e879f9;box-shadow:0 0 12px #e879f9}
.rx-status[data-kind=beep]{background:#2a2008} .rx-status[data-kind=beep] .dot{background:#facc15;box-shadow:0 0 12px #facc15}
.rx-status[data-kind=error] .dot{background:#ef4444}
@keyframes rxpulse{50%{opacity:.35}}
.rx-spectrum{width:100%;height:190px;display:block;background:radial-gradient(ellipse at 70% 0%,#111a2e,#05080e);border-radius:8px}
.rx-wf-wrap{position:relative;margin-top:8px} .rx-waterfall{width:100%;height:150px;display:block;border-radius:8px;background:#000;image-rendering:pixelated}
.rx-wf-axis{position:absolute;left:6px;top:0;bottom:0;font:10px ui-monospace,monospace;color:#cbd5e1aa;pointer-events:none}
.rx-wf-axis span{position:absolute;left:0;transform:translateY(-50%)}
.rx-grid{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:10px;margin-top:10px} @media (max-width:720px){.rx-grid{grid-template-columns:1fr}}
.rx-card{background:#0b1220;border:1px solid #1a2436;border-radius:10px;padding:12px}
.rx-meter{display:grid;grid-template-columns:34px 1fr 54px;align-items:center;gap:8px;margin:6px 0;font:12px ui-monospace,monospace}
.rx-meter .bar{position:relative;height:10px;background:#111827;border-radius:5px;overflow:hidden}
.rx-meter .fill{height:100%;width:0;background:linear-gradient(90deg,#334155,#64748b);transition:width .1s}
.rx-meter.hot .fill{background:linear-gradient(90deg,#0891b2,#22d3ee,#e879f9)} .rx-meter .tick{position:absolute;top:0;bottom:0;width:2px;background:#facc15}
.rx-meter .val{text-align:right;color:#9fb0c8}
.rx-big{font:600 22px ui-monospace,monospace;color:#e6edf3;margin:4px 0} .rx-big .lbl{font-size:11px;color:#7d8aa0;text-transform:uppercase;letter-spacing:.1em}
.rx-big .good{color:#4ade80} .rx-big .warnc{color:#fbbf24}
.rx-code{font:600 18px ui-monospace,monospace;color:#67e8f9;margin-bottom:8px;word-break:break-all}
.rx table{width:100%;border-collapse:collapse;margin:0} .rx th,.rx td{border:0;border-bottom:1px solid #162033;padding:3px 6px;font-size:13px;text-align:left}
.rx th{color:#7d8aa0;font-weight:500;width:38%}
.rx-symbols{display:grid;grid-template-columns:repeat(24,1fr);gap:3px;margin-top:10px}
.rx-symbols span{font:11px ui-monospace,monospace;text-align:center;padding:4px 0;border-radius:3px;color:#0b1220;background:#1e293b}
.rx-log{margin-top:10px;max-height:170px;overflow:auto;font:12px ui-monospace,monospace;background:#05080e;border-radius:8px;padding:6px 8px}
.rx-log-row{padding:2px 0;color:#cbd5e1} .rx-log-row .t{color:#475569} .rx-log-row.dim{color:#64748b} .rx-log-row.warn{color:#fbbf24} .rx-log-row.ok{color:#a7f3d0}
.rx-log-row code{background:#0f1a2c;color:#67e8f9}
.rx-small{font:12px ui-monospace,monospace;color:#7d8aa0;display:flex;gap:8px;align-items:center;margin-top:6px}
.rx-info{margin-top:6px;font:11px ui-monospace,monospace;color:#64748b}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3} code{background:#161b22}
  th,td{border-color:#30363d} a{color:#4493f8} .sub{color:#9198a1} .note{background:#2e2a1a;border-color:#6e5a1a}}
"""

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>IJRU timing tracks with event trigger (test builds)</title>
<style>{CSS}</style></head>
<body>
<h1>IJRU timing tracks with event trigger</h1>
<p class="note">Test builds, not official IJRU releases. Based on the IJRU timing tracks v1.0.0
from <a href="https://ijru.sport/rules/timing-tracks-and-score-sheets">ijru.sport</a>; the
announcement, beeps and timing are unchanged.</p>
<p>Each track carries its event definition lookup code and the time to the start beep as a short
near-ultrasonic data burst, played twice early in the announcement. A phone listening in the gym
can decode it and know which event is about to start before the beep.</p>
<ul>
<li><strong>Mid band</strong> (17.5–19.5 kHz) is the default build. <strong>Low band</strong>
(16–18 kHz) is a fallback for sound systems that cut the top of the range; it is easier to hear.</li>
<li>Play the files as they are. The MP3s are mono 320 kbps; re-encoding them, especially to
stereo below 320 kbps or with the LAME V2 preset, can strip the trigger. Use the WAV if your
software needs a different format.</li>
<li>Every file here was decoded successfully from the published MP3 in simulated clean and
gym conditions before publishing.</li>
</ul>
{RECEIVER_HTML}
<p>Download all MP3s: <a href="{zips['mid'].name}" download>mid band</a> ({mb(zips['mid'])}) ·
<a href="{zips['low'].name}" download>low band</a> ({mb(zips['low'])})</p>
<div class="scroll"><table>
<thead><tr><th>Track</th><th>Mid band (default)</th><th>Low band (fallback)</th></tr></thead>
<tbody>
{rows}
</tbody></table></div>
</body></html>
"""
(out / "index.html").write_text(page)
print(f"built {len(builds)} builds for {len(tracks)} tracks")
