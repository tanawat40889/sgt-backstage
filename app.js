const EXT = '.sgtbs';
// the extension and format marker used before the rename; still opened, then converted
const OLD_EXT = '.sgtobs';
const APP_IDS = ['sgtbs', 'sgtobs'];
const MEDIA_DIR = 'media';
const DB_NAME = 'sgtobs';
const STORE = 'recent';

const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'],
  // slides exported from PowerPoint / Canva / Keynote
  pdf: ['pdf'],
};

// source types that draw a picture (and so have position / size / crop)
const VISUAL = ['image', 'video', 'camera', 'screen', 'pdf'];
// source types fed by a MediaStream
const STREAMED = ['camera', 'mic', 'screen'];
const DEV_KIND = { camera: 'videoinput', mic: 'audioinput' };

const LAYERS = 3;
const SMOOTH_MS = 500;
// with Smooth, sound fades this long: music cut in half a second still sounds like a cut
const AUDIO_FADE_MS = 1500;

const $ = id => document.getElementById(id);

// current project: { dir, fh, data }
let cur = null;
// shot id selected per layer (null = clear layer)
let sel = { pv: [], live: [] };
let stages = {};
let trans = 'cut';
// shot open in the inspector: { shotId, srcId }
let edit = null;
// projector window, null when closed
let outWin = null;
// file src -> object URL (absent = file missing)
const urls = new Map();
// stream key -> Promise<MediaStream>, shared by every stage showing that source
const streams = new Map();

/* ---------- recent folders (IndexedDB) ---------- */

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function store(mode, fn) {
  const d = await db();
  try {
    return await new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode);
      const rq = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  } finally {
    d.close();
  }
}

async function recentAll() {
  const all = await store('readonly', s => s.getAll());
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

async function remember(dir) {
  let id;
  for (const r of await recentAll()) {
    if (await r.handle.isSameEntry(dir)) { id = r.id; break; }
  }
  await store('readwrite', s => s.put({
    id: id ?? crypto.randomUUID(),
    name: dir.name,
    handle: dir,
    openedAt: Date.now(),
  }));
}

const forget = id => store('readwrite', s => s.delete(id));

/* ---------- project file ---------- */

function newProject(name) {
  const now = new Date().toISOString();
  return {
    app: APP_IDS[0],
    version: 2,
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width: 1920, height: 1080 },
    layers: newLayers(),
  };
}

function newLayers() {
  return Array.from({ length: LAYERS }, (_, i) => ({ name: `Layer ${i + 1}`, shots: [] }));
}

// def: { type, name, ...type-specific fields, stream? }
function newSource(canvas, { stream, ...def }) {
  const s = { id: crypto.randomUUID(), ...def };
  if (VISUAL.includes(s.type)) {
    Object.assign(s, { x: 0, y: 0, w: canvas.width, h: canvas.height, crop: { l: 0, t: 0, r: 0, b: 0 } });
  }
  if (stream) setScreenStream(s, stream);
  return s;
}

// bring files written by older versions up to the current shape
function normalize(data) {
  data.canvas ??= { width: 1920, height: 1080 };
  if (!Array.isArray(data.layers)) data.layers = newLayers();
  for (const l of data.layers) {
    // v1 shots were a single source
    l.shots = (l.shots ?? []).map(s => {
      if (s.sources) return s;
      const { id, ...def } = s;
      return { id, name: s.name, sources: [newSource(data.canvas, def)] };
    });
  }
  while (data.layers.length > LAYERS && !data.layers.at(-1).shots.length) data.layers.pop();
  data.version = 2;
  data.app = APP_IDS[0];
  return data;
}

async function ensurePerm(dir) {
  const o = { mode: 'readwrite' };
  if (await dir.queryPermission(o) === 'granted') return true;
  return await dir.requestPermission(o) === 'granted';
}

// first project file in the folder with this extension, or null
async function findProjectFile(dir, ext) {
  const names = [];
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'file' && !n.startsWith('.') && n.toLowerCase().endsWith(ext)) names.push(n);
  }
  names.sort();
  return names.length ? dir.getFileHandle(names[0]) : null;
}

async function writeProject(fh, data) {
  const w = await fh.createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
}

async function readProject(fh) {
  const txt = await (await fh.getFile()).text();
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(`ไฟล์ ${fh.name} ไม่ใช่ JSON ที่ถูกต้อง`);
  }
  if (!APP_IDS.includes(data?.app)) throw new Error(`ไฟล์ ${fh.name} ไม่ใช่โปรเจค SGT Backstage`);
  return normalize(data);
}

// returns { fh, data, created, convertedFrom }
async function loadOrCreate(dir) {
  let fh = await findProjectFile(dir, EXT);
  if (fh) return { fh, data: await readProject(fh), created: false };

  // a folder from before the rename: copy its project into a file with the new
  // extension and work on that; the old file is left untouched
  const old = await findProjectFile(dir, OLD_EXT);
  if (old) {
    const data = await readProject(old);
    data.app = APP_IDS[0];
    fh = await dir.getFileHandle(old.name.slice(0, -OLD_EXT.length) + EXT, { create: true });
    await writeProject(fh, data);
    return { fh, data, created: false, convertedFrom: old.name };
  }

  const data = newProject(dir.name);
  fh = await dir.getFileHandle(dir.name + EXT, { create: true });
  await writeProject(fh, data);
  await dir.getDirectoryHandle(MEDIA_DIR, { create: true });
  return { fh, data, created: true };
}

async function listMedia(dir) {
  let m;
  try {
    m = await dir.getDirectoryHandle(MEDIA_DIR);
  } catch (e) {
    if (e.name === 'NotFoundError') return [];
    throw e;
  }
  const out = [];
  for await (const [n, h] of m.entries()) {
    if (h.kind !== 'file' || n.startsWith('.')) continue;
    const ext = n.split('.').pop().toLowerCase();
    const kind = Object.keys(KINDS).find(k => KINDS[k].includes(ext));
    if (!kind) continue;
    out.push({ name: n, kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function fileAt(dir, path) {
  const parts = path.split('/');
  const name = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(name)).getFile();
}

async function loadUrl(src) {
  if (urls.has(src)) return;
  try {
    urls.set(src, URL.createObjectURL(await fileAt(cur.dir, src)));
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  cur.data.updatedAt = new Date().toISOString();
  await writeProject(cur.fh, cur.data);
}

// for edits that fire on every keystroke
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(guard(save), 400);
}

async function closeProject() {
  if (cur && saveTimer) await save();
  // also blanks the output window, which stays open across projects
  for (const st of Object.values(stages)) {
    dropAudio(st.el);
    st.el.replaceChildren();
  }
  for (const k of [...streams.keys()]) stopStream(k);
  for (const u of urls.values()) URL.revokeObjectURL(u);
  for (const p of pdfPages.values()) p.then(u => URL.revokeObjectURL(u), () => {});
  for (const p of pdfDocs.values()) p.then(d => d.destroy(), () => {});
  pdfPages.clear();
  pdfDocs.clear();
  urls.clear();
  starts.clear();
  durs.clear();
  stages = {};
  edit = null;
  cur = null;
}

// songs play one after another when the shot is a playlist, or when its list loops
// (Loop alone = back to back, no crossfade)
const isList = shot => !!(shot.playlist || shot.plLoop);

const allShots = () => cur.data.layers.flatMap(l => l.shots);
const findShot = id => allShots().find(s => s.id === id);

/* ---------- PDF slides ---------- */

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
// file src -> Promise<PDFDocumentProxy>
const pdfDocs = new Map();
// "src#page" -> Promise<object URL of that page as a PNG>
const pdfPages = new Map();
let pdfLibLoading = null;

// the reader is only fetched once a project actually uses a PDF
function pdfLib() {
  pdfLibLoading ??= loadScript(`${PDFJS}pdf.min.js`).then(() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
    return pdfjsLib;
  });
  // a failed download (offline) may be retried later
  pdfLibLoading.catch(() => { pdfLibLoading = null; });
  return pdfLibLoading;
}

function pdfDoc(src) {
  if (!pdfDocs.has(src)) {
    const p = pdfLib().then(lib => lib.getDocument({ url: urls.get(src) }).promise);
    p.catch(() => pdfDocs.delete(src));
    pdfDocs.set(src, p);
  }
  return pdfDocs.get(src);
}

// Every stage shows the same picture of a page, so each page is drawn only once,
// at the project's canvas width (never below 1280 px, capped at 2560 px).
function pdfPageUrl(src, n) {
  const key = `${src}#${n}`;
  if (!pdfPages.has(key)) {
    const width = Math.min(2560, Math.max(1280, cur.data.canvas.width));
    const p = (async () => {
      const page = await (await pdfDoc(src)).getPage(n);
      const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const cv = Object.assign(document.createElement('canvas'), { width: Math.round(vp.width), height: Math.round(vp.height) });
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      return URL.createObjectURL(await new Promise(res => cv.toBlob(res, 'image/png')));
    })();
    p.catch(() => pdfPages.delete(key));
    pdfPages.set(key, p);
  }
  return pdfPages.get(key);
}

// Go to page n of a PDF source: Preview, Live and Output all change together.
async function setPage(s, n) {
  const doc = await pdfDoc(s.src);
  n = Math.max(1, Math.min(doc.numPages, Math.round(n) || 1));
  if (n !== (s.page ?? 1)) {
    s.page = n;
    saveSoon();
  }
  renderInsp();
  const url = await pdfPageUrl(s.src, n);
  // a later page change may have overtaken this one while it was being drawn
  if ((s.page ?? 1) !== n) return;
  for (const st of Object.values(stages)) {
    for (const img of st.el.querySelectorAll(`img[data-sid="${s.id}"]`)) img.src = url;
  }
  // draw the next page ahead of time, so moving forward is instant
  if (n < doc.numPages) pdfPageUrl(s.src, n + 1).catch(() => {});
}

// The PDF that the arrow keys / a presentation clicker turn: the one on Live
// (topmost layer first), else the one waiting on Preview.
function pdfTarget() {
  for (const ids of [sel.live, sel.pv]) {
    for (const id of ids) {
      const s = id && findShot(id)?.sources.find(x => x.type === 'pdf');
      if (s) return s;
    }
  }
  return null;
}

// dir: +1 next, -1 previous. Returns false when no PDF is showing. Also called by output.html.
function pdfKey(dir) {
  const s = cur && pdfTarget();
  if (s) guard(setPage)(s, (s.page ?? 1) + dir);
  return !!s;
}

/* ---------- cameras / audio inputs / screen capture ---------- */

async function listDevices(type) {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === DEV_KIND[type] && d.deviceId !== 'default' && d.deviceId !== 'communications');
}

// one capture per screen source, one per physical device
const streamKey = s => s.type === 'screen' ? `screen:${s.id}` : `${s.type}:${s.deviceId}`;

async function openStream(s) {
  // ids differ per machine, so fall back to matching the saved label
  const all = await listDevices(s.type);
  const d = all.find(x => x.deviceId === s.deviceId) ?? all.find(x => x.label && x.label === s.label);
  const c = { deviceId: { exact: d?.deviceId || s.deviceId } };
  return navigator.mediaDevices.getUserMedia(s.type === 'camera'
    ? { video: { ...c, width: { ideal: 1920 }, height: { ideal: 1080 } } }
    : { audio: { ...c, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
}

function getStream(s) {
  const k = streamKey(s);
  if (!streams.has(k)) {
    // a screen capture can only start from a user click, see pickScreen
    if (s.type === 'screen') return Promise.reject(new DOMException('no capture yet', 'NeedPick'));
    const p = openStream(s);
    p.catch(() => streams.delete(k));
    streams.set(k, p);
  }
  return streams.get(k);
}

function stopStream(k) {
  const p = streams.get(k);
  streams.delete(k);
  p?.then(st => st.getTracks().forEach(t => t.stop()), () => {});
}

// stop captures no source refers to any more
function gcStreams() {
  const used = new Set(allShots().flatMap(sh => sh.sources).filter(s => STREAMED.includes(s.type)).map(streamKey));
  for (const k of [...streams.keys()]) if (!used.has(k)) stopStream(k);
}

function setScreenStream(s, st) {
  const k = streamKey(s);
  stopStream(k);
  const p = Promise.resolve(st);
  streams.set(k, p);
  // the user can end sharing from the browser's own bar
  st.getVideoTracks()[0].addEventListener('ended', () => {
    if (streams.get(k) !== p) return;
    streams.delete(k);
    if (cur) rerender(sh => sh.sources.some(x => x.id === s.id));
  });
}

const askScreen = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });

async function pickScreen(s) {
  let st;
  try {
    st = await askScreen();
  } catch (e) {
    if (e.name === 'NotAllowedError') return;
    throw e;
  }
  setScreenStream(s, st);
  rerender(sh => sh.sources.some(x => x.id === s.id));
}

/* ---------- open flow ---------- */

async function pickFolder() {
  let dir;
  try {
    dir = await showDirectoryPicker({ id: 'sgtobs', mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw e;
  }
  await openFolder(dir);
}

async function openFolder(dir) {
  if (!await ensurePerm(dir)) {
    toast('ไม่ได้รับอนุญาตให้เข้าถึง folder', true);
    return;
  }
  const { fh, data, created, convertedFrom } = await loadOrCreate(dir);
  await remember(dir);
  await closeProject();
  cur = { dir, fh, data };
  await renderProject();
  show('project');
  toast(created ? `สร้าง ${fh.name} แล้ว`
    : convertedFrom ? `แปลง ${convertedFrom} เป็น ${fh.name} แล้ว (ไฟล์เดิมยังอยู่)`
      : `เปิด ${fh.name}`);
}

async function goHome() {
  await closeProject();
  document.title = 'SGT Backstage';
  await renderRecent();
  show('home');
}

/* ---------- render ---------- */

function show(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmtDate = d => new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

async function renderRecent() {
  const all = await recentAll();
  const ul = $('recentList');
  ul.replaceChildren();
  $('recentBox').hidden = !all.length;

  for (const r of all) {
    const li = el('li');
    const open = el('button', 'open');
    open.append(el('span', 'name', r.name), el('span', 'when', fmtDate(r.openedAt)));
    open.onclick = guard(() => openFolder(r.handle));

    const rm = el('button', 'remove', '×');
    rm.title = 'ลบออกจากรายการ';
    rm.onclick = guard(async () => { await forget(r.id); await renderRecent(); });

    li.append(open, rm);
    ul.append(li);
  }
}

async function renderProject() {
  const { dir, fh, data } = cur;
  document.title = `${data.name} — SGT Backstage`;
  $('projName').textContent = data.name;
  $('projPath').textContent = `${dir.name}/${fh.name}`;
  $('project').style.setProperty('--ar', data.canvas.width / data.canvas.height);

  await Promise.all(allShots().flatMap(sh => sh.sources).filter(s => s.src).map(s => loadUrl(s.src)));
  sel = { pv: data.layers.map(() => null), live: data.layers.map(() => null) };
  stages = { pv: makeStage($('pvStage')), live: makeStage($('liveStage')) };
  attachOutput();
  renderLayers();
  renderInsp();
}

/* ---------- stages (preview / live) ---------- */

const makeStage = el => ({ el, cur: cur.data.layers.map(() => null), nodes: cur.data.layers.map(() => null) });

const pct = v => `${v * 100}%`;

// Gradient stops for one fade between `from` % and `to` %, opaque -> clear (or clear ->
// opaque when `rising`). A straight ramp shows as a band with two visible edges, so the
// opacity follows an S-curve instead: it leaves and arrives gently, like a lens vignette.
function fadeStops(from, to, rising) {
  const STEPS = 12;
  return Array.from({ length: STEPS + 1 }, (_, k) => {
    const t = k / STEPS;
    // smootherstep: zero slope and zero curvature at both ends
    const e = t * t * t * (t * (t * 6 - 15) + 10);
    const alpha = rising ? e : 1 - e;
    return `rgba(0,0,0,${alpha.toFixed(3)}) ${(from + (to - from) * t).toFixed(2)}%`;
  }).join(', ');
}

// position, size and crop of one source box (.src > .view > media), in canvas pixels.
// .view is the cropped picture, fitted inside the box with its aspect ratio kept.
function applyGeom(box, s) {
  const { width: W, height: H } = cur.data.canvas;
  Object.assign(box.style, { left: pct(s.x / W), top: pct(s.y / H), width: pct(s.w / W), height: pct(s.h / H) });

  const view = box.firstChild;
  // Soft edges, so the source underneath shows through. Every mask below is one
  // layer; the picture is visible only where all of them are opaque (intersect).
  //   feather: fades to nothing over f % of the width / height on each side
  //   diag:    fades out across a diagonal through the middle, `soft` % wide
  const masks = [];
  const f = s.feather;
  if (f && (f.l || f.t || f.r || f.b)) {
    masks.push(
      `linear-gradient(to right, ${fadeStops(0, f.l, true)}, ${fadeStops(100 - f.r, 100, false)})`,
      `linear-gradient(to bottom, ${fadeStops(0, f.t, true)}, ${fadeStops(100 - f.b, 100, false)})`,
    );
  }
  if (s.diag) masks.push(`linear-gradient(to ${s.diag.to}, ${fadeStops(50 - s.diag.soft / 2, 50 + s.diag.soft / 2, false)})`);
  // rounded corners, given in canvas pixels: 100cqw is this box's width, which is s.w of them
  view.style.borderRadius = s.radius ? `${s.radius / s.w * 100}cqw` : '';
  for (const p of ['mask-image', '-webkit-mask-image']) view.style.setProperty(p, masks.join(', '));
  view.style.setProperty('mask-composite', 'intersect');
  view.style.setProperty('-webkit-mask-composite', 'source-in');

  const m = view.firstChild;
  const iw = m.naturalWidth || m.videoWidth;
  const ih = m.naturalHeight || m.videoHeight;
  // size is unknown until the media has loaded; shotNode calls back then
  view.style.visibility = iw ? '' : 'hidden';
  if (!iw) return;

  const c = s.crop;
  const fx = 1 - (c.l + c.r) / 100;
  const fy = 1 - (c.t + c.b) / 100;
  view.style.setProperty('--a', (iw * fx) / (ih * fy));
  Object.assign(m.style, { width: pct(1 / fx), height: pct(1 / fy), left: pct(-c.l / 100 / fx), top: pct(-c.t / 100 / fy) });
}

// feed a stream into a media element; on failure say why via note()
function feed(m, s, note, onStream) {
  getStream(s).then(st => {
    m.srcObject = st;
    onStream?.(st);
  }, e => {
    if (e.name === 'NeedPick') {
      note(`เลือกหน้าต่าง: ${s.name}`, () => pickScreen(s));
    } else {
      console.error(e);
      note(`ใช้ ${s.name} ไม่ได้ (${e.name})`);
    }
  });
}

// mode: 'pv' | 'live' | 'out' — sound plays only from the live stage
function shotNode(shot, mode) {
  const n = el('div', 'lyr');
  const tags = el('div', 'tags');
  // status labels are for the operator, never for the projector
  const note = (text, fn) => {
    if (mode === 'out') return;
    const t = el(fn ? 'button' : 'span', 'tag', text);
    if (fn) t.onclick = guard(fn);
    tags.append(t);
  };

  // every sound of this shot goes through one bus, so the whole shot can be faded as one
  const bus = () => (n._bus ??= liveBus());
  // playlist shots play their audio files one after another instead of all at once
  const songs = isList(shot) ? [] : null;

  shot.sources.forEach((s, k) => {
    if (s.type === 'audio' || s.type === 'mic') {
      const inList = songs && s.type === 'audio';
      if (inList) songs.push(null);
      if (mode !== 'live') return;
      const a = Object.assign(el('audio'), { autoplay: !inList, preload: 'auto' });
      if (s.type === 'mic') {
        feed(a, s, note, st => meterStream(a, st, bus()));
      } else if (urls.has(s.src)) {
        a.src = urls.get(s.src);
        a.dataset.name = s.name;
        a.dataset.shot = shot.id;
        a.dataset.sid = s.id;
        if (starts.has(s.id)) a.currentTime = starts.get(s.id);
        // in a playlist the list loops as a whole, not each song
        a.loop = !!s.loop && !inList;
        meterElement(a, bus());
        if (inList) {
          // setStage must not start these; runPlaylist does, in order
          a.dataset.pl = 1;
          songs[songs.length - 1] = a;
        }
      } else {
        return note(`ไม่พบไฟล์ ${s.src}`);
      }
      n.append(a);
      return;
    }

    let m;
    if (s.type === 'pdf') {
      if (!urls.has(s.src)) return note(`ไม่พบไฟล์ ${s.src}`);
      // the current page, drawn once and shown as a picture; setPage swaps it later
      m = el('img');
      m.dataset.sid = s.id;
      pdfPageUrl(s.src, s.page ?? 1).then(u => { m.src = u; }, e => {
        console.error(e);
        note(`เปิด ${s.name} ไม่ได้`);
      });
    } else if (s.type === 'image' || s.type === 'video') {
      const url = urls.get(s.src);
      if (!url) return note(`ไม่พบไฟล์ ${s.src}`);
      m = s.type === 'image'
        ? Object.assign(el('img'), { src: url })
        : Object.assign(el('video'), { src: url, autoplay: true, muted: mode !== 'live', playsInline: true });
      m.dataset.name = s.name;
      m.dataset.shot = shot.id;
      m.dataset.sid = s.id;
      if (s.type === 'video') m.loop = !!s.loop;
      if (s.type === 'video') {
        if (starts.has(s.id)) m.currentTime = starts.get(s.id);
        // Preview never plays a video: it holds one still frame (the start position),
        // which is all that placing and cropping it needs. Live and Output play.
        if (mode === 'pv') {
          m.autoplay = false;
          m.preload = 'auto';
          m.dataset.hold = 1;
          note(`▶ ${s.name}`);
        }
      }
      if (s.type === 'video' && mode === 'live') meterElement(m, bus());
    } else {
      m = Object.assign(el('video'), { autoplay: true, muted: true, playsInline: true });
      feed(m, s, note);
    }
    const box = el('div', 'src');
    box.dataset.src = s.id;
    // first source in the list is on top
    box.style.zIndex = shot.sources.length - k;
    const view = el('div', 'view');
    view.append(m);
    box.append(view);
    const fit = () => { if (cur) applyGeom(box, s); };
    for (const ev of ['load', 'loadedmetadata', 'resize']) m.addEventListener(ev, fit);
    applyGeom(box, s);
    n.append(box);
  });

  const list = songs?.filter(Boolean) ?? [];
  if (mode === 'live' && list.length) n._start = () => { n._pl = runPlaylist(list, shot.playlist ? shot.cross ?? 3 : 0, () => !!shot.plLoop); };

  n.append(tags);
  return n;
}

// apply a per-layer selection to a stage; only layers that changed transition
function setStage(st, ids, ms, mode) {
  ids.forEach((id, i) => {
    if (st.cur[i] === id) return;
    st.cur[i] = id;
    const old = st.nodes[i];
    const node = id ? shotNode(findShot(id), mode) : null;
    st.nodes[i] = node;

    if (node) {
      // layer 1 is on top
      node.style.zIndex = ids.length - i;
      node.style.setProperty('--i', i);
      node.style.transition = `opacity ${ms}ms`;
      node.style.opacity = ms ? 0 : 1;
      st.el.append(node);
      for (const m of node.querySelectorAll('video:not([data-hold]), audio:not([data-pl])')) m.play().catch(() => {});
      node._start?.();
      if (ms) {
        node.offsetWidth;
        node.style.opacity = 1;
        fadeBus(node, 0, 1, AUDIO_FADE_MS);
      }
    }
    if (old) {
      old.style.transition = `opacity ${ms}ms`;
      old.style.opacity = 0;
      // the countdown should already follow the incoming shot
      old.dataset.out = 1;
      if (ms) fadeBus(old, null, 0, AUDIO_FADE_MS);
      // an outgoing shot with sound stays (invisible) until its fade-out is done
      setTimeout(() => {
        dropAudio(old);
        old.remove();
      }, ms && old._bus ? Math.max(ms, AUDIO_FADE_MS) : ms);
    }
  });
}

function pushLive(ms) {
  setStage(stages.live, sel.live, ms, 'live');
  if (stages.out) setStage(stages.out, sel.live, ms, 'out');
}

// rebuild every on-screen copy of the shots matching pred (file videos restart)
function rerender(pred) {
  for (const st of Object.values(stages)) {
    st.cur.forEach((id, i) => {
      if (id && pred(findShot(id))) st.cur[i] = undefined;
    });
  }
  setStage(stages.pv, sel.pv, 0, 'pv');
  pushLive(0);
}

// move/resize/crop in place, without restarting anything
function regeom(s) {
  for (const st of Object.values(stages)) {
    for (const box of st.el.querySelectorAll(`[data-src="${s.id}"]`)) applyGeom(box, s);
  }
  placeGizmo();
}

function setTrans(t) {
  trans = t === 'smooth' ? 'smooth' : 'cut';
  for (const b of document.querySelectorAll('.trans')) b.classList.toggle('active', b.dataset.t === trans);
}

function go() {
  if (!cur) return;
  actx?.resume();
  sel.live = [...sel.pv];
  pushLive(trans === 'smooth' ? SMOOTH_MS : 0);
  // the start positions picked on Preview have now been used
  starts.clear();
  mark();
}

/* ---------- live audio: routing + level meter ---------- */

const DB_FLOOR = -60;
let actx = null;
let master = null;
// one analyser per channel (L, R)
let analysers = [];

// built on first use: browsers only start audio after a user gesture
function audioGraph() {
  if (!actx) {
    actx = new AudioContext();
    // explicit stereo so a mono source reads on both bars
    master = new GainNode(actx, { channelCount: 2, channelCountMode: 'explicit' });
    const split = new ChannelSplitterNode(actx, { numberOfOutputs: 2 });
    master.connect(actx.destination);
    master.connect(split);
    analysers = [0, 1].map(ch => {
      const a = new AnalyserNode(actx, { fftSize: 1024 });
      split.connect(a, ch);
      return a;
    });
  }
  actx.resume();
  return actx;
}

// everything audible on Live goes through master, so the meter shows the real mix
// one per live shot node: element -> its own gain -> shot bus -> master
function liveBus() {
  const b = new GainNode(audioGraph());
  b.connect(master);
  return b;
}

function meterElement(m, bus) {
  const ctx = audioGraph();
  m._an = ctx.createMediaElementSource(m);
  m._gain = new GainNode(ctx);
  m._an.connect(m._gain).connect(bus);
}

function meterStream(m, st, bus) {
  // the graph plays it; unmuted, the element would play it a second time
  m.muted = true;
  const ctx = audioGraph();
  m._an = ctx.createMediaStreamSource(st);
  m._gain = new GainNode(ctx);
  m._an.connect(m._gain).connect(bus);
}

function ramp(gainNode, from, to, sec) {
  const g = gainNode.gain;
  const t = actx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(from ?? g.value, t);
  g.linearRampToValueAtTime(to, t + sec);
}

// fade all sound of a live shot node; from null = from wherever it is now
function fadeBus(node, from, to, ms) {
  if (node._bus) ramp(node._bus, from, to, ms / 1000);
}

// play tracks in order, overlapping each change by `cross` seconds (0 = back to back);
// loop() is asked at the end of the list, so the option can change while it plays.
// Returns { jump(k) } to switch straight to track k.
function runPlaylist(tracks, cross, loop) {
  // only the watcher of the most recently started track may hand over
  let gen = 0;
  const play = (k, again) => {
    const my = ++gen;
    const a = tracks[k];
    if (again) a.currentTime = 0;
    a.play().catch(() => {});
    const watch = () => {
      if (my !== gen || !a.isConnected) return;
      const last = k === tracks.length - 1;
      if (last && !loop()) return;
      // a lone looping song just starts over; nothing to crossfade with
      const solo = tracks.length === 1;
      // overlap is capped so a short track is never all crossfade
      const x = solo ? 0 : Math.min(cross, a.duration / 2 || 0);
      if (!a.ended && !(x > 0 && a.duration - a.currentTime <= x)) return;
      a.removeEventListener('timeupdate', watch);
      a.removeEventListener('ended', watch);
      const nxt = tracks[last ? 0 : k + 1];
      if (a.ended) {
        ramp(nxt._gain, 1, 1, 0);
      } else {
        ramp(a._gain, 1, 0, x);
        ramp(nxt._gain, 0, 1, x);
      }
      play(last ? 0 : k + 1, true);
    };
    a.addEventListener('timeupdate', watch);
    a.addEventListener('ended', watch);
  };
  play(0, false);
  return {
    jump(k) {
      for (const t of tracks) {
        t.pause();
        ramp(t._gain, 1, 1, 0);
      }
      play(k, true);
    },
  };
}

function dropAudio(root) {
  for (const m of root.querySelectorAll('video, audio')) {
    m.pause();
    m._an?.disconnect();
    m._gain?.disconnect();
  }
  for (const n of root.matches('.lyr') ? [root] : root.querySelectorAll('.lyr')) n._bus?.disconnect();
}

const meterBuf = new Float32Array(1024);
const meterLvl = [0, 0];
const meterHold = [0, 0];

let meterAt = 0;

function meterTick(now = 0) {
  requestAnimationFrame(meterTick);
  // seconds since the last frame, so fall speed does not depend on frame rate
  const dt = Math.min(0.5, (now - meterAt) / 1000);
  meterAt = now;
  document.querySelectorAll('#meter .bar').forEach((bar, ch) => {
    let pk = 0;
    if (cur && analysers[ch]) {
      analysers[ch].getFloatTimeDomainData(meterBuf);
      for (const v of meterBuf) pk = Math.max(pk, Math.abs(v));
    }
    const db = pk ? 20 * Math.log10(pk) : -Infinity;
    const p = Math.max(0, Math.min(1, 1 - db / DB_FLOOR));
    // jump up instantly, fall back slowly; the peak line lingers longer
    meterLvl[ch] = Math.max(p, meterLvl[ch] - 1.5 * dt);
    meterHold[ch] = Math.max(meterLvl[ch], meterHold[ch] - 0.3 * dt);
    bar.firstElementChild.style.height = pct(1 - meterLvl[ch]);
    bar.lastElementChild.style.bottom = pct(meterHold[ch]);
    bar.classList.toggle('clip', db >= -0.1);
  });
}

/* ---------- output window (projector) ---------- */

async function openOutput() {
  if (outWin && !outWin.closed) {
    outWin.close();
    return;
  }
  let feat = 'popup,width=960,height=540';
  // put it fullscreen on a second display when the browser lets us
  if ('getScreenDetails' in window) {
    try {
      const sd = await getScreenDetails();
      const scr = sd.screens.find(x => x !== sd.currentScreen);
      if (scr) feat = `popup,fullscreen,left=${scr.availLeft},top=${scr.availTop},width=${scr.availWidth},height=${scr.availHeight}`;
    } catch (e) {
      if (e.name !== 'NotAllowedError') throw e;
    }
  }
  if (!window.open('output.html', 'sgtobs-output', feat)) throw new Error('Browser บล็อก popup — อนุญาต popup สำหรับหน้านี้ก่อน');
}

// called by output.html once it has loaded
function outputReady(w) {
  outWin = w;
  $('outBtn').classList.add('on');
  $('outBtn').textContent = 'ปิดจอ Output';
  attachOutput();
}

function outputClosed() {
  outWin = null;
  delete stages.out;
  $('outBtn').classList.remove('on');
  $('outBtn').textContent = 'เปิดจอ Output';
}

// mirror the current live stage into the output window
function attachOutput() {
  if (!outWin || outWin.closed || !cur) return;
  const d = outWin.document;
  d.documentElement.style.setProperty('--ar', cur.data.canvas.width / cur.data.canvas.height);
  stages.out = makeStage(d.getElementById('stage'));
  stages.out.el.replaceChildren();
  setStage(stages.out, sel.live, 0, 'out');
  for (const a of stages.live.el.querySelectorAll('.src video[src]')) {
    const b = stages.out.el.querySelector(`[data-src="${a.closest('.src').dataset.src}"] video`);
    if (b) b.currentTime = a.currentTime;
  }
}

/* ---------- layers / shots ---------- */

const thaiWords = new Intl.Segmenter('th', { granularity: 'word' });

// Short label for a scene tile, made from its name:
//   "scene 1" -> "s1"   "Opening Song" -> "OS"   "intro" -> "in"   "song02.mp3" -> "s02"
//   "ทดสอบ" -> "ทส"     "พื้นหลัง เปิดงาน" -> "พป"
function abbr(name) {
  const MAX = 4;
  // a file name's extension says nothing about the scene
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  // words: split on spaces and punctuation, and between letters and digits
  let parts = base.split(/[\s\-_.,/()]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/).filter(Boolean);
  // Thai is written without spaces, so let the browser find the words
  if (parts.length === 1 && /[ก-ฮ]/.test(base)) {
    parts = [...thaiWords.segment(base)].filter(w => w.isWordLike).map(w => w.segment);
  }
  // a number is kept whole; a Thai word gives its first consonant, skipping leading vowels (เ แ โ ใ ไ)
  const head = w => (/^\d+$/.test(w) ? w : w.match(/[ก-ฮ]/)?.[0] ?? [...w][0]);
  if (parts.length > 1) return parts.map(head).join('').slice(0, MAX);

  const w = parts[0] ?? base;
  const thai = w.match(/[ก-ฮ]/g);
  // one Thai word: its first consonant and the one that starts its second half
  if (thai) return thai.length > 1 ? thai[0] + thai[Math.floor(thai.length / 2)] : thai[0];
  return [...w].slice(0, 2).join('') || '?';
}

// the label on a scene's tile: the one typed by the user, else made from the name
const tileLabel = shot => shot.abbr || abbr(shot.name);

// what a scene mostly is, to tint its tile: its first picture source, else its first source
const tileKind = shot => (shot.sources.find(s => VISUAL.includes(s.type)) ?? shot.sources[0])?.type ?? 'empty';

function selectShot(i, id) {
  sel.pv[i] = id;
  setStage(stages.pv, sel.pv, 0, 'pv');
  edit = id ? { shotId: id, srcId: null } : null;
  mark();
  renderInsp();
}

function shotTile(i, shot) {
  const id = shot?.id ?? null;
  const t = el('div', 'shot');
  t.dataset.layer = i;
  t.dataset.id = id ?? '';

  if (!shot) t.classList.add('none');
  const th = el('div', 'thumb');
  if (!shot) th.append(el('span', 'off', '⦸'));
  if (shot) {
    // no preview picture: a short label made from the name, tinted by what the scene is
    t.dataset.kind = tileKind(shot);
    t.title = shot.name;
    th.append(el('span', 'abbr', tileLabel(shot)));
    if (shot.sources.length > 1) th.append(el('span', 'count', shot.sources.length));
  }
  const hk = getHotkey(i, shot);
  if (hk) th.append(el('span', 'hk', keyLabel(hk)));
  t.append(th, el('span', 'name', shot ? shot.name : 'ว่าง'));

  t.onclick = () => selectShot(i, id);
  t.oncontextmenu = e => {
    e.preventDefault();
    openShotMenu(e, i, shot);
  };

  if (shot) {
    t.ondblclick = renameShot;
    const rm = el('button', 'rm', '×');
    rm.title = 'ลบ scene';
    rm.onclick = guard(async e => {
      e.stopPropagation();
      if (await askDelete(`ลบ scene "${shot.name}"?`, sceneDetail(shot))) await removeShot(i, id);
    });
    t.append(rm);
  }
  return t;
}

function renderLayers() {
  $('layers').replaceChildren(...cur.data.layers.map((l, i) => {
    const row = el('div', 'layer');
    const bin = el('div', 'bin');
    const add = el('button', 'addShot', '+');
    add.title = 'เพิ่ม scene';
    add.onclick = guard(() => openAddMenu(add, def => addShot(i, def), true));
    bin.append(shotTile(i, null), ...l.shots.map(s => shotTile(i, s)), add);
    row.append(el('div', 'layerName', i + 1), bin);
    return row;
  }));
  mark();
}

// highlight which shot of each layer is in preview / live / the inspector
function mark() {
  for (const t of document.querySelectorAll('#layers .shot')) {
    const id = t.dataset.id || null;
    t.classList.toggle('pv', sel.pv[t.dataset.layer] === id);
    t.classList.toggle('live', sel.live[t.dataset.layer] === id);
    t.classList.toggle('editing', !!id && edit?.shotId === id);
  }
}

// def = first source of the new shot, or null for an empty shot
async function addShot(i, def) {
  const shot = { id: crypto.randomUUID(), name: def?.name ?? 'Scene', sources: [] };
  if (def) {
    if (def.src) await loadUrl(def.src);
    shot.sources.push(newSource(cur.data.canvas, def));
  }
  cur.data.layers[i].shots.push(shot);
  await save();
  renderLayers();
  selectShot(i, shot.id);
}

// Ask before deleting; resolves true only when the user presses "ลบ".
// Esc, clicking outside, or "ยกเลิก" all mean no.
let askDone = null;

function askDelete(text, detail = '') {
  // a question still on screen is answered "no" by asking another
  askDone?.(false);
  return new Promise(res => {
    const d = $('askDlg');
    askDone = yes => {
      askDone = null;
      if (d.open) d.close();
      res(yes);
    };
    $('askText').textContent = text;
    $('askDetail').textContent = detail;
    d.showModal();
    // so a stray Enter cancels instead of deleting
    $('askNo').focus();
  });
}

const sceneDetail = shot => (shot.sources.length ? `มี ${shot.sources.length} source · ไฟล์ใน folder ไม่ถูกลบ` : '');

async function removeShot(i, id) {
  const l = cur.data.layers[i];
  l.shots = l.shots.filter(s => s.id !== id);
  for (const k of ['pv', 'live']) if (sel[k][i] === id) sel[k][i] = null;
  if (edit?.shotId === id) edit = null;
  setStage(stages.pv, sel.pv, 0, 'pv');
  pushLive(0);
  gcStreams();
  await save();
  renderLayers();
  renderInsp();
}

function renameShot() {
  $('shotName').focus();
  $('shotName').select();
}

/* ---------- shot shortcuts (Ctrl + key) ---------- */

// shot waiting for its key: { layer, shot }
let capture = null;

// e.code names the physical key, so shortcuts work on any keyboard layout (Thai included)
const keyLabel = code => `Ctrl+${code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num')}`;

// in everything below, shot === null stands for the layer's "ว่าง" (nothing) tile
const getHotkey = (i, shot) => (shot ? shot.hotkey : cur.data.layers[i].clearHotkey);

function openShotMenu(e, i, shot) {
  const m = $('addMenu');
  const close = fn => async () => {
    m.hidden = true;
    await fn();
  };
  const hk = getHotkey(i, shot);
  const items = [menuItem('⌨', hk ? `เปลี่ยน shortcut (${keyLabel(hk)})` : 'ตั้ง shortcut…', () => {
    capture = { layer: i, shot };
    m.replaceChildren(el('p', '', 'กด Ctrl ค้างไว้ แล้วกดปุ่มที่ต้องการ'), el('p', 'dim', 'Esc = ยกเลิก'));
  })];
  if (hk) items.push(menuItem('×', 'ลบ shortcut', close(() => setHotkey(i, shot, null))));
  if (shot) {
    items.push(
      menuItem('✎', 'เปลี่ยนชื่อ', close(() => { selectShot(i, shot.id); renameShot(); })),
      menuItem('×', 'ลบ scene', close(async () => {
        if (await askDelete(`ลบ scene "${shot.name}"?`, sceneDetail(shot))) await removeShot(i, shot.id);
      })),
    );
  }
  m.replaceChildren(...items);
  placeMenu({ left: e.clientX, top: e.clientY, bottom: e.clientY });
}

async function setHotkey(i, shot, code) {
  const l = cur.data.layers[i];
  if (code) {
    // one layer shows one thing at a time, so a key may not point at two of its tiles
    for (const s of l.shots) if (s.hotkey === code) delete s.hotkey;
    if (l.clearHotkey === code) delete l.clearHotkey;
  }
  const [o, k] = shot ? [shot, 'hotkey'] : [l, 'clearHotkey'];
  if (code) o[k] = code;
  else delete o[k];
  await save();
  renderLayers();
}

async function onCaptureKey(e) {
  e.preventDefault();
  if (e.code === 'Escape') {
    capture = null;
    $('addMenu').hidden = true;
    return;
  }
  // wait for a real key while only modifiers are down
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  if (!e.ctrlKey) return toast('ต้องกด Ctrl ค้างไว้ด้วย', true);
  const { layer, shot } = capture;
  capture = null;
  $('addMenu').hidden = true;
  await setHotkey(layer, shot, e.code);
  toast(`${shot?.name ?? `ว่าง (layer ${layer + 1})`} = ${keyLabel(e.code)}`);
}

// put everything bound to this key into Preview; returns false when nothing is
function runHotkey(code) {
  // [layer, shot id]; null id = clear that layer
  const hits = [];
  cur.data.layers.forEach((l, i) => {
    if (l.clearHotkey === code) hits.push([i, null]);
    else if (l.shots.some(s => s.hotkey === code)) hits.push([i, l.shots.find(s => s.hotkey === code).id]);
  });
  // a shot (not a clear) on the topmost layer goes last, so the inspector ends on it
  for (const [i, id] of hits.sort((a, b) => !!a[1] - !!b[1] || b[0] - a[0])) selectShot(i, id);
  return hits.length > 0;
}

/* ---------- countdown (time left on live audio / video files) ---------- */

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QR_URL = 'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js';
const ROOM_KEY = 'sgtobs-room';

// six digits: short enough to read out and type on a phone
const newRoom = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
const fmtRoom = r => `${r.slice(0, 3)} ${r.slice(3)}`;

// Each operator's browser owns one room; only countdown pages opened with its id see it.
let room = localStorage.getItem(ROOM_KEY);
// (codes saved by earlier versions were letters and digits; those are replaced)
if (!/^\d{6}$/.test(room ?? '')) localStorage.setItem(ROOM_KEY, room = newRoom());

// same-browser windows get the countdown over this, with no network at all
let cdChan = openRoomChannel();
// other devices connect peer-to-peer (PeerJS); null until its library has loaded
let peer = null;
const conns = new Set();
// 'off' | 'on' | 'retry' | 'nolib'
let peerState = 'off';

// remote.html in this same browser sends its commands back over the channel
function openRoomChannel() {
  const ch = new BroadcastChannel(`sgtobs-countdown-${room}`);
  ch.onmessage = e => onRemote(e.data);
  return ch;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const sc = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error(`โหลด ${src} ไม่ได้`)) });
    document.head.append(sc);
  });
}

// team = one cue-sheet team, or '' for the plain time-left page
const REMOTE = '@remote';

// what = '' for the plain time-left page, a cue-sheet team name for that team's page,
// or REMOTE for the phone / tablet remote control
function countdownUrl(what = $('cdTeam').value) {
  const page = new URL(what === REMOTE ? 'remote.html' : 'countdown.html', location.href).href;
  return `${page}#${room}${what && what !== REMOTE ? `/${encodeURIComponent(what)}` : ''}`;
}

/* ---------- remote control (remote.html on a phone / tablet) ---------- */

// everything the remote draws: the scenes of each layer, and what is on Preview / Live
function remoteState() {
  const pdf = pdfTarget();
  return {
    name: cur.data.name,
    trans,
    pv: sel.pv,
    live: sel.live,
    layers: cur.data.layers.map(l => l.shots.map(sh => ({ id: sh.id, label: tileLabel(sh), name: sh.name, kind: tileKind(sh) }))),
    pdf: pdf && { name: pdf.name, page: pdf.page ?? 1 },
    // bookmarks of the file the seek bar is on (its position travels with the countdown tick)
    marks: (tp?.s.bookmarks ?? []).map(b => ({ t: b.t, name: b.name })),
  };
}

let lastState = '';

// sent whenever it changes (checked on the countdown tick), and on request
function sendState(force) {
  const st = cur ? remoteState() : null;
  const json = JSON.stringify(st);
  if (!force && json === lastState) return;
  lastState = json;
  cdChan.postMessage({ st });
  for (const c of conns) if (c.open) c.send({ st });
}

// ids of commands already carried out: a remote in this browser reaches us twice,
// once over the channel and once over its peer connection
const seenCmds = new Set();

function onRemote(m) {
  if (!m?.cmd) return;
  if (m.n != null) {
    if (seenCmds.has(m.n)) return;
    seenCmds.add(m.n);
    setTimeout(() => seenCmds.delete(m.n), 10000);
  }
  if (m.cmd === 'hello') return sendState(true);
  if (!cur) return;
  if (m.cmd === 'select') {
    const l = cur.data.layers[m.layer];
    // only ever a scene that really is on that layer, or null to empty it
    if (l && (m.id === null || l.shots.some(sh => sh.id === m.id))) selectShot(m.layer, m.id);
  } else if (m.cmd === 'go') {
    go();
  } else if (m.cmd === 'trans') {
    setTrans(m.t);
  } else if (m.cmd === 'page') {
    pdfKey(m.dir === -1 ? -1 : 1);
  } else if (m.cmd === 'seek') {
    // same bar as on the control page: it moves whatever that bar is on right now
    if (Number.isFinite(m.t)) seekTo(m.t);
  }
  sendState();
}

// the code other devices type in to find this control page
function showRoom() {
  $('roomBtn').textContent = `รหัส ${fmtRoom(room)}`;
  $('cdCode').textContent = fmtRoom(room);
}

function setPeerState(st) {
  peerState = st;
  if (!$('cdPanel').hidden) renderCdPanel();
}

function startPeer() {
  peer = new Peer(`sgtobs-${room}`);
  peer.on('open', () => setPeerState('on'));
  peer.on('connection', c => {
    c.on('open', () => {
      conns.add(c);
      setPeerState(peerState);
      if (cur) c.send({ st: remoteState() });
    });
    c.on('data', onRemote);
    const gone = () => { conns.delete(c); setPeerState(peerState); };
    c.on('close', gone);
    c.on('error', gone);
  });
  peer.on('disconnected', () => {
    setPeerState('retry');
    setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 3000);
  });
  peer.on('error', e => {
    console.error(e);
    if (e.type === 'unavailable-id') {
      // another tab of this browser already holds the saved room: use a throwaway one here
      peer.destroy();
      cdChan.close();
      room = newRoom();
      cdChan = openRoomChannel();
      showRoom();
      return startPeer();
    }
    setPeerState('retry');
    if (peer.destroyed) setTimeout(startPeer, 5000);
  });
}

function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// where one team stands at `pos` seconds into the track; list is sorted by time
function teamState(list, pos) {
  const k = list.findIndex(c => c.t > pos);
  const at = k < 0 ? list.length : k;
  const cue = c => c && { in: c.t - pos, text: c.text };
  return { now: list[at - 1]?.text ?? null, next: cue(list[at]) ?? null, then: cue(list[at + 1]) ?? null };
}

function countdownTick() {
  // with several files live, count down the one that ends last
  let best = null;
  let bestEl = null;
  // cue sheets follow the clock of their own shot's file
  let teams = null;
  for (const m of stages.live?.el.querySelectorAll('video[src], audio[src]') ?? []) {
    // skip playlist tracks still waiting their turn, and shots that are fading out
    if (!Number.isFinite(m.duration) || m.ended || m.paused || m.closest('[data-out]')) continue;
    const left = m.duration - m.currentTime;
    if (!best || left > best.left) {
      best = { left, total: m.duration, name: m.dataset.name };
      bestEl = m;
    }
    const cues = !teams && findShot(m.dataset.shot)?.cues;
    if (cues) teams = Object.fromEntries(Object.entries(cues).map(([t, list]) => [t, teamState(list, m.currentTime)]));
  }
  transportTick(bestEl);
  $('cd').textContent = best ? `−${fmtTime(best.left)}` : '';
  $('cd').title = best?.name ?? '';
  $('cd').classList.toggle('soon', !!best && best.left <= 10);
  // wrapped, because PeerJS cannot carry a bare null (nothing playing)
  const msg = {
    d: best && { ...best, teams },
    // where the seek bar stands, for the remote's copy of it
    p: tp && { mode: tp.mode, name: tp.s.name, pos: tpPos(), dur: tp.dur },
  };
  cdChan.postMessage(msg);
  for (const c of conns) if (c.open) c.send(msg);
  sendState();
}

function drawQr(cv, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const k = Math.floor(cv.width / (n + quiet * 2));
  const off = Math.floor((cv.width - n * k) / 2);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(off + c * k, off + r * k, k, k);
  }
}

function renderCdPanel() {
  // one page per team that appears in any cue sheet of this project
  const names = cur ? [...new Set(allShots().flatMap(sh => Object.keys(sh.cues ?? {})))] : [];
  const was = $('cdTeam').value;
  $('cdTeam').replaceChildren(
    new Option('Countdown: เวลารวมของเพลง / วิดีโอ', ''),
    ...names.map(n => new Option(`Countdown: ทีม ${n}`, n)),
    new Option('Remote: ควบคุมจากมือถือ / tablet', REMOTE),
  );
  $('cdTeam').value = was === REMOTE || names.includes(was) ? was : '';
  $('cdWarn').hidden = $('cdTeam').value !== REMOTE;

  const url = countdownUrl();
  $('cdUrl').value = url;
  $('cdOpen').href = url;
  $('cdQr').hidden = !window.qrcode;
  if (window.qrcode) drawQr($('cdQr'), url);

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('cdStatus').textContent = {
    on: `พร้อมใช้งาน · เชื่อมต่ออยู่ ${conns.size} เครื่อง`,
    off: 'กำลังเชื่อมต่อ…',
    retry: 'เชื่อมต่อ server ไม่ได้ กำลังลองใหม่… (เปิดในเครื่องนี้ยังใช้ได้)',
    nolib: 'ไม่มีอินเทอร์เน็ต: ใช้ได้เฉพาะหน้าต่างใน browser นี้',
  }[peerState] + (local ? ' · ตอนนี้เป็น localhost เครื่องอื่นจะเปิด URL นี้ไม่ได้' : '');
}

function toggleCdPanel() {
  const p = $('cdPanel');
  p.hidden = !p.hidden;
  if (p.hidden) return;
  renderCdPanel();
  const r = $('cdBtn').getBoundingClientRect();
  p.style.top = `${r.bottom + 6}px`;
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8))}px`;
}

async function copyCdUrl() {
  await navigator.clipboard.writeText(countdownUrl());
  toast('คัดลอก URL แล้ว');
}

/* ---------- transport: seek bar + bookmarks ---------- */

// What the bar controls right now, or null:
//   { mode: 'live', m, s, dur }  a file playing on Live (m = its media element)
//   { mode: 'pv', s, dur }       the selected shot's file, not live yet: the bar sets where it will start
let tp = null;
let tpKey = '';
// true while the user holds the slider, so the ticker does not fight the drag
let tpDrag = false;
// source id -> seconds: start positions picked on Preview, used up by the next Go
const starts = new Map();
// file src -> length in seconds (NaN until its metadata has loaded)
const durs = new Map();

// elapsed time rounds down (the countdown's fmtTime rounds up)
const fmtPos = sec => fmtTime(Math.floor(sec));

const srcOf = m => allShots().flatMap(sh => sh.sources).find(s => s.id === m.dataset.sid);

function durOf(s) {
  if (!durs.has(s.src)) {
    durs.set(s.src, NaN);
    const probe = Object.assign(el(s.type), { preload: 'metadata' });
    probe.onloadedmetadata = () => durs.set(s.src, probe.duration);
    probe.src = urls.get(s.src);
  }
  return durs.get(s.src);
}

const tpPos = () => (tp.mode === 'live' ? tp.m.currentTime : starts.get(tp.s.id) ?? 0);

// The selected shot wins, so a song can be lined up before it goes live;
// with no file in the selected shot, the bar follows whatever is playing on Live.
function transportTarget(liveBest) {
  const shot = editShot();
  const s = shot?.sources.find(x => (x.type === 'audio' || x.type === 'video') && urls.has(x.src));
  if (s) {
    const mine = [...(stages.live?.el.querySelectorAll('video[src], audio[src]') ?? [])]
      .filter(m => m.dataset.shot === shot.id && !m.closest('[data-out]'));
    if (!mine.length) return { mode: 'pv', s, dur: durOf(s) };
    // on Live: the track that is playing, or the last one once everything has finished
    const m = mine.findLast(x => !x.paused) ?? mine.findLast(x => x.ended);
    return m && srcOf(m) ? { mode: 'live', m, s: srcOf(m), dur: m.duration } : null;
  }
  return liveBest && srcOf(liveBest) ? { mode: 'live', m: liveBest, s: srcOf(liveBest), dur: liveBest.duration } : null;
}

function transportTick(liveBest) {
  const t = cur ? transportTarget(liveBest) : null;
  tp = t && Number.isFinite(t.dur) ? t : null;
  const key = tp ? `${tp.mode}:${tp.s.id}:${tp.dur}` : '';
  if (key !== tpKey) {
    tpKey = key;
    renderBookmarks();
    renderRuler();
  }
  songListTick();
  $('transport').classList.toggle('off', !tp);
  $('tpSeek').disabled = $('bmAdd').disabled = !tp;
  $('tpMode').textContent = tp ? (tp.mode === 'live' ? 'LIVE' : 'PREVIEW') : '';
  $('tpMode').className = tp?.mode ?? '';
  $('tpName').textContent = tp ? tp.s.name : 'เลือก scene ที่มีเพลง / วิดีโอ';
  $('tpPos').textContent = tp ? fmtPos(tpPos()) : '';
  $('tpLeft').textContent = tp ? `−${fmtTime(tp.dur - tpPos())}` : '';
  if (!tp) return;
  $('tpSeek').max = tp.dur;
  if (!tpDrag) $('tpSeek').value = tpPos();
}

/* what is on Preview and on Live, layer by layer, shown inside the transport bar */

const isFile = s => (s.type === 'audio' || s.type === 'video') && urls.has(s.src);
const fmtDur = d => (Number.isFinite(d) ? fmtPos(d) : '');

function songListTick() {
  for (const [stage, ids] of [['live', sel.live], ['pv', sel.pv]]) {
    const box = $(stage === 'live' ? 'plLive' : 'plPv');
    // [layer index, scene] for every layer that shows something, top layer first
    const rows = cur ? ids.map((id, i) => [i, id && findShot(id)]).filter(r => r[1]) : [];
    // rebuilt only when something shown has changed; times and highlight update every tick
    const key = rows.map(([i, sh]) => [i, sh.id, sh.name, isList(sh), sh.playlist && sh.cross, !!sh.plLoop,
      ...sh.sources.map(s => `${s.id}:${s.name}:${isFile(s) ? durOf(s) : s.page ?? ''}`)].join('|')).join('||');
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(rows.length ? buildStageList(stage, rows) : el('p', 'dim', 'ว่าง'));
    }
    if (stage !== 'live') continue;
    for (const li of box.querySelectorAll('li.file')) {
      const m = stages.live?.el.querySelector(`audio[data-sid="${li._src.id}"], video[data-sid="${li._src.id}"]`);
      const on = !!m && !m.paused && !m.ended && !m.closest('[data-out]');
      // when a file starts, scroll its row to the middle of the list
      if (on && !li.classList.contains('on')) {
        const ol = li.parentNode;
        ol.scrollTop = li.offsetTop - (ol.clientHeight - li.offsetHeight) / 2;
      }
      li.classList.toggle('on', on);
      li.lastChild.textContent = on ? `−${fmtTime(m.duration - m.currentTime)}` : fmtDur(durOf(li._src));
    }
  }
}

// one list per stage: a heading row per layer's scene, then a row per source in it
function buildStageList(stage, rows) {
  const ol = el('ol');
  for (const [i, sh] of rows) {
    const list = isList(sh);
    const songs = sh.sources.filter(s => s.type === 'audio');
    const mode = songs.length < 2 ? ''
      : !list ? 'เล่นพร้อมกัน'
        : [sh.playlist ? `cross ${sh.cross ?? 3} วิ` : 'เล่นต่อกัน', sh.plLoop && 'วน'].filter(Boolean).join(' · ');
    const head = el('li', 'head');
    head.append(el('span', 'no', i + 1), el('b', 'name', sh.name), el('span', 'dim', mode));
    ol.append(head);
    if (!sh.sources.length) ol.append(el('li', 'dim', 'ไม่มี source'));

    for (const s of sh.sources) {
      const li = el('li', isFile(s) ? 'file' : '');
      li._src = s;
      const info = isFile(s) ? fmtDur(durOf(s)) : s.type === 'pdf' ? `หน้า ${s.page ?? 1}` : '';
      li.append(el('span', 'kind', srcKind(sh, s)), el('span', 'name', s.name), el('span', 'num', info));
      if (stage === 'live' && list && s.type === 'audio' && isFile(s)) {
        const k = songs.filter(isFile).indexOf(s);
        li.classList.add('can');
        li.title = 'คลิกเพื่อข้ามไปเพลงนี้';
        li.onclick = () => stages.live?.nodes[i]?._pl?.jump(k);
      }
      ol.append(li);
    }
  }
  return ol;
}

function seekTo(t) {
  if (!tp) return;
  // stop just short of the end, or the track would count as finished at once
  t = Math.max(0, Math.min(t, tp.dur - 0.1));
  if (tp.mode === 'pv') {
    starts.set(tp.s.id, t);
    // show the frame it will start on
    const v = stages.pv.el.querySelector(`video[data-sid="${tp.s.id}"]`);
    if (v) {
      v.pause();
      v.currentTime = t;
    }
    return;
  }
  tp.m.currentTime = t;
  // a finished track starts again from the new spot
  if (tp.m.paused) tp.m.play().catch(() => {});
  // keep the projector's copy of a video in step
  const twin = stages.out?.el.querySelector(`video[data-sid="${tp.s.id}"]`);
  if (twin) {
    twin.currentTime = t;
    twin.play().catch(() => {});
  }
}

// time scale under the slider: a label every 30 s and a line every 5 s,
// widened in step for long files so labels never overlap
function renderRuler() {
  const r = $('tpRuler');
  r.replaceChildren();
  if (!tp) return;
  const w = r.clientWidth || 1;
  const major = [30, 60, 120, 300, 600, 1800, 3600].find(sec => sec / tp.dur * w >= 44) ?? 3600;
  const minor = major / 6;
  for (let k = 0; k * minor <= tp.dur; k++) {
    const big = k % 6 === 0;
    const tick = el('i', big ? 'big' : '');
    tick.style.left = pct(k * minor / tp.dur);
    r.append(tick);
    if (big) {
      const lab = el('span', '', fmtPos(k * minor));
      lab.style.left = tick.style.left;
      r.append(lab);
    }
  }
}

function renderBookmarks() {
  const list = tp?.s.bookmarks ?? [];
  $('tpMarks').replaceChildren(...list.map(b => {
    const i = el('i');
    i.style.left = pct(b.t / tp.dur);
    return i;
  }));
  $('bmList').replaceChildren(...list.map(b => bookmarkChip(tp.s, b)));
}

function bookmarkChip(s, b) {
  const c = el('span', 'bm');
  const jump = el('button', 'jump');
  jump.append(el('span', 'name', b.name), el('span', 'at', fmtPos(b.t)));
  jump.title = 'คลิก = ไปที่จุดนี้ · ดับเบิลคลิก = เปลี่ยนชื่อ';
  jump.onclick = () => seekTo(b.t);
  jump.ondblclick = () => {
    const inp = Object.assign(el('input'), { type: 'text', value: b.name });
    const commit = guard(async () => {
      b.name = inp.value.trim() || b.name;
      await save();
      renderBookmarks();
    });
    inp.onblur = commit;
    inp.onkeydown = e => {
      if (e.key === 'Enter' || e.key === 'Escape') inp.blur();
    };
    jump.replaceWith(inp);
    inp.focus();
    inp.select();
  };
  const rm = el('button', 'rm', '×');
  rm.title = 'ลบ bookmark';
  rm.onclick = guard(async () => {
    if (!await askDelete(`ลบ bookmark "${b.name}" (${fmtPos(b.t)})?`)) return;
    s.bookmarks = s.bookmarks.filter(x => x !== b);
    await save();
    renderBookmarks();
  });
  c.append(jump, rm);
  return c;
}

async function addBookmark() {
  if (!tp) return;
  const s = tp.s;
  const t = Math.round(tpPos() * 10) / 10;
  s.bookmarks ??= [];
  s.bookmarks.push({ t, name: `จุด ${s.bookmarks.length + 1}` });
  s.bookmarks.sort((a, b) => a.t - b.t);
  await save();
  renderBookmarks();
}

/* ---------- cue sheets (per-team timed cues on an audio / video shot) ---------- */

const CUE_EXAMPLE = {
  note: 'time เขียนได้เป็น "นาที:วินาที" เช่น "1:05" หรือ "1:05.5", "ชั่วโมง:นาที:วินาที" เช่น "1:02:03", หรือจำนวนวินาที เช่น 65 — นับจากต้นเพลง/วิดีโอ ชื่อทีมตั้งเองได้ เพิ่มหรือลบทีมได้',
  teams: {
    Spotlight: [
      { time: '0:00', cue: 'ดับไฟทั้งหมด' },
      { time: '0:08', cue: 'เปิด spot กลางเวที' },
      { time: '0:45', cue: 'spot ตามนักร้องไปซ้าย' },
      { time: '1:30', cue: 'ดับ spot' },
    ],
    PAR: [
      { time: '0:04', cue: 'PAR สีน้ำเงิน 30%' },
      { time: '0:32.5', cue: 'PAR สีแดง เต็ม' },
      { time: '1:15', cue: 'PAR กระพริบตามจังหวะ' },
    ],
    Follow: [
      { time: '0:10', cue: 'follow นักแสดงคนที่ 1' },
      { time: 62, cue: 'เปลี่ยนไป follow นักแสดงคนที่ 2' },
    ],
  },
};

// "1:05.5" / "1:02:03" / 65 -> seconds, or null when it is not a time
function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^\s*\d+(:\d{1,2}){0,2}(\.\d+)?\s*$/.test(v)) return null;
  return v.trim().split(':').reduce((sec, part) => sec * 60 + Number(part), 0);
}

// -> { team: [{ t, text }] } sorted by time; throws with the exact spot that is wrong
function parseCues(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON ไม่ถูกต้อง: ${e.message}`);
  }
  const teams = j?.teams;
  if (!teams || typeof teams !== 'object' || Array.isArray(teams)) throw new Error('ต้องมี "teams" ที่ข้างในเป็นรายชื่อทีม');
  const out = {};
  for (const [name, list] of Object.entries(teams)) {
    if (!Array.isArray(list)) throw new Error(`ทีม "${name}" ต้องเป็นรายการ cue ใน [ ]`);
    out[name] = list.map((c, k) => {
      const t = parseTime(c?.time);
      if (t == null) throw new Error(`ทีม "${name}" cue ที่ ${k + 1}: time "${c?.time}" ไม่ถูกต้อง`);
      if (typeof c.cue !== 'string' || !c.cue.trim()) throw new Error(`ทีม "${name}" cue ที่ ${k + 1}: ไม่มีข้อความ "cue"`);
      return { t, text: c.cue.trim() };
    }).sort((a, b) => a.t - b.t);
  }
  if (!Object.keys(out).length) throw new Error('ใน "teams" ยังไม่มีทีม');
  return out;
}

async function setCues(text) {
  const shot = editShot();
  if (!shot) return;
  shot.cues = parseCues(text);
  await save();
  renderInsp();
  toast(`ใส่ cue ให้ ${shot.name} แล้ว (${Object.keys(shot.cues).length} ทีม)`);
}

async function clearCues() {
  delete editShot().cues;
  await save();
  renderInsp();
}

function downloadCueExample() {
  const a = Object.assign(el('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(CUE_EXAMPLE, null, 2)], { type: 'application/json' })),
    download: 'cue-example.json',
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- inspector (the shot being edited) ---------- */

const editShot = () => (edit && findShot(edit.shotId)) || null;
const editSrc = () => editShot()?.sources.find(s => s.id === edit.srcId) ?? null;

function renderInsp() {
  try {
    renderInspBody();
  } finally {
    placeGizmo();
  }
}

function fillGeom(s) {
  for (const inp of document.querySelectorAll('#geom input')) {
    if (inp === document.activeElement) continue;
    inp.value = inp.dataset.k ? s[inp.dataset.k] ?? 0
      : inp.dataset.c ? s.crop[inp.dataset.c]
        : s.feather?.[inp.dataset.f] ?? 0;
  }
  // the numbers stay folded away in the panel; the row only shows where the picture is
  $('geomSum').textContent = `${s.w}×${s.h} ที่ ${s.x}, ${s.y}`;
}

// short label for a source: its type, or its place in the running order of a song list
const srcKind = (shot, s) => (isList(shot) && s.type === 'audio'
  ? `♪${shot.sources.filter(x => x.type === 'audio').indexOf(s) + 1}`
  : s.type);

// dropdown of the scene's sources: pick one to edit, reorder, or delete
function openSrcMenu() {
  const shot = editShot();
  if (!shot) return;
  const m = $('addMenu');
  const mini = (text, title, fn, off) => {
    const b = el('button', 'mini', text);
    b.title = title;
    b.disabled = !!off;
    b.onclick = guard(fn);
    return b;
  };
  const rows = shot.sources.map((s, k) => {
    const row = el('div', s.id === edit.srcId ? 'srcRow sel' : 'srcRow');
    row.append(
      menuItem(srcKind(shot, s), s.name, () => {
        edit.srcId = s.id;
        m.hidden = true;
        renderInsp();
      }),
      // top of the list is in front on screen (and first in a song list)
      mini('▲', 'เลื่อนขึ้น (มาข้างหน้า)', () => moveSource(shot, k, -1), k === 0),
      mini('▼', 'เลื่อนลง (ไปข้างหลัง)', () => moveSource(shot, k, 1), k === shot.sources.length - 1),
      mini('×', 'ลบ source', async () => {
        if (await askDelete(`ลบ source "${s.name}" ออกจาก scene นี้?`, 'ไฟล์ใน folder ไม่ถูกลบ')) await removeSource(shot, s.id);
      }),
    );
    return row;
  });
  m.replaceChildren(...(rows.length ? rows : [el('p', 'dim', 'ยังไม่มี source — กด "+ เพิ่ม"')]));
  placeMenu($('srcBtn').getBoundingClientRect(), 'src');
}

function renderInspBody() {
  const shot = editShot();
  $('inspEmpty').hidden = !!shot;
  $('inspBody').hidden = !shot;
  if (!shot) return;

  if (document.activeElement !== $('shotName')) $('shotName').value = shot.name;
  if (document.activeElement !== $('shotAbbr')) $('shotAbbr').value = shot.abbr ?? '';
  $('shotAbbr').placeholder = abbr(shot.name);
  if (!shot.sources.some(s => s.id === edit.srcId)) edit.srcId = shot.sources[0]?.id ?? null;

  const songs = shot.sources.filter(s => s.type === 'audio');
  $('plGrp').hidden = songs.length < 2;
  $('plOn').checked = !!shot.playlist;
  $('plCross').disabled = !shot.playlist;
  $('plLoop').checked = !!shot.plLoop;
  if (document.activeElement !== $('plCross')) $('plCross').value = shot.cross ?? 3;

  // the Sources button shows the selected source; the full list opens from it
  const k = shot.sources.findIndex(x => x.id === edit.srcId);
  const picked = shot.sources[k];
  $('srcBtn').replaceChildren(
    ...(picked ? [el('span', 'kind', srcKind(shot, picked)), el('span', 'name', picked.name)] : [el('span', 'name dim', 'ยังไม่มี')]),
    el('span', 'more', shot.sources.length > 1 ? `${k + 1}/${shot.sources.length} ▾` : '▾'),
  );
  // reordering or deleting from the open list keeps it open
  if (!$('addMenu').hidden && $('addMenu').dataset.kind === 'src') openSrcMenu();

  // cue sheets run on a file's clock, so only shots with an audio / video file take one
  $('splitBtn').hidden = shot.sources.filter(s => VISUAL.includes(s.type)).length < 2;
  $('cueGrp').hidden = !shot.sources.some(s => s.type === 'audio' || s.type === 'video');
  const teams = Object.entries(shot.cues ?? {});
  $('cueBtn').textContent = `${teams.length ? `Cue: ${teams.map(([n, l]) => `${n} ${l.length}`).join(' · ')}` : 'Cue ทีม'} ▾`;

  const s = editSrc();
  const vis = !!s && VISUAL.includes(s.type);
  // the row is always there, so picking a source never changes the bar's height
  $('srcSet').classList.toggle('none', !s);
  $('geomBtn').hidden = !vis;
  if (!vis) {
    $('geomPanel').hidden = true;
    $('geomSum').textContent = '';
  }
  const loopable = !!s && (s.type === 'video' || (s.type === 'audio' && !isList(shot)));
  $('loopLbl').hidden = !loopable;
  $('loopOn').checked = !!s?.loop;
  $('noGeom').hidden = !s || vis || loopable;
  $('srcName').disabled = !s;
  if (document.activeElement !== $('srcName')) $('srcName').value = s?.name ?? '';
  $('pdfNav').hidden = s?.type !== 'pdf';
  if (s?.type === 'pdf') {
    if (document.activeElement !== $('pdfPage')) $('pdfPage').value = s.page ?? 1;
    $('pdfCount').textContent = '/ …';
    pdfDoc(s.src).then(d => {
      if (editSrc() !== s) return;
      $('pdfCount').textContent = `/ ${d.numPages}`;
      $('pdfPage').max = d.numPages;
    }, () => { $('pdfCount').textContent = '/ ?'; });
  }
  if (!vis) return;
  fillGeom(s);
  $('repickBtn').hidden = s.type !== 'screen';
}

/* ---------- move / resize on the preview ---------- */

const MIN_SIZE = 16;
const giz = el('div');
giz.id = 'gizmo';
giz.hidden = true;
for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
  const i = el('i');
  i.dataset.h = h;
  giz.append(i);
}

// frame the selected source, when its shot is the one showing in preview
function placeGizmo() {
  const s = editSrc();
  const on = !!s && VISUAL.includes(s.type) && sel.pv.includes(edit.shotId);
  giz.hidden = !on;
  if (!on) return;
  if (giz.parentNode !== $('pvStage')) $('pvStage').append(giz);
  const { width: W, height: H } = cur.data.canvas;
  Object.assign(giz.style, { left: pct(s.x / W), top: pct(s.y / H), width: pct(s.w / W), height: pct(s.h / H) });
}

// how: 'move', or the edges being dragged ('n', 'se', ...)
function startDrag(e, s, how) {
  e.preventDefault();
  // screen pixels -> canvas pixels
  const k = cur.data.canvas.width / $('pvStage').getBoundingClientRect().width;
  const o = { x: s.x, y: s.y, w: s.w, h: s.h };

  const move = ev => {
    const dx = Math.round((ev.clientX - e.clientX) * k);
    const dy = Math.round((ev.clientY - e.clientY) * k);
    if (how === 'move') {
      s.x = o.x + dx;
      s.y = o.y + dy;
    } else {
      if (how.includes('e')) s.w = Math.max(MIN_SIZE, o.w + dx);
      if (how.includes('s')) s.h = Math.max(MIN_SIZE, o.h + dy);
      // dragging the left / top edge keeps the opposite edge where it is
      if (how.includes('w')) {
        s.w = Math.max(MIN_SIZE, o.w - dx);
        s.x = o.x + o.w - s.w;
      }
      if (how.includes('n')) {
        s.h = Math.max(MIN_SIZE, o.h - dy);
        s.y = o.y + o.h - s.h;
      }
    }
    regeom(s);
    fillGeom(s);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    saveSoon();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

function onStagePointerDown(e) {
  const shot = editShot();
  if (e.button || !shot || e.target.closest('.tag')) return;

  const h = e.target.closest('#gizmo i');
  if (h) return startDrag(e, editSrc(), h.dataset.h);

  // topmost source of the edited shot under the pointer, even if another layer covers it
  const box = document.elementsFromPoint(e.clientX, e.clientY)
    .map(x => x.closest('#pvStage .src'))
    .find(b => b && shot.sources.some(s => s.id === b.dataset.src));
  if (!box) return;
  const s = shot.sources.find(x => x.id === box.dataset.src);
  if (edit.srcId !== s.id) {
    edit.srcId = s.id;
    renderInsp();
  }
  startDrag(e, s, 'move');
}

// everything showing this shot is rebuilt, then the change is saved
async function shotChanged(shot) {
  rerender(sh => sh.id === shot.id);
  gcStreams();
  await save();
  renderLayers();
  renderInsp();
}

async function addSource(shot, def) {
  if (def.src) await loadUrl(def.src);
  const s = newSource(cur.data.canvas, def);
  // pictures go on top, in front; sounds go last, so a playlist grows in play order
  if (VISUAL.includes(s.type)) shot.sources.unshift(s);
  else shot.sources.push(s);
  edit.srcId = s.id;
  await shotChanged(shot);
}

async function moveSource(shot, k, d) {
  const [s] = shot.sources.splice(k, 1);
  shot.sources.splice(k + d, 0, s);
  await shotChanged(shot);
}

async function removeSource(shot, id) {
  shot.sources = shot.sources.filter(s => s.id !== id);
  await shotChanged(shot);
}

const OPPOSITE = { l: 'r', r: 'l', t: 'b', b: 't' };

function onGeomInput(inp) {
  const s = editSrc();
  const v = Number(inp.value);
  if (!s || inp.value === '' || !Number.isFinite(v)) return;
  if (inp.dataset.k) {
    const k = inp.dataset.k;
    if (k === 'radius') {
      if (v > 0) s.radius = v;
      else delete s.radius;
    } else {
      s[k] = k === 'w' || k === 'h' ? Math.max(1, v) : v;
    }
  } else if (inp.dataset.f) {
    // the two fades of one axis may meet in the middle, but not cross
    const e = inp.dataset.f;
    s.feather ??= { l: 0, t: 0, r: 0, b: 0 };
    s.feather[e] = Math.max(0, Math.min(v, 100 - s.feather[OPPOSITE[e]]));
  } else {
    // opposite edges may not crop away the whole picture
    const c = inp.dataset.c;
    s.crop[c] = Math.max(0, Math.min(v, 99 - s.crop[OPPOSITE[c]]));
  }
  regeom(s);
  saveSoon();
}

function fitSource() {
  const s = editSrc();
  if (!s) return;
  Object.assign(s, { x: 0, y: 0, w: cur.data.canvas.width, h: cur.data.canvas.height, crop: { l: 0, t: 0, r: 0, b: 0 } });
  delete s.feather;
  delete s.diag;
  delete s.radius;
  regeom(s);
  saveSoon();
  renderInsp();
}

// crop (in %) that makes a source fill a box of the given aspect ratio, cut evenly from both sides
function fillCrop(s, boxAspect) {
  const { width: W, height: H } = cur.data.canvas;
  const m = stages.pv.el.querySelector(`[data-src="${s.id}"] .view > *`);
  const iw = m && (m.naturalWidth || m.videoWidth);
  // until the picture has loaded, assume it has the shape of the canvas
  const a = iw ? iw / (m.naturalHeight || m.videoHeight) : W / H;
  const cut = v => Math.round((1 - v) / 2 * 1000) / 10;
  return a > boxAspect
    ? { l: cut(boxAspect / a), r: cut(boxAspect / a), t: 0, b: 0 }
    : { l: 0, r: 0, t: cut(a / boxAspect), b: cut(a / boxAspect) };
}

// how wide the blend between the two pictures is, as a share of the screen
const BLEND = 0.3;

// Lay out the scene's first two pictures as one blended split. The front one (a)
// takes the left / top side and fades into the other across the middle.
//   'lr' | 'tb'  each picture gets its half plus half the blend, cropped to fill it
//   'd1' | 'd2'  both stay full-screen; a is cut along a diagonal ("/" or "\")
async function splitBlend(mode) {
  const shot = editShot();
  const [a, b] = shot.sources.filter(s => VISUAL.includes(s.type));
  if (!b) return;
  const { width: W, height: H } = cur.data.canvas;
  for (const s of [a, b]) {
    Object.assign(s, { x: 0, y: 0, w: W, h: H, crop: { l: 0, t: 0, r: 0, b: 0 } });
    delete s.feather;
    delete s.diag;
  }
  // share of a's own box that lies in the overlap, i.e. how far its fade must reach
  const reach = Math.round(BLEND / (0.5 + BLEND / 2) * 1000) / 10;
  if (mode === 'lr') {
    const w = Math.round(W * (0.5 + BLEND / 2));
    Object.assign(a, { w, crop: fillCrop(a, w / H) });
    Object.assign(b, { x: W - w, w, crop: fillCrop(b, w / H) });
    a.feather = { l: 0, t: 0, r: reach, b: 0 };
  } else if (mode === 'tb') {
    const h = Math.round(H * (0.5 + BLEND / 2));
    Object.assign(a, { h, crop: fillCrop(a, W / h) });
    Object.assign(b, { y: H - h, h, crop: fillCrop(b, W / h) });
    a.feather = { l: 0, t: 0, r: 0, b: reach };
  } else {
    // "/" keeps a's top-left corner, "\" keeps its bottom-left corner
    a.diag = { to: mode === 'd1' ? 'bottom right' : 'top right', soft: BLEND * 100 };
  }
  regeom(a);
  regeom(b);
  await save();
  renderInsp();
}

function openSplitMenu() {
  const m = $('addMenu');
  const pick = mode => async () => {
    m.hidden = true;
    await splitBlend(mode);
  };
  m.replaceChildren(
    menuItem('◧', 'ซ้าย | ขวา', pick('lr')),
    menuItem('⬒', 'บน / ล่าง', pick('tb')),
    menuItem('◩', 'เฉียง ⟋ (หน้าอยู่มุมซ้ายบน)', pick('d1')),
    menuItem('◣', 'เฉียง ⟍ (หน้าอยู่มุมซ้ายล่าง)', pick('d2')),
  );
  placeMenu($('splitBtn').getBoundingClientRect());
}

/* ---------- add menu (pick a source) ---------- */

function menuItem(kind, name, fn) {
  const b = el('button');
  b.append(el('span', 'kind', kind), el('span', 'name', name));
  b.onclick = guard(fn);
  return b;
}

// onPick(def) receives the chosen source definition (null = empty shot)
// sections of the add menu the user has folded shut; everything starts open
const MENU_CLOSED_KEY = 'sgtobs-menu-closed';
const menuClosed = new Set(JSON.parse(localStorage.getItem(MENU_CLOSED_KEY) ?? '[]'));

// one foldable group of the add menu: a header that opens / closes the rows under it
function menuSection(key, title, rows) {
  const sec = el('section', menuClosed.has(key) ? 'sec closed' : 'sec');
  const head = el('button', 'secHead');
  head.append(el('span', 'arrow', '▾'), el('span', 'name', title), el('span', 'n', rows.filter(r => r.tagName === 'BUTTON').length || ''));
  head.onclick = () => {
    if (!sec.classList.toggle('closed')) menuClosed.delete(key);
    else menuClosed.add(key);
    localStorage.setItem(MENU_CLOSED_KEY, JSON.stringify([...menuClosed]));
    // the menu changed height: keep it sitting against its button
    placeMenu($('addMenu')._anchor, $('addMenu').dataset.kind);
  };
  const body = el('div', 'secBody');
  body.append(...rows);
  sec.append(head, body);
  return sec;
}

const FILE_GROUPS = [['image', 'ภาพ'], ['video', 'วิดีโอ'], ['audio', 'เพลง / เสียง'], ['pdf', 'สไลด์ PDF']];

async function openAddMenu(btn, onPick, withEmpty) {
  const m = $('addMenu');
  const items = [];
  const pick = def => async () => {
    m.hidden = true;
    await onPick(def);
  };

  if (withEmpty) items.push(menuItem('+', 'Scene เปล่า', pick(null)));

  items.push(menuSection('screen', 'โปรแกรมอื่น', [
    menuItem('screen', 'หน้าต่าง / แท็บ browser / ทั้งจอ…', async () => {
      m.hidden = true;
      let stream;
      try {
        stream = await askScreen();
      } catch (e) {
        if (e.name === 'NotAllowedError') return;
        throw e;
      }
      await onPick({ type: 'screen', name: 'จับหน้าจอ', stream });
    }),
  ]));

  for (const [type, head, ask] of [['camera', 'กล้อง', 'video'], ['mic', 'เสียงเข้า (ไมค์)', 'audio']]) {
    const devs = await listDevices(type);
    let rows;
    if (!devs.length) {
      rows = [el('p', 'dim', 'ไม่พบอุปกรณ์')];
    } else if (!devs[0].label) {
      // labels stay blank until the user grants access once
      rows = [menuItem('+', 'อนุญาตเพื่อแสดงรายการ…', async () => {
        const st = await navigator.mediaDevices.getUserMedia({ [ask]: true });
        st.getTracks().forEach(t => t.stop());
        await openAddMenu(btn, onPick, withEmpty);
      })];
    } else {
      rows = devs.map(d => menuItem(type === 'camera' ? 'cam' : 'mic', d.label,
        pick({ type, name: d.label, deviceId: d.deviceId, label: d.label })));
    }
    items.push(menuSection(type, head, rows));
  }

  // files from media/, one section per kind; kinds with no files are left out
  const media = await listMedia(cur.dir);
  for (const [kind, title] of FILE_GROUPS) {
    const files = media.filter(f => f.kind === kind);
    if (!files.length) continue;
    items.push(menuSection(kind, title, files.map(f => menuItem(kind, f.name,
      pick({ type: kind, name: f.name, src: `${MEDIA_DIR}/${f.name}` })))));
  }
  if (!media.length) items.push(el('p', 'dim', `ยังไม่มีไฟล์ใน ${MEDIA_DIR}/`));

  m.replaceChildren(...items);
  placeMenu(btn.getBoundingClientRect());
}

// show the menu above the anchor rect, or below it when there is no room above;
// kind names what the menu is showing, for code that needs to refresh it in place
function placeMenu(r, kind = '') {
  const m = $('addMenu');
  m._anchor = r;
  m.dataset.kind = kind;
  m.hidden = false;
  const h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(r.bottom + 6, innerHeight - h - 8))}px`;
}

/* ---------- init ---------- */

// wrap handlers so failures surface in the UI instead of the console only
function guard(fn) {
  return async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      console.error(e);
      toast(e.name === 'NotFoundError' ? 'ไม่พบ folder นี้แล้ว (อาจถูกย้ายหรือลบ)' : e.message, true);
    }
  };
}

$('pickBtn').onclick = guard(pickFolder);
$('menuBtn').onclick = () => {
  const m = $('addMenu');
  const close = fn => async () => {
    m.hidden = true;
    await fn();
  };
  m.replaceChildren(
    menuItem('▤', 'เปลี่ยน Folder…', close(pickFolder)),
    menuItem('⌂', 'หน้าแรก', close(goHome)),
  );
  placeMenu($('menuBtn').getBoundingClientRect());
};

$('plOn').onchange = guard(async () => {
  const shot = editShot();
  if ($('plOn').checked) {
    shot.playlist = true;
    shot.cross ??= 3;
  } else {
    delete shot.playlist;
  }
  await shotChanged(shot);
});
$('plCross').onchange = guard(async () => {
  const shot = editShot();
  const v = Number($('plCross').value);
  shot.cross = Number.isFinite(v) ? Math.max(0, Math.min(30, v)) : 3;
  await shotChanged(shot);
});
$('goBtn').onclick = guard(go);
$('outBtn').onclick = guard(openOutput);
$('cdBtn').onclick = guard(toggleCdPanel);
$('roomBtn').onclick = guard(toggleCdPanel);
showRoom();
$('cdCopy').onclick = guard(copyCdUrl);
$('cdUrl').onfocus = () => $('cdUrl').select();
$('cdTeam').onchange = renderCdPanel;

$('tpSeek').onpointerdown = () => { tpDrag = true; };
$('tpSeek').oninput = () => seekTo(Number($('tpSeek').value));
$('tpSeek').onchange = () => {
  tpDrag = false;
  // a focused slider would swallow Space / Enter meant for Go
  $('tpSeek').blur();
};
$('bmAdd').onclick = guard(addBookmark);
// the bar starts closed, to leave the stages as much room as possible
$('tpToggle').onclick = () => {
  const open = $('transport').hidden;
  $('transport').hidden = !open;
  $('tpToggle').classList.toggle('on', open);
  $('tpToggle').textContent = `แถบเวลา ${open ? '▴' : '▾'}`;
  $('tpToggle').blur();
};
new ResizeObserver(renderRuler).observe($('tpRuler'));
// lets the GO column match the screens' height (see #takeCol in style.css)
new ResizeObserver(() => $('stages').style.setProperty('--stageH', `${$('pvStage').offsetHeight}px`)).observe($('pvStage'));

$('cueBtn').onclick = () => {
  const m = $('addMenu');
  const close = fn => async () => {
    m.hidden = true;
    await fn();
  };
  const items = [
    menuItem('↑', 'อัปโหลด JSON…', close(() => $('cueFile').click())),
    menuItem('⎘', 'วาง JSON…', close(openCuePaste)),
  ];
  if (editShot()?.cues) items.push(menuItem('×', 'ลบ cue ของ scene นี้', close(async () => {
    if (await askDelete(`ลบ cue ทั้งหมดของ scene "${editShot().name}"?`)) await clearCues();
  })));
  items.push(menuItem('↓', 'ดาวน์โหลดตัวอย่าง JSON', close(downloadCueExample)));
  m.replaceChildren(...items);
  placeMenu($('cueBtn').getBoundingClientRect());
};

$('loopOn').onchange = guard(async () => {
  const src = editSrc();
  if ($('loopOn').checked) src.loop = true;
  else delete src.loop;
  // switch it on whatever is already playing, without restarting it
  for (const st of Object.values(stages)) {
    for (const m of st.el.querySelectorAll(`[data-sid="${src.id}"]`)) m.loop = !!src.loop;
  }
  await save();
});
$('plLoop').onchange = guard(async () => {
  const shot = editShot();
  const was = isList(shot);
  if ($('plLoop').checked) shot.plLoop = true;
  else delete shot.plLoop;
  // without Playlist ticked, Loop is what switches the songs between "in turn" and "all at once"
  if (was !== isList(shot)) await shotChanged(shot);
  else await save();
});
$('cueFile').onchange = guard(async () => {
  const f = $('cueFile').files[0];
  // let the same file be picked again after it has been fixed
  $('cueFile').value = '';
  if (f) await setCues(await f.text());
});
function openCuePaste() {
  $('cueText').value = '';
  $('cueErr').textContent = '';
  $('cueDlg').showModal();
}
$('cueOk').onclick = async () => {
  // a toast would sit behind the dialog, so report bad JSON inside it
  try {
    await setCues($('cueText').value);
    $('cueDlg').close();
  } catch (e) {
    $('cueErr').textContent = e.message;
  }
};
$('cueCancel').onclick = () => $('cueDlg').close();

$('askYes').onclick = () => askDone?.(true);
$('askNo').onclick = () => askDone?.(false);
// a click on the dimmed area around the box
$('askDlg').onclick = e => { if (e.target === $('askDlg')) askDone?.(false); };
// closed some other way (Esc)
$('askDlg').addEventListener('close', () => askDone?.(false));

setInterval(countdownTick, 200);

// neither library is needed to run a show, so load them without holding up the page
loadScript(PEERJS_URL).then(startPeer, () => setPeerState('nolib'));
loadScript(QR_URL).then(() => { if (!$('cdPanel').hidden) renderCdPanel(); }, e => console.error(e));

$('srcBtn').onclick = () => {
  if (!$('addMenu').hidden && $('addMenu').dataset.kind === 'src') $('addMenu').hidden = true;
  else openSrcMenu();
};
$('addSrcBtn').onclick = guard(() => openAddMenu($('addSrcBtn'), def => addSource(editShot(), def), false));
$('fitBtn').onclick = guard(fitSource);
// the picture settings open from a button, like the Sources list, and stay open while editing
$('geomBtn').onclick = () => {
  const p = $('geomPanel');
  p.hidden = !p.hidden;
  $('geomBtn').classList.toggle('on', !p.hidden);
  if (p.hidden) return;
  const r = $('geomBtn').getBoundingClientRect();
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8))}px`;
  p.style.top = `${Math.max(8, r.top - p.offsetHeight - 6)}px`;
};
$('pdfPrev').onclick = guard(() => setPage(editSrc(), (editSrc().page ?? 1) - 1));
$('pdfNext').onclick = guard(() => setPage(editSrc(), (editSrc().page ?? 1) + 1));
$('pdfPage').onchange = guard(() => setPage(editSrc(), Number($('pdfPage').value)));
$('pdfPage').onkeydown = e => { if (e.key === 'Enter') $('pdfPage').blur(); };
$('splitBtn').onclick = openSplitMenu;
$('repickBtn').onclick = guard(() => pickScreen(editSrc()));
$('pvStage').addEventListener('pointerdown', onStagePointerDown);

$('shotName').oninput = () => {
  const shot = editShot();
  if (!shot) return;
  shot.name = $('shotName').value;
  const t = document.querySelector(`#layers .shot[data-id="${shot.id}"]`);
  if (t) {
    t.title = shot.name;
    t.querySelector('.name').textContent = shot.name;
    t.querySelector('.abbr').textContent = tileLabel(shot);
  }
  $('shotAbbr').placeholder = abbr(shot.name);
  saveSoon();
};
$('srcName').oninput = () => {
  const s = editSrc();
  const v = $('srcName').value.trim();
  // an empty box keeps the old name rather than leaving a nameless source
  if (!s || !v) return;
  s.name = v;
  // the countdown and seek bar read the name off the media that is already playing
  for (const st of Object.values(stages)) {
    for (const m of st.el.querySelectorAll(`[data-sid="${s.id}"]`)) m.dataset.name = v;
  }
  $('srcBtn').querySelector('.name').textContent = v;
  saveSoon();
};
$('srcName').onchange = renderInsp;
$('srcName').onkeydown = e => {
  if (e.key === 'Enter' || e.key === 'Escape') $('srcName').blur();
};
$('shotAbbr').oninput = () => {
  const shot = editShot();
  if (!shot) return;
  const v = $('shotAbbr').value.trim();
  // empty = go back to the label made from the name
  if (v) shot.abbr = v;
  else delete shot.abbr;
  const t = document.querySelector(`#layers .shot[data-id="${shot.id}"] .abbr`);
  if (t) t.textContent = tileLabel(shot);
  saveSoon();
};
$('shotAbbr').onkeydown = e => {
  if (e.key === 'Enter' || e.key === 'Escape') $('shotAbbr').blur();
};
$('shotName').onkeydown = e => {
  if (e.key === 'Enter' || e.key === 'Escape') $('shotName').blur();
};

for (const inp of document.querySelectorAll('#geom input')) {
  inp.oninput = () => onGeomInput(inp);
  // show the clamped value once editing ends
  inp.onchange = renderInsp;
}

for (const b of document.querySelectorAll('.trans')) b.onclick = () => setTrans(b.dataset.t);

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#cdPanel, #cdBtn, #roomBtn')) $('cdPanel').hidden = true;
  // dragging on Preview is part of editing the picture, so it leaves the panel open
  if (!e.target.closest('#geomPanel, #geomBtn, #pvStage')) {
    $('geomPanel').hidden = true;
    $('geomBtn').classList.remove('on');
  }
  if (e.target.closest('#addMenu, .addShot, #addSrcBtn, #srcBtn, #splitBtn, #menuBtn, #cueBtn')) return;
  $('addMenu').hidden = true;
  capture = null;
});

// Ctrl+key = shot shortcut, Space / Enter = Go
document.addEventListener('keydown', e => {
  if (!cur || e.repeat) return;
  // while a dialog is up, keys belong to it (Enter must not fire GO behind it)
  if (document.querySelector('dialog[open]')) return;
  if (capture) return guard(onCaptureKey)(e);
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (runHotkey(e.code)) e.preventDefault();
    return;
  }
  // arrows, and the PageUp / PageDown that presentation clickers send, turn the PDF
  const turn = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.code];
  if (turn && !e.metaKey && !e.altKey) {
    if (pdfKey(turn)) e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
  e.preventDefault();
  // otherwise the key would also re-click whichever button has focus
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  go();
});

addEventListener('pagehide', () => outWin?.close());

if (!('showDirectoryPicker' in window)) {
  $('pickBtn').disabled = true;
  $('unsupported').hidden = false;
}

for (const db of [0, -6, -12, -24, -36, -48]) {
  const t = el('span', '', db);
  t.style.bottom = pct(1 - db / DB_FLOOR);
  $('meterScale').append(t);
}
meterTick();

guard(renderRecent)();
