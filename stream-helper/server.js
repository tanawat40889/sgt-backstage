#!/usr/bin/env node
// SGT Backstage stream helper.
//
// A browser cannot speak RTMP, which is what YouTube Live takes in. This small program
// runs on the same computer as the control page: the page records its Live picture and
// sound and posts the recording here in small pieces, and this hands them to ffmpeg,
// which re-encodes and sends them on to YouTube.
//
//   node server.js            (needs Node 18+ and ffmpeg on the PATH)
//
// No dependencies. Listens on 127.0.0.1 only, so nothing else on the network can reach it.

const http = require('http');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.BACKSTAGE_PORT) || 5185;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// for testing without going on air: write the stream to this file instead of sending it
const TEST_OUT = process.env.BACKSTAGE_TEST_OUT || '';

// Only these pages may drive the helper. A browser always sends Origin on these requests,
// so another site open in the same browser cannot start a stream behind the user's back.
const ALLOWED_ORIGINS = [
  /^https:\/\/tanawat40889\.github\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

const QUALITY = {
  '720p': { w: 1280, h: 720, v: 3000, a: 128 },
  '1080p': { w: 1920, h: 1080, v: 6000, a: 160 },
};

function ffmpegText(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8' });
  return r.error ? null : `${r.stdout}${r.stderr}`;
}

const encoders = ffmpegText(['-encoders']);
const protocols = ffmpegText(['-protocols']) ?? '';
const hasFfmpeg = encoders !== null;
// the Mac's hardware encoder costs almost no CPU; x264 works everywhere else
const videoEncoder = !hasFfmpeg ? null
  : process.platform === 'darwin' && /h264_videotoolbox/.test(encoders) ? 'h264_videotoolbox'
    : /libx264/.test(encoders) ? 'libx264' : null;
const hasRtmps = /\brtmps\b/.test(protocols);
const YOUTUBE = hasRtmps ? 'rtmps://a.rtmps.youtube.com/live2' : 'rtmp://a.rtmp.youtube.com/live2';

// the one stream in progress: { proc, startedAt, bytes, log, stats, ended, error }
let job = null;

// the stream key is a password: it must never reach a log or a status reply
const redact = (text, key) => (key ? text.split(key).join('****') : text);

function start({ key, server, quality }) {
  if (job && !job.ended) throw new Error('กำลัง stream อยู่แล้ว');
  if (!hasFfmpeg) throw new Error('ไม่พบ ffmpeg ในเครื่อง');
  if (!videoEncoder) throw new Error('ffmpeg ตัวนี้ไม่มีตัว encode H.264');
  const q = QUALITY[quality] ?? QUALITY['720p'];
  if (!TEST_OUT && !/^[\w-]{8,100}$/.test(key ?? '')) throw new Error('stream key ไม่ถูกต้อง');
  const base = (server || YOUTUBE).replace(/\/+$/, '');
  if (!/^rtmps?:\/\/[\w.-]+(:\d+)?\/[\w./-]+$/.test(base)) throw new Error('ที่อยู่ server ต้องขึ้นต้นด้วย rtmp:// หรือ rtmps://');

  const venc = videoEncoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-x264-params', 'scenecut=0'];
  const args = [
    '-hide_banner', '-loglevel', 'info', '-stats',
    // the recording arrives live over a pipe: start reading at once, keep timestamps honest
    '-fflags', '+genpts+nobuffer', '-analyzeduration', '2000000', '-probesize', '2000000',
    '-i', 'pipe:0',
    // YouTube wants a steady frame rate and a keyframe at least every 4 s (here: every 2 s)
    '-vf', `fps=30,scale=${q.w}:${q.h}:force_original_aspect_ratio=decrease,pad=${q.w}:${q.h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    ...venc,
    '-b:v', `${q.v}k`, '-maxrate', `${q.v}k`, '-bufsize', `${q.v * 2}k`, '-g', '60', '-keyint_min', '60',
    '-c:a', 'aac', '-b:a', `${q.a}k`, '-ar', '44100', '-ac', '2',
    '-f', 'flv', TEST_OUT || `${base}/${key}`,
  ];
  if (TEST_OUT) args.unshift('-y');

  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const j = { proc, startedAt: Date.now(), bytes: 0, log: '', stats: null, ended: false, error: null, quality: quality in QUALITY ? quality : '720p' };
  job = j;

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => {
    j.log = (j.log + redact(d, key)).slice(-6000);
    // ffmpeg's running line: "frame= 123 fps= 30 ... bitrate=3000.1kbits/s speed=1x"
    const m = [...j.log.matchAll(/frame=\s*(\d+)\s+fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s.*?speed=\s*([\d.]+)x/g)].pop();
    if (m) j.stats = { frames: +m[1], fps: +m[2], kbps: +m[3], speed: +m[4] };
  });
  // the browser may still be posting when ffmpeg has gone; that must not crash the helper
  proc.stdin.on('error', () => {});
  proc.on('error', e => { j.ended = true; j.error = e.message; });
  proc.on('close', code => {
    j.ended = true;
    // 255 is what ffmpeg returns when it is told to quit; that is a normal stop
    if (code && code !== 255 && !j.stopping) {
      const last = j.log.split(/[\r\n]+/).filter(l => l.trim() && !/^frame=/.test(l)).slice(-3).join(' | ');
      j.error = last || `ffmpeg หยุดทำงาน (code ${code})`;
    }
    console.log(`[${new Date().toLocaleTimeString()}] stream จบ${j.error ? ` (ผิดพลาด: ${j.error})` : ''}`);
  });
  console.log(`[${new Date().toLocaleTimeString()}] เริ่ม stream ${j.quality} ไปที่ ${TEST_OUT || base}`);
}

function stop() {
  if (!job || job.ended) return;
  job.stopping = true;
  // closing the pipe lets ffmpeg finish the stream cleanly; kill it if that takes too long
  job.proc.stdin.end();
  const proc = job.proc;
  setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 4000);
}

function status() {
  return {
    ok: true,
    ffmpeg: hasFfmpeg,
    encoder: videoEncoder,
    rtmps: hasRtmps,
    streaming: !!job && !job.ended,
    seconds: job && !job.ended ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
    bytes: job?.bytes ?? 0,
    stats: job?.stats ?? null,
    error: job?.error ?? null,
    test: !!TEST_OUT,
  };
}

function readBody(req, limit) {
  return new Promise((res, rej) => {
    const parts = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        rej(new Error('ข้อมูลใหญ่เกินไป'));
        req.destroy();
      } else {
        parts.push(c);
      }
    });
    req.on('end', () => res(Buffer.concat(parts)));
    req.on('error', rej);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = !!origin && ALLOWED_ORIGINS.some(re => re.test(origin));
  const send = (code, body) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    res.end(JSON.stringify(body));
  };

  // a page on the web asking to reach this computer: the browser checks with us first
  if (req.method === 'OPTIONS') {
    res.writeHead(allowed ? 204 : 403, allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    } : {});
    return res.end();
  }

  try {
    if (req.method === 'GET' && req.url === '/status') return send(200, status());
    // everything that does something must come from an allowed page
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    if (!allowed) return send(403, { error: 'หน้านี้ไม่ได้รับอนุญาตให้ใช้ตัวช่วย' });

    if (req.url === '/start') {
      start(JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'));
      return send(200, status());
    }
    if (req.url === '/chunk') {
      const buf = await readBody(req, 32 * 1024 * 1024);
      if (!job || job.ended) return send(409, { error: job?.error || 'ไม่ได้ stream อยู่', ...status() });
      job.bytes += buf.length;
      // wait when ffmpeg is behind, so the page sees the delay instead of memory filling up
      if (!job.proc.stdin.write(buf)) await new Promise(r => job.proc.stdin.once('drain', r));
      return send(200, { ok: true });
    }
    if (req.url === '/stop') {
      stop();
      return send(200, status());
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(400, { error: e.message });
  }
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} ถูกใช้อยู่ (ตัวช่วยอาจเปิดอยู่แล้ว)` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SGT Backstage stream helper พร้อมที่ http://127.0.0.1:${PORT}`);
  console.log(hasFfmpeg
    ? `ffmpeg: พบแล้ว · ตัว encode: ${videoEncoder ?? 'ไม่มี H.264!'} · ${hasRtmps ? 'RTMPS (เข้ารหัส)' : 'RTMP (ไม่เข้ารหัส)'}`
    : 'ไม่พบ ffmpeg: ติดตั้งก่อน เช่น  brew install ffmpeg');
  if (TEST_OUT) console.log(`โหมดทดสอบ: เขียนลง ${TEST_OUT} แทนการส่งออก`);
  console.log('เปิดค้างไว้ระหว่าง live · กด Ctrl+C เพื่อปิด');
});

// never leave an ffmpeg running on its own
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (job && !job.ended) job.proc.kill('SIGKILL');
    process.exit(0);
  });
}
