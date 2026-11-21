#!/usr/bin/env node
// make-shorts: one stream link in (Twitch VOD or ended YouTube live stream), N captioned 1080x1920
// YouTube Shorts out, each with title/description/tags.
//
//   node make-shorts.mjs <link> [--count 30] [--min 35] [--max 60] [--layout split|full] [--parallel 3]
//
//   Twitch:  https://www.twitch.tv/videos/2932305259
//   YouTube: https://www.youtube.com/watch?v=XXXXXXXXXXX  (also youtu.be/..., youtube.com/live/...)
//
// Steps (each one is skipped if its output already exists, so you can re-run after a crash):
//   1. Download the chat (TwitchDownloaderCLI / yt-dlp live chat replay)  -> runs/<id>/chat.json
//   2. Find the loudest chat spikes (chat-clips.mjs)                       -> runs/<id>/moments.json
//   3. Download each moment in source quality, horizontal                 -> runs/<id>/pieces/piece_XX.mp4
//   4. OpenShorts (self-hosted, localhost:8000): picks the best 35-60 s + burned captions + title
//   5. Split screen (gameplay top, facecam bottom, captions on the seam) when the stream has a facecam
//   6. Gemini: YouTube description + tags
//   7. Final files                                                         -> runs/<id>/final/short_XX.mp4 + .txt + shorts.csv
//
// Needs: OpenShorts running (docker compose up -d backend in ./openshorts), GEMINI_API_KEY in ./openshorts/.env.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, openAsBlob, createReadStream, unlinkSync, rmSync, renameSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, basename, relative } from 'node:path';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const USAGE = 'Usage: node make-shorts.mjs <Twitch VOD link | YouTube live stream link> [--count 30] [--min 35] [--max 60] [--layout split|full]';
const arg = args.find((a) => !a.startsWith('--') && /twitch\.tv\/videos\/\d+|^\d+$|youtube\.com|youtu\.be/.test(a));
if (!arg) { console.log(USAGE); process.exit(1); }
const ytId = arg.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/)?.[1];
const PLATFORM = ytId ? 'YouTube' : 'Twitch';
if (!ytId && !/twitch\.tv\/videos\/\d+|^\d+$/.test(arg)) { console.log('Could not read that link.\n' + USAGE); process.exit(1); }
const VOD = ytId ?? (arg.match(/videos\/(\d+)/)?.[1] ?? arg.match(/^(\d+)$/)[1]);
const YT_URL = ytId && `https://www.youtube.com/watch?v=${ytId}`;
const COUNT = Number(opt('count', 30));
const MIN = Number(opt('min', 35));
const MAX = Number(opt('max', 45));    // shorter shorts keep more viewers to the end
const BEFORE = Number(opt('before', 40)); // piece = 40 s before the chat spike + 20 s after
const AFTER = Number(opt('after', 20));
const LAYOUT = opt('layout', 'split');    // split = gameplay top + facecam bottom (when there is a facecam); full = whole frame
const INTRO = opt('intro', 'on') !== 'off'; // AI voiceover hook at the start of every short (on the paused first frame)
const BAR = opt('bar', 'on') !== 'off';     // progress bar along the top
const PUNCH = opt('punch', 'on') !== 'off'; // whoosh + quick zoom where the intro ends and the clip starts
const PICK = Math.max(1, Number(opt('pick', 1.3))); // make this many times more shorts, keep the best --count (AI virality score)
const CANDIDATES = Math.ceil(COUNT * PICK);
const VOICE = opt('voice', 'en-US-AndrewNeural'); // any edge-tts voice, e.g. en-US-GuyNeural, en-US-RogerNeural
const CAM_SHARE = Math.min(60, Math.max(25, Number(opt('cam', 40)))) / 100; // split screen: the facecam's share of the height (smaller = sharper streamer)
const SEAM_Y = 1920 - 2 * Math.round(1920 * CAM_SHARE / 2);              // where gameplay meets facecam (captions sit there)
const API = opt('api', 'http://localhost:8000');
const TDL = join(HERE, process.platform === 'win32' ? 'TwitchDownloaderCLI.exe' : 'TwitchDownloaderCLI');
const OS_OUT = join(HERE, 'openshorts', 'output');
const DOCKER = 'openshorts-backend'; // container_name in openshorts/docker-compose.yml; it mounts this folder at /host

const RUN = join(HERE, 'runs', ytId ? `yt_${VOD}` : VOD);
const PIECES = join(RUN, 'pieces'), FINAL = join(RUN, 'final'), EXTRA = join(FINAL, 'extra');
for (const d of [RUN, PIECES, FINAL]) mkdirSync(d, { recursive: true });
const log = (...m) => console.log(new Date().toLocaleTimeString(), ...m);
const run = (cmd, a) => { const r = spawnSync(cmd, a, { stdio: ['ignore', 'ignore', 'inherit'] }); return r.status === 0; };
const hms = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (k) => String(k).padStart(2, '0');
const inBox = (p) => '/host/' + relative(HERE, p).split('\\').join('/'); // host path -> the same file inside the OpenShorts container
const dockerExec = (a, opts = {}) => spawnSync('docker', ['exec', '-w', '/app', DOCKER, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const COOKIES = join(HERE, 'youtube-cookies.txt');
const cookieArgs = () => (existsSync(COOKIES) ? ['--cookies', inBox(COOKIES)] : []);
const ytdlp = (a, opts) => dockerExec(['yt-dlp', '--no-warnings', ...(existsSync(COOKIES) ? ['--cookies', inBox(COOKIES)] : []), ...a], opts);

const envFile = join(HERE, 'openshorts', '.env');
const GEMINI = process.env.GEMINI_API_KEY ?? (existsSync(envFile) && readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m)?.[1].trim());

// 1. chat
const chatFile = join(RUN, 'chat.json');
if (!existsSync(chatFile) && ytId) await youtubeChat();
if (!existsSync(chatFile)) {
  log('Downloading chat (big streams take 10-30 min)...');
  if (!run(TDL, ['chatdownload', '--id', VOD, '-o', chatFile, '--collision', 'Overwrite'])) throw new Error('chat download failed. Is the link right and the video public?');
}

// YouTube: the live chat replay of an ended stream, rewritten in the shape TwitchDownloader writes
// (comments[].content_offset_seconds + streamer + video), so every later step is shared.
async function youtubeChat() {
  await waitForOpenShorts(); // yt-dlp runs inside the OpenShorts container
  log('Reading the YouTube video info...');
  // only the fields needed: a long stream's full -J listing is ~1 GB
  const r = ytdlp(['--no-playlist', '-O', '%(.{id,title,channel,uploader,uploader_id,channel_url,duration,live_status})j', YT_URL]);
  let info;
  try { info = JSON.parse(r.stdout); } catch {
    throw new Error(`YouTube refused the request: ${(r.stderr || '').trim().split('\n').pop()}\n(If it mentions signing in or a bot check, see "YouTube cookies" in README.md.)`);
  }
  if (['is_live', 'is_upcoming'].includes(info.live_status)) {
    throw new Error(`This stream is ${info.live_status === 'is_upcoming' ? 'not started yet' : 'still live'}. Run this again after it has ended.`);
  }
  // Very long streams can stay "post_live" (still processing) for days. YouTube then serves them as numbered
  // live segments, which yt-dlp cannot cut: ytlive.py fetches just the segments needed.
  const segments = info.live_status === 'post_live';
  if (segments) log('YouTube is still processing this stream: downloading it segment by segment.');
  const raw = join(RUN, 'src.live_chat.json');
  if (!existsSync(raw)) {
    log('Downloading the live chat replay (big streams take 10-40 min)...');
    ytdlp(['--skip-download', '--no-playlist', '--write-subs', '--sub-langs', 'live_chat', '-o', inBox(join(RUN, 'src')), YT_URL], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const handle = info.uploader_id?.startsWith('@') ? info.uploader_id : (info.channel_url ?? '').replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
  const meta = (comments, source) => JSON.stringify({
    platform: 'youtube', source,
    streamer: { name: info.channel ?? info.uploader ?? 'the streamer', login: handle },
    video: { title: info.title ?? '', length: info.duration ?? 0, chapters: [] },
    live_segments: segments,
    comments,
  });
  if (!existsSync(raw)) {
    // Many streams have chat replay switched off. Backup signal: loudness. When something big happens the
    // streamer yells, so a 10 s stretch much louder than the 5 minutes around it is a moment.
    log('No chat replay on this video: finding the moments by loudness instead (downloading the audio only)...');
    loudnessMoments(info.duration ?? 0, segments);
    writeFileSync(chatFile, meta([], 'audio'));
    return;
  }
  const comments = [];
  for await (const line of createInterface({ input: createReadStream(raw, 'utf8'), crlfDelay: Infinity })) {
    if (!/liveChat(Text|Paid)MessageRenderer/.test(line)) continue; // real messages and Super Chats, not system notices
    try {
      const t = Number(JSON.parse(line).replayChatItemAction?.videoOffsetTimeMsec) / 1000;
      if (t >= 0) comments.push({ content_offset_seconds: t });
    } catch { /* partial line */ }
  }
  if (!comments.length) throw new Error('The chat replay is empty.');
  writeFileSync(chatFile, meta(comments, 'chat'));
  log(`${comments.length} chat messages.`);
}

// Loudness per 10 s of the whole stream (audio only: a few hundred MB even for 10 hours), scored like
// chat-clips.mjs scores chat: how much louder than the median of the 5 minutes around it.
function loudnessMoments(length, segments) {
  const BUCKET = 10, AROUND = 30, GAP = 90;
  if (!readdirSync(RUN).some((f) => f.startsWith('audio.') && !f.endsWith('.part'))) {
    const r = segments
      ? dockerExec(['python', 'ytlive.py', 'audio', YT_URL, inBox(join(RUN, 'audio.m4a')), String(length), ...cookieArgs()])
      : ytdlp(['--no-playlist', '-f', 'ba[abr<=80]/wa/ba', '-o', inBox(join(RUN, 'audio.%(ext)s')), YT_URL]);
    if (r.status !== 0) throw new Error(`audio download failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  const audio = join(RUN, readdirSync(RUN).find((f) => f.startsWith('audio.') && !f.endsWith('.part')));
  log('Measuring loudness...');
  // Windows' own ffmpeg (from step 1 of the README), reading the file straight from disk: through Docker's
  // drive link, an audio file joined from thousands of segments took hours instead of minutes.
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', audio, '-af',
    `aformat=channel_layouts=mono,aresample=8000,asetnsamples=n=${8000 * BUCKET}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // bucket by timestamp, so a missing segment leaves a gap instead of shifting every later moment
  const db = [];
  for (const x of (r.stdout || '').matchAll(/pts_time:(\S+)\s+lavfi\.astats\.Overall\.RMS_level=(\S+)/g)) {
    const v = Number(x[2]);
    db[Math.floor(Number(x[1]) / BUCKET)] = Number.isFinite(v) ? v : -90;
  }
  for (let i = 0; i < db.length; i++) if (db[i] === undefined) db[i] = -90;
  if (db.length < 60) throw new Error('This video has no chat replay and its audio could not be measured, so there is no way to find moments.');
  const amp = db.map((d) => 10 ** (d / 20));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
  const score = amp.map((v, i) => v / (median(amp.slice(Math.max(0, i - AROUND), i + AROUND + 1)) || 1e-9));
  const order = score.map((_, i) => i).sort((a, b) => score[b] - score[a]);
  const peaks = [];
  for (const i of order) {
    if (peaks.length >= CANDIDATES) break;
    const t = i * BUCKET;
    if (db[i] < -45 || t < 120) continue; // silence, or the stream's opening minutes
    if (peaks.some((p) => Math.abs(p.t - t) < GAP)) continue;
    peaks.push({ t, msgs: 0, score: +score[i].toFixed(1), start: Math.max(0, Math.min(t - BEFORE, (length || 1e9) - BEFORE - AFTER)), end: 0 });
    peaks[peaks.length - 1].end = peaks[peaks.length - 1].start + BEFORE + AFTER;
  }
  peaks.sort((a, b) => a.t - b.t);
  writeFileSync(join(RUN, 'moments.json'), JSON.stringify(peaks, null, 2));
  log(`${peaks.length} loud moments found.`);
}

const chatMeta = JSON.parse(readFileSync(chatFile, 'utf8'), (k, v) => (k === 'comments' ? undefined : v));
const streamer = chatMeta.streamer?.name ?? 'the streamer';
const streamerLogin = chatMeta.streamer?.login ?? streamer.toLowerCase();
const tagName = streamer.replace(/\W/g, '').toLowerCase();
const creditUrl = PLATFORM === 'YouTube' ? `youtube.com/${streamerLogin}` : `twitch.tv/${streamerLogin}`;
const vodTitle = chatMeta.video?.title ?? '';
const SIGNAL = chatMeta.source === 'audio' ? 'audio' : 'chat'; // what picked the moments
// The game of the longest chapter (streams often start in "Just Chatting"). YouTube has none: Gemini reads the title.
const chapters = chatMeta.video?.chapters ?? [];
const game = chapters.length ? [...chapters].sort((a, b) => b.lengthMilliseconds - a.lengthMilliseconds)[0].gameDisplayName : (chatMeta.video?.game ?? '');

// 2. moments
const momentsFile = join(RUN, 'moments.json');
if (!existsSync(momentsFile)) {
  log(`Finding top ${COUNT} chat spikes...`);
  run('node', [join(HERE, 'chat-clips.mjs'), chatFile, '--top', String(CANDIDATES + 5), '--before', String(BEFORE), '--after', String(AFTER), '--gap', '90', '--out', RUN]);
  // Drop the opening 2 minutes (everyone saying hi is a spike, not a moment), give every piece the full
  // BEFORE+AFTER length (OpenShorts needs 45 s+ to cut from), keep the best COUNT, in stream order.
  const len = chatMeta.video?.length || Infinity;
  const ms = JSON.parse(readFileSync(momentsFile, 'utf8'))
    .filter((m) => m.t >= 120)
    .sort((a, b) => b.score - a.score).slice(0, CANDIDATES)
    .map((m) => { const start = Math.max(0, Math.min(m.t - BEFORE, len - BEFORE - AFTER)); return { ...m, start, end: start + BEFORE + AFTER }; })
    .sort((a, b) => a.t - b.t);
  writeFileSync(momentsFile, JSON.stringify(ms, null, 2));
}
const moments = JSON.parse(readFileSync(momentsFile, 'utf8'));
log(`${moments.length} moments. Streamer: ${streamer}. Game: ${game || '?'}`);

// 3. pieces (source quality, horizontal; OpenShorts does the vertical framing)
const pieceOf = (k) => join(PIECES, `piece_${pad(k)}.mp4`);
// Asynchronous: the downloads must not block OpenShorts from starting on the pieces already there
// (spawnSync here held every short back until all pieces were downloaded).
const spawnAsync = (cmd, a) => new Promise((res) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  p.on('close', (status) => res({ status, stderr }));
  p.on('error', (e) => res({ status: -1, stderr: String(e) }));
});
async function downloadPieces() {
  for (const [i, m] of moments.entries()) {
    const out = pieceOf(i + 1);
    if (existsSync(out) && statSync(out).size > 1e6) continue;
    log(`Downloading piece ${i + 1}/${moments.length} (${hms(m.start)}-${hms(m.end)})`);
    let r;
    if (ytId && chatMeta.live_segments) {
      // written under a temporary name and renamed, so a short never picks up a half-written piece
      const tmp = out.replace(/\.mp4$/, '.dl.mp4');
      r = await spawnAsync('docker', ['exec', '-w', '/app', DOCKER, 'python', 'ytlive.py', 'piece', YT_URL, String(m.start), String(m.end), inBox(tmp), '--height', '1440', ...cookieArgs()]);
      if (r.status === 0 && existsSync(tmp)) renameSync(tmp, out);
    } else if (ytId) {
      // 1080p max, H.264 first (OpenCV in the container decodes it everywhere; AV1 it may not).
      r = await spawnAsync('docker', ['exec', '-w', '/app', DOCKER, 'yt-dlp', '--no-warnings', ...cookieArgs(), '--no-playlist', '--download-sections', `*${m.start}-${m.end}`,
        '-f', 'bv*[height<=1440][height>1080][vcodec!^=av01]+ba/bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][vcodec!^=av01]+ba/b[height<=1080]/b',
        '--merge-output-format', 'mp4', '--force-overwrites', '-o', inBox(out), YT_URL]);
    } else {
      r = await spawnAsync(TDL, ['videodownload', '--id', VOD, '-b', hms(m.start), '-e', hms(m.end), '-o', out, '--collision', 'Overwrite']);
    }
    if (!(r.status === 0 && existsSync(out))) log(`  piece ${i + 1} FAILED: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
}

// 3b. split screen: where is the streamer's facecam? Found once for the whole stream (it stays put),
// from frames of the first pieces, by split_render.py inside the OpenShorts container.
const camFile = join(RUN, 'cam.json');
let camPromise = null;
function streamCam() {
  if (LAYOUT !== 'split') return Promise.resolve(null);
  return (camPromise ??= (async () => {
    if (existsSync(camFile)) return JSON.parse(readFileSync(camFile, 'utf8')).box;
    const want = Math.min(8, moments.length);
    const have = () => moments.map((_, i) => pieceOf(i + 1)).filter((p) => existsSync(p) && statSync(p).size > 1e6);
    while (have().length < want && !dlDone) await sleep(5000);
    const ps = have().slice(0, want);
    if (!ps.length) return null;
    log('Looking for the facecam (split screen)...');
    const r = dockerExec(['python', 'split_render.py', 'detect', inBox(camFile), ...ps.map(inBox)]);
    const box = existsSync(camFile) ? JSON.parse(readFileSync(camFile, 'utf8')).box : null;
    log(box ? `Facecam found at ${box.join(',')}: shorts will be split screen.` : `No facecam found${r.status ? ` (${(r.stderr || '').trim().split('\n').pop()})` : ''}: shorts keep the full frame.`);
    return box;
  })());
}

// 4. OpenShorts
async function waitForOpenShorts() {
  for (let i = 0; ; i++) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    if (i % 12 === 0) log('Waiting for OpenShorts on', API, '(start it with: cd openshorts; docker compose up -d)');
    await sleep(10000);
  }
}

async function openshorts(piece) {
  await waitForOpenShorts();
  const fd = new FormData();
  fd.append('file', await openAsBlob(piece), basename(piece));
  for (const [k, v] of Object.entries({ acknowledged: 'true', target_clips: '1', clip_min_seconds: String(MIN), clip_max_seconds: String(MAX), output_format: 'vertical' })) fd.append(k, v);
  const r = await fetch(`${API}/api/process`, { method: 'POST', body: fd });
  const body = await r.json().catch(() => ({}));
  if (!body.job_id) throw new Error(`submit failed ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const job = body.job_id;
  let st = {};
  for (let i = 0; i < 360; i++) {
    await sleep(10000);
    st = await fetch(`${API}/api/status/${job}`).then((x) => x.json()).catch(() => ({}));
    if (st.status && !['queued', 'processing'].includes(st.status)) break;
  }
  const dir = join(OS_OUT, job);
  const metaName = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('_metadata.json'));
  const meta = metaName ? JSON.parse(readFileSync(join(dir, metaName), 'utf8')) : {};
  const clip = (meta.shorts ?? [])[0] ?? {};
  let video = clip.video_url && join(dir, basename(clip.video_url));
  if (!video || !existsSync(video)) {
    const mp4s = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mp4') && !/^wm_|vertical\.mp4$/.test(f)) : [];
    mp4s.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    video = mp4s[0] && join(dir, mp4s[0]);
  }
  if (!video) throw new Error(`no clip from job ${job} (status ${st.status}): ${(st.logs ?? []).slice(-5).join(' | ')}`);
  const words = (meta.transcript?.segments ?? []).filter((s) => s.end >= (clip.start ?? 0) && s.start <= (clip.end ?? 1e9)).map((s) => s.text).join(' ');
  return { video, clip, transcript: words.slice(0, 3000), dir };
}

// OpenShorts keeps every job's working files and a copy of the uploaded piece (~120 MB a short):
// drop them once the short is saved.
function cleanJob(dir) {
  try {
    const job = basename(dir);
    rmSync(dir, { recursive: true, force: true });
    const up = join(HERE, 'openshorts', 'uploads');
    if (existsSync(up)) for (const f of readdirSync(up)) if (f.startsWith(job)) rmSync(join(up, f), { force: true });
  } catch { /* best effort */ }
}

// Re-render the clip OpenShorts picked as split screen (same window, same captions moved onto the seam,
// same loudness-normalised audio). Returns the new file, or null to keep OpenShorts' full-frame clip.
async function splitScreen(piece, r, out) {
  const box = await streamCam();
  if (!box) return null;
  const ass = existsSync(r.dir) && readdirSync(r.dir).find((f) => /^autosubs_.*\.ass$/.test(f));
  if (!ass || r.clip.start == null || r.clip.end == null) return null;
  const res = dockerExec(['python', 'split_render.py', inBox(piece), String(r.clip.start), String(r.clip.end),
    inBox(join(r.dir, ass)), inBox(r.video), inBox(out), box.join(','), String(CAM_SHARE)]);
  if (res.status === 0 && existsSync(out)) return out;
  log(res.status === 2 ? '  facecam hidden in this clip: keeping the full frame' : `  split screen failed, keeping the full frame: ${(res.stderr || '').trim().split('\n').pop()}`);
  return null;
}

// 5. YouTube description + tags
async function ytDetails(clip, transcript) {
  const fallback = {
    title: clip.video_title_for_youtube_short ?? `${streamer} ${game} moment`,
    description: `${clip.video_description_for_tiktok ?? ''}\n\nCredit: ${streamer} (${creditUrl})\n\n#shorts #${tagName} ${game ? '#' + game.replace(/\W/g, '').toLowerCase() : ''}`.trim(),
    tags: [streamer, game, game && `${streamer} ${game}`, `${PLATFORM.toLowerCase()} clips`, 'stream highlights', 'shorts'].filter(Boolean),
  };
  if (!GEMINI) return fallback;
  const prompt = `You write YouTube Shorts metadata for a clip from ${streamer}'s ${PLATFORM} live stream${game ? ` playing ${game}` : ''} (stream title: "${vodTitle}"${game ? '' : '; work out the game or topic from it'}).
Name the game exactly as ${game ? 'given here' : 'the stream title does'} (same version number: "GTA 6" stays "GTA 6", never an older game), in the title, hashtags and tags alike.
Suggested title from another tool: "${clip.video_title_for_youtube_short ?? ''}".
What is said in the clip: """${transcript || '(no speech)'}"""
Return JSON: {"title": string (max 90 chars, curiosity hook, no clickbait lies, include ${streamer}), "description": string (2-3 short lines describing the moment, then the line "Credit: ${streamer} - ${creditUrl}", then 3-5 hashtags including #shorts), "tags": array of 12-18 relevant search tags (strings, no #), "voiceover": string (ONE sentence an AI narrator says BEFORE the clip plays: 9-13 words, about 4 seconds spoken; builds curiosity about what is about to happen without giving away the ending; names ${streamer} once; plain spoken English, no emojis, no hashtags, no quotes; e.g. "${streamer} had no idea what this guy was about to do to him.")}`;
  // up to 3 tries: a busy free key sometimes answers 429/500 for a moment
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
      });
      const j = await r.json();
      const d = JSON.parse(j.candidates[0].content.parts[0].text);
      if (d.title && d.description && Array.isArray(d.tags)) return d;
    } catch { /* retry */ }
    await sleep(15000 * attempt);
  }
  return fallback;
}

const probe = (f) => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], { encoding: 'utf8' }); try { const j = JSON.parse(r.stdout); return { w: j.streams[0].width, h: j.streams[0].height, dur: Number(j.format.duration) }; } catch { return {}; } };

// Run downloads in the background while OpenShorts works through finished pieces.
const dl = downloadPieces();
let dlDone = false; dl.then(() => { dlDone = true; });
const rows = [];
const PARALLEL = Number(opt('parallel', 3)); // OpenShorts jobs at once (each ~1.8 GB RAM, ~2-3 CPU cores)
let next = 0;
async function worker() {
  while (next < moments.length) {
    const i = next++;
    await makeShort(i, moments[i]);
  }
}
async function makeShort(i, m) {
  const k = i + 1, mp4 = join(FINAL, `short_${pad(k)}.mp4`), txt = join(FINAL, `short_${pad(k)}.txt`);
  if (existsSync(mp4) && existsSync(txt)) { rows.push({ k, m, info: JSON.parse(readFileSync(txt + '.json', 'utf8')) }); return; }
  const xtxt = join(EXTRA, `short_${pad(k)}.txt`); // already made, set aside by an earlier "keep the best" pass
  if (existsSync(join(EXTRA, `short_${pad(k)}.mp4`)) && existsSync(xtxt)) { rows.push({ k, m, info: JSON.parse(readFileSync(xtxt + '.json', 'utf8')) }); return; }
  while (!(existsSync(pieceOf(k)) && statSync(pieceOf(k)).size > 1e6) && !dlDone) await sleep(5000);
  await sleep(3000); // let the downloader finish writing
  if (!existsSync(pieceOf(k))) { log(`short ${k}: no piece, skipped`); return; }
  try {
    log(`short ${k}/${moments.length}: OpenShorts...`);
    let r, p;
    for (let attempt = 1; ; attempt++) { // never save a short under the minimum length; retry once if the AI returns nothing
      try { r = await openshorts(pieceOf(k)); } catch (e) {
        if (attempt >= 2) throw e;
        log(`short ${k}: OpenShorts returned no clip, retrying`);
        continue;
      }
      p = probe(r.video);
      if (p.dur >= MIN - 0.5) break;
      if (attempt >= 2) throw new Error(`clip only ${Math.round(p.dur)} s after ${attempt} tries, not saved`);
      log(`short ${k}: came out ${Math.round(p.dur)} s, retrying`);
    }
    const { clip, transcript } = r;
    let src = r.video, layout = 'full';
    const split = await splitScreen(pieceOf(k), r, join(FINAL, `short_${pad(k)}.split.tmp.mp4`));
    if (split) { const q = probe(split); if (q.dur >= MIN - 0.5) { p = q; src = split; layout = 'split'; } }
    const d = await ytDetails(clip, transcript);
    // Finishing, in one encode: the AI voiceover hook on the paused first frame, a whoosh + quick zoom into
    // the clip, and a progress bar along the top.
    let intro = 0;
    if (INTRO || BAR) {
      const line = INTRO ? (d.voiceover || `${streamer} was not ready for what happened next.`).replace(/[#\p{Extended_Pictographic}]/gu, '').trim() : '-';
      const fin = join(FINAL, `short_${pad(k)}.fin.tmp.mp4`);
      const ri = dockerExec(['python', 'intro_voice.py', inBox(src), inBox(fin), line, '--voice', VOICE,
        ...(layout === 'split' ? ['--seam', String(SEAM_Y)] : []), ...(BAR ? ['--bar'] : []), ...(PUNCH && INTRO ? ['--punch'] : [])]);
      const q = existsSync(fin) ? probe(fin) : {};
      if (ri.status === 0 && q.dur >= p.dur - 0.2) {
        if (INTRO) { intro = +(q.dur - p.dur).toFixed(1); d.voiceover = line; }
        p = q;
        copyFileSync(fin, mp4);
      } else {
        log(`  finishing step (voiceover/bar) failed, keeping the clip without it: ${(ri.stderr || '').trim().split('\n').pop()}`);
        copyFileSync(src, mp4);
      }
      if (existsSync(fin)) unlinkSync(fin);
    } else {
      copyFileSync(src, mp4);
    }
    if (split && existsSync(split)) unlinkSync(split);
    const info = { ...d, stream_time: hms(m.t), chat_score: m.score, viral_score: clip.predicted_score ?? null,
      width: p.w, height: p.h, seconds: Math.round(p.dur), layout, intro_seconds: intro };
    writeFileSync(txt + '.json', JSON.stringify(info, null, 2));
    writeFileSync(txt, `TITLE:\n${d.title}\n\nDESCRIPTION:\n${d.description}\n\nTAGS:\n${d.tags.join(', ')}\n\n---\nFrom ${streamer}'s stream at ${hms(m.t)} (${SIGNAL} ${m.score}x louder than normal). ${p.w}x${p.h}, ${Math.round(p.dur)} s, ${layout === 'split' ? 'split screen' : 'full frame'}${intro ? `, starts with a ${intro} s AI voiceover: "${d.voiceover}"` : ''}.\n`);
    rows.push({ k, m, info });
    cleanJob(r.dir);
    log(`short ${k}: done ${p.w}x${p.h} ${Math.round(p.dur)}s - ${d.title}`);
  } catch (e) { log(`short ${k}: FAILED ${e.message}`); }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
await dl;

// Keep the best: more shorts were made than asked (--pick). Rank them by the AI's virality score (the chat/loudness
// hype breaks ties), keep --count in final\, and set the rest aside in final\extra\ (not deleted).
const rank = (r) => (Number(r.info.viral_score) || 0) * 10 + (Number(r.info.chat_score) || 0);
rows.sort((a, b) => rank(b) - rank(a));
const keep = rows.slice(0, COUNT), aside = rows.slice(COUNT);
const place = (k, toExtra) => {
  for (const ext of ['.mp4', '.txt', '.txt.json']) {
    const name = `short_${pad(k)}${ext}`, from = join(toExtra ? FINAL : EXTRA, name), to = join(toExtra ? EXTRA : FINAL, name);
    if (existsSync(from)) { mkdirSync(toExtra ? EXTRA : FINAL, { recursive: true }); renameSync(from, to); }
  }
};
for (const { k } of keep) place(k, false);
for (const { k } of aside) place(k, true);
if (aside.length) log(`Kept the ${keep.length} best of ${rows.length} shorts (AI virality score). The other ${aside.length} ${aside.length === 1 ? 'is' : 'are'} in final\\extra.`);

const csv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
writeFileSync(join(FINAL, 'shorts.csv'), 'file,seconds,resolution,stream_time,viral_score,chat_score,title,description,tags\n' +
  keep.map(({ k, info }) => [`short_${pad(k)}.mp4`, info.seconds, `${info.width}x${info.height}`, info.stream_time, info.viral_score ?? '', info.chat_score, info.title, info.description, info.tags.join(', ')].map(csv).join(',')).join('\n'));
log(`DONE: ${keep.length} shorts in ${FINAL} (shorts.csv is sorted best-first)`);
