#!/usr/bin/env python3
"""Подгонка границ клипов под паузы в звуке.

Порт идеи snap_boundaries.py из claude-shorts (MIT), но без whisper:
границы ищутся по тишине через ffmpeg silencedetect, только stdlib.

Использование:
  python snap_boundaries.py --video IN.mp4 --segments approved.json --out snapped.json
  python snap_boundaries.py --video IN.mp4 --segments approved.json --out snapped.json --no-silence

approved.json:
  {"segments":[{"id":1,"start":262.0,"end":301.0}, ...]}
"""
import argparse
import json
import os
import re
import subprocess
import sys

MIN_DUR = 5.0
MAX_DUR = 60.0
PAD_AFTER = 0.30
SEARCH = 1.5


def find_ffmpeg(explicit=None):
    if explicit:
        return explicit
    for name in ("ffmpeg", "ffmpeg.exe"):
        for base in (os.environ.get("LOCALAPPDATA", ""),):
            if not base:
                continue
            tools = os.path.join(base, "Sinty", "tools")
            if not os.path.isdir(tools):
                continue
            for d in sorted(os.listdir(tools)):
                if d.lower().startswith("ffmpeg"):
                    for sub in ("bin", ""):
                        p = os.path.join(tools, d, sub, name)
                        if os.path.isfile(p):
                            return p
    return name


def silence_map(ffmpeg, video, noise="-32dB", min_len="0.28"):
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-i", video,
           "-af", "silencedetect=noise=%s:d=%s" % (noise, min_len), "-f", "null", "-"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    except OSError as exc:
        sys.exit("ffmpeg не запустился: %s" % exc)
    out = (p.stderr or "") + (p.stdout or "")
    starts = [float(x) for x in re.findall(r"silence_start:\s*(-?[\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*(-?[\d.]+)", out)]
    return starts, ends


def nearest_pause(t, starts, ends):
    """Ближайшая точка внутри паузы, либо None."""
    best = None
    for s, e in zip(starts, ends):
        if s <= t <= e:
            return t
        d = min(abs(t - s), abs(t - e))
        if d <= SEARCH:
            point = s if abs(t - s) <= abs(t - e) else e
            if best is None or d < best[0]:
                best = (d, point)
    return best[1] if best else None


def duration(ffmpeg, video):
    probe = ffmpeg.replace("ffmpeg.exe", "ffprobe.exe").replace("ffmpeg", "ffprobe")
    try:
        p = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", video], capture_output=True, text=True)
        return float((p.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--segments", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default=None)
    ap.add_argument("--no-silence", action="store_true")
    a = ap.parse_args()

    ffmpeg = find_ffmpeg(a.ffmpeg)
    total = duration(ffmpeg, a.video)

    starts, ends = ([], []) if a.no_silence else silence_map(ffmpeg, a.video)

    with open(a.segments, "r", encoding="utf-8") as f:
        data = json.load(f)

    report = []
    for seg in data.get("segments", []):
        s0 = float(seg.get("start", 0))
        e0 = float(seg.get("end", s0 + MIN_DUR))
        s = nearest_pause(s0, starts, ends)
        e = nearest_pause(e0, starts, ends)
        if s is None:
            s = s0
        if e is None:
            e = e0 + PAD_AFTER
        if e - s < MIN_DUR:
            e = s + MIN_DUR
        if e - s > MAX_DUR:
            e = s + MAX_DUR
        if total:
            e = min(e, total)
        seg["start"] = round(s, 2)
        seg["end"] = round(e, 2)
        seg["duration"] = round(e - s, 2)
        report.append({"id": seg.get("id"), "start_delta": round(s - s0, 2),
                       "end_delta": round(e - e0, 2), "duration": seg["duration"]})

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(json.dumps({"pauses": len(starts), "segments": report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
