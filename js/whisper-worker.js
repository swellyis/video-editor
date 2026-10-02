// Speech-to-text worker: Whisper (tiny / base, 8-bit ONNX) through the vendored transformers.js + onnxruntime-web (WASM).
// Runs off the main thread so the editor stays responsive. Model files come from Hugging Face on first use and are kept in Cache Storage.
import { pipeline, env } from '../vendor/whisper/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/whisper/', import.meta.url).href;
env.backends.onnx.logLevel = 'error';

let asr = null, english = false;
const post = (m, t) => self.postMessage(m, t || []);

// CPU (WASM) only: a WebGPU path could not be verified on real hardware, and a hung GPU session would freeze the job.
async function load({ repo }) {
  english = /\.en$/.test(repo);
  const progress = (p) => { if (p && (p.status === 'progress' || p.status === 'download' || p.status === 'done' || p.status === 'initiate')) post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded || 0, total: p.total || 0 }); };
  asr = await pipeline('automatic-speech-recognition', repo, { device: 'wasm', dtype: 'q8', progress_callback: progress });
  return { device: 'wasm' };
}

async function run({ audio, language }) {
  const opts = { return_timestamps: 'word', chunk_length_s: 30 };
  if (!english) { opts.task = 'transcribe'; if (language && language !== 'auto') opts.language = language; }
  const out = await asr(audio, opts);
  const words = [];
  for (const c of out.chunks || []) {
    const w = String(c.text || '').trim(); if (!w) continue;
    const [s, e] = c.timestamp || [null, null];
    if (s == null) continue;
    words.push({ w, start: s, end: e == null ? s + 0.3 : e });
  }
  return { text: String(out.text || '').trim(), words };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'load') { const r = await load(m); post({ type: 'ready', device: r.device }); }
    else if (m.type === 'run') { const r = await run(m); post({ type: 'result', id: m.id, ...r }); }
  } catch (e) { post({ type: 'error', id: m.id, message: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 600) }); }
};
post({ type: 'boot' });
