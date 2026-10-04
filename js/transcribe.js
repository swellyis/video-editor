// On-device speech-to-text (Whisper via the vendored transformers.js, in a Web Worker). Nothing is uploaded: the model files
// come from Hugging Face once, are kept in Cache Storage, and after that it works offline.
import { layout } from './model.js';
import { applyCustomWords, parseCustomWords, chunkWords } from './captions.js';
import { frameDb, noiseFloor, speechRegions } from './vad.js';
import { splitLong, Packer, jobAudio, mapWords, jobTail, spreadWords, JOB_MAX } from './asr-plan.js';

export const SR = 16000;
export const WINDOW_SEC = 30;
const FRAME = 0.02;        // seconds per loudness frame for the speech finder
export const GPU_KEY = 've-asr-gpu'; // 'off' = never try the GPU, 'bad' = it failed once on this device
export const CACHE_NAME = 'transformers-cache'; // transformers.js' own browser cache

/** Model choices. Sizes are the real quantised downloads (encoder + decoder + tokenizer), rounded. */
export const MODELS = {
  fast: { label: 'Fast', note: 'Whisper tiny', mb: 45, en: 'Xenova/whisper-tiny.en', multi: 'Xenova/whisper-tiny' },
  better: { label: 'Better', note: 'Whisper base', mb: 81, en: 'Xenova/whisper-base.en', multi: 'Xenova/whisper-base' },
};
export const RUNTIME_MB = 22; // the WebAssembly runtime, fetched once from this site (cached by the service worker)
export const LANGUAGES = [
  ['english', 'English'], ['auto', 'Auto-detect (slower to load)'], ['spanish', 'Spanish'], ['portuguese', 'Portuguese'], ['french', 'French'],
  ['german', 'German'], ['italian', 'Italian'], ['dutch', 'Dutch'], ['polish', 'Polish'], ['russian', 'Russian'], ['ukrainian', 'Ukrainian'],
  ['korean', 'Korean'], ['chinese', 'Chinese'], ['japanese', 'Japanese'], ['hindi', 'Hindi'], ['arabic', 'Arabic'], ['indonesian', 'Indonesian'],
  ['swahili', 'Swahili'], ['tagalog', 'Tagalog'], ['turkish', 'Turkish'],
];
export const repoFor = (model, language) => { const m = MODELS[model] || MODELS.fast; return !language || language === 'english' ? m.en : m.multi; };
export class TranscribeCancelled extends Error { constructor() { super('Transcription cancelled'); this.name = 'TranscribeCancelled'; } }

/** Test seam: set `hooks.engine` to a factory returning an object with load/run/terminate to avoid the real model. */
export const hooks = { engine: null };

/** Is this model already in the browser cache (so no download is needed)? */
export async function isModelCached(repo) {
  try {
    if (!('caches' in self) || !(await caches.has(CACHE_NAME))) return false;
    const c = await caches.open(CACHE_NAME);
    return (await c.keys()).some(r => r.url.includes('/' + repo + '/resolve/') && /decoder_model_merged_quantized/.test(r.url));
  } catch { return false; }
}
/** Is any speech model downloaded? */
export async function anyModelCached() { for (const m of Object.values(MODELS)) for (const r of [m.en, m.multi]) if (await isModelCached(r)) return true; return false; }
/** Forget the downloaded models (frees ~45–160 MB). */
export async function clearModels() { try { return await caches.delete(CACHE_NAME); } catch { return false; } }

/** The Web Worker engine. */
class WorkerEngine {
  constructor() {
    this.w = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map(); this.seq = 0; this.onProg = null; this.readyP = null; this.device = 'wasm'; this.dead = false;
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (this.beat) this.beat();
      if (m.type === 'progress') this.onProg && this.onProg(m);
      else if (m.type === 'ready') { this.device = m.device || 'wasm'; this.readyP && this.readyP.res(m); }
      else if (m.type === 'error') { const p = this.pending.get(m.id) || this.readyP; if (p) { this.pending.delete(m.id); p.rej(new Error(m.message)); } }
      else if (m.type === 'result') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.res(m); } }
    };
    this.w.onerror = (e) => { const err = new Error('The speech engine could not start' + (e && e.message ? ': ' + e.message : '.')); if (this.readyP) this.readyP.rej(err); for (const p of this.pending.values()) p.rej(err); this.pending.clear(); };
  }
  /** device 'webgpu' is attempted by the worker and falls back to 'wasm' by itself; a silent worker (no message for 45 s) is given up on. */
  load(repo, onProgress, { device = 'wasm' } = {}) {
    this.onProg = onProgress;
    return new Promise((res, rej) => {
      let timer = null; const arm = () => { if (device !== 'webgpu' && device !== 'webgpu!') return; clearTimeout(timer); timer = setTimeout(() => rej(new Error('The GPU did not answer')), 45000); };
      this.beat = arm; arm();
      this.readyP = { res: (m) => { clearTimeout(timer); this.beat = null; res(m); }, rej: (e) => { clearTimeout(timer); this.beat = null; rej(e); } };
      this.w.postMessage({ type: 'load', repo, device: device === 'webgpu!' ? 'webgpu' : device, force: device === 'webgpu!' });
    });
  }
  run(audio, language) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.w.postMessage({ type: 'run', id, audio, language }, [audio.buffer]); });
  }
  terminate() { this.dead = true; this.w.terminate(); }
}
export const createEngine = () => (hooks.engine ? hooks.engine() : new WorkerEngine());

/** How many leading words have believable timings (three words inside 30 ms of each other, or time running backwards, is a collapse). */
export function trustedCount(ws) {
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].start < ws[i - 1].start - 0.05) return i;
    if (i + 1 < ws.length && ws[i + 1].start - ws[i - 1].start < 0.03) return i - 1;
  }
  return ws.length;
}
/** Evenly re-time words (weighted by length) over [a, b]. */
export function spread(ws, a, b) {
  const tot = ws.reduce((n, w) => n + w.w.length + 1, 0), span = Math.max(0.2, b - a); let at = a;
  return ws.map(w => { const d = span * (w.w.length + 1) / tot; const o = { w: w.w, start: at, end: at + d }; at += d; return o; });
}
/** A few repeated-word loops are the classic Whisper failure on noise; keep at most three of a run. */
export function dropLoops(words) {
  const out = []; let run = 0;
  for (const w of words) {
    const prev = out[out.length - 1];
    run = prev && prev.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === w.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ? run + 1 : 0;
    if (run < 3) out.push(w);
  }
  return out;
}

/** 16 kHz mono Float32 chunks of the timeline's spoken audio (clip sound, overlay sound, voice and detached tracks; not music), streamed. */
async function* speechChunks(project, media, from) {
  const { mixChunks } = await import('./audio.js'); // (loaded only when transcribing: it pulls in the media decoders)
  const proj = { ...project, audio: (project.audio || []).filter(a => a.voice) };
  const lay = layout(proj);
  let t = Math.floor(from / WINDOW_SEC) * WINDOW_SEC;
  for await (const b of mixChunks(proj, lay, media, { sampleRate: SR, chunkSec: WINDOW_SEC, from })) {
    const n = b.length, a = b.getChannelData(0), out = new Float32Array(n);
    if (b.numberOfChannels > 1) { const c = b.getChannelData(1); for (let i = 0; i < n; i++) out[i] = (a[i] + c[i]) / 2; } else out.set(a);
    yield { t, data: out };
    t += n / SR;
  }
}

/** Which device to try first: the GPU only where the browser offers WebGPU and it has not failed here before. */
export function pickDevice(pref) {
  let stored = null; try { stored = localStorage.getItem(GPU_KEY); } catch { /* optional */ }
  if (pref === 'webgpu!') return 'webgpu!'; // (tests only: run the GPU path even on a software adapter)
  if (pref === 'wasm' || stored === 'off' || stored === 'bad') return 'wasm';
  if (pref === 'webgpu' || (typeof navigator !== 'undefined' && navigator.gpu)) return typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
  return 'wasm';
}
/** How many engines may work at once: each is a full copy of the model (about 150–250 MB), so phones get two at most. */
export function workerCount(want, { cores = 4, mem = 4, phone = false } = {}) {
  if (want) return Math.max(1, Math.min(6, want | 0));
  const byCpu = Math.floor(cores / 2), byMem = mem >= 8 ? 4 : mem >= 4 ? 3 : 1;
  return Math.max(1, Math.min(byCpu, byMem, phone ? 2 : 4));
}
const hw = () => ({ cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, mem: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4, phone: typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches });

/**
 * Transcribe the project's speech. Returns word timings in TIMELINE time, so clip trims, speed changes, multiple clips and gaps
 * are already accounted for.
 *
 * How it is fast: the audio is mixed once at 16 kHz (streamed), the loud parts are found (speech finder), quiet stretches are never
 * transcribed, and the speech is packed into windows of up to 29 s (the engine always spends a whole 30 s window, so full windows
 * are the cheapest way). Windows are decoded by up to a few engines in parallel (Web Workers), the GPU (WebGPU) is used where the
 * browser has it. The words are mapped back to the timeline and returned in the same format as before.
 *   range: { start, end } limits it to part of the timeline (e.g. one selected clip).
 *   onProgress({ phase: 'download'|'load'|'transcribe', frac, etaSec, doneSec, totalSec, device, workers, bytes, totalBytes })
 *   stats (optional object) receives { device, workers, jobs, speechSec, skippedSec, retries } for tests and the log.
 */
export async function transcribe({ project, media, range, language = 'english', model = 'fast', custom = '', onProgress = () => { }, signal, setEngine, workers, device: devicePref, stats = {} }) {
  const repo = repoFor(model, language);
  const total = layout(project).total;
  const t0 = Math.max(0, range ? range.start : 0), t1 = Math.min(total, range ? range.end : total);
  if (!(t1 - t0 > 0.2)) throw new Error('There is nothing to transcribe here.');
  const engines = []; if (setEngine) setEngine({ terminate() { for (const e of engines) { try { e.terminate(); } catch { /* gone */ } } } });
  const guard = () => { if (signal && signal.aborted) throw new TranscribeCancelled(); };
  // a cancel must release whatever is awaiting the worker (a terminated worker never answers)
  const abortP = new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(new TranscribeCancelled()), { once: true }); }); abortP.catch(() => { });
  const race = (p) => Promise.race([p, abortP]);
  const N = hooks.engine ? Math.max(1, workers || 1) : workerCount(workers, hw());
  Object.assign(stats, { workers: 1, maxWorkers: N, jobs: 0, speechSec: 0, skippedSec: 0, retries: 0, device: 'wasm' });
  try {
    // 1) the first engine: model download (first time only) + load
    const files = new Map(); const expected = (MODELS[model] || MODELS.fast).mb * 1048576;
    const onDl = (m) => {
      if (m.file && m.total) files.set(m.file, [m.loaded, m.total]);
      let loaded = 0; for (const [l] of files.values()) loaded += l;
      onProgress({ phase: 'download', frac: Math.min(0.99, loaded / expected), bytes: loaded, totalBytes: expected });
    };
    const startEngine = async (dev, report) => {
      const e = createEngine(); engines.push(e);
      try { await race(e.load(repo, report ? onDl : null, { device: dev })); }
      catch (err) { engines.splice(engines.indexOf(e), 1); try { e.terminate(); } catch { /* gone */ } throw err; }
      return e;
    };
    onProgress({ phase: 'download', frac: 0 });
    let dev = hooks.engine ? 'wasm' : pickDevice(devicePref), first;
    try { first = await startEngine(dev, true); }
    catch (err) {
      if (err instanceof TranscribeCancelled || (dev !== 'webgpu' && dev !== 'webgpu!')) throw err;
      try { localStorage.setItem(GPU_KEY, 'bad'); } catch { /* optional */ }
      dev = 'wasm'; first = await startEngine('wasm', true);
    }
    guard();
    stats.device = first.device || 'wasm';
    onProgress({ phase: 'load', frac: 1 });

    // 2) engine pool: idle engines wait for a job; more engines are started while there is work queued
    const idle = [first]; let growing = false; const waiters = [];
    const freed = () => { const w = waiters.shift(); if (w) w(); };
    const grow = async () => {
      if (growing || engines.length >= N) return; growing = true;
      try { const e = await startEngine(first.device === 'webgpu' ? dev : 'wasm', false); stats.workers = engines.length; idle.push(e); freed(); }
      catch (err) { if (err instanceof TranscribeCancelled) errors.push(err); stats.maxWorkers = engines.length; /* fewer engines is fine */ }
      growing = false;
    };
    const takeEngine = async () => { for (;;) { guard(); if (errors.length) throw errors[0]; if (idle.length) return idle.pop(); await race(new Promise(r => waiters.push(r))); } };
    const release = (e) => { idle.push(e); freed(); };

    // 3) jobs: each is transcribed by whichever engine is free; the words are mapped back to the timeline
    const all = [], errors = [], inflight = new Set(); let doneW = 0, jobsDone = 0, scheduledEnd = t0, allScheduled = false;
    const started = performance.now();
    const report = () => {
      const el = (performance.now() - started) / 1000, frac = allScheduled && jobsDone >= stats.jobs ? 1 : clamp01(doneW / Math.max(1e-6, t1 - t0));
      onProgress({ phase: 'transcribe', frac, doneSec: frac * (t1 - t0), totalSec: t1 - t0, etaSec: frac >= 1 ? 0 : frac > 0.03 ? el * (1 - frac) / frac : null, device: stats.device, workers: stats.workers });
    };
    const runJob = async (job, weight) => {
      let eng = await takeEngine(), tail = null;
      let res;
      try { res = await race(eng.run(jobAudio(job, SR), language)); }
      catch (err) {
        if (err instanceof TranscribeCancelled || eng.device !== 'webgpu') throw err;
        // the GPU failed while working: remember it, finish this and the rest on the CPU
        try { localStorage.setItem(GPU_KEY, 'bad'); } catch { /* optional */ }
        const i = engines.indexOf(eng); if (i >= 0) engines.splice(i, 1); try { eng.terminate(); } catch { /* gone */ }
        eng = await startEngine('wasm', false); stats.device = 'wasm'; stats.retries++;
        res = await race(eng.run(jobAudio(job, SR), language));
      }
      guard();
      let ws = (res.words || []).map(w => ({ w: w.w, start: w.start, end: Math.max(w.end, w.start + 0.05) }));
      // Whisper's word alignment sometimes collapses (many words stamped with the same instant). Trust only the part before that
      // and listen again from there; if there is no usable part, spread those words over the job so the text is not lost.
      const good = trustedCount(ws);
      if (good < ws.length) {
        const lastGood = good ? ws[good - 1].end : 0;
        if (lastGood >= 1 && (job.tries || 0) < 3) { ws = ws.slice(0, good); tail = jobTail(job, lastGood, SR); if (tail) stats.retries++; }
        else ws = spreadWords(ws, 0, job.len);
      }
      all.push(...mapWords(job, ws));
      doneW += weight; release(eng);
      if (tail) { await runJob(tail, 0); return; }
      jobsDone++; report();
    };
    const submit = async (job) => {
      stats.jobs++; stats.speechSec += job.len;
      const end = job.segs[job.segs.length - 1].b, weight = Math.max(0.01, Math.min(end, t1) - scheduledEnd); scheduledEnd = Math.max(scheduledEnd, end);
      // do not read ahead faster than the engines can work
      while (inflight.size >= engines.length * 2 + 1) { await race(Promise.race([...inflight])); guard(); if (errors.length) throw errors[0]; }
      if (engines.length < N && inflight.size >= engines.length && !growing) grow();
      const p = runJob(job, weight).catch((e) => { errors.push(e); }).finally(() => inflight.delete(p)); inflight.add(p);
    };

    // 4) read the audio once (streamed) and cut it into jobs
    onProgress({ phase: 'transcribe', frac: 0, doneSec: 0, totalSec: t1 - t0, etaSec: null, device: stats.device, workers: 1 });
    const packer = new Packer(JOB_MAX);
    let buf = new Float32Array(0), bufStart = Math.floor(t0 / WINDOW_SEC) * WINDOW_SEC, streamDone = false, floor = null;
    const emit = async (regionList) => {
      for (const r of regionList) {
        const a = Math.max(r.a + bufStart, t0), b = Math.min(r.b + bufStart, t1); if (b - a < 0.15) continue;
        const i0 = Math.round((a - bufStart) * SR), i1 = Math.min(buf.length, Math.round((b - bufStart) * SR));
        for (const job of packer.add({ a, b, data: buf.slice(i0, i1) })) await submit(job);
      }
    };
    const it = speechChunks(project, media, t0)[Symbol.asyncIterator]();
    const readMore = async (seconds) => {
      const want = buf.length + seconds * SR;
      while (!streamDone && buf.length < want) {
        const r = await race(it.next()); guard(); if (errors.length) throw errors[0];
        if (r.done) { streamDone = true; break; }
        const nb = new Float32Array(buf.length + r.value.data.length); nb.set(buf); nb.set(r.value.data, buf.length); buf = nb;
      }
    };
    const MAXBUF = 150; // seconds read ahead when there is no break in the speech to cut at
    let more = 60;
    for (;;) {
      guard(); if (errors.length) throw errors[0];
      await readMore(more); more = 30;
      const db = frameDb(buf, Math.round(FRAME * SR)), est = noiseFloor(db); floor = floor == null ? est : 0.6 * floor + 0.4 * est;
      const regs = speechRegions(db, { frameSec: FRAME, floorDb: floor }), len = buf.length / SR;
      if (streamDone) { await emit(splitLong(regs, db, FRAME)); break; }
      const final = regs.filter(r => r.b < len - 2.5);       // followed by at least 2.5 s of audio: the speech really ended there
      let cutAt = 0;
      if (final.length) { await emit(splitLong(final, db, FRAME)); cutAt = final[final.length - 1].b + 0.1; }
      else if (len > MAXBUF && regs.length) {                   // a long unbroken run: send all but its last piece, which waits for more audio
        const parts = splitLong([{ a: regs[0].a, b: Math.min(regs[0].b, len) }], db, FRAME);
        if (parts.length > 1) { await emit(parts.slice(0, -1)); cutAt = parts[parts.length - 1].a; }
      }
      if (cutAt > 0) { const cut = Math.min(buf.length, Math.round(cutAt * SR)); buf = buf.slice(cut); bufStart += cut / SR; }
    }
    const lastJob = packer.flush(); if (lastJob) await submit(lastJob);
    allScheduled = true;
    while (inflight.size) { await race(Promise.race([...inflight])); guard(); }
    if (errors.length) throw errors[0];
    guard();
    stats.skippedSec = Math.max(0, (t1 - t0) - stats.speechSec);
    onProgress({ phase: 'transcribe', frac: 1, doneSec: t1 - t0, totalSec: t1 - t0, etaSec: 0, device: stats.device, workers: stats.workers });
    all.sort((x, y) => x.start - y.start);
    // words from two jobs can overlap in time at a boundary; keep them in order
    for (let i = 1; i < all.length; i++) if (all[i].start < all[i - 1].start) all[i].start = all[i - 1].start;
    const clean = dropLoops(all);
    const list = parseCustomWords(custom); if (list.length) applyCustomWords(clean, list);
    return clean;
  } finally { for (const e of engines) { try { e.terminate(); } catch { /* already gone */ } } }
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Words → caption lines for the style's words-per-caption. */
export const wordsToCaptions = (words, maxWords) => chunkWords(words, { maxWords });
