// Proxy editing: a small, easy-to-seek copy of a big video (4K or long) made on this device in the background. The preview and
// the timeline play the proxy; the export always reads the ORIGINAL file (exporter.js never asks for a proxy).
// Storage: the origin-private file system (OPFS, disk-backed, written as a stream) where the browser can write there; otherwise
// (older Safari) an in-memory build stored in IndexedDB, for proxies up to MEM_LIMIT. A tiny metadata entry 'px:<mediaId>' lives
// in the kv store. Proxies are never put in project files or backups: they can always be made again.
import { db } from './db.js';
import { loadMediabunny } from './media.js';

export const PROXY_V = 1;              // bump when the proxy recipe changes: old proxies are made again
export const SHORT_SIDE = 540;         // the proxy's short side (540p for landscape, 540 wide for portrait)
export const KEY_INTERVAL = 0.5;       // a key frame every half second: seeking only decodes a few frames
export const AUTO_SIDE = 2560;         // 4K-ish: long side ≥ 2560 px …
export const AUTO_SECONDS = 10 * 60;   // … or longer than 10 minutes → a proxy is suggested / made automatically
export const MEM_LIMIT = 400 * 1048576;
const DIR = 'proxies', KEY = 'px:';

/** Does this media record deserve a proxy (4K-class picture or a long file)? */
export function needsProxy(rec) {
  if (!rec || rec.kind !== 'video') return false;
  const w = rec.width || 0, h = rec.height || 0;
  return Math.max(w, h) >= AUTO_SIDE || Math.min(w, h) >= 1440 || (rec.duration || 0) >= AUTO_SECONDS;
}
/** Proxy size for a source: short side SHORT_SIDE (never upscaled), even numbers, same aspect. */
export function proxyDims(w, h, short = SHORT_SIDE) {
  if (!(w > 0 && h > 0)) return { width: 960, height: 540 };
  const s = Math.min(1, short / Math.min(w, h));
  const ev = (v) => Math.max(2, Math.round(v * s / 2) * 2);
  return { width: ev(w), height: ev(h) };
}
/** Proxy bit rate (bits/s): about 0.1 bits per pixel per frame at 30 fps, at least 600 kbps. */
export const proxyBitrate = (w, h, fps = 30) => Math.max(600000, Math.round(w * h * Math.min(60, fps || 30) * 0.1));
/** Estimated proxy size in bytes for a duration. */
export const proxyEstimate = (rec) => { const d = proxyDims(rec.width, rec.height); return Math.round((proxyBitrate(d.width, d.height) + 128000) / 8 * (rec.duration || 0)); };

const opfsOK = () => !!(typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype);
async function dir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(DIR, { create: true }); }
const fileName = (id) => id + '-v' + PROXY_V + '.mp4';

/** Stored proxy metadata (or null). */
export async function proxyMeta(id) { const m = await db.kvGet(KEY + id).catch(() => null); return m && m.v === PROXY_V ? m : null; }
/** The proxy as a File/Blob, or null when there is none (or it went missing). */
export async function proxyFile(id) {
  const m = await proxyMeta(id); if (!m) return null;
  try {
    if (m.where === 'opfs') { const f = await (await (await dir()).getFileHandle(m.name)).getFile(); return f.size === m.size ? f : null; }
    return m.blob && m.blob.size === m.size ? m.blob : null;
  } catch { return null; }
}
export async function deleteProxy(id) {
  const m = await db.kvGet(KEY + id).catch(() => null);
  if (m && m.where === 'opfs' && opfsOK()) { try { await (await dir()).removeEntry(m.name); } catch { /* gone */ } }
  await db.kvDel(KEY + id).catch(() => { });
}
/** Remove proxy files whose media is gone (or that belong to an older recipe). keepIds: media ids still stored. */
export async function cleanupProxies(keepIds) {
  if (!opfsOK()) return 0;
  let n = 0;
  try {
    const d = await dir(), keep = new Set(keepIds || []);
    for await (const [name] of d.entries()) {
      const m = /^(.+)-v(\d+)\.mp4(\.part)?$/.exec(name);
      if (!m || !keep.has(m[1]) || +m[2] !== PROXY_V || m[3]) { await d.removeEntry(name).catch(() => { }); n++; }
    }
  } catch { /* no OPFS */ }
  return n;
}

export class ProxyCancelled extends Error { constructor() { super('Proxy cancelled'); this.name = 'ProxyCancelled'; } }

/**
 * Make the proxy for a media record. onProgress(0..1). Resolves { width, height, size, ms, where } and stores it; throws
 * ProxyCancelled on cancel, or an Error with a plain-language message when this browser can't make one.
 */
export async function makeProxy(rec, { signal, onProgress } = {}) {
  if (!rec || !rec.blob) throw new Error('The original file is not on this device.');
  const mb = await loadMediabunny();
  const t0 = performance.now();
  const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('This file has no picture to make a proxy of.');
  const sw = vt.displayWidth || rec.width, sh = vt.displayHeight || rec.height, d = proxyDims(sw, sh);
  const fps = rec.fps || 30;
  const useOPFS = opfsOK();
  if (!useOPFS && proxyEstimate(rec) > MEM_LIMIT) throw new Error('This browser can’t write a proxy this big to disk (it would be about ' + Math.round(proxyEstimate(rec) / 1048576) + ' MB in memory).');
  let writable = null, name = fileName(rec.id), dh = null;
  if (useOPFS) { dh = await dir(); const fh = await dh.getFileHandle(name + '.part', { create: true }); writable = await fh.createWritable(); }
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: useOPFS ? false : 'in-memory' }),
    target: useOPFS ? new mb.StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) : new mb.BufferTarget(),
  });
  // the sound is copied as it is when MP4 can hold it (no re-encoding, identical sound); otherwise it becomes Opus
  const video = { width: d.width, height: d.height, fit: 'fill', codec: 'avc', bitrate: proxyBitrate(d.width, d.height, fps), keyFrameInterval: KEY_INTERVAL, forceTranscode: true };
  let conv = await mb.Conversion.init({ input, output, video });
  if (conv.isValid && (conv.discardedTracks || []).some(x => x.track && x.track.type === 'audio')) {
    conv = await mb.Conversion.init({ input, output, video, audio: { codec: 'opus', bitrate: 96000 } });
  }
  if (!conv.isValid) {
    try { writable && await writable.abort(); } catch { /* */ }
    const why = (conv.discardedTracks || []).map(x => x.reason).join(', ');
    throw new Error('This browser can’t make a proxy of this file' + (why ? ' (' + why + ')' : '') + '.');
  }
  const abort = () => conv.cancel().catch(() => { });
  if (signal) { if (signal.aborted) abort(); signal.addEventListener('abort', abort, { once: true }); }
  conv.onProgress = (f) => onProgress && onProgress(Math.min(0.99, f));
  try {
    await conv.execute();
  } catch (e) {
    try { writable && await writable.abort(); } catch { /* */ }
    if (dh) await dh.removeEntry(name + '.part').catch(() => { });
    if ((signal && signal.aborted) || (e && /cancel/i.test(e.name + ' ' + e.message))) throw new ProxyCancelled();
    throw e;
  } finally { if (signal) signal.removeEventListener('abort', abort); try { input.dispose && input.dispose(); } catch { /* */ } }
  let meta;
  if (useOPFS) {
    // the stream was closed by the muxer; rename .part → final by copying the handle (move() where available)
    const part = await dh.getFileHandle(name + '.part');
    if (part.move) await part.move(name);
    else { const f = await part.getFile(); const fh = await dh.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(f); await w.close(); await dh.removeEntry(name + '.part'); }
    const f = await (await dh.getFileHandle(name)).getFile();
    meta = { v: PROXY_V, where: 'opfs', name, size: f.size };
  } else {
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    meta = { v: PROXY_V, where: 'idb', blob, size: blob.size };
  }
  Object.assign(meta, { width: d.width, height: d.height, ms: Math.round(performance.now() - t0), srcSize: rec.blob.size, created: Date.now() });
  await db.kvSet(KEY + rec.id, meta);
  onProgress && onProgress(1);
  const { blob: _b, ...pub } = meta; void _b;
  return pub;
}
