// Unit tests for Sync: the FFT, the envelope correlator (offset, confidence, drift) and the move itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, newAudio, ensureLanes } from '../js/model.js';
import { RATE, fft, atSpeed, prepare, ncc, align, applySync, minOverlap } from '../js/sync.js';

let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// fake "speech" loudness curve (dB, RATE values per second): bursts of different level and length
function speech(sec, s0) {
  seed = s0; const n = Math.round(sec * RATE), db = new Float32Array(n).fill(-60);
  let i = 0; while (i < n) { const len = Math.round((0.1 + rnd() * 0.5) * RATE), gap = Math.round((0.05 + rnd() * 0.5) * RATE), lvl = -30 + rnd() * 15; for (let k = 0; k < len && i + k < n; k++) db[i + k] = lvl + 3 * Math.sin(k / 7); i += len + gap; }
  return db;
}
const noisy = (a, s0, amp, gain = 0) => { seed = s0; return a.map(v => Math.max(v + gain + (rnd() - 0.5) * amp, -80)); };
// the same event heard by a recorder that started `off` s after (off > 0) or before (off < 0) the reference
function shifted(X, off, len) {
  const o = Math.round(off * RATE), out = new Float32Array(len || X.length).fill(-60);
  for (let j = 0; j < out.length; j++) { const k = j + o; if (k >= 0 && k < X.length) out[j] = X[k]; }
  return out;
}
const X = speech(300, 11);

test('fft: forward then inverse is the identity and finds a tone', () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n), orig = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = orig[i] = Math.sin(2 * Math.PI * 5 * i / n) + 0.3 * Math.cos(2 * Math.PI * 9 * i / n);
  fft(re, im);
  const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.ok(mag[5] > 30 && mag[9] > 9 && mag[7] < 1e-6);
  fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});
test('ncc: lag sign — positive means the second content shows up later in the first', () => {
  const a = new Float32Array(400), b = new Float32Array(100);
  for (let i = 0; i < 100; i++) { b[i] = Math.sin(i / 3) * Math.exp(-((i - 50) ** 2) / 800); a[i + 120] = b[i]; }
  const { c, lo } = ncc(a, b, -200, 300, 50); let bi = 0; for (let i = 0; i < c.length; i++) if (c[i] > c[bi]) bi = i;
  assert.equal(lo + bi, 120); assert.ok(c[bi] > 0.99);
});
test('atSpeed resamples the envelope for the playing speed', () => {
  const e = Float32Array.from({ length: 1000 }, (_, i) => i);
  const f = atSpeed(e, 2); assert.equal(f.length, 499); assert.equal(f[10], 20);
  assert.equal(atSpeed(e, 1), e);
});
test('known offsets are recovered to a few ms despite noise, level change and a lead-in', () => {
  for (const off of [-3.2, 0.04, 45, -20.5, 0]) {
    const a = prepare(noisy(X.slice(0, 90 * RATE), 3, 6)), b = prepare(noisy(shifted(X, off, 90 * RATE), 4, 8, -9));
    const r = align(a, b);
    assert.ok(r.ok, `off ${off}: ${r.reason}`); assert.ok(Math.abs(r.lag - off) < 0.012, `off ${off} -> ${r.lag}`);
    assert.ok(r.confidence > 0.8 && r.agreement >= 0.9, `conf ${r.confidence}`);
  }
});
test('unrelated recordings are refused', () => {
  const r = align(prepare(X.slice(0, 120 * RATE)), prepare(speech(120, 99)));
  assert.equal(r.ok, false); assert.ok(r.confidence < 0.6);
});
test('silence or a flat level is refused, not matched', () => {
  const flat = new Float32Array(60 * RATE).fill(-50);
  assert.equal(align(prepare(flat), prepare(X.slice(0, 60 * RATE))).ok, false);
  assert.equal(align(prepare(flat), prepare(flat)).ok, false);
});
test('too short to judge is refused with a reason', () => {
  const r = align(prepare(X.slice(0, 2 * RATE)), prepare(X.slice(0, 2 * RATE)));
  assert.equal(r.ok, false); assert.equal(r.reason, 'short');
  assert.ok(minOverlap(60 * RATE, 60 * RATE) >= 4 && minOverlap(10000 * RATE, 10000 * RATE) <= 20);
});
test('an offset beyond the +-60 s default is found by the wider search', () => {
  const a = prepare(noisy(X.slice(0, 200 * RATE), 3, 6)), b = prepare(noisy(shifted(X, 95, 100 * RATE), 4, 6, -5));
  const r = align(a, b, { maxOffset: 60 }); assert.ok(r.ok && Math.abs(r.lag - 95) < 0.012, JSON.stringify(r));
});
test('drift: a clock that runs 1000 ppm fast is reported and the lag is given for the middle', () => {
  const n = 280 * RATE, a = noisy(X.slice(0, n), 3, 4), b = new Float32Array(n);
  const k = 1.001;
  for (let j = 0; j < n; j++) { const x = j * k, i = Math.floor(x), f = x - i; b[j] = X[i] * (1 - f) + X[i + 1] * f; }
  const r = align(prepare(a), prepare(noisy(b, 4, 4, -6)));
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(Math.abs(r.driftPpm) - 1000) < 150, `ppm ${r.driftPpm}`);
  assert.ok(Math.abs(Math.abs(r.driftMs) - 280) < 50, `ms ${r.driftMs}`);
  assert.ok(Math.abs(r.lag - 140 * (1 - 1 / k)) < 0.03, `lag ${r.lag}`);
});
test('no drift is reported for a clean pair', () => {
  const r = align(prepare(noisy(X.slice(0, 280 * RATE), 3, 4)), prepare(noisy(shifted(X, 2, 280 * RATE), 4, 4)));
  assert.ok(r.ok); assert.ok(Math.abs(r.driftPpm) < 60, `ppm ${r.driftPpm}`);
});

// ---- the move
const media = (id, duration) => ({ id, duration, kind: 'video', name: id, width: 160, height: 90 });
function proj() {
  const p = newProject('T'); p.clips = [Object.assign(newClipFromMedia(media('cam', 60)), { id: 'c1' })];
  p.audio = [Object.assign(newAudio({ id: 'rec', duration: 60, name: 'rec' }, 30), { id: 'a1' })];
  ensureLanes(p); return p;
}
test('applySync moves only that item, keeps it on its lane when free, and can mute the other', () => {
  const p = proj(); p.captions = [{ id: 'cp', start: 5, end: 6, text: 'x' }]; p.markers = [{ id: 'm', time: 40, name: 'm' }];
  const snap = () => JSON.stringify([p.captions.map(c => [c.start, c.end, c.text]), p.markers, p.clips[0].start]), before = snap();
  const r = applySync(p, { type: 'audio', id: 'a1' }, 3.25, { mute: { type: 'clip', id: 'c1' } });
  assert.equal(r.start, 3.25); assert.equal(p.audio[0].start, 3.25); assert.equal(p.clips[0].muted, true);
  assert.equal(snap(), before);
});
test('applySync: not before the start of the project, and no mute unless asked', () => {
  const p = proj(); const r = applySync(p, { type: 'audio', id: 'a1' }, -2);
  assert.equal(r.fail, true); assert.equal(r.reason, 'before-start'); assert.equal(p.audio[0].start, 30);
  applySync(p, { type: 'audio', id: 'a1' }, 8); assert.notEqual(p.clips[0].muted, true);
});
test('applySync: landing on another item of the same lane gives a new lane instead of overlapping', () => {
  const p = proj(); p.audio.push(Object.assign(newAudio({ id: 'm2', duration: 20, name: 'm2' }, 10), { id: 'a2' }));
  ensureLanes(p);
  const r = applySync(p, { type: 'audio', id: 'a1' }, 12);
  assert.equal(p.audio.find(a => a.id === 'a1').start, 12);
  const a1 = p.audio.find(a => a.id === 'a1'), a2 = p.audio.find(a => a.id === 'a2');
  assert.notEqual(a1.lane, a2.lane); assert.equal(typeof r.lane, 'number');
});
