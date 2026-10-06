// Clean voice: make a cleaner copy of a file's sound on this device (nothing is uploaded).
//   Light  = RNNoise (ships with the app, ~110 KB, works offline from the first use)
//   Strong = DPDFNet neural network (about 21 MB, downloaded once on request, then kept for offline use)
// The cleaned sound is stored as a derived audio file (mono, 48 kHz, Opus/AAC) next to the original, which is never changed.
// The file is read, cleaned and written in 10-second pieces, so an hour-long recording needs only a few MB of memory.
import { loadMediabunny } from './media.js';
import { SourceReader } from './audio.js';
import { Resampler, SR } from './clean-dsp.js';
import { db } from './db.js';
import { cleanId, CLEAN_VERSION, changeId, changeKey, normChange, changeIsOn, CHANGE_VERSION } from './model.js';
import { yieldToMain } from './util.js';

export class CleanCancelled extends Error { constructor() { super('Cleaning cancelled'); this.name = 'CleanCancelled'; } }
export class CleanError extends Error { constructor(code, msg) { super(msg); this.name = 'CleanError'; this.code = code; } }

export const AI_CACHE = 'video-editor-ai'; // the service worker keeps this cache across app updates
const STRONG_DIR = new URL('../vendor/clean-strong/', import.meta.url).href;
/** The files of the Strong engine and their real sizes in bytes (the download is ~21 MB, fetched only when the user agrees). */
export const STRONG_FILES = [
  { key: 'model', name: 'dpdfnet2_48khz_hr.onnx', bytes: 10596848, type: 'application/octet-stream' },
  { key: 'wasm', name: 'ort-wasm-simd-threaded.wasm', bytes: 11210254, type: 'application/wasm' },
  { key: 'mjs', name: 'ort-wasm-simd-threaded.mjs', bytes: 20856, type: 'text/javascript' },
  { key: 'ort', name: 'ort.wasm.min.mjs', bytes: 48259, type: 'text/javascript' },
  { key: 'init', name: 'dpdfnet2_48khz_hr.init.json', bytes: 7242, type: 'application/json' },
];
export const STRONG_BYTES = STRONG_FILES.reduce((a, f) => a + f.bytes, 0);
export const STRONG_MB = Math.round(STRONG_BYTES / 1048576);
const fileUrl = (f) => STRONG_DIR + f.name;

/** Test seam: `hooks.engine` may return { init, push, finish, close } instead of the real worker. */
export const hooks = { engine: null };

const hasCaches = () => typeof caches !== 'undefined';
/** Are the Strong engine files stored on this device? */
export async function strongReady() {
  try {
    if (!hasCaches() || !(await caches.has(AI_CACHE))) return false;
    const c = await caches.open(AI_CACHE);
    for (const f of STRONG_FILES) if (!(await c.match(fileUrl(f), { ignoreSearch: true }))) return false;
    return true;
  } catch { return false; }
}
/** Download the Strong engine once (with progress) and keep it for offline use. onProgress({ loaded, total, file }). */
export async function downloadStrong({ onProgress, signal } = {}) {
  if (!hasCaches()) throw new CleanError('nocache', 'This browser cannot keep downloaded files, so the Strong engine is not available here.');
  const c = await caches.open(AI_CACHE);
  let done = 0;
  for (const f of STRONG_FILES) {
    if (await c.match(fileUrl(f), { ignoreSearch: true })) { done += f.bytes; onProgress && onProgress({ loaded: done, total: STRONG_BYTES, file: f.name }); continue; }
    let res;
    try { res = await fetch(fileUrl(f), { signal, cache: 'no-cache' }); } catch (e) { if (signal && signal.aborted) throw new CleanCancelled(); throw new CleanError('offline', 'The download did not start. Check the internet connection and try again.'); }
    if (!res.ok || !res.body) throw new CleanError('download', 'The download failed (' + res.status + '). Try again later.');
    const parts = []; let got = 0; const rd = res.body.getReader();
    for (;;) {
      let r;
      try { r = await rd.read(); } catch (e) { if (signal && signal.aborted) throw new CleanCancelled(); throw new CleanError('offline', 'The download was interrupted. Try again; it continues with the files already saved.'); }
      if (r.done) break;
      parts.push(r.value); got += r.value.length;
      onProgress && onProgress({ loaded: done + Math.min(got, f.bytes), total: STRONG_BYTES, file: f.name });
    }
    const blob = new Blob(parts, { type: f.type });
    if (blob.size !== f.bytes) throw new CleanError('download', 'The download was incomplete. Try again.'); // never keep a truncated file
    await c.put(fileUrl(f), new Response(blob, { headers: { 'content-type': f.type, 'content-length': String(blob.size) } }));
    done += f.bytes;
  }
  onProgress && onProgress({ loaded: STRONG_BYTES, total: STRONG_BYTES, file: '' });
}
/** Delete the downloaded Strong engine (frees ~21 MB). */
export async function removeStrong() {
  try { if (!hasCaches()) return false; const c = await caches.open(AI_CACHE); let any = false; for (const f of STRONG_FILES) any = (await c.delete(fileUrl(f), { ignoreSearch: true })) || any; return any; } catch { return false; }
}
async function strongUrls() {
  const c = await caches.open(AI_CACHE), out = {}, made = [];
  for (const f of STRONG_FILES) {
    const r = await c.match(fileUrl(f), { ignoreSearch: true });
    if (!r) throw new CleanError('missing', 'The Strong engine is not downloaded yet.');
    const u = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: f.type })); out[f.key] = u; made.push(u);
  }
  out.revoke = () => made.forEach(u => URL.revokeObjectURL(u));
  return out;
}

/** The engine behind a worker: promise-based push/finish with a message queue. */
class WorkerEngine {
  constructor() {
    this.w = new Worker(new URL('./clean-worker.js', import.meta.url), { type: 'module' });
    this.waiting = new Map(); this.seq = 0; this.ready = null;
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready' && this.ready) { this.ready.res(); this.ready = null; }
      else if (m.type === 'out') { const p = this.waiting.get(m.id); if (p) { this.waiting.delete(m.id); p.res(m.samples); } }
      else if (m.type === 'error') { const p = this.waiting.get(m.id) || this.ready; if (p) { this.waiting.delete(m.id); if (p === this.ready) this.ready = null; p.rej(new Error(m.message)); } }
    };
    this.w.onerror = (e) => { const err = new Error('The cleaning engine could not start' + (e && e.message ? ': ' + e.message : '.')); if (this.ready) this.ready.rej(err); for (const p of this.waiting.values()) p.rej(err); this.waiting.clear(); };
  }
  init(level, strong, params) { return new Promise((res, rej) => { this.ready = { res, rej }; this.w.postMessage({ type: 'init', level, params: params || null, strong: strong ? { ort: strong.ort, mjs: strong.mjs, wasm: strong.wasm, model: strong.model, init: strong.init } : null }); }); }
  _call(msg, transfer) { return new Promise((res, rej) => { const id = ++this.seq; this.waiting.set(id, { res, rej }); this.w.postMessage({ ...msg, id }, transfer || []); }); }
  push(samples) { return this._call({ type: 'push', samples }, [samples.buffer]); }
  finish() { return this._call({ type: 'finish' }); }
  close() { try { this.w.terminate(); } catch { /* ignore */ } for (const p of this.waiting.values()) p.rej(new CleanCancelled()); this.waiting.clear(); }
}

/** Which container to store the cleaned copy in: AAC (m4a) or Opus where the browser can write them, else WAV (short files only). */
export async function pickStore(mb) {
  const can = (codec, bitrate) => mb.canEncodeAudio(codec, { numberOfChannels: 1, sampleRate: SR, bitrate }).catch(() => false);
  if (await can('aac', 96000)) return { fmt: 'm4a', codec: 'aac', bitrate: 96000, ext: 'm4a', mime: 'audio/mp4' };
  if (await can('opus', 64000)) return { fmt: 'opus', codec: 'opus', bitrate: 64000, ext: 'ogg', mime: 'audio/ogg' };
  return { fmt: 'wav', codec: 'pcm-s16', ext: 'wav', mime: 'audio/wav' };
}
export const WAV_MAX_SEC = 20 * 60; // without a compressing encoder a 48 kHz WAV is ~5.5 MB per minute: only short files

const SRC_CHUNK_SEC = 10;
/**
 * Clean the sound of one media file and store the result as the derived media `cleanId(mediaId, level)`.
 * options: { level: 'light'|'strong', onProgress({ frac, etaSec, phase }), signal }
 * Resolves the stored record. Throws CleanCancelled / CleanError (codes: noaudio, unreadable, toolong, failed, missing, ...).
 */
export async function cleanMedia(media, mediaId, { level = 'light', onProgress, signal, fallbackDur } = {}) {
  if (level !== 'light' && level !== 'strong') throw new CleanError('level', 'Unknown level.');
  return derive(media, mediaId, { engine: level, id: cleanId(mediaId, level), meta: { cleanOf: mediaId, cleanLevel: level, cleanV: CLEAN_VERSION }, label: 'Clean voice', onProgress, signal, fallbackDur });
}
/**
 * Change voice: make the changed-voice copy `changeId(mediaId, clean, params)` of a media file. Clean voice comes first: when `clean` is
 * 'light' / 'strong' its cleaned copy must already be stored and is the input. params: { pitch, tone, radio }.
 */
export async function changeMedia(media, mediaId, { clean = 'off', params, onProgress, signal, fallbackDur } = {}) {
  if (!changeIsOn(params)) throw new CleanError('level', 'Nothing to change.');
  const p = normChange(params), src = clean === 'off' ? mediaId : cleanId(mediaId, clean);
  if (clean !== 'off' && !(await hasCleaned(media, mediaId, clean))) throw new CleanError('needclean', 'Apply Clean voice first (“Clean now”), then Change voice.');
  return derive(media, src, { engine: 'voice', params: p, id: changeId(mediaId, clean, p), meta: { changeOf: mediaId, changeKey: changeKey(p), changeV: CHANGE_VERSION, cleanLevel: clean === 'off' ? undefined : clean }, label: 'Change voice', onProgress, signal, fallbackDur });
}
/** A usable stored duration: finite and > 0 (MediaRecorder WebM reports NaN / Infinity until it has been scanned). */
const knownDur = (d) => (Number.isFinite(d) && d > 0 ? d : 0);
async function derive(media, mediaId, { engine, params, id, meta, label, onProgress, signal, fallbackDur }) {
  const level = engine;
  if (signal && signal.aborted) throw new CleanCancelled();
  const rec = await media.get(mediaId);
  if (!rec || !rec.blob) throw new CleanError('missing', 'The original file is not on this device.');
  const mb = await loadMediabunny();
  const store = await pickStore(mb);
  let dur = knownDur(rec.duration);
  if (store.fmt === 'wav' && dur > WAV_MAX_SEC) throw new CleanError('toolong', 'This browser cannot store a processed copy of a recording this long (it has no audio encoder).');
  let eng = null, strong = null, reader = null, output = null;
  const cleanup = async (ok) => {
    try { eng && eng.close && eng.close(); } catch { /* ignore */ }
    try { strong && strong.revoke(); } catch { /* ignore */ }
    try { reader && reader.close(); } catch { /* ignore */ }
    if (!ok) { try { output && await output.cancel(); } catch { /* ignore */ } }
  };
  const onAbort = () => { try { eng && eng.close(); } catch { /* ignore */ } };
  signal && signal.addEventListener('abort', onAbort);
  const t0 = performance.now();
  try {
    onProgress && onProgress({ frac: 0, etaSec: null, phase: 'starting' });
    if (level === 'strong') { if (!hooks.engine) strong = await strongUrls(); }
    eng = hooks.engine ? hooks.engine() : new WorkerEngine();
    await eng.init(engine, strong, params);
    if (signal && signal.aborted) throw new CleanCancelled();
    try { reader = await new SourceReader(rec.blob, rec.name, rec.duration).open(); }
    catch (e) { if (e.noAudio) throw new CleanError('noaudio', 'This file has no sound to clean.'); throw new CleanError('unreadable', 'This browser cannot read the sound of this file (' + (e.message || 'unknown format') + ').'); }
    if (!dur) { // unknown length: find the real one (and remember it), else use how much of it the timeline uses
      dur = knownDur(await reader.realDuration());
      if (dur) { rec.duration = dur; db.updateMediaMeta(mediaId, { duration: dur }).catch(() => { }); }
      else { dur = knownDur(typeof fallbackDur === 'function' ? fallbackDur() : fallbackDur); } // the processed copy then covers what the timeline plays
      if (!dur) throw new CleanError('unreadable', 'This browser cannot tell how long this file is.');
      if (store.fmt === 'wav' && dur > WAV_MAX_SEC) throw new CleanError('toolong', 'This browser cannot store a processed copy of a recording this long (it has no audio encoder).');
    }
    const sr = reader.sr, step = Math.round(SRC_CHUNK_SEC * sr);
    let nSrc = Math.max(1, Math.round(dur * sr));
    const rs = new Resampler(sr, SR);
    output = new mb.Output({
      format: store.fmt === 'wav' ? new mb.WavOutputFormat() : store.fmt === 'opus' ? new mb.OggOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new mb.BufferTarget(),
    });
    const src = new mb.AudioBufferSource(store.fmt === 'wav' ? { codec: store.codec } : { codec: store.codec, bitrate: store.bitrate });
    output.addAudioTrack(src);
    await output.start();
    let written = 0, srcDone = 0;
    const write = async (f32) => {
      if (!f32 || !f32.length) return;
      const ab = new AudioBuffer({ length: f32.length, numberOfChannels: 1, sampleRate: SR });
      ab.copyToChannel(f32, 0); await src.add(ab); written += f32.length;
    };
    const report = () => { const frac = Math.min(0.99, srcDone / nSrc), el = (performance.now() - t0) / 1000; onProgress && onProgress({ frac, etaSec: frac > 0.02 ? el * (1 - frac) / frac : null, phase: 'processing' }); };
    let inflight = null;
    const settle = async () => { if (inflight) { const out = await inflight; inflight = null; await write(out); } };
    for (let s0 = 0; s0 < nSrc; s0 += step) {
      if (signal && signal.aborted) throw new CleanCancelled();
      const n = Math.min(step, nSrc - s0), ch = await reader.read(s0, n);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) { let a = 0; for (let c = 0; c < ch.length; c++) a += ch[c][i]; mono[i] = a / ch.length; }
      const piece = rs.push(mono);
      await settle();
      if (piece.length) inflight = eng.push(Float32Array.from(piece));
      srcDone = s0 + n; report();
      await yieldToMain();
    }
    await settle();
    const tail = rs.finish();
    if (tail.length) await write(await eng.push(Float32Array.from(tail)));
    await write(await eng.finish());
    if (signal && signal.aborted) throw new CleanCancelled();
    src.close(); await output.finalize();
    const blob = new Blob([output.target.buffer], { type: store.mime });
    if (!blob.size) throw new CleanError('failed', 'No sound was produced.');
    const out = { id, kind: 'audio', name: label + ' · ' + String(rec.name || 'audio').replace(/^(Clean|Change) voice · /, ''), type: store.mime, size: blob.size, created: Date.now(), blob, duration: written / SR, hasAudio: true, ...meta };
    await db.putMedia(out);
    media.forget(id); media.recs.set(id, (await db.getMedia(id)) || out);
    onProgress && onProgress({ frac: 1, etaSec: 0, phase: 'done' });
    await cleanup(true);
    return media.recs.get(id);
  } catch (e) {
    await cleanup(false);
    if (e instanceof CleanCancelled || e instanceof CleanError) throw e;
    if (signal && signal.aborted) throw new CleanCancelled();
    throw new CleanError('failed', 'Could not clean this sound: ' + ((e && e.message) || e));
  } finally { signal && signal.removeEventListener('abort', onAbort); }
}

/** Is there a stored cleaned copy of this media at this level (and of the current version)? */
export async function hasCleaned(media, mediaId, level) {
  if (level !== 'light' && level !== 'strong') return false;
  const r = await media.get(cleanId(mediaId, level)).catch(() => null);
  return !!(r && r.blob && r.cleanV === CLEAN_VERSION);
}
/** Delete the cleaned copies of a media file (both levels). */
export async function deleteCleaned(media, mediaId) {
  for (const level of ['light', 'strong']) { const id = cleanId(mediaId, level); media.forget(id); await db.deleteMedia(id).catch(() => { }); }
}

/** Is there a stored changed-voice copy for this media / Clean voice level / settings? */
export async function hasChanged(media, mediaId, clean, params) {
  if (!changeIsOn(params)) return false;
  const r = await media.get(changeId(mediaId, clean, params)).catch(() => null);
  return !!(r && r.blob && r.changeV === CHANGE_VERSION);
}
