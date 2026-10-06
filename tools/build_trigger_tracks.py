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

CSS = """
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  max-width:1100px;margin:0 auto;padding:24px;color:#1f2328;background:#fff}
code{background:#f6f8fa;padding:.1em .35em;border-radius:4px;font-size:85%}
table{border-collapse:collapse;margin:1em 0;width:100%} th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top}
thead th{text-align:left} tbody th{text-align:left;font-weight:600;width:30%}
.sub{font-weight:400;color:#59636e;font-size:14px} audio{width:100%;height:36px} .dl{font-size:13px;margin-top:4px}
.scroll{overflow-x:auto} .note{background:#fff8c5;border:1px solid #d4a72c66;padding:8px 12px;border-radius:6px;font-size:14px}
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
