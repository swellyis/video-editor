import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT, Resampler, DfStream, vorbisWindow } from '../js/clean-dsp.js';

const rnd = (n, seed = 1) => { let s = seed; return Float32Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; }); };

test('FFT of 960 points matches a direct DFT', () => {
  const n = 960, f = new FFT(n), re = Float64Array.from(rnd(n, 3)), im = Float64Array.from(rnd(n, 4)), or = new Float64Array(n), oi = new Float64Array(n);
  f.forward(re, im, or, oi);
  for (const k of [0, 1, 7, 100, 479, 480, 959]) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) { const a = (-2 * Math.PI * k * t) / n; sr += re[t] * Math.cos(a) - im[t] * Math.sin(a); si += re[t] * Math.sin(a) + im[t] * Math.cos(a); }
    assert.ok(Math.abs(or[k] - sr) < 1e-8 && Math.abs(oi[k] - si) < 1e-8, 'bin ' + k);
  }
});

test('the vorbis window satisfies the overlap-add (Princen-Bradley) condition at hop N/2', () => {
  const w = vorbisWindow(960);
  for (let i = 0; i < 480; i++) assert.ok(Math.abs(w[i] * w[i] + w[i + 480] * w[i + 480] - 1) < 1e-6);
});

/** A stand-in for the network that, like the real one, answers 4 frames late and otherwise passes the spectrum through. */
const delayedPassThrough = (frames = 4) => ({
  init: () => ({ q: Array.from({ length: frames }, () => new Float32Array(962)) }),
  run: async (spec, st) => { const out = st.q.shift(); st.q.push(Float32Array.from(spec)); return { spec: out, state: st }; },
});

for (const chunk of [480, 1000, 7777, 100000]) {
  test('DfStream re-aligns a 4-frame-late model and keeps the length (chunks of ' + chunk + ')', async () => {
    const n = 48000 * 3 + 123, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.31 + 1);
    const s = new DfStream(delayedPassThrough(), {}), outs = [];
    for (let i = 0; i < n; i += chunk) outs.push(await s.push(x.subarray(i, Math.min(n, i + chunk))));
    outs.push(await s.finish());
    const y = new Float32Array(outs.reduce((a, o) => a + o.length, 0)); let k = 0; for (const o of outs) { y.set(o, k); k += o.length; }
    assert.equal(y.length, n);
    let worst = 0; for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(y[i] - x[i]));
    assert.ok(worst < 2e-3, 'worst error ' + worst);
  });
}

test('DfStream dry mix keeps a share of the original', async () => {
  const n = 48000, x = rnd(n, 9);
  const zero = { init: () => ({}), run: async (spec, st) => ({ spec: new Float32Array(962), state: st }) };
  const s = new DfStream(zero, { dry: 0.25 }); const a = await s.push(x), b = await s.finish();
  const y = new Float32Array(a.length + b.length); y.set(a); y.set(b, a.length);
  assert.equal(y.length, n);
  for (let i = 100; i < n; i += 997) assert.ok(Math.abs(y[i] - 0.25 * x[i]) < 1e-5);
});

test('Resampler: 44.1 kHz sine becomes a 48 kHz sine of the right length, chunking does not matter', () => {
  const sr = 44100, n = sr * 2, x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
  const r = new Resampler(sr), parts = [];
  for (let i = 0; i < n; i += 3001) parts.push(r.push(x.subarray(i, Math.min(n, i + 3001))));
  parts.push(r.finish());
  const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { y.set(p, k); k += p.length; }
  assert.equal(y.length, Math.round(n * 48000 / sr));
  let worst = 0; for (let i = 100; i < y.length - 100; i++) worst = Math.max(worst, Math.abs(y[i] - Math.sin((2 * Math.PI * 1000 * i) / 48000)));
  assert.ok(worst < 2e-3, 'worst ' + worst);
});

test('Resampler: 16 kHz and 48 kHz', () => {
  const r48 = new Resampler(48000), x = rnd(1000, 5);
  assert.equal(r48.push(x), x);
  const r16 = new Resampler(16000), a = r16.push(rnd(16000, 6)), b = r16.finish();
  assert.equal(a.length + b.length, 48000);
});
