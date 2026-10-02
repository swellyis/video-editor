// On-device speech-to-text (Whisper via the vendored transformers.js, in a Web Worker). Nothing is uploaded: the model files
// come from Hugging Face once, are kept in Cache Storage, and after that it works offline.
import { layout } from './model.js';
import { applyCustomWords, parseCustomWords, chunkWords } from './captions.js';

export const SR = 16000;
export const WINDOW_SEC = 30;
const TAIL_SEC = 1.5;      // words ending in the last moments of a window are re-heard in the next one (cut-off words are unreliable)
const MIN_ADVANCE = 6;     // always move forward at least this many seconds per window
const SILENT_RMS = 0.003;  // below this a window is treated as silence (Whisper invents words from silence)
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
    this.pending = new Map(); this.seq = 0; this.onProg = null; this.readyP = null;
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') this.onProg && this.onProg(m);
      else if (m.type === 'ready') this.readyP && this.readyP.res(m);
      else if (m.type === 'error') { const p = this.pending.get(m.id) || this.readyP; if (p) { this.pending.delete(m.id); p.rej(new Error(m.message)); } }
      else if (m.type === 'result') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.res(m); } }
    };
    this.w.onerror = (e) => { const err = new Error('The speech engine could not start' + (e && e.message ? ': ' + e.message : '.')); if (this.readyP) this.readyP.rej(err); for (const p of this.pending.values()) p.rej(err); this.pending.clear(); };
  }
  load(repo, onProgress) {
    this.onProg = onProgress;
    return new Promise((res, rej) => { this.readyP = { res, rej }; this.w.postMessage({ type: 'load', repo }); });
  }
  run(audio, language) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.w.postMessage({ type: 'run', id, audio, language }, [audio.buffer]); });
  }
  terminate() { this.w.terminate(); }
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
const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, Math.ceil(a.length / 4))); };

/**
 * Transcribe the project's speech. Returns word timings in TIMELINE time, so clip trims, speed changes, multiple clips and gaps
 * are already accounted for. Windows are 30 s and each one resumes where the last reliable word ended.
 *   range: { start, end } limits it to part of the timeline (e.g. one selected clip).
 *   onProgress({ phase: 'download'|'load'|'transcribe', frac, etaSec, bytes, totalBytes })
 */
export async function transcribe({ project, media, range, language = 'english', model = 'fast', custom = '', onProgress = () => { }, signal, setEngine }) {
  const repo = repoFor(model, language);
  const total = layout(project).total;
  const t0 = Math.max(0, range ? range.start : 0), t1 = Math.min(total, range ? range.end : total);
  if (!(t1 - t0 > 0.2)) throw new Error('There is nothing to transcribe here.');
  const engine = createEngine(); if (setEngine) setEngine(engine);
  const guard = () => { if (signal && signal.aborted) throw new TranscribeCancelled(); };
  // a cancel must release whatever is awaiting the worker (a terminated worker never answers)
  const abortP = new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(new TranscribeCancelled()), { once: true }); }); abortP.catch(() => { });
  const race = (p) => Promise.race([p, abortP]);
  try {
    // 1) model: download (first time only) + load
    const files = new Map(); const expected = (MODELS[model] || MODELS.fast).mb * 1048576;
    onProgress({ phase: 'download', frac: 0 });
    await race(engine.load(repo, (m) => {
      if (m.file && m.total) files.set(m.file, [m.loaded, m.total]);
      let loaded = 0; for (const [l] of files.values()) loaded += l;
      onProgress({ phase: 'download', frac: Math.min(0.99, loaded / expected), bytes: loaded, totalBytes: expected });
    }));
    guard();
    onProgress({ phase: 'load', frac: 1 });
    // 2) stream the audio and transcribe it window by window
    const words = []; let pos = Math.round(t0 * SR); const endS = Math.round(t1 * SR);
    let buf = new Float32Array(0), bufStart = Math.floor(t0 / WINDOW_SEC) * WINDOW_SEC * SR;
    const it = speechChunks(project, media, t0)[Symbol.asyncIterator]();
    let streamDone = false;
    const fill = async (until) => {
      while (!streamDone && bufStart + buf.length < until) {
        const r = await race(it.next()); guard();
        if (r.done) { streamDone = true; break; }
        const nb = new Float32Array(buf.length + r.value.data.length); nb.set(buf); nb.set(r.value.data, buf.length); buf = nb;
      }
    };
    onProgress({ phase: 'transcribe', frac: 0, doneSec: 0, totalSec: t1 - t0, etaSec: null });
    const started = performance.now();
    let silent = 0;
    while (pos < endS - 0.4 * SR) {
      guard();
      const winEnd = Math.min(pos + WINDOW_SEC * SR, endS), last = winEnd >= endS;
      await fill(winEnd);
      const a = Math.max(0, pos - bufStart), b = Math.min(buf.length, winEnd - bufStart);
      let next = winEnd;
      if (b - a > 0.4 * SR && rms(buf.subarray(a, b)) >= SILENT_RMS) {
        const slice = buf.slice(a, b);
        const res = await race(engine.run(slice, language)); guard();
        let ws = (res.words || []).map(w => ({ w: w.w, start: pos / SR + w.start, end: pos / SR + Math.max(w.end, w.start + 0.05) }));
        // Whisper's word alignment sometimes collapses (many words stamped with the same instant). Trust only the part before that
        // and listen again from there; if there is no usable part, spread those words over the window so the text is not lost.
        const good = trustedCount(ws);
        let resume = false;
        if (good < ws.length) {
          const lastGood = good ? ws[good - 1].end : pos / SR;
          if (lastGood - pos / SR >= 1) { ws = ws.slice(0, good); next = Math.min(winEnd, Math.ceil(lastGood * SR)); resume = true; }
          else ws = spread(ws, pos / SR, winEnd / SR - (last ? 0 : TAIL_SEC));
        }
        if (resume) words.push(...ws);
        else if (last) words.push(...ws);
        else {
          const cut = winEnd / SR - TAIL_SEC, keep = ws.filter(w => w.end <= cut);
          if (keep.length) { words.push(...keep); next = Math.min(winEnd, Math.max(pos + MIN_ADVANCE * SR, Math.ceil(keep[keep.length - 1].end * SR))); }
          // (nothing reliable in the window: it was mostly noise, move on)
        }
      } else silent++;
      pos = next;
      // free what we no longer need
      const drop = Math.max(0, pos - bufStart - SR); if (drop > 0 && drop <= buf.length) { buf = buf.slice(drop); bufStart += drop; }
      const done = clamp01((pos - t0 * SR) / Math.max(1, endS - t0 * SR)), el = (performance.now() - started) / 1000;
      onProgress({ phase: 'transcribe', frac: done, doneSec: pos / SR - t0, totalSec: t1 - t0, etaSec: done > 0.02 ? el * (1 - done) / done : null });
    }
    onProgress({ phase: 'transcribe', frac: 1, doneSec: t1 - t0, totalSec: t1 - t0, etaSec: 0, silentWindows: silent });
    const clean = dropLoops(words);
    const list = parseCustomWords(custom); if (list.length) applyCustomWords(clean, list);
    return clean;
  } finally { try { engine.terminate(); } catch { /* already gone */ } }
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Words → caption lines for the style's words-per-caption. */
export const wordsToCaptions = (words, maxWords) => chunkWords(words, { maxWords });
