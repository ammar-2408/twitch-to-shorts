"""Download parts of a YouTube stream that YouTube still serves as a live broadcast
(live_status "post_live": very long streams can stay like this for days). Such a
stream is a numbered list of short segments (&sq=N, usually 2 s each) instead of
one seekable file, and yt-dlp's --download-sections returns empty files for it.
Local addition, used by make-shorts.mjs.

    python ytlive.py audio URL OUT.m4a DURATION [--cookies FILE]
        the whole audio track (for the loudness search), low bitrate
    python ytlive.py piece URL START END OUT.mp4 [--cookies FILE]
        one stretch in 1080p (H.264) with audio
"""
import concurrent.futures
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

COOKIES = []
MAX_HEIGHT = [1080]  # --height: 1440 gives the facecam more pixels when the stream has it


def fmt_url(url, fmt):
    r = subprocess.run(["yt-dlp", "--no-warnings", "--no-playlist", *COOKIES, "-g", "-f", fmt, url],
                       capture_output=True, text=True)
    lines = r.stdout.strip().splitlines()
    if r.returncode != 0 or not lines:
        sys.exit(f"no stream URL for format {fmt}: {r.stderr.strip()[-300:]}")
    return lines[0]


def fetch(u, n, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(f"{u}&sq={n}", timeout=30) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                return b""  # a missing segment leaves a gap, not a failed run
            time.sleep(1 + 2 * i)


def start_time(data):
    """Start time (s) of one segment, read with ffprobe; None if unreadable."""
    if not data:
        return None
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(data)
        name = f.name
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=start_time", "-of", "csv=p=0", name],
                           capture_output=True, text=True)
        return float(r.stdout.split()[0])
    except (IndexError, ValueError):
        return None
    finally:
        os.unlink(name)


def seg_seconds(u):
    """Segment length: segment N starts at N x length. Tries a few N (a request
    can come back empty); YouTube live segments are 2 s when all else fails."""
    for n in (10, 20, 40, 80):
        t = start_time(fetch(u, n))
        if t:
            return round(t / n, 3)
    return 2.0


def fetch_range(u, first, last, out, workers=16):
    """Segments first..last, in order, appended to out."""
    with open(out, "wb") as f, concurrent.futures.ThreadPoolExecutor(workers) as ex:
        for chunk in range(first, last + 1, 256):
            for data in ex.map(lambda n: fetch(u, n), range(chunk, min(last, chunk + 255) + 1)):
                f.write(data)


def audio(url, out, duration):
    u = fmt_url(url, "139/ba[abr<=80]/ba")
    sd = seg_seconds(u)
    n = math.ceil(float(duration) / sd)
    print(f"{n} audio segments of {sd}s", flush=True)
    fetch_range(u, 0, n, out + ".part")
    os.replace(out + ".part", out)


def piece_once(url, start, end, out):
    h = MAX_HEIGHT[0]
    vu = fmt_url(url, f"bv*[height<={h}][height>1080]/bv*[height<={h}][vcodec^=avc1]/bv*[height<={h}]")
    au = fmt_url(url, "ba[ext=m4a]/ba")
    sd = seg_seconds(au)
    first, last = int(float(start) // sd), int(math.ceil(float(end) / sd))
    tmp = out + ".tmp"
    # The first segment carries the file header: without it the joined file is unreadable.
    for u in (vu, au):
        if not fetch(u, first, tries=10):
            return "first segment unavailable"
    fetch_range(vu, first, last, tmp + ".v.mp4", workers=4)
    fetch_range(au, first, last, tmp + ".a.m4a", workers=4)
    # Plain copy: the mp4 muxer already starts the timeline at 0. (-itsoffset here collapsed
    # every timestamp to 0: ffmpeg still played it, but OpenCV read no frames and the audio
    # decoded as silence, so OpenShorts found no speech.)
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp + ".v.mp4", "-i", tmp + ".a.m4a",
                        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", out],
                       capture_output=True, text=True)
    for f in (tmp + ".v.mp4", tmp + ".a.m4a"):
        if os.path.exists(f):
            os.unlink(f)
    if r.returncode != 0:
        return r.stderr.strip()[-300:]
    return check(out, float(end) - float(start))


def check(path, want):
    """The piece must be readable the way OpenShorts reads it: OpenCV frames from the
    middle, and audio that decodes to real samples over (nearly) the whole length."""
    import cv2
    c = cv2.VideoCapture(path)
    total = c.get(cv2.CAP_PROP_FRAME_COUNT)
    c.set(cv2.CAP_PROP_POS_FRAMES, int(total / 2))
    ok, _ = c.read()
    c.release()
    if not ok:
        return "video frames unreadable"
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "packet=pts_time",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    pts = [float(x.strip(",")) for x in r.stdout.split() if x.strip(",")]
    if not pts or max(pts) - min(pts) < want * 0.9:
        return "audio timestamps broken"
    return None


def piece(url, start, end, out):
    """Up to 3 tries, each with fresh stream URLs (YouTube sometimes drops a request)."""
    err = None
    for attempt in range(3):
        err = piece_once(url, start, end, out)
        if not err:
            return
        time.sleep(5 + 10 * attempt)
    sys.exit(err)


def main():
    args = sys.argv[1:]
    if "--height" in args:
        i = args.index("--height")
        MAX_HEIGHT[0] = int(args[i + 1])
        del args[i:i + 2]
    if "--cookies" in args:
        i = args.index("--cookies")
        COOKIES.extend(["--cookies", args[i + 1]])
        del args[i:i + 2]
    mode = args[0]
    if mode == "audio":
        audio(args[1], args[2], args[3])
    elif mode == "piece":
        piece(args[1], args[2], args[3], args[4])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
