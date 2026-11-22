"""AI voiceover intro (local addition, used by make-shorts.mjs).

Before the clip plays: its first frame, frozen, blurred and slowly zooming,
with an AI voice (Microsoft Edge neural TTS through edge-tts: free, no key)
speaking a short hook line, the words shown as captions as they are spoken.
Then the clip plays as it was.

    python intro_voice.py IN.mp4 OUT.mp4 "TEXT" [--voice NAME] [--max 5.5] [--seam Y]
"""
import asyncio
import json
import os
import subprocess
import sys

import edge_tts

VOICE = "en-US-AndrewNeural"
MAX = 5.5          # seconds of intro at most
PAD = 0.35         # silence after the last word before the clip starts


async def speak_once(text, voice, rate, mp3):
    words = []
    c = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    with open(mp3, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                s = ch["offset"] / 1e7
                words.append((s, s + ch["duration"] / 1e7, ch["text"]))
    return words


async def speak(text, voice, rate, mp3, tries=20):
    """Voice to mp3; returns [(start, end, word)] in seconds. The free service
    drops some requests ("No audio was received"), so retry with pauses."""
    for i in range(tries):
        try:
            return await speak_once(text, voice, rate, mp3)
        except edge_tts.exceptions.NoAudioReceived:
            if i == tries - 1:
                raise
            await asyncio.sleep(min(45, 3 + 4 * i))   # the service refuses in bursts, sometimes for minutes: wait it out (~10 min max)


def probe(path, entries, stream="v:0"):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entries,
                        "-of", "json", path], capture_output=True, text=True)
    return json.loads(r.stdout or "{}")


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip() or 0)


def ass_time(t):
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def captions(words, total, path, w, h, seam=None):
    """Karaoke-style captions, a few words at a time (up to ~10 letters, so a line
    always fits the width), the one being spoken in yellow."""
    size = int(h * 0.095)   # about the size of OpenShorts' own captions
    head = (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
            "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
            "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Hook,Anton,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,1,{max(4, size // 14)},2,5,60,60,0,1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    lines = []
    groups, cur = [], []
    for wd in words:
        keep_with_prev = wd[2].isdigit() and len(wd[2]) <= 2          # "GTA 6" stays together
        if cur and not keep_with_prev and (len(" ".join(x[2] for x in cur + [wd])) > 10 or len(cur) >= 3):
            groups.append(cur)
            cur = []
        cur.append(wd)
    if cur:
        groups.append(cur)
    for gi, g in enumerate(groups):
        for wi, (s, e, _) in enumerate(g):
            nxt = g[wi + 1][0] if wi + 1 < len(g) else (groups[gi + 1][0][0] if gi + 1 < len(groups) else total)
            text = " ".join(("{\\c&H00E5FF&}" + x.upper() + "{\\c&HFFFFFF&}") if j == wi else x.upper()
                            for j, (_, _, x) in enumerate(g))
            pos = "{\\pos(%d,%d)}" % (w // 2, seam) if seam else ""   # on the split's seam
            lines.append(f"Dialogue: 0,{ass_time(s)},{ass_time(nxt)},Hook,,0,0,0,,{pos}{text}")
    open(path, "w", encoding="utf-8").write(head + "\n".join(lines) + "\n")


def main():
    args = sys.argv[1:]
    voice, mx, seam = VOICE, MAX, None
    bar = "--bar" in args          # progress bar along the top
    punch = "--punch" in args      # whoosh + quick zoom where the intro ends and the clip starts
    args = [a for a in args if a not in ("--bar", "--punch")]
    if "--voice" in args:
        i = args.index("--voice"); voice = args[i + 1]; del args[i:i + 2]
    if "--seam" in args:
        i = args.index("--seam"); seam = int(args[i + 1]); del args[i:i + 2]
    if "--max" in args:
        i = args.index("--max"); mx = float(args[i + 1]); del args[i:i + 2]
    still = None   # the first frame without captions (image or video): the intro pauses on it
    if "--still" in args:
        i = args.index("--still"); still = args[i + 1]; del args[i:i + 2]
        if not os.path.exists(still):
            still = None
    logo = None    # a sponsor/campaign logo (PNG): bottom-right, on screen for the whole video
    if "--logo" in args:
        i = args.index("--logo"); logo = args[i + 1]; del args[i:i + 2]
        if not os.path.exists(logo):
            sys.exit(f"logo file not found: {logo}")
    src, out, text = args[0], args[1], " ".join(args[2].split())
    intro = text not in ("", "-")      # "-" = no voiceover, only the bar
    mp3, ass = out + ".voice.mp3", out + ".intro.ass"

    v = probe(src, "stream=width,height,r_frame_rate")["streams"][0]
    w, h = int(v["width"]), int(v["height"])
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    fps = round(num / den) or 30
    clip_dur = duration(src)

    words, total = [], 0.0
    inputs = ["-i", src]
    g = []
    if intro:
        for rate in ("+8%", "+20%", "+32%"):   # faster until the line fits
            words = asyncio.run(speak(text, voice, rate, mp3))
            total = duration(mp3) + PAD
            if total <= mx:
                break
        total = min(total, mx + 1.0)
        frames = max(1, round(total * fps))
        captions(words, total, ass, w, h, seam)
        mid = seam or h // 2
        band_h = int(h * 0.17)
        band_y = max(0, min(h - band_h, mid - band_h // 2))
        inputs += ["-i", mp3]
        if still:
            # the paused frame comes from a caption-free copy: the hook words look like normal captions
            inputs += ["-i", still]
            g.append(f"[2:v]trim=end_frame=1,scale={w}:{h},setsar=1[f];[0:v]null[m];")
            cover = ""
        else:
            # no clean frame available: a solid band hides the clip's own caption behind the hook words
            g.append("[0:v]split=2[f][m];")
            cover = f"drawbox=x=0:y={band_y}:w=iw:h={band_h}:color=black@1.0:t=fill,"
        g.append(
            # the first frame, paused: perfectly still and sharp
            # (timestamps set straight after the loop: an fps filter there kept only one frame)
            f"[f]trim=end_frame=1,loop=loop={frames - 1}:size=1:start=0,setpts=N/{fps}/TB,"
            f"{cover}setsar=1,format=yuv420p,ass=filename='{ass}'[iv];"
        )
        # the clip: with --punch it starts on a quick zoom (10% -> 0 over 0.35 s)
        zoom = (f"scale=w='trunc({w}*(1+0.10*max(0,1-t/0.35))/2)*2':h=-2:eval=frame:flags=bicubic,crop={w}:{h},"
                if punch else "")
        g.append(f"[m]setpts=PTS-STARTPTS,{zoom}format=yuv420p,setsar=1[mv];[iv][mv]concat=n=2:v=1:a=0[v0];")
        g.append(
            f"[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:{total:.3f}[va];"
            f"[0:a]aresample=44100,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[ma];"
            f"[va][ma]concat=n=2:v=0:a=1[a0];"
        )
        if punch:
            # a "whoosh" made from filtered noise (no sound file, no licence), peaking at the cut
            at = max(0, int((total - 0.3) * 1000))
            g.append(
                f"anoisesrc=d=0.6:c=pink:r=44100:a=0.7,highpass=f=400,lowpass=f=6000,"
                f"afade=t=in:st=0:d=0.3:curve=exp,afade=t=out:st=0.3:d=0.3:curve=exp,"
                f"aformat=channel_layouts=stereo,volume=0.55,adelay=delays={at}:all=1[wh];"
                f"[a0][wh]amix=inputs=2:normalize=0:duration=first[a1];"
            )
        else:
            g.append("[a0]anull[a1];")
    else:
        g.append("[0:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v0];[0:a]asetpts=PTS-STARTPTS[a1];")
    dur = total + clip_dur
    if logo:
        # the logo as given (aspect kept, never stretched, recoloured or cropped), half the frame wide like the
        # campaign example, bottom-right: in the streamer-on-top layout that is gameplay, clear of captions and cam
        li = len(inputs) // 2
        inputs += ["-i", logo]
        lw = w // 2
        g.append(f"[{li}:v]scale={lw}:-1:flags=lanczos,format=rgba[lg];"
                 f"[v0][lg]overlay=x=W-w-{w // 40}:y=H-h-{h // 48}:format=auto[vl];")
    vin = "[vl]" if logo else "[v0]"
    if bar:
        bh = max(8, h // 160)   # 12 px on 1920
        g.append(
            f"color=c=0xFFD400:s={w}x{bh}:r={fps}:d={dur:.3f}[bar];"
            f"{vin}drawbox=x=0:y=0:w=iw:h={bh}:color=black@0.35:t=fill[vt];"
            f"[vt][bar]overlay=x='-w+w*t/{dur:.3f}':y=0:eval=frame:shortest=1[v]"
        )
    else:
        g.append(f"{vin}null[v]")
    graph = "".join(g).rstrip(";")
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph,
                        "-map", "[v]", "-map", "[a1]", "-c:v", "libx264", "-preset", "fast", "-crf", "16",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out],
                       capture_output=True, text=True)
    for f in (mp3, ass):
        try:
            os.unlink(f)
        except OSError:
            pass
    if r.returncode != 0:
        sys.exit(r.stderr.strip()[-400:])
    print(json.dumps({"intro_seconds": round(total, 2), "voice": voice, "words": len(words), "bar": bar, "punch": punch}))


if __name__ == "__main__":
    main()
