#!/usr/bin/env node
// chat-clips: find the best moments of a Twitch stream from its chat, and cut them as vertical clips.
//
// 1. Get the chat:   TwitchDownloaderCLI chatdownload --id <VOD> -o chat.json
// 2. Find + cut:     node chat-clips.mjs chat.json --vod <VOD>        (downloads only the clip pieces)
//              or:   node chat-clips.mjs chat.json --video vod.mp4    (cuts from a video you already have)
//              or:   node chat-clips.mjs chat.json                    (just lists the moments)
//
// Needs: Node 18+, ffmpeg on PATH (for cutting), TwitchDownloaderCLI on PATH or --tdl <path> (for --vod).
// Free, MIT. Only clip creators who allow it.

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const chatFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!chatFile) {
  console.log('Usage: node chat-clips.mjs chat.json [--vod ID | --video file.mp4] [--top 5] [--out clips]');
  process.exit(1);
}

const BUCKET = Number(opt('bucket', 10)); // seconds per bar
const TOP = Number(opt('top', 5));        // how many clips
const BEFORE = Number(opt('before', 20)); // chat reacts AFTER the moment, so start earlier
const AFTER = Number(opt('after', 10));
const GAP = Number(opt('gap', 90));       // min seconds between two clips
const OUT = opt('out', 'clips');
const VOD = opt('vod');
const VIDEO = opt('video');
const TDL = opt('tdl', 'TwitchDownloaderCLI');

// --- 1. Read chat (TwitchDownloader JSON: comments[].content_offset_seconds) ---
const chat = JSON.parse(readFileSync(chatFile, 'utf8'));
const times = (chat.comments ?? []).map((c) => c.content_offset_seconds).filter((t) => typeof t === 'number');
if (times.length === 0) throw new Error('No chat messages found. Is this a TwitchDownloader chat .json?');

// --- 2. Count messages per bucket ---
const length = times.reduce((m, t) => (t > m ? t : m), chat.video?.length ?? 0); // reduce, not spread: big streams have millions of messages
const counts = new Array(Math.ceil(length / BUCKET) + 1).fill(0);
for (const t of times) counts[Math.floor(t / BUCKET)]++;

// --- 3. Score = how much louder than the chat around it (so a busy stream doesn't win just by being busy) ---
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const AROUND = Math.round(300 / BUCKET); // 5 minutes on each side
const score = counts.map((n, i) => n / (median(counts.slice(Math.max(0, i - AROUND), i + AROUND + 1)) + 1));

// --- 4. Pick the top spikes, keep them apart ---
const order = score.map((s, i) => i).sort((a, b) => score[b] - score[a]);
const peaks = [];
for (const i of order) {
  if (peaks.length >= TOP) break;
  const t = i * BUCKET;
  if (counts[i] < 5) continue;
  if (peaks.some((p) => Math.abs(p.t - t) < GAP)) continue;
  peaks.push({ t, msgs: counts[i], score: +score[i].toFixed(1) });
}
peaks.sort((a, b) => a.t - b.t);

// --- 5. Show it ---
const hms = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const bars = ' ▁▂▃▄▅▆▇█';
const W = 60, per = Math.ceil(counts.length / W);
const cols = Array.from({ length: Math.ceil(counts.length / per) }, (_, k) => Math.max(...counts.slice(k * per, (k + 1) * per)));
const top = Math.max(...cols);
console.log(`\n${times.length} chat messages, ${hms(length)} of stream\n`);
console.log(cols.map((c) => bars[Math.round((c / top) * 8)]).join(''));
console.log(`0:00:00${' '.repeat(Math.max(1, cols.length - 14))}${hms(length)}\n`);
peaks.forEach((p, k) => console.log(`#${k + 1}  ${hms(p.t)}  ${p.msgs} msgs in ${BUCKET}s  (${p.score}x normal)  -> clip ${hms(p.t - BEFORE)} to ${hms(p.t + AFTER)}`));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'moments.json'), JSON.stringify(peaks.map((p) => ({ ...p, start: Math.max(0, p.t - BEFORE), end: p.t + AFTER })), null, 2));

if (!VOD && !VIDEO) {
  console.log(`\nSaved ${join(OUT, 'moments.json')}. Add --vod <ID> or --video <file> to cut the clips.`);
  process.exit(0);
}

// --- 6. Cut vertical clips (9:16 centre crop) ---
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} failed (is it installed and on PATH?)`);
};
const VERTICAL = ['-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac'];

peaks.forEach((p, k) => {
  const start = Math.max(0, p.t - BEFORE), dur = BEFORE + AFTER;
  const out = join(OUT, `clip_${String(k + 1).padStart(2, '0')}.mp4`);
  console.log(`\nCutting ${out} (${hms(start)})`);
  if (VIDEO) {
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', VIDEO, ...VERTICAL, out]);
  } else {
    const piece = join(OUT, `piece_${k + 1}.mp4`);
    run(TDL, ['videodownload', '--id', VOD, '-b', hms(start), '-e', hms(start + dur), '-o', piece]);
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', piece, ...VERTICAL, out]);
    rmSync(piece, { force: true });
  }
});
console.log(`\nDone. ${peaks.length} vertical clips in ./${OUT}. Drop them in OpenShorts or CapCut for captions.`);
