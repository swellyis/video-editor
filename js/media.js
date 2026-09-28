// Media import, metadata probing, thumbnails, waveforms, and runtime caches (object URLs, images).
import { db } from './db.js';
import { uid } from './util.js';

let mbPromise = null;
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

/** Compute waveform peaks (values 0..255, `rate` per second). */
export async function computePeaks(blob, rate = 20) {
  if (blob.size > 150 * 1024 * 1024) return null;
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

export function kindOf(file) {
  const t = file.type || '', n = (file.name || '').toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/.test(n)) return 'video';
  if (t.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/.test(n)) return 'image';
  if (t.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(n)) return 'audio';
  return null;
}

export class MediaLibrary {
  constructor() { this.recs = new Map(); this.urls = new Map(); this.images = new Map(); this.listeners = new Set(); }
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

  /** Import a File into IndexedDB; returns media record. */
  async importFile(file, forceKind) {
    const kind = forceKind || kindOf(file);
    if (!kind) throw new Error('Unsupported file: ' + file.name);
    const id = uid('med');
    let meta;
    if (kind === 'video') meta = await probeVideo(file);
    else if (kind === 'image') meta = await probeImage(file);
    else meta = await probeAudio(file);
    const rec = { id, kind, name: file.name || (kind + '-' + id), type: file.type, size: file.size, created: Date.now(), blob: file, ...meta };
    if (kind === 'video' && rec.hasAudio == null) rec.hasAudio = await hasAudioTrack(file);
    if (rec.hasAudio == null) rec.hasAudio = kind !== 'image';
    // Store a Blob copy (File objects from pickers are fine to persist in IndexedDB)
    await db.putMedia(rec);
    // Re-read from DB so the blob is disk-backed and survives the picker's File going stale
    const stored = await db.getMedia(id);
    this.recs.set(id, stored || rec);
    if (kind !== 'image' && rec.hasAudio) this.fillPeaks(id);
    return this.recs.get(id);
  }
  async replaceMedia(id, file) {
    const kind = kindOf(file);
    const meta = kind === 'video' ? await probeVideo(file) : kind === 'image' ? await probeImage(file) : await probeAudio(file);
    const rec = { id, kind, name: file.name, type: file.type, size: file.size, created: Date.now(), blob: file, ...meta };
    if (kind === 'video' && rec.hasAudio == null) rec.hasAudio = await hasAudioTrack(file);
    if (rec.hasAudio == null) rec.hasAudio = kind !== 'image';
    await db.putMedia(rec);
    this.forget(id);
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
