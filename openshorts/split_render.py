"""Split-screen render for stream clips (local addition, used by make-shorts.mjs).

Top half: gameplay, cropped from the centre of the source frame.
Bottom half: the streamer's facecam, found by OpenShorts' own detector
(camera_inset.detect) and enlarged to fill the half.
Captions: OpenShorts' karaoke ASS for the same clip, moved onto the seam.

    python split_render.py detect CAM.json PIECE1 PIECE2 ...   (once per stream)
    python split_render.py SRC START END ASS AUDIO_CLIP OUT X,Y,W,H

SRC        horizontal source piece (1920x1080)
START/END  the clip's window inside SRC, seconds (from the job metadata)
ASS        the job's autosubs_*.ass (timed from the clip start)
AUDIO_CLIP the job's finished clip: its loudness-normalised audio is reused
OUT        output mp4 (1080x1920)

Exit code 2 = no facecam found: the caller keeps the normal layout.
"""
import json
import os
import re
import subprocess
import sys

import camera_inset

OUT_W, OUT_H = 1080, 1920
HALF = OUT_H // 2


def even(v):
    v = int(round(v))
    return v - v % 2


def probe_size(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height", "-of", "json", path], capture_output=True, text=True)
    s = json.loads(r.stdout)["streams"][0]
    return int(s["width"]), int(s["height"])


def guess_window(box, fw, fh):
    """Fallback cam window when the still-pixel search finds none: a typical
    webcam frame around the person (person ~2/3 of its height, at its bottom)."""
    x, y, w, h = box
    wh = min(fh, h * 1.5)
    ww = min(fw, wh * 16 / 9)
    wx = min(max(0, x + w / 2 - ww / 2), fw - ww)
    wy = min(max(0, y + h - wh), fh - wh)
    return [int(wx), int(wy), int(ww), int(wh)]


def cam_crop(box, window, fw, fh):
    """The biggest crop with the bottom half's aspect that fits INSIDE the cam
    window (so no gameplay shows around the streamer), centred on the person
    sideways and keeping their head in."""
    x, y, w, h = box
    wx, wy, ww, wh = window
    # stay a little inside the window's edges (borders, glow)
    m = max(2, int(min(ww, wh) * 0.02))
    wx, wy, ww, wh = wx + m, wy + m, ww - 2 * m, wh - 2 * m
    aspect = OUT_W / HALF
    if ww / wh >= aspect:
        ch, cw = wh, wh * aspect
        x0 = min(max(wx, x + w / 2 - cw / 2), wx + ww - cw)
        y0 = wy
    else:
        cw, ch = ww, ww / aspect
        x0 = wx
        y0 = min(max(wy, y - 0.12 * ch), wy + wh - ch)
    return even(cw), even(ch), even(x0), even(y0)


def game_crop(fw, fh, window=None):
    """Centre crop of the gameplay, slid sideways so it stays clear of the
    cam window."""
    aspect = OUT_W / HALF
    gh = fh
    gw = gh * aspect
    if gw > fw:
        gw, gh = fw, fw / aspect
    gx = (fw - gw) / 2
    if window:
        wx, wy, ww, wh = window
        if wx + ww / 2 < fw / 2:
            gx = max(gx, min(fw - gw, wx + ww * 1.08 + 4))   # margin: the detected edge can sit a little inside the real one
        else:
            gx = min(gx, max(0, wx - ww * 0.08 - 4 - gw))
    return even(gw), even(gh), even(gx), even((fh - gh) / 2)


def find_window(grays, box, fw, fh, s=4):
    """The cam window's rectangle, from its borders. A facecam's border is a straight
    line in the same place in every frame, while gameplay edges move, so edge
    strength averaged over frames from all over the stream picks out the border.
    Each side is searched near the person; a weak side falls back to the person's
    own edge (or the screen edge when the cam touches it)."""
    import cv2
    import numpy as np
    if len(grays) < 6:
        return None
    ex = np.mean([np.abs(cv2.Sobel(g.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)) for g in grays], axis=0)
    ey = np.mean([np.abs(cv2.Sobel(g.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)) for g in grays], axis=0)
    H, W = ex.shape
    x, y, w, h = [int(v / s) for v in box]
    STRONG = 3.0

    def best(profile, lo, hi):
        lo, hi = max(0, lo), min(len(profile) - 1, hi)
        if hi <= lo:
            return None, 0.0
        seg = profile[lo:hi + 1]
        i = int(np.argmax(seg))
        base = float(np.median(profile[max(0, lo - 20):min(len(profile), hi + 20)])) + 1e-6
        return lo + i, float(seg[i]) / base

    colp = ex[max(0, y):min(H, y + h)].mean(axis=0)
    right, rs = best(colp, x + w - int(0.15 * w), x + w + int(1.5 * w))
    left, ls = best(colp, x - int(1.5 * w), x + int(0.15 * w))
    if rs < STRONG:
        right = min(W - 1, x + w)
    if ls < STRONG:
        left = 0 if x < 0.1 * W else x          # cam pinned to the screen's left edge
    if right >= W - 2 or (x + w) > 0.9 * W and rs < STRONG:
        right = W - 1 if (x + w) > 0.9 * W else right
    rowp = ey[:, max(0, left):min(W, right + 1)].mean(axis=1)
    top, ts = best(rowp, y - h, y + int(0.25 * h))
    bottom, bs = best(rowp, y + int(0.6 * h), y + h + int(0.6 * h))
    if ts < STRONG:
        top = y
    if bs < STRONG:
        bottom = min(H - 1, y + h)
    win = [left * s, top * s, (right - left) * s, (bottom - top) * s]
    if win[2] < box[2] * 0.6 or win[3] < box[3] * 0.6 or win[2] * win[3] > 0.25 * fw * fh:
        return None
    return win


def person_window(box, fw, fh):
    """Safe fallback: the person's own box (a streamer often fills the cam). A
    tighter zoom, but it never shows gameplay."""
    x, y, w, h = box
    return [max(0, x), max(0, y), min(w, fw - max(0, x)), min(h, fh - max(0, y))]


def seam_ass(src, dst):
    """Same captions, centred on the seam: Alignment 5 (middle centre), MarginV 0."""
    text = open(src, encoding="utf-8-sig").read()
    out = []
    for line in text.splitlines():
        if line.startswith("Style:"):
            f = line[len("Style:"):].split(",")
            if len(f) >= 23:
                f[18] = "5"   # Alignment
                f[21] = "0"   # MarginV
                line = "Style:" + ",".join(f)
        elif line.startswith("Dialogue:"):
            line = re.sub(r"\\an\d", "", line)
        out.append(line)
    open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")


_yolo = None


def persons(frame):
    """All person boxes [x, y, w, h] with confidence (YOLOv8n, baked into the image)."""
    global _yolo
    if _yolo is None:
        from ultralytics import YOLO
        _yolo = YOLO("yolov8n.pt")
    r = _yolo(frame, classes=[0], verbose=False)[0]
    out = []
    for b in r.boxes:
        cx, cy, w, h = [float(v) for v in b.xywh[0].tolist()]
        out.append(([int(cx - w / 2), int(cy - h / 2), int(w), int(h)], float(b.conf)))
    return out


def cam_person(frame, fw, fh):
    """The streamer in a facecam: a small person near an edge/corner (game
    characters are big or centred, so they drop out)."""
    c = [(b, s) for b, s in persons(frame)
         if camera_inset.is_cornered(b, fw, fh) and b[2] * b[3] < 0.12 * fw * fh]
    return max(c, key=lambda t: t[1])[0] if c else None


def frames(path, positions):
    import cv2
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fw, fh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    for p in positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(p * max(0, total - 1)))
        ok, frame = cap.read()
        if ok:
            yield frame, fw, fh
    cap.release()


def detect_stream_cam(pieces, per_piece=5):
    """The facecam for the whole stream: the person (median box over many
    pieces) and the window around them. The cam stays put, so this is done
    once and serves every clip. Returns [px, py, pw, ph, wx, wy, ww, wh]."""
    import cv2
    boxes, grays, tried, fw, fh = [], [], 0, 0, 0
    for path in pieces:
        for frame, fw, fh in frames(path, [(i + 0.5) / per_piece for i in range(per_piece)]):
            tried += 1
            grays.append(cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (fw // 4, fh // 4), interpolation=cv2.INTER_AREA))
            b = cam_person(frame, fw, fh)
            if b:
                boxes.append(b)
    if len(boxes) < max(3, tried * 0.4):
        return None
    med = lambda k: sorted(b[k] for b in boxes)[len(boxes) // 2]
    box = [med(0), med(1), med(2), med(3)]
    window = find_window(grays, box, fw, fh) or person_window(box, fw, fh)
    return box + window


def cam_visible(src, box, start, end, dur, samples=5):
    """The streamer is in the cam box for most of this clip (not hidden by a
    full-screen scene)."""
    x, y, w, h = box
    hits = 0
    pos = [(float(start) + (float(end) - float(start)) * (i + 0.5) / samples) / dur for i in range(samples)]
    for frame, fw, fh in frames(src, pos):
        for b, _ in persons(frame):
            cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
            if x - w * 0.3 <= cx <= x + w * 1.3 and y - h * 0.3 <= cy <= y + h * 1.3 and b[2] * b[3] < 0.12 * fw * fh:
                hits += 1
                break
    return hits >= (samples + 1) // 2


def main():
    if sys.argv[1] == "detect":   # split_render.py detect OUT.json piece1.mp4 piece2.mp4 ...
        box = detect_stream_cam(sys.argv[3:])
        json.dump({"box": box}, open(sys.argv[2], "w"))
        print("CAM", json.dumps(box))
        return
    src, start, end, ass, audio_clip, out, box_arg = sys.argv[1:8]
    vals = [int(v) for v in box_arg.split(",")]
    box = vals[:4]
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                       capture_output=True, text=True)
    if not cam_visible(src, box, start, end, float(r.stdout.strip() or 0) or 1):
        print("NOCAM")
        sys.exit(2)
    fw, fh = probe_size(src)
    window = vals[4:8] if len(vals) >= 8 else guess_window(box, fw, fh)
    cw, ch, cx, cy = cam_crop(box, window, fw, fh)
    gw, gh, gx, gy = game_crop(fw, fh, window)
    seam = out + ".seam.ass"
    seam_ass(ass, seam)
    graph = (
        f"[0:v]split=2[g][c];"
        f"[g]crop={gw}:{gh}:{gx}:{gy},scale={OUT_W}:{HALF}:flags=lanczos[top];"
        # the cam is small in the source: clean compression blocks first, enlarge, then contrast-adaptive sharpen
        f"[c]crop={cw}:{ch}:{cx}:{cy},hqdn3d=1.5:1.5:4:4,scale={OUT_W}:{HALF}:flags=lanczos,cas=0.7[bot];"
        f"[top][bot]vstack=inputs=2,setsar=1,ass=filename='{seam}'[v]"
    )
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", str(start), "-to", str(end), "-i", src, "-i", audio_clip,
           "-filter_complex", graph, "-map", "[v]", "-map", "1:a:0", "-shortest",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
           "-c:a", "copy", "-movflags", "+faststart", out]
    try:
        subprocess.run(cmd, check=True)
    finally:
        if os.path.exists(seam):
            os.unlink(seam)
    print("SPLIT", json.dumps({"cam_box": box, "window": window, "cam_crop": [cw, ch, cx, cy], "game_crop": [gw, gh, gx, gy]}))


if __name__ == "__main__":
    main()
