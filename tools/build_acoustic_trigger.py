"""Build the unlisted acoustic-trigger page for andrejpk.github.io.

Run make_examples.py and make_mp3_examples.py in the experiment first, then:
  uv run --no-project --with markdown,numpy,matplotlib,soundfile \
    python tools/build_acoustic_trigger.py <experiment dir> <output dir>
"""
import csv
import html
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import markdown
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf

src, out = Path(sys.argv[1]), Path(sys.argv[2])
examples = src / "out" / "examples"
(out / "audio").mkdir(parents=True, exist_ok=True)
(out / "spectrograms").mkdir(parents=True, exist_ok=True)
(out / "mp3").mkdir(parents=True, exist_ok=True)
(out / "downloads").mkdir(parents=True, exist_ok=True)

SCHEMES = [("mfsk16", "mid"), ("mfsk16f", "mid"), ("mfsk32", "mid"),
           ("mfsk16", "low"), ("css30", "mid"), ("ggwave", "-")]
LEVELS = (-12, -20)
HEARD_TAIL_S = 2.0  # make_examples.py simulates the track up to 2 s after the start beep


def spectrogram(ax, y, fs, t_end, title):
    seg = y[: int(t_end * fs)]
    ax.specgram(seg, NFFT=2048, Fs=fs, noverlap=1536, cmap="magma", vmin=-140, vmax=-40)
    ax.set_ylim(0, min(fs / 2, 22000))
    ax.set_yticks(range(0, 22001, 4000))
    ax.set_yticklabels([f"{f // 1000}k" for f in range(0, 22001, 4000)])
    ax.set_title(title, fontsize=10, loc="left")
    ax.set_ylabel("Hz")


cells = {}
for kind, band in SCHEMES:
    for lvl in LEVELS:
        name = f"SRSS_{kind}_{band}_{lvl}dB"
        clean, fs = sf.read(examples / f"{name}.wav")
        heard, hfs = sf.read(examples / f"{name}_as_heard_gym15m.wav")
        t_end = len(heard) / hfs
        beep = t_end - HEARD_TAIL_S

        for stem in (name, f"{name}_as_heard_gym15m"):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", examples / f"{stem}.wav",
                            "-compression_level", "8", out / "audio" / f"{stem}.flac"], check=True)

        fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 5.2), sharex=True, constrained_layout=True)
        spectrogram(a1, clean, fs, t_end, "Embedded track (what the speaker plays)")
        spectrogram(a2, heard, hfs, t_end, "Simulated capture, gym at 15 m, 5 dB SNR")
        for a in (a1, a2):
            a.axvline(beep, color="cyan", lw=0.8, ls="--")
        a2.set_xlabel(f"seconds (dashed line = start beep at {beep:.2f} s)")
        fig.suptitle(f"{kind} · band {band} · {lvl} dBFS", fontsize=11)
        fig.savefig(out / "spectrograms" / f"{name}.png", dpi=90)
        plt.close(fig)
        cells[(kind, band, lvl)] = name
        print("built", name)


def cell(name):
    return f"""<td>
  <div class="lbl">Embedded track</div>
  <audio controls preload="none" src="audio/{name}.flac"></audio>
  <a class="dl" href="audio/{name}.flac" download>download FLAC</a>
  <div class="lbl">As heard, gym 15 m</div>
  <audio controls preload="none" src="audio/{name}_as_heard_gym15m.flac"></audio>
  <a class="dl" href="audio/{name}_as_heard_gym15m.flac" download>download FLAC</a>
  <a href="spectrograms/{name}.png"><img loading="lazy" src="spectrograms/{name}.png" alt="Spectrogram of {name}"></a>
</td>"""


rows = "\n".join(
    f"<tr><th>{kind}<br><span class=\"band\">band {band}</span></th>"
    + "".join(cell(cells[(kind, band, lvl)]) for lvl in LEVELS) + "</tr>"
    for kind, band in SCHEMES)

examples_html = f"""
<section id="listening-examples">
<h2>Listening examples</h2>
<p>The IJRU <code>SRSS</code> timing track with the trigger burst for
<code>e.ijru.sp.sr.srss.1.30</code> embedded in its announcement, for each scheme at two
levels. The <em>embedded track</em> is what the speaker would play. The <em>as heard</em> version
simulates a phone 15 m from the speaker in a gym (RT60 ≈ 1 s, crowd noise at 5 dB SNR) and runs
until 2 s after the start beep. The −12 dBFS examples are deliberately loud; −20 dBFS is the
recommended level. Audio is lossless FLAC, so the 16–20 kHz band is intact. Use headphones and
don't turn the volume up too far: the bursts sit near the top of the audible range.</p>
<p>In the spectrograms the burst is the chirp preamble followed by stepped tones above 15 kHz,
early in the announcement; the dashed line marks the start beep. Click a spectrogram to enlarge it.</p>
<div class="scroll"><table class="examples">
<thead><tr><th></th>{''.join(f'<th>{l} dBFS</th>' for l in LEVELS)}</tr></thead>
<tbody>
{rows}
</tbody></table></div>
</section>
"""

ENCODER_LABELS = {
    "cbr192_mono": "192 kbps mono",
    "cbr192_stereo": "192 kbps stereo",
    "v2_stereo": "VBR V2 stereo (LAME standard preset)",
    "cbr128_stereo": "128 kbps stereo",
    "cbr128_stereo_lp20k": "128 kbps stereo, low-pass forced to 20 kHz",
    "cbr320_stereo": "320 kbps stereo",
}

mp3_dir = examples / "mp3"
mp3_rows = []
with open(mp3_dir / "decoded.csv") as f:
    for row in csv.DictReader(f):
        name = row["name"]
        (out / "mp3" / f"{name}.mp3").write_bytes((mp3_dir / f"{name}.mp3").read_bytes())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3_dir / f"{name}_as_heard_gym15m.wav",
                        "-compression_level", "8", out / "mp3" / f"{name}_as_heard_gym15m.flac"], check=True)
        with tempfile.TemporaryDirectory() as d:
            dec = Path(d) / "dec.wav"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3_dir / f"{name}.mp3", "-ac", "1", dec], check=True)
            played, fs = sf.read(dec)
        heard, hfs = sf.read(mp3_dir / f"{name}_as_heard_gym15m.wav")
        t_end = len(heard) / hfs
        fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 5.2), sharex=True, constrained_layout=True)
        spectrogram(a1, played, fs, t_end, "Decoded MP3 (what the speaker plays)")
        spectrogram(a2, heard, hfs, t_end, "Simulated capture, gym at 15 m, 5 dB SNR")
        for a in (a1, a2):
            a.axvline(t_end - HEARD_TAIL_S, color="cyan", lw=0.8, ls="--")
        a2.set_xlabel("seconds (dashed line = start beep)")
        fig.suptitle(f"{row['kind']} · band {row['band']} · -20 dBFS · {ENCODER_LABELS.get(row['encoder'], row['encoder'])}", fontsize=11)
        fig.savefig(out / "spectrograms" / f"{name}.png", dpi=90)
        plt.close(fig)
        mp3_rows.append(row)
        print("built", name)

mp3_table = "\n".join(f"""<tr><th>{html.escape(ENCODER_LABELS.get(r["encoder"], r["encoder"]))}<br>
<span class="band">{r["kind"]}, band {r["band"]}</span><br>
<span class="{'ok' if r['decoded_gym15m'] == 'True' else 'bad'}">{'decodes' if r['decoded_gym15m'] == 'True' else 'does not decode'}</span></th>
<td>
  <div class="lbl">MP3 file</div>
  <audio controls preload="none" src="mp3/{r['name']}.mp3"></audio>
  <a class="dl" href="mp3/{r['name']}.mp3" download>download MP3</a>
  <div class="lbl">As heard, gym 15 m</div>
  <audio controls preload="none" src="mp3/{r['name']}_as_heard_gym15m.flac"></audio>
  <a class="dl" href="mp3/{r['name']}_as_heard_gym15m.flac" download>download FLAC</a>
</td>
<td><a href="spectrograms/{r['name']}.png"><img loading="lazy" src="spectrograms/{r['name']}.png" alt="Spectrogram of {r['name']}"></a></td></tr>"""
    for r in mp3_rows)

mp3_html = f"""
<section id="mp3-listening-examples">
<h3>MP3 listening examples</h3>
<p>The recommended burst (<code>mfsk16f</code>, −20 dBFS) in SRSS, encoded the ways an organiser
might. These are the actual MP3 files, so your browser plays exactly what a laptop would. The
<em>as heard</em> capture runs through the same 15 m gym channel as above, and the label says
whether the receiver recovered the code from it. In the spectrograms of the failing encodes,
the encoder's low-pass is a flat ceiling across the whole track: burst tones above it are gone,
and losing those symbols is enough to lose the code.</p>
<div class="scroll"><table class="examples mp3">
<thead><tr><th>Encoding</th><th>Audio</th><th>Spectrogram</th></tr></thead>
<tbody>
{mp3_table}
</tbody></table></div>
</section>
"""

zip_path = out / "downloads" / "acoustic-trigger-examples.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
    for f in sorted((out / "audio").glob("*.flac")):
        z.write(f, f"lossless/{f.name}")
    for f in sorted((out / "mp3").iterdir()):
        z.write(f, f"mp3/{f.name}")
zip_mb = zip_path.stat().st_size / 1e6

md = (src / "README.md").read_text()
md = md.replace("`out/*.wav` examples", "embedded-track examples")
md = md.replace("(copy in `event-definition-lookup-codes.md`)",
                "(copy: [event definition lookup codes](lookup-codes.html))")
md = re.sub(r"Run `make_examples.py` and listen to `out/examples/`",
            "Listen to the [examples](#listening-examples)", md)
exts = ["tables", "fenced_code", "toc", "sane_lists"]
report_html = markdown.markdown(md, extensions=exts)
codes_html = markdown.markdown((src / "event-definition-lookup-codes.md").read_text(), extensions=exts)

CSS = """
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  max-width:1100px;margin:0 auto;padding:24px;color:#1f2328;background:#fff}
h1,h2,h3{line-height:1.25} h2{border-bottom:1px solid #d0d7de;padding-bottom:.3em;margin-top:2em}
code{background:#f6f8fa;padding:.1em .35em;border-radius:4px;font-size:90%}
pre{background:#f6f8fa;padding:12px;overflow:auto;border-radius:6px} pre code{padding:0;background:none}
table{border-collapse:collapse;margin:1em 0} th,td{border:1px solid #d0d7de;padding:6px 10px;vertical-align:top}
.scroll{overflow-x:auto} .examples th{white-space:nowrap;text-align:left} .band{font-weight:400;color:#59636e}
.examples td{min-width:330px} .examples audio{width:100%;height:36px}
.examples img{width:100%;margin-top:6px;border:1px solid #d0d7de}
.lbl{font-size:13px;color:#59636e;margin-top:4px}
.dl{font-size:12px} .ok{color:#1a7f37;font-weight:600} .bad{color:#cf222e;font-weight:600}
.examples.mp3 td{min-width:300px} .examples.mp3 img{margin-top:0}
.note{background:#fff8c5;border:1px solid #d4a72c66;padding:8px 12px;border-radius:6px;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}
  code,pre{background:#161b22} th,td,h2,.examples img{border-color:#30363d} a{color:#4493f8}
  .band,.lbl{color:#9198a1} .note{background:#2e2a1a;border-color:#6e5a1a}
  .ok{color:#3fb950} .bad{color:#f85149}}
"""


def page(title, body):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>{html.escape(title)}</title>
<style>{CSS}</style></head>
<body>
{body}
</body></html>
"""


(out / "index.html").write_text(page(
    "Acoustic event trigger — POC",
    f'<p class="note">Unlisted research notes. Simulation-only proof of concept. '
    f'<a href="downloads/acoustic-trigger-examples.zip" download>Download all example audio</a> '
    f'({zip_mb:.0f} MB zip: lossless FLAC and MP3 examples) · '
    f'<a href="#listening-examples">lossless examples</a> · <a href="#mp3-listening-examples">MP3 examples</a></p>\n'
    + report_html.replace("<hr />", examples_html + "<hr />", 1) + mp3_html))
(out / "lookup-codes.html").write_text(page(
    "Event definition lookup codes",
    '<p><a href="./">← Acoustic event trigger POC</a></p>\n' + codes_html))
