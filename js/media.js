// Media import, metadata probing, thumbnails, waveforms, and runtime caches (object URLs, images).
import { db } from './db.js';
import { uid } from './util.js';

let mbPromise = null, gifPromise = null;
export function loadMediabunny() {
  if (!mbPromise) mbPromise = import('../vendor/mediabunny.min.mjs');
  return mbPromise;
}

function once(target, ev, timeout = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('Timed out waiting for ' + ev)); }, timeout);
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(target.error || new Error('Media error')); };
    const cleanup = () => { clearTimeout(t); target.removeEventListener(ev, ok); target.removeEventListener('error', bad); };
    target.addEventListener(ev, ok); target.addEventListener('error', bad);
  });
}
export function seekVideo(v, t, timeout = 8000) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return res();
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, timeout);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function probeVideo(blob) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true;
  const url = URL.createObjectURL(blob);
  try {
    v.src = url;
    await once(v, 'loadedmetadata');
    let duration = v.duration;
    if (!Number.isFinite(duration)) { // MediaRecorder WebM without duration
      v.currentTime = 1e7; await once(v, 'seeked').catch(() => { }); duration = v.duration; v.currentTime = 0;
    }
    if (v.readyState < 2) await once(v, 'loadeddata').catch(() => { });
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('No video track');
    const strip = [];
    const n = 8, th = 72, tw = Math.round(Math.min(160, th * (w / h)));
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const x = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      const t = Math.min(Math.max(0.05, duration - 0.05), (duration * (i + 0.5)) / n);
      await seekVideo(v, t, 4000);
      try { x.drawImage(v, 0, 0, tw, th); strip.push(c.toDataURL('image/jpeg', 0.6)); } catch { strip.push(''); }
    }
    let hasAudio = null;
    if (typeof v.webkitAudioDecodedByteCount === 'number' || v.audioTracks) {
      if (v.audioTracks) hasAudio = v.audioTracks.length > 0;
    }
    return { duration, width: w, height: h, strip, hasAudio };
  } finally {
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
  }
}

async function probeImage(blob) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const th = 72, tw = Math.round(Math.min(160, th * (w / h)));
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  c.getContext('2d').drawImage(bmp, 0, 0, tw, th);
  bmp.close && bmp.close();
  return { width: w, height: h, strip: [c.toDataURL('image/jpeg', 0.7)] };
}

async function probeAudio(blob) {
  const a = document.createElement('audio'); a.preload = 'metadata';
  const url = URL.createObjectURL(blob);
  try {
    a.src = url; await once(a, 'loadedmetadata'); let d = a.duration;
    if (!Number.isFinite(d) || d <= 0) {
      // MediaRecorder WebM files have no duration header: seek to the end to discover it
      d = await new Promise((res) => {
        const done = () => { a.removeEventListener('durationchange', ch); clearTimeout(to); res(Number.isFinite(a.duration) ? a.duration : 0); };
        const ch = () => { if (Number.isFinite(a.duration)) done(); };
        const to = setTimeout(done, 3000);
        a.addEventListener('durationchange', ch);
        try { a.currentTime = 1e7; } catch { done(); }
      });
    }
    if (!Number.isFinite(d) || d <= 0) {
      try {
        const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        const buf = await ac.decodeAudioData(await blob.arrayBuffer()); d = buf.duration;
      } catch { d = 0; }
    }
    return { duration: d };
  }
  finally { a.removeAttribute('src'); a.load(); URL.revokeObjectURL(url); }
}

async function hasAudioTrack(blob) {
  try {
    const mb = await loadMediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const tr = await input.getPrimaryAudioTrack();
    input.dispose && input.dispose();
    return !!tr;
  } catch { return null; }
}

/**
 * Compute waveform peaks (values 0..255, `rate` per second). Streams the audio through WebCodecs in small decoded
 * chunks, so only the low-resolution peak array is kept — an hour-long sermon never sits in memory as PCM.
 */
export async function computePeaks(blob, rate = 20) {
  try {
    const mb = await loadMediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track && await track.canDecode()) {
        const peaks = [];
        const sink = new mb.AudioBufferSink(track);
        for await (const { buffer, timestamp } of sink.buffers()) {
          const ch = buffer.getChannelData(0), sr = buffer.sampleRate;
          const t0 = Math.max(0, timestamp);
          for (let i = 0; i < ch.length; i += 4) {
            const bin = Math.floor((t0 + i / sr) * rate);
            const v = Math.abs(ch[i]);
            if (!(v <= (peaks[bin] || 0))) peaks[bin] = v;
          }
          if (peaks.length > rate * 6 * 3600) break; // 6 h safety cap
        }
        for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(255, Math.round(Math.sqrt(peaks[i] || 0) * 255));
        if (peaks.length) return { rate, data: peaks };
      }
    } finally { input.dispose && input.dispose(); }
  } catch (e) { /* fall through to the small-file path */ }
  if (blob.size > 60 * 1024 * 1024) return null; // never decode a big file in one piece
  try {
    const buf = await blob.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ac = new Ctx(1, 1, 44100);
    const audio = await ac.decodeAudioData(buf);
    const ch = audio.getChannelData(0), step = Math.max(1, Math.floor(audio.sampleRate / rate));
    const peaks = [];
    for (let i = 0; i < ch.length; i += step) {
      let m = 0; const e = Math.min(ch.length, i + step);
      for (let j = i; j < e; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      peaks.push(Math.min(255, Math.round(Math.sqrt(m) * 255)));
    }
    return { rate, data: peaks };
  } catch { return null; }
}

// ---------- HEIC (iPhone photos) ----------
export const isHeic = (file) => /image\/hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');
let heicWorker = null, heicSeq = 0;
function heicDecodeWasm(buffer) {
  if (!heicWorker) heicWorker = new Worker(new URL('./heic-worker.js', import.meta.url));
  const id = ++heicSeq;
  return new Promise((resolve, reject) => {
    const on = (e) => {
      if (e.data.id !== id) return;
      heicWorker.removeEventListener('message', on);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    heicWorker.addEventListener('message', on);
    heicWorker.postMessage({ id, buffer }, [buffer]);
  });
}
/** Convert a HEIC/HEIF photo to a JPEG File. Native decoding first (Safari), then the bundled WebAssembly decoder. */
export async function heicToJpeg(file) {
  let canvas = null;
  try {
    const bmp = await createImageBitmap(file);
    canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
  } catch { canvas = null; }
  if (!canvas) {
    const { width, height, data } = await heicDecodeWasm(await file.arrayBuffer());
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  }
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not convert the HEIC photo');
  return new File([blob], (file.name || 'photo').replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
}

// ---------- animated GIF ----------
export const isGif = (file) => /image\/gif/i.test(file.type || '') || /\.gif$/i.test(file.name || '');
const MAX_GIF_PIXELS = 48e6; // total decoded pixels kept per GIF (~190 MB of RGBA at worst): larger GIFs are scaled down
/** Decode every frame of an animated GIF to ImageBitmaps. Returns { frames:[{img,t0,dur}], total, w, h } or null. */
export async function decodeGif(blob) {
  const buf = await blob.arrayBuffer();
  if (typeof ImageDecoder !== 'undefined') {
    try {
      if (await ImageDecoder.isTypeSupported('image/gif')) {
        const dec = new ImageDecoder({ data: buf, type: 'image/gif' });
        await dec.tracks.ready;
        await dec.completed.catch(() => { });
        const tr = dec.tracks.selectedTrack, n = Math.min(tr.frameCount, 2000);
        const first = (await dec.decode({ frameIndex: 0 })).image;
        const w = first.displayWidth, h = first.displayHeight;
        const sc = Math.min(1, Math.sqrt(MAX_GIF_PIXELS / Math.max(1, w * h * n)));
        const opts = sc < 1 ? { resizeWidth: Math.max(1, Math.round(w * sc)), resizeHeight: Math.max(1, Math.round(h * sc)), resizeQuality: 'medium' } : {};
        const frames = []; let t = 0;
        for (let i = 0; i < n; i++) {
          const image = i === 0 ? first : (await dec.decode({ frameIndex: i })).image;
          const dur = image.duration && image.duration >= 20000 ? image.duration / 1e6 : 0.1; // browsers treat <20 ms as 100 ms
          frames.push({ img: await createImageBitmap(image, opts), t0: t, dur });
          t += dur; image.close();
        }
        dec.close();
        return { frames, total: t, w, h, via: 'ImageDecoder' };
      }
    } catch (e) { console.info('ImageDecoder could not decode GIF, trying fallback:', e.message); }
  }
  // Fallback: small bundled GIF parser (gifuct-js) + manual frame compositing
  if (!gifPromise) gifPromise = import('../vendor/gifuct.min.mjs');
  const { parseGIF, decompressFrames } = await gifPromise;
  const gif = parseGIF(buf);
  const raw = decompressFrames(gif, true);
  if (!raw.length) return null;
  const w = gif.lsd.width, h = gif.lsd.height, n = Math.min(raw.length, 2000);
  const sc = Math.min(1, Math.sqrt(MAX_GIF_PIXELS / Math.max(1, w * h * n)));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  const patch = document.createElement('canvas'), px = patch.getContext('2d');
  const frames = []; let t = 0, prev = null, saved = null;
  for (let i = 0; i < n; i++) {
    const f = raw[i];
    if (prev) {
      if (prev.disposalType === 2) x.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
      else if (prev.disposalType === 3 && saved) x.putImageData(saved, 0, 0);
    }
    saved = f.disposalType === 3 ? x.getImageData(0, 0, w, h) : null;
    const { width: pw, height: ph, left, top } = f.dims;
    if (pw > 0 && ph > 0) {
      patch.width = pw; patch.height = ph;
      px.putImageData(new ImageData(new Uint8ClampedArray(f.patch), pw, ph), 0, 0);
      x.drawImage(patch, left, top);
    }
    const dur = f.delay && f.delay >= 20 ? f.delay / 1000 : 0.1;
    const opts = sc < 1 ? { resizeWidth: Math.max(1, Math.round(w * sc)), resizeHeight: Math.max(1, Math.round(h * sc)) } : {};
    frames.push({ img: await createImageBitmap(c, opts), t0: t, dur });
    t += dur; prev = f;
  }
  return { frames, total: t, w, h, via: 'gifuct' };
}
/** Frame of a decoded GIF at time t (seconds, loops forever). */
export function gifFrameAt(g, t) {
  const fr = g.frames;
  if (fr.length === 1 || !(g.total > 0)) return fr[0];
  let x = ((t % g.total) + g.total) % g.total;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fr[m].t0 <= x) lo = m; else hi = m - 1; }
  return fr[lo];
}

export function kindOf(file) {
  const t = file.type || '', n = (file.name || '').toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/.test(n)) return 'video';
  if (t.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/.test(n)) return 'image';
  if (t.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(n)) return 'audio';
  return null;
}

export class MediaLibrary {
  constructor() { this.recs = new Map(); this.urls = new Map(); this.images = new Map(); this.gifs = new Map(); this.listeners = new Set(); }
  onChange(fn) { this.listeners.add(fn); }
  _emit(id) { this.listeners.forEach(f => f(id)); }

  async get(id) {
    if (!id) return null;
    if (this.recs.has(id)) return this.recs.get(id);
    const rec = await db.getMedia(id);
    if (rec) this.recs.set(id, rec);
    return rec || null;
  }
  peek(id) { return this.recs.get(id) || null; }
  has(id) { return this.recs.has(id); }
  async preload(ids) { await Promise.all([...ids].map(id => this.get(id))); }
  url(id) {
    const rec = this.recs.get(id);
    if (!rec) return null;
    if (!this.urls.has(id)) this.urls.set(id, URL.createObjectURL(rec.blob));
    return this.urls.get(id);
  }
  async image(id) {
    if (this.images.has(id)) return this.images.get(id);
    const rec = await this.get(id);
    if (!rec) return null;
    const p = (async () => {
      const img = new Image(); img.decoding = 'async';
      img.src = this.url(id);
      await img.decode();
      return { img, w: img.naturalWidth, h: img.naturalHeight };
    })();
    this.images.set(id, p);
    try { const r = await p; this.images.set(id, r); return r; } catch (e) { this.images.delete(id); throw e; }
  }
  imageSync(id) { const v = this.images.get(id); return v && !(v instanceof Promise) ? v : null; }
  /** Is this media an animated image (GIF with more than one frame)? */
  isAnimated(id) { const r = this.recs.get(id); return !!(r && r.animated); }
  /** Decoded GIF frames (cached per media id; decoded on first use, never persisted). */
  async gif(id) {
    if (this.gifs.has(id)) return this.gifs.get(id);
    const rec = await this.get(id);
    if (!rec) return null;
    const p = decodeGif(rec.blob).catch((e) => { console.warn('GIF decode failed', e); return null; });
    this.gifs.set(id, p);
    const g = await p; this.gifs.set(id, g);
    return g;
  }
  gifSync(id) { const v = this.gifs.get(id); return v && !(v instanceof Promise) ? v : null; }
  /**
   * Drawable source for an image media at animation time t: the GIF frame for animated GIFs (kicks off decoding
   * and returns the still image until frames are ready), otherwise the still image. onReady is called after async loads.
   */
  imageSourceAt(id, t, onReady) {
    if (this.isAnimated(id)) {
      const g = this.gifSync(id);
      if (g && g.frames.length) { const f = gifFrameAt(g, t); return { img: f.img, w: f.img.width, h: f.img.height }; }
      if (!this.gifs.has(id)) this.gif(id).then(() => onReady && onReady()).catch(() => { });
    }
    const im = this.imageSync(id);
    if (!im) { this.image(id).then(() => onReady && onReady()).catch(() => { }); return null; }
    return { img: im.img, w: im.w, h: im.h };
  }

  /** Import a File into IndexedDB; returns media record. */
  async importFile(file, forceKind) {
    const kind = forceKind || kindOf(file);
    if (!kind) throw new Error('Unsupported file: ' + file.name);
    if (kind === 'image' && isHeic(file)) file = await heicToJpeg(file);
    const id = uid('med');
    let meta;
    if (kind === 'video') meta = await probeVideo(file);
    else if (kind === 'image') meta = await probeImage(file);
    else meta = await probeAudio(file);
    const rec = { id, kind, name: file.name || (kind + '-' + id), type: file.type, size: file.size, created: Date.now(), blob: file, ...meta };
    if (kind === 'video' && rec.hasAudio == null) rec.hasAudio = await hasAudioTrack(file);
    if (rec.hasAudio == null) rec.hasAudio = kind !== 'image';
    if (kind === 'image' && isGif(file)) await this._probeGif(rec);
    // Store a Blob copy (File objects from pickers are fine to persist in IndexedDB)
    await db.putMedia(rec);
    // Re-read from DB so the blob is disk-backed and survives the picker's File going stale
    const stored = await db.getMedia(id);
    this.recs.set(id, stored || rec);
    if (kind !== 'image' && rec.hasAudio) this.fillPeaks(id);
    return this.recs.get(id);
  }
  async _probeGif(rec) {
    const g = await decodeGif(rec.blob).catch((e) => { console.warn('GIF decode failed', e); return null; });
    if (g && g.frames.length > 1) { rec.animated = true; rec.duration = g.total; rec.frameCount = g.frames.length; this.gifs.set(rec.id, g); }
    else if (!g && typeof ImageDecoder === 'undefined') rec.gifStill = true;
  }
  async replaceMedia(id, file) {
    let kind = kindOf(file);
    if (kind === 'image' && isHeic(file)) file = await heicToJpeg(file);
    const meta = kind === 'video' ? await probeVideo(file) : kind === 'image' ? await probeImage(file) : await probeAudio(file);
    const rec = { id, kind, name: file.name, type: file.type, size: file.size, created: Date.now(), blob: file, ...meta };
    if (kind === 'video' && rec.hasAudio == null) rec.hasAudio = await hasAudioTrack(file);
    if (rec.hasAudio == null) rec.hasAudio = kind !== 'image';
    this.forget(id);
    if (kind === 'image' && isGif(file)) await this._probeGif(rec);
    await db.putMedia(rec);
    this.recs.set(id, (await db.getMedia(id)) || rec);
    if (kind !== 'image' && rec.hasAudio) this.fillPeaks(id);
    this._emit(id);
    return this.recs.get(id);
  }
  async fillPeaks(id) {
    const rec = await this.get(id);
    if (!rec || rec.peaks) return;
    const peaks = await computePeaks(rec.blob);
    if (peaks) { rec.peaks = peaks; await db.updateMediaMeta(id, { peaks }); this._emit(id); }
  }
  forget(id) {
    const u = this.urls.get(id); if (u) URL.revokeObjectURL(u);
    this.urls.delete(id); this.images.delete(id); this.recs.delete(id);
    const g = this.gifs.get(id); if (g && g.frames) for (const f of g.frames) try { f.img.close(); } catch { }
    this.gifs.delete(id);
  }
  /** Import a data-url embedded media record (from project JSON). */
  async importEmbedded(m, blob) {
    const rec = { ...m, blob, created: Date.now() };
    delete rec.data;
    await db.putMedia(rec);
    this.recs.set(rec.id, (await db.getMedia(rec.id)) || rec);
    return rec;
  }
}
export const media = new MediaLibrary();
