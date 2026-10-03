// Unit tests for Snap to beat: tempo, the beat tracker, refusal when there is no beat, and the streaming onset meter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORATE, prepare, autocorr, tempo, track, analyze, rangeOf } from '../js/beat.js';
import { OnsetMeter } from '../js/beat-scan.js';

let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// an onset-strength curve with a click on every beat (+ a little noise), phase in seconds
function clicks(sec, bpm, { phase = 0.37, jitter = 0.004, noise = 0.3 } = {}) {
  const n = sec * ORATE, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = rnd() * noise;
  const T = 60 / bpm, truth = [];
  for (let t = phase; t < sec - 0.1; t += T) { truth.push(t); const i = Math.round((t + (rnd() - 0.5) * 2 * jitter) * ORATE); o[i] += 2; if (i + 1 < n) o[i + 1] += 1; }
  o.truth = truth; return o;
}
const maxErr = (beats, truth) => Math.max(...beats.map(t => Math.min(...truth.map(u => Math.abs(u - t)))));

test('tempo and beat positions for click tracks at known BPM', () => {
  for (const bpm of [60, 74, 90, 100, 120, 128, 140]) {
    const o = clicks(90, bpm), a = analyze(o);
    assert.ok(a.ok, `${bpm}: ${a.reason}`);
    assert.ok(Math.abs(a.bpm - bpm) / bpm < 0.005, `${bpm} → ${a.bpm}`);
    assert.ok(a.confidence > 0.9);
    assert.ok(maxErr(a.beats, o.truth) < 0.012, `${bpm}: beats off by ${maxErr(a.beats, o.truth)}`);
    assert.ok(a.beats.length >= o.truth.length - 3);
  }
});
test('the first beat is not at 0 when the music starts later (quiet intro is not tracked)', () => {
  const o = clicks(60, 100, { phase: 8.2 }); for (let i = 0; i < 6 * ORATE; i++) o[i] = 0;
  const a = analyze(o); assert.ok(a.ok); assert.ok(a.beats[0] > 8, 'first beat ' + a.beats[0]);
});
test('swung eighth notes over a steady pulse still give the pulse', () => {
  const n = 120 * ORATE, o = new Float32Array(n).map(() => rnd() * 0.3), T = 0.6;
  for (let t = 0.4; t < 118; t += T) for (const [dt, g] of [[0, 2], [T * 2 / 3, 1]]) { const i = Math.round((t + dt) * ORATE); o[i] += g; o[i + 1] += g / 2; }
  const a = analyze(o); assert.ok(a.ok); assert.ok(Math.abs(a.bpm - 100) < 0.6, 'bpm ' + a.bpm);
});
test('noise, a flat pad and random hits are refused: no clear beat', () => {
  const noise = new Float32Array(120 * ORATE).map(() => rnd());
  assert.equal(analyze(noise).ok, false);
  assert.equal(analyze(new Float32Array(60 * ORATE)).ok, false);
  const r = new Float32Array(120 * ORATE).map(() => rnd() * 0.3); for (let t = 1; t < 118; t += 0.2 + rnd() * 0.9) r[Math.round(t * ORATE)] += 2;
  const a = analyze(r); assert.equal(a.ok, false); assert.ok(a.confidence < 0.8);
  assert.equal(analyze(new Float32Array(100)).reason, 'short');
});
test('autocorrelation peaks at the beat period; prepare keeps only rises', () => {
  const o = prepare(clicks(60, 120)), ac = autocorr(o, 400);
  assert.ok(Math.abs(ac[0] - 1) < 1e-6); let b = 150; for (let l = 150; l < 260; l++) if (ac[l] > ac[b]) b = l;
  assert.ok(Math.abs(b - 100) <= 1 || Math.abs(b - 200) <= 1, 'peak at ' + b);
  assert.ok(prepare(Float32Array.from([1, 2, 3, 4])).every(v => v >= 0));
  const t = tempo(o); assert.ok(Math.abs(t.bpm - 120) < 0.6 && t.strength > 0.3);
});
test('the tracker follows a tempo that changes slowly', () => {
  const n = 90 * ORATE, o = new Float32Array(n).map(() => rnd() * 0.3), truth = []; let t = 0.5;
  while (t < 88) { truth.push(t); o[Math.round(t * ORATE)] += 2; t += 60 / (100 + 10 * t / 90); }
  const a = analyze(o); assert.ok(a.ok); assert.ok(a.bpm > 100 && a.bpm < 110);
  assert.ok(maxErr(a.beats, truth) < 0.02, 'off by ' + maxErr(a.beats, truth));
  assert.ok(track(o, 60 * ORATE / 105).length > 100);
});
test('rangeOf finds the beats inside a window', () => {
  const b = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(rangeOf(b, 2, 4), [1, 4]); assert.deepEqual(rangeOf(b, 7, 9), [6, 6]); assert.deepEqual(rangeOf(b, -1, 0.5), [0, 0]); assert.deepEqual(rangeOf(b, 1, 6), [0, 6]);
});

// ---- the streaming meter on real-looking PCM (kick + hat), chunked differently from the frame size
function pcm(sr, sec, bpm, phase) {
  const x = new Float32Array(sr * sec), T = 60 / bpm, truth = [];
  for (let t = phase; t < sec - 0.3; t += T) {
    truth.push(t); const i0 = Math.round(t * sr);
    for (let k = 0; k < 0.15 * sr; k++) x[i0 + k] += Math.sin(2 * Math.PI * 70 * k / sr) * Math.exp(-k / sr / 0.05) * 0.8;
    const h = Math.round((t + T / 2) * sr); for (let k = 0; k < 0.03 * sr; k++) x[h + k] += (rnd() - 0.5) * Math.exp(-k / sr / 0.01) * 0.4;
  }
  for (let i = 0; i < x.length; i++) x[i] += (rnd() - 0.5) * 0.004;
  return { x, truth };
}
test('OnsetMeter: any chunk size gives the same curve, and the beats come out right (44.1 kHz does not divide 200)', () => {
  const sr = 44100, { x, truth } = pcm(sr, 40, 96, 0.43);
  const whole = new OnsetMeter(sr).push(x), m2 = new OnsetMeter(sr), parts = [];
  for (let i = 0; i < x.length; i += 7001) parts.push(...m2.push(x.subarray(i, i + 7001)));
  assert.equal(parts.length, whole.length); assert.ok(Math.abs(whole.length - 40 * ORATE) <= 1);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(whole[i] - parts[i]) < 1e-9);
  const a = analyze(Float32Array.from(whole));
  assert.ok(a.ok); assert.ok(Math.abs(a.bpm - 96) < 0.4, 'bpm ' + a.bpm); assert.ok(maxErr(a.beats, truth) < 0.02, 'off by ' + maxErr(a.beats, truth));
});
test('OnsetMeter: silence gives nothing, and the start-up of the filters is not an onset', () => {
  const o = new OnsetMeter(48000).push(new Float32Array(48000)); assert.ok(o.every(v => v === 0));
  const c = new OnsetMeter(16000).push(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 3) * 0.5)); assert.ok(c[0] === 0);
});
