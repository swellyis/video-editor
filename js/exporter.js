// Export: fast path = WebCodecs (via vendored Mediabunny) frame-accurate render, faster than real time.
// Fallback = real-time canvas + MediaRecorder (MP4 when the browser supports it, else WebM).
import { layout, activeAt, sourceTime, outputDims, overlaysAt, overlaySourceTime } from './model.js';
import { Compositor, ensureFonts } from './render.js';
import { Player } from './player.js';
import { mixChunks, hasAudio } from './audio.js';
import { loadMediabunny, seekVideo, gifFrameAt } from './media.js';

export class ExportCancelled extends Error { constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; } }

const BPP = { low: 0.055, medium: 0.085, high: 0.12, max: 0.18 };
export function bitrateFor(w, h, fps, quality) {
  const b = w * h * Math.min(fps, 60) * (BPP[quality] || BPP.high);
  return Math.round(Math.min(60e6, Math.max(1.5e6, b)));
}

export function recorderMimeTypes() {
  if (!window.MediaRecorder) return [];
  const list = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return list.filter(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
}
export const extFor = (mime) => (/mp4/i.test(mime) ? 'mp4' : /quicktime/.test(mime) ? 'mov' : 'webm');

/** Describe what this browser can do (for the UI). */
export async function capabilities(project) {
  const caps = { webcodecs: typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined', fastMp4: false, fastWebm: false, audioCodec: null, recorder: recorderMimeTypes() };
  if (caps.webcodecs) {
    try {
      const mb = await loadMediabunny();
      const { width, height } = outputDims(project);
      const br = bitrateFor(width, height, project.settings.fps, project.settings.quality);
      caps.fastMp4 = await mb.canEncodeVideo('avc', { width, height, bitrate: br });
      caps.fastWebm = (await mb.canEncodeVideo('vp9', { width, height, bitrate: br })) || (await mb.canEncodeVideo('vp8', { width, height, bitrate: br }));
      caps.aac = await mb.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 });
      caps.opus = await mb.canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 });
    } catch (e) { console.warn('Capability probe failed', e); }
  }
  return caps;
}

/**
 * Which container/engine an export with this format setting will most likely produce, from capabilities():
 * 'auto' = MP4 when this browser can make it quickly, otherwise fast WebM, otherwise whatever MediaRecorder offers.
 * Returns { ext: 'mp4'|'webm', engine: 'fast'|'realtime'|null, reason? } (engine null = cannot export that format).
 */
export function planFormat(caps, format = 'auto') {
  const fastAudio = (c) => (c === 'mp4' ? caps.aac || caps.opus : caps.opus) !== false;
  if (caps && caps.webcodecs) {
    if (format !== 'webm' && caps.fastMp4 && fastAudio('mp4')) return { ext: 'mp4', engine: 'fast' };
    if (format !== 'mp4' && caps.fastWebm && fastAudio('webm')) return { ext: 'webm', engine: 'fast' };
  }
  const rec = (caps && caps.recorder) || [];
  const mp4 = rec.some(t => t.includes('mp4')), webm = rec.some(t => t.includes('webm'));
  if (format === 'mp4') return mp4 ? { ext: 'mp4', engine: 'realtime' } : { ext: 'mp4', engine: null, reason: 'This browser can’t make MP4 files. Choose Auto or WebM.' };
  if (format === 'webm') return webm ? { ext: 'webm', engine: 'realtime' } : mp4 ? { ext: 'mp4', engine: 'realtime' } : { ext: 'webm', engine: null };
  return mp4 ? { ext: 'mp4', engine: 'realtime' } : webm ? { ext: 'webm', engine: 'realtime' } : { ext: 'mp4', engine: null };
}

// ---------- output sinks: stream the encoded file to disk instead of assembling it in memory ----------
const OPFS_PREFIX = 'export-';
export const canStreamToOPFS = () => !!(navigator.storage && navigator.storage.getDirectory && window.FileSystemFileHandle && 'createWritable' in FileSystemFileHandle.prototype);
/** Remove leftover export files from the origin-private file system. */
export async function cleanupExports(keep) {
  if (!canStreamToOPFS()) return;
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const [name] of dir.entries()) if (name.startsWith(OPFS_PREFIX) && name !== keep) await dir.removeEntry(name).catch(() => { });
  } catch { }
}
/**
 * Create where the export is written. kinds:
 *  - 'file':   a FileSystemFileHandle the user picked (showSaveFilePicker) — written directly to their disk
 *  - 'opfs':   a temporary file in the origin-private file system (disk-backed, then downloaded from there)
 *  - 'memory': in-memory buffer (fallback)
 * Returns { kind, writable?, finish(): Promise<Blob|File>, abort() }.
 */
export async function createSink({ handle, ext = 'mp4', allowOPFS = true } = {}) {
  let fh = handle, kind = handle ? 'file' : 'memory', name = null;
  if (!fh && allowOPFS && canStreamToOPFS()) {
    try {
      const dir = await navigator.storage.getDirectory();
      name = OPFS_PREFIX + Date.now() + '.' + ext;
      await cleanupExports(); // only one export kept at a time
      fh = await dir.getFileHandle(name, { create: true });
      kind = 'opfs';
    } catch (e) { console.info('OPFS unavailable, exporting in memory:', e.message); fh = null; kind = 'memory'; }
  }
  if (!fh) return { kind: 'memory', finish: async (blob) => blob, abort: async () => { } };
  let writable;
  try { writable = await fh.createWritable(); }
  catch (e) { if (kind === 'file') throw e; return { kind: 'memory', finish: async (blob) => blob, abort: async () => { } }; }
  return {
    kind, handle: fh, name, writable,
    finish: async () => { try { await writable.close(); } catch { /* already closed by the muxer */ } return fh.getFile(); },
    abort: async () => {
      try { await writable.abort(); } catch { }
      if (kind === 'opfs') try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry(name); } catch { }
    },
  };
}

function makeProgress(onProgress) {
  const t0 = performance.now(); let lastEta = null;
  return (frac, stage, extra = {}) => {
    const el = (performance.now() - t0) / 1000;
    let eta = null;
    if (frac > 0.03 && el > 1) {
      const raw = el / frac - el;
      eta = lastEta == null ? raw : lastEta * 0.8 + raw * 0.2;
      lastEta = eta;
    }
    onProgress && onProgress({ frac: Math.min(1, frac), stage, eta, elapsed: el, ...extra });
  };
}

class ElementReader {
  constructor(url) { this.v = document.createElement('video'); this.v.muted = true; this.v.playsInline = true; this.v.preload = 'auto'; this.v.src = url; }
  async open() { if (this.v.readyState < 1) await new Promise((r, j) => { this.v.onloadedmetadata = r; this.v.onerror = () => j(new Error('Video failed to load')); }); }
  async at(t) { await seekVideo(this.v, t); if (this.v.readyState < 2) await new Promise(r => setTimeout(r, 30)); return { img: this.v, w: this.v.videoWidth, h: this.v.videoHeight }; }
  close() { this.v.removeAttribute('src'); this.v.load(); }
}

/** Fast frame-accurate export. Throws on unsupported configurations so the caller can fall back. */
async function exportFast(project, media, { onProgress, signal, format, openSink, onWarn }) {
  const mb = await loadMediabunny();
  const lay = layout(project);
  const { width: W, height: H } = outputDims(project);
  const fps = project.settings.fps || 30;
  const total = lay.total;
  const N = Math.max(1, Math.round(total * fps));
  const bitrate = bitrateFor(W, H, fps, project.settings.quality);
  const progress = makeProgress(onProgress);
  const check = () => { if (signal && signal.aborted) throw new ExportCancelled(); };

  // format: 'mp4' (only MP4), 'webm' (only WebM) or 'auto' (MP4 if this browser can encode H.264, else VP9/VP8 WebM)
  const withAudio = hasAudio(project, lay);
  const pickAudio = async (container) => {
    if (!withAudio) return '';
    for (const c of container === 'mp4' ? ['aac', 'opus'] : ['opus', 'vorbis']) if (await mb.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })) return c;
    return null;
  };
  let container = null, vcodec = null, acodec = null;
  if (format !== 'webm' && await mb.canEncodeVideo('avc', { width: W, height: H, bitrate })) {
    const a = await pickAudio('mp4'); if (a !== null) { container = 'mp4'; vcodec = 'avc'; acodec = a; }
  }
  if (!container && format === 'mp4') throw new Error('This browser cannot encode MP4 (H.264) with WebCodecs');
  if (!container) {
    for (const c of ['vp9', 'vp8']) if (await mb.canEncodeVideo(c, { width: W, height: H, bitrate })) { vcodec = c; break; }
    if (!vcodec) throw new Error('No WebCodecs video encoder available');
    acodec = await pickAudio('webm');
    if (acodec === null) throw new Error('No WebCodecs audio encoder available');
    container = 'webm';
  }
  acodec = acodec || null;
  progress(0, 'Preparing…');
  // open the output only now that the container is known (a picked file gets the right extension)
  const sink = openSink ? await openSink(container) : null;

  await ensureFonts();
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const comp = new Compositor();
  // Streamed sinks write straight to disk (MP4 index at the end, no seeking back through a giant buffer).
  const streamed = !!(sink && sink.writable);
  const output = new mb.Output({
    format: container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: streamed ? false : 'in-memory' }) : new mb.WebMOutputFormat(),
    target: streamed ? new mb.StreamTarget(sink.writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) : new mb.BufferTarget(),
  });
  const vsrc = new mb.CanvasSource(canvas, { codec: vcodec, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null;
  if (withAudio) { asrc = new mb.AudioBufferSource({ codec: acodec, bitrate: 192000 }); output.addAudioTrack(asrc); }
  output.setMetadataTags && output.setMetadataTags({ title: project.name });
  await output.start();

  // --- frame plan: which clips are visible on each frame and at which source time
  const plan = new Array(N), planO = new Array(N);
  const images = new Map();
  const tsLists = new Map(), lastFrame = new Map();
  for (let k = 0; k < N; k++) {
    const t = (k + 0.001) / fps;
    const act = activeAt(lay, t);
    plan[k] = act;
    for (const a of act) {
      const c = a.it.clip;
      if (c.kind !== 'video') continue;
      if (!tsLists.has(c.id)) tsLists.set(c.id, []);
      tsLists.get(c.id).push(sourceTime(a.it, t));
      lastFrame.set(c.id, k);
    }
    const ao = overlaysAt(project, t);
    planO[k] = ao;
    for (const o of ao) {
      if (o.kind !== 'video') continue;
      if (!tsLists.has(o.id)) tsLists.set(o.id, []);
      tsLists.get(o.id).push(overlaySourceTime(o, t));
      lastFrame.set(o.id, k);
    }
  }
  const gifs = new Map();
  const loadImg = async (id) => {
    if (images.has(id)) return;
    const im = await media.image(id).catch(() => null); if (im) images.set(id, im);
    if (media.isAnimated && media.isAnimated(id)) { const g = await media.gif(id); if (g && g.frames.length) gifs.set(id, g); }
  };
  for (const o of project.overlays || []) if (o.kind === 'image') await loadImg(o.mediaId);
  // images & logo
  for (const it of lay.items) if (it.clip.kind === 'image') await loadImg(it.clip.mediaId);
  const imageSrc = (id, at) => {
    const g = gifs.get(id);
    if (g) { const f = gifFrameAt(g, at); return { img: f.img, w: f.img.width, h: f.img.height }; }
    const im = images.get(id); return im ? { img: im.img, w: im.w, h: im.h } : null;
  };
  const logo = project.logo ? await media.image(project.logo.mediaId).catch(() => null) : null;

  const readers = new Map();
  const openReader = async (c) => {
    const rec = await media.get(c.mediaId);
    if (!rec) return { next: async () => null, close() { } };
    const list = tsLists.get(c.id) || [];
    try {
      const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('cannot decode');
      const first = await track.getFirstTimestamp().catch(() => 0);
      const off = first > 0 ? first : 0;
      const dw = track.displayWidth, dh = track.displayHeight;
      const scale = Math.min(1, Math.max(W, H) * 1.5 / Math.max(dw, dh));
      const opts = { poolSize: 3 };
      if (scale < 0.99) { opts.width = Math.round(dw * scale / 2) * 2; opts.height = Math.round(dh * scale / 2) * 2; }
      const sink = new mb.CanvasSink(track, opts);
      const gen = sink.canvasesAtTimestamps(list.map(s => s + off));
      let last = null;
      return {
        mode: 'webcodecs',
        next: async () => { const r = await gen.next(); if (!r.done && r.value) last = { img: r.value.canvas, w: r.value.canvas.width, h: r.value.canvas.height }; return last; },
        close: () => { gen.return().catch(() => { }); input.dispose && input.dispose(); },
      };
    } catch (e) {
      console.info('Falling back to <video> seeking for', c.name, e.message);
      const r = new ElementReader(media.url(c.mediaId)); await r.open();
      let i = 0;
      return { mode: 'element', next: () => r.at(list[Math.min(i++, list.length - 1)]), close: () => r.close() };
    }
  };

  // audio is mixed chunk by chunk, just ahead of the video frames (flat memory for any length)
  const chunks = withAudio ? mixChunks(project, lay, media, { onWarn }) : null;
  let audioFedSec = 0, audioDone = !withAudio;
  const feedAudio = async (untilSec) => {
    while (!audioDone && audioFedSec < untilSec) {
      const r = await chunks.next();
      if (r.done) { audioDone = true; break; }
      await asrc.add(r.value);
      audioFedSec += r.value.duration;
    }
  };

  const tStart = performance.now();
  try {
    for (let k = 0; k < N; k++) {
      check();
      const t = k / fps;
      const sources = new Map();
      for (const a of plan[k]) {
        const c = a.it.clip;
        if (c.kind === 'image') { const src = imageSrc(c.mediaId, (k + 0.001) / fps - a.it.start + (c.in || 0)); if (src) sources.set(c.id, src); continue; }
        let r = readers.get(c.id);
        if (!r) { r = await openReader(c); readers.set(c.id, r); }
        const f = await r.next();
        if (f) sources.set(c.id, f);
        if (lastFrame.get(c.id) === k) { r.close(); readers.delete(c.id); }
      }
      for (const o of planO[k]) {
        if (o.kind === 'image') { const src = imageSrc(o.mediaId, (k + 0.001) / fps - o.start + (o.in || 0)); if (src) sources.set(o.id, src); continue; }
        let r = readers.get(o.id);
        if (!r) { r = await openReader(o); readers.set(o.id, r); }
        const f = await r.next();
        if (f) sources.set(o.id, f);
        if (lastFrame.get(o.id) === k) { r.close(); readers.delete(o.id); }
      }
      comp.render(ctx, W, H, project, lay, (k + 0.001) / fps, (it) => sources.get(it.clip.id) || null, { getLogo: () => logo, getOverlaySource: (o) => sources.get(o.id) || null });
      await vsrc.add(t, 1 / fps);
      await feedAudio(t + 2);
      if (k % 3 === 0 || k === N - 1) {
        const el = (performance.now() - tStart) / 1000;
        progress(0.04 + 0.94 * ((k + 1) / N), `Rendering frame ${k + 1} of ${N}`, { speed: el > 0 ? (k + 1) / fps / el : 0, method: 'fast' });
      }
    }
    await feedAudio(total + 20);
    check();
    progress(0.99, 'Finalizing file…');
    vsrc.close(); asrc && asrc.close();
    await output.finalize();
  } catch (e) {
    for (const r of readers.values()) r.close();
    if (chunks) chunks.return().catch(() => { });
    try { await output.cancel(); } catch { }
    throw e;
  }
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob = streamed ? await sink.finish() : new Blob([output.target.buffer], { type: mime });
  return { blob, mime, ext: container, streamed: streamed ? sink.kind : null, method: 'WebCodecs (' + vcodec.toUpperCase() + (acodec ? ' + ' + acodec.toUpperCase() : '') + ')', width: W, height: H, fps, duration: total };
}

/** Real-time fallback using MediaRecorder. */
async function exportRealtime(project, media, { onProgress, signal, format, openSink, onWarn }) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record video (no MediaRecorder).');
  const lay = layout(project);
  const { width: W, height: H } = outputDims(project);
  const fps = project.settings.fps || 30;
  const total = lay.total;
  const progress = makeProgress(onProgress);
  let types = recorderMimeTypes();
  if (format === 'webm') types = types.filter(t => t.includes('webm')).concat(types.filter(t => !t.includes('webm')));
  if (format === 'mp4' && !types.some(t => t.includes('mp4'))) throw new Error('MP4 recording is not supported in this browser — choose WebM.');
  const mime = types[0] || '';
  const sink = openSink ? await openSink(extFor(mime || 'video/webm')) : null;
  progress(0, 'Preparing audio…');
  const withAudio = hasAudio(project, lay);
  const chunks = withAudio ? mixChunks(project, lay, media, { onWarn }) : null;
  const ahead = []; // pre-mixed chunks waiting to be scheduled
  if (chunks) for (let i = 0; i < 2; i++) { const r = await chunks.next(); if (r.done) break; ahead.push(r.value); }
  if (signal && signal.aborted) { chunks && chunks.return().catch(() => { }); throw new ExportCancelled(); }
  await ensureFonts();
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  canvas.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;';
  document.body.appendChild(canvas);
  const comp = new Compositor();
  const player = new Player({ canvas, getProject: () => project, media, compositor: comp, audio: false });
  player.invalidate();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC({ sampleRate: 48000 });
  await ac.resume();
  const stream = canvas.captureStream(fps);
  let dest = null;
  if (withAudio) {
    dest = ac.createMediaStreamDestination();
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bitrateFor(W, H, fps, project.settings.quality), audioBitsPerSecond: 192000 });
  // recorded data goes straight to disk when a sink is available; otherwise it is kept in memory
  const parts = []; let writeChain = Promise.resolve();
  const streamed = !!(sink && sink.writable);
  rec.ondataavailable = e => { if (!(e.data && e.data.size)) return; if (streamed) { const d = e.data; writeChain = writeChain.then(() => sink.writable.write(d)); } else parts.push(e.data); };
  const stopped = new Promise(r => rec.addEventListener('stop', r, { once: true }));
  // preroll first frame
  player.sync(0, false);
  for (let i = 0; i < 60; i++) { if (player.sync(0, false)) break; await new Promise(r => setTimeout(r, 50)); }
  player.render();
  rec.start(1000);
  const t0 = ac.currentTime + 0.1;
  // schedule audio chunk by chunk; keep ~2 chunks queued ahead of the clock
  let schedAt = 0, feeding = false, audioEnded = !withAudio;
  const schedule = (buf) => { const s = ac.createBufferSource(); s.buffer = buf; s.connect(dest); s.start(t0 + schedAt); schedAt += buf.duration; };
  while (ahead.length) schedule(ahead.shift());
  const topUp = async () => {
    if (feeding || audioEnded) return; feeding = true;
    try {
      while (!audioEnded && schedAt - Math.max(0, ac.currentTime - t0) < 15) {
        const r = await chunks.next();
        if (r.done) { audioEnded = true; break; }
        schedule(r.value);
      }
    } finally { feeding = false; }
  };
  let cancelled = false;
  await new Promise((resolve) => {
    const step = () => {
      if (signal && signal.aborted) { cancelled = true; return resolve(); }
      const t = Math.max(0, ac.currentTime - t0);
      if (t >= total) { player.t = total; player.render(); return resolve(); }
      player.t = t; player.sync(t, true); player.render();
      topUp();
      progress(0.02 + 0.97 * (t / total), `Recording in real time · ${Math.round(t)}s of ${Math.round(total)}s`, { method: 'realtime', speed: 1 });
      if (document.hidden) setTimeout(step, 1000 / fps); else requestAnimationFrame(step);
    };
    step();
  });
  await new Promise(r => setTimeout(r, 200));
  rec.stop(); await stopped;
  stream.getTracks().forEach(t => t.stop());
  player.destroy(); canvas.remove(); ac.close().catch(() => { });
  if (chunks) chunks.return().catch(() => { });
  if (cancelled) throw new ExportCancelled();
  const outMime = (rec.mimeType || mime || 'video/webm').split(';')[0];
  let blob;
  if (streamed) { await writeChain; await sink.writable.close(); blob = await sink.finish(); }
  else blob = new Blob(parts, { type: outMime });
  return { blob, streamed: streamed ? sink.kind : null, mime: outMime, ext: extFor(outMime), method: 'MediaRecorder (real time)', width: W, height: H, fps, duration: total };
}

/**
 * Run an export. options: { format: 'auto'|'mp4'|'webm', engine: 'auto'|'fast'|'realtime', onProgress, signal }
 */
export async function runExport(project, media, options = {}) {
  const engine = options.engine || 'auto';
  // options.makeSink(ext) -> sink (see createSink). Each engine opens it once it knows the container, once per attempt,
  // so a failed attempt's partial file is discarded.
  const format = ['mp4', 'webm'].includes(options.format) ? options.format : 'auto';
  const attempt = async (fn) => {
    let sink = null;
    const openSink = async (ext) => (sink = options.makeSink ? await options.makeSink(ext) : null);
    try { return await fn(project, media, { ...options, format, openSink }); }
    catch (e) { if (sink) await sink.abort(); throw e; }
  };
  if (engine !== 'realtime' && typeof VideoEncoder !== 'undefined') {
    try { return await attempt(exportFast); }
    catch (e) {
      if (e instanceof ExportCancelled) throw e;
      if (engine === 'fast') throw e;
      console.warn('Fast export unavailable, using real-time recorder:', e.message);
      options.onFallback && options.onFallback(e.message);
    }
  }
  return attempt(exportRealtime);
}
