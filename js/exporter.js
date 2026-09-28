// Export: fast path = WebCodecs (via vendored Mediabunny) frame-accurate render, faster than real time.
// Fallback = real-time canvas + MediaRecorder (MP4 when the browser supports it, else WebM).
import { layout, activeAt, sourceTime, outputDims } from './model.js';
import { Compositor, ensureFonts } from './render.js';
import { Player } from './player.js';
import { mixAudio } from './audio.js';
import { loadMediabunny, seekVideo } from './media.js';

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
async function exportFast(project, media, { onProgress, signal, format }) {
  const mb = await loadMediabunny();
  const lay = layout(project);
  const { width: W, height: H } = outputDims(project);
  const fps = project.settings.fps || 30;
  const total = lay.total;
  const N = Math.max(1, Math.round(total * fps));
  const bitrate = bitrateFor(W, H, fps, project.settings.quality);
  const progress = makeProgress(onProgress);
  const check = () => { if (signal && signal.aborted) throw new ExportCancelled(); };

  let container = format === 'webm' ? 'webm' : 'mp4';
  let vcodec = null;
  if (container === 'mp4' && await mb.canEncodeVideo('avc', { width: W, height: H, bitrate })) vcodec = 'avc';
  if (!vcodec) {
    if (format === 'mp4') throw new Error('This browser cannot encode H.264 with WebCodecs');
    container = 'webm';
    for (const c of ['vp9', 'vp8']) if (await mb.canEncodeVideo(c, { width: W, height: H, bitrate })) { vcodec = c; break; }
  }
  if (!vcodec) throw new Error('No WebCodecs video encoder available');

  progress(0, 'Mixing audio…');
  const mixed = await mixAudio(project, lay, media, { onStatus: (s) => progress(0.01, s) });
  check();
  let acodec = null;
  if (mixed) {
    const cand = container === 'mp4' ? ['aac', 'opus'] : ['opus', 'vorbis'];
    for (const c of cand) if (await mb.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })) { acodec = c; break; }
    if (!acodec) throw new Error('No WebCodecs audio encoder available');
  }

  await ensureFonts();
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const comp = new Compositor();
  const output = new mb.Output({
    format: container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  const vsrc = new mb.CanvasSource(canvas, { codec: vcodec, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null;
  if (mixed) { asrc = new mb.AudioBufferSource({ codec: acodec, bitrate: 192000 }); output.addAudioTrack(asrc); }
  output.setMetadataTags && output.setMetadataTags({ title: project.youtube.title || project.name });
  await output.start();

  // --- frame plan: which clips are visible on each frame and at which source time
  const plan = new Array(N);
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
  }
  // images & logo
  const images = new Map();
  for (const it of lay.items) if (it.clip.kind === 'image') { const im = await media.image(it.clip.mediaId).catch(() => null); if (im) images.set(it.clip.mediaId, im); }
  const logo = project.logo ? await media.image(project.logo.mediaId).catch(() => null) : null;

  const readers = new Map();
  const openReader = async (it) => {
    const c = it.clip, rec = await media.get(c.mediaId);
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

  let audioFed = 0; const SR = mixed ? mixed.sampleRate : 48000;
  const feedAudio = async (untilSec) => {
    if (!asrc) return;
    const until = Math.min(mixed.length, Math.ceil(untilSec * SR));
    while (audioFed < until) {
      const n = Math.min(SR, until - audioFed);
      const chunk = new AudioBuffer({ numberOfChannels: mixed.numberOfChannels, length: n, sampleRate: SR });
      for (let c = 0; c < mixed.numberOfChannels; c++) chunk.copyToChannel(mixed.getChannelData(c).subarray(audioFed, audioFed + n), c);
      await asrc.add(chunk);
      audioFed += n;
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
        if (c.kind === 'image') { const im = images.get(c.mediaId); if (im) sources.set(c.id, { img: im.img, w: im.w, h: im.h }); continue; }
        let r = readers.get(c.id);
        if (!r) { r = await openReader(a.it); readers.set(c.id, r); }
        const f = await r.next();
        if (f) sources.set(c.id, f);
        if (lastFrame.get(c.id) === k) { r.close(); readers.delete(c.id); }
      }
      comp.render(ctx, W, H, project, lay, (k + 0.001) / fps, (it) => sources.get(it.clip.id) || null, { getLogo: () => logo });
      await vsrc.add(t, 1 / fps);
      await feedAudio(t + 1);
      if (k % 3 === 0 || k === N - 1) {
        const el = (performance.now() - tStart) / 1000;
        progress(0.04 + 0.94 * ((k + 1) / N), `Rendering frame ${k + 1} of ${N}`, { speed: el > 0 ? (k + 1) / fps / el : 0, method: 'fast' });
      }
    }
    await feedAudio(total + 1);
    check();
    progress(0.99, 'Finalizing file…');
    vsrc.close(); asrc && asrc.close();
    await output.finalize();
  } catch (e) {
    for (const r of readers.values()) r.close();
    try { await output.cancel(); } catch { }
    throw e;
  }
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob = new Blob([output.target.buffer], { type: mime });
  return { blob, mime, ext: container, method: 'WebCodecs (' + vcodec.toUpperCase() + (acodec ? ' + ' + acodec.toUpperCase() : '') + ')', width: W, height: H, fps, duration: total };
}

/** Real-time fallback using MediaRecorder. */
async function exportRealtime(project, media, { onProgress, signal, format }) {
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
  progress(0, 'Mixing audio…');
  const mixed = await mixAudio(project, lay, media, { onStatus: s => progress(0.01, s) });
  if (signal && signal.aborted) throw new ExportCancelled();
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
  let bsrc = null;
  if (mixed) {
    const dest = ac.createMediaStreamDestination();
    bsrc = ac.createBufferSource(); bsrc.buffer = mixed; bsrc.connect(dest);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bitrateFor(W, H, fps, project.settings.quality), audioBitsPerSecond: 192000 });
  const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.addEventListener('stop', r, { once: true }));
  // preroll first frame
  player.sync(0, false);
  for (let i = 0; i < 60; i++) { if (player.sync(0, false)) break; await new Promise(r => setTimeout(r, 50)); }
  player.render();
  rec.start(1000);
  const t0 = ac.currentTime + 0.1;
  if (bsrc) bsrc.start(t0);
  let cancelled = false;
  await new Promise((resolve) => {
    const step = () => {
      if (signal && signal.aborted) { cancelled = true; return resolve(); }
      const t = Math.max(0, ac.currentTime - t0);
      if (t >= total) { player.t = total; player.render(); return resolve(); }
      player.t = t; player.sync(t, true); player.render();
      progress(0.02 + 0.97 * (t / total), `Recording in real time · ${Math.round(t)}s of ${Math.round(total)}s`, { method: 'realtime', speed: 1 });
      if (document.hidden) setTimeout(step, 1000 / fps); else requestAnimationFrame(step);
    };
    step();
  });
  await new Promise(r => setTimeout(r, 200));
  rec.stop(); await stopped;
  stream.getTracks().forEach(t => t.stop());
  player.destroy(); canvas.remove(); ac.close().catch(() => { });
  if (cancelled) throw new ExportCancelled();
  const outMime = (rec.mimeType || mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type: outMime }), mime: outMime, ext: extFor(outMime), method: 'MediaRecorder (real time)', width: W, height: H, fps, duration: total };
}

/**
 * Run an export. options: { format: 'auto'|'mp4'|'webm', engine: 'auto'|'fast'|'realtime', onProgress, signal }
 */
export async function runExport(project, media, options = {}) {
  const engine = options.engine || 'auto';
  if (engine !== 'realtime' && typeof VideoEncoder !== 'undefined') {
    try { return await exportFast(project, media, options); }
    catch (e) {
      if (e instanceof ExportCancelled) throw e;
      if (engine === 'fast') throw e;
      console.warn('Fast export unavailable, using real-time recorder:', e.message);
      options.onFallback && options.onFallback(e.message);
    }
  }
  return exportRealtime(project, media, options);
}
