// "Clean voice" worker: runs the speech cleaner off the main thread, one stream per file.
//   light  -> RNNoise (WebAssembly, ~110 KB, ships with the app, works offline at once)
//   strong -> DPDFNet (ONNX neural network) on onnxruntime-web (WebAssembly); its files are downloaded once on request
// Protocol: {type:'init', level, strong:{mjs, wasm, model, init}}  -> {type:'ready'}
//           {type:'push', id, samples}  -> {type:'out', id, samples}      (48 kHz mono; may be shorter or empty)
//           {type:'finish', id}         -> {type:'out', id, samples, done:true}
import { RnStream, DfStream } from './clean-dsp.js';

let stream = null, sess = null, ort = null, mod = null;
const post = (m, t) => self.postMessage(m, t || []);
const DRY = { light: 0.18, strong: 0 }; // share of the original sound kept in the result

async function init({ level, strong }) {
  if (stream && stream.close) stream.close();
  stream = null;
  if (level === 'strong') {
    if (!strong) throw new Error('The Strong model files are missing.');
    if (!ort) ort = await import(strong.ort);
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: strong.mjs, wasm: strong.wasm };
    const init = await (await fetch(strong.init)).json();
    if (!sess) sess = await ort.InferenceSession.create(new Uint8Array(await (await fetch(strong.model)).arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    const state0 = () => { const s = new Float32Array(init.stateSize); s.set(init.erbNorm, 0); s.set(init.specNorm, init.erbNorm.length); return s; };
    const shape = [1, 1, init.bins, 2];
    const model = {
      init: state0,
      run: async (spec, state) => {
        const out = await sess.run({ spec: new ort.Tensor('float32', spec, shape), state_in: new ort.Tensor('float32', state, [init.stateSize]) });
        return { spec: out.spec_e.data, state: out.state_out.data };
      },
    };
    stream = new DfStream(model, { dry: DRY.strong });
  } else {
    if (!mod) mod = await (await import('../vendor/clean/rnnoise.js')).default({ locateFile: (f) => new URL('../vendor/clean/' + f, import.meta.url).href });
    stream = new RnStream(mod, { dry: DRY.light });
  }
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'init') { await init(m); post({ type: 'ready' }); }
    else if (m.type === 'push') { const o = await stream.push(m.samples); post({ type: 'out', id: m.id, samples: o }, [o.buffer]); }
    else if (m.type === 'finish') { const o = await stream.finish(); post({ type: 'out', id: m.id, samples: o, done: true }, [o.buffer]); if (stream.close) stream.close(); stream = null; }
    else if (m.type === 'close') { if (stream && stream.close) stream.close(); stream = null; self.close(); }
  } catch (e) { post({ type: 'error', id: m.id, message: String((e && e.message) || e) }); }
};
post({ type: 'boot' });
