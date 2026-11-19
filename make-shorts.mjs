#!/usr/bin/env node
// make-shorts: one Twitch VOD link in, N captioned 1080x1920 YouTube Shorts out, each with title/description/tags.
//
//   node make-shorts.mjs https://www.twitch.tv/videos/2932305259 [--count 30] [--min 35] [--max 60]
//
// Steps (each one is skipped if its output already exists, so you can re-run after a crash):
//   1. Download the chat (TwitchDownloaderCLI)              -> runs/<id>/chat.json
//   2. Find the loudest chat spikes (chat-clips.mjs)        -> runs/<id>/moments.json
//   3. Download each moment in source quality, horizontal  -> runs/<id>/pieces/piece_XX.mp4
//   4. OpenShorts (self-hosted, localhost:8000): vertical reframe + burned captions + title
//   5. Gemini: YouTube description + tags
//   6. Final files                                          -> runs/<id>/final/short_XX.mp4 + short_XX.txt + shorts.csv
//
// Needs: OpenShorts running (docker compose up -d in ./openshorts), GEMINI_API_KEY in ./openshorts/.env.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, openAsBlob } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const link = args.find((a) => /twitch\.tv\/videos\/\d+|^\d+$/.test(a));
if (!link) { console.log('Usage: node make-shorts.mjs <twitch VOD link> [--count 30] [--min 35] [--max 60]'); process.exit(1); }
const VOD = link.match(/(\d+)\s*$/)?.[1] ?? link.match(/videos\/(\d+)/)[1];
const COUNT = Number(opt('count', 30));
const MIN = Number(opt('min', 35));
const MAX = Number(opt('max', 60));
const BEFORE = Number(opt('before', 40)); // piece = 40 s before the chat spike + 20 s after
const AFTER = Number(opt('after', 20));
const API = opt('api', 'http://localhost:8000');
const TDL = join(HERE, process.platform === 'win32' ? 'TwitchDownloaderCLI.exe' : 'TwitchDownloaderCLI');
const OS_OUT = join(HERE, 'openshorts', 'output');

const RUN = join(HERE, 'runs', VOD);
const PIECES = join(RUN, 'pieces'), FINAL = join(RUN, 'final');
for (const d of [RUN, PIECES, FINAL]) mkdirSync(d, { recursive: true });
const log = (...m) => console.log(new Date().toLocaleTimeString(), ...m);
const run = (cmd, a) => { const r = spawnSync(cmd, a, { stdio: ['ignore', 'ignore', 'inherit'] }); return r.status === 0; };
const hms = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (k) => String(k).padStart(2, '0');

const envFile = join(HERE, 'openshorts', '.env');
const GEMINI = process.env.GEMINI_API_KEY ?? (existsSync(envFile) && readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m)?.[1].trim());

// 1. chat
const chatFile = join(RUN, 'chat.json');
if (!existsSync(chatFile)) {
  log('Downloading chat (big streams take 10-30 min)...');
  if (!run(TDL, ['chatdownload', '--id', VOD, '-o', chatFile, '--collision', 'Overwrite'])) throw new Error('chat download failed');
}
const chatMeta = JSON.parse(readFileSync(chatFile, 'utf8'), (k, v) => (k === 'comments' ? undefined : v));
const streamer = chatMeta.streamer?.name ?? 'the streamer';
const streamerLogin = chatMeta.streamer?.login ?? streamer.toLowerCase();
const vodTitle = chatMeta.video?.title ?? '';
// The game of the longest chapter (streams often start in "Just Chatting").
const chapters = chatMeta.video?.chapters ?? [];
const game = chapters.length ? [...chapters].sort((a, b) => b.lengthMilliseconds - a.lengthMilliseconds)[0].gameDisplayName : (chatMeta.video?.game ?? '');

// 2. moments
const momentsFile = join(RUN, 'moments.json');
if (!existsSync(momentsFile)) {
  log(`Finding top ${COUNT} chat spikes...`);
  run('node', [join(HERE, 'chat-clips.mjs'), chatFile, '--top', String(COUNT), '--before', String(BEFORE), '--after', String(AFTER), '--gap', '90', '--out', RUN]);
}
const moments = JSON.parse(readFileSync(momentsFile, 'utf8'));
log(`${moments.length} moments. Streamer: ${streamer}. Game: ${game || '?'}`);

// 3. pieces (source quality, horizontal; OpenShorts does the vertical framing)
const pieceOf = (k) => join(PIECES, `piece_${pad(k)}.mp4`);
async function downloadPieces() {
  for (const [i, m] of moments.entries()) {
    const out = pieceOf(i + 1);
    if (existsSync(out) && statSync(out).size > 1e6) continue;
    log(`Downloading piece ${i + 1}/${moments.length} (${hms(m.start)}-${hms(m.end)})`);
    if (!run(TDL, ['videodownload', '--id', VOD, '-b', hms(m.start), '-e', hms(m.end), '-o', out, '--collision', 'Overwrite'])) log(`  piece ${i + 1} FAILED`);
  }
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
  return { video, clip, transcript: words.slice(0, 3000) };
}

// 5. YouTube description + tags
async function ytDetails(clip, transcript) {
  const fallback = {
    title: clip.video_title_for_youtube_short ?? `${streamer} ${game} moment`,
    description: `${clip.video_description_for_tiktok ?? ''}\n\nCredit: ${streamer} (twitch.tv/${streamerLogin})\n\n#shorts #${streamerLogin} ${game ? '#' + game.replace(/\W/g, '').toLowerCase() : ''}`.trim(),
    tags: [streamer, streamerLogin, game, `${streamer} ${game}`, 'twitch clips', 'shorts'].filter(Boolean),
  };
  if (!GEMINI) return fallback;
  const prompt = `You write YouTube Shorts metadata for a clip from ${streamer}'s Twitch stream${game ? ` playing ${game}` : ''} (stream title: "${vodTitle}").
Suggested title from another tool: "${clip.video_title_for_youtube_short ?? ''}".
What is said in the clip: """${transcript || '(no speech)'}"""
Return JSON: {"title": string (max 90 chars, curiosity hook, no clickbait lies, include ${streamer}), "description": string (2-3 short lines describing the moment, then the line "Credit: ${streamer} - twitch.tv/${streamerLogin}", then 3-5 hashtags including #shorts), "tags": array of 12-18 relevant search tags (strings, no #)}`;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
    });
    const j = await r.json();
    const d = JSON.parse(j.candidates[0].content.parts[0].text);
    if (!d.title || !d.description || !Array.isArray(d.tags)) return fallback;
    return d;
  } catch { return fallback; }
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
  while (!(existsSync(pieceOf(k)) && statSync(pieceOf(k)).size > 1e6) && !dlDone) await sleep(5000);
  await sleep(3000); // let the downloader finish writing
  if (!existsSync(pieceOf(k))) { log(`short ${k}: no piece, skipped`); return; }
  try {
    log(`short ${k}/${moments.length}: OpenShorts...`);
    let r, p;
    for (let attempt = 1; ; attempt++) { // never save a short under 30 s
      r = await openshorts(pieceOf(k)); p = probe(r.video);
      if (p.dur >= 30) break;
      if (attempt >= 2) throw new Error(`clip only ${Math.round(p.dur)} s after ${attempt} tries, not saved`);
      log(`short ${k}: came out ${Math.round(p.dur)} s, retrying`);
    }
    const { video, clip, transcript } = r;
    copyFileSync(video, mp4);
    const d = await ytDetails(clip, transcript);
    const info = { ...d, stream_time: hms(m.t), chat_score: m.score, width: p.w, height: p.h, seconds: Math.round(p.dur) };
    writeFileSync(txt + '.json', JSON.stringify(info, null, 2));
    writeFileSync(txt, `TITLE:\n${d.title}\n\nDESCRIPTION:\n${d.description}\n\nTAGS:\n${d.tags.join(', ')}\n\n---\nFrom ${streamer}'s stream at ${hms(m.t)} (chat ${m.score}x louder than normal). ${p.w}x${p.h}, ${Math.round(p.dur)} s.\n`);
    rows.push({ k, m, info });
    log(`short ${k}: done ${p.w}x${p.h} ${Math.round(p.dur)}s - ${d.title}`);
  } catch (e) { log(`short ${k}: FAILED ${e.message}`); }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
await dl;

const csv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
writeFileSync(join(FINAL, 'shorts.csv'), 'file,seconds,resolution,stream_time,chat_score,title,description,tags\n' +
  rows.sort((a, b) => b.info.chat_score - a.info.chat_score).map(({ k, info }) => [`short_${pad(k)}.mp4`, info.seconds, `${info.width}x${info.height}`, info.stream_time, info.chat_score, info.title, info.description, info.tags.join(', ')].map(csv).join(',')).join('\n'));
log(`DONE: ${rows.length} shorts in ${FINAL} (shorts.csv is sorted best-first)`);
