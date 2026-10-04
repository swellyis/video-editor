import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDb, noiseFloor, speechRegions, inRegions } from '../js/vad.js';
import { splitLong, Packer, jobAudio, mapWords, jobTail, toSource, spreadWords } from '../js/asr-plan.js';
import { workerCount, pickDevice, trustedCount } from '../js/transcribe.js';

const SR = 16000;
const tone = (secs, amp) => Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => amp * Math.sin(i * 0.3));
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Float32Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

test('speech finder: finds the loud parts and skips quiet room noise', () => {
  const a = cat(tone(3, 0.001), tone(2, 0.3), tone(4, 0.001), tone(1.5, 0.3), tone(2, 0.001));
  const db = frameDb(a, 320);
  const r = speechRegions(db, { frameSec: 0.02 });
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0].a - 3) < 0.3 && Math.abs(r[0].b - 5) < 0.45, JSON.stringify(r));
  assert.ok(Math.abs(r[1].a - 9) < 0.3 && Math.abs(r[1].b - 10.5) < 0.45);
  assert.ok(noiseFloor(db) < -50);
  assert.ok(inRegions(r, 4) && !inRegions(r, 7));
});
test('speech finder: short pauses inside a sentence keep it in one piece; tiny clicks are ignored', () => {
  const a = cat(tone(1, 0.001), tone(1, 0.3), tone(0.25, 0.001), tone(1, 0.3), tone(1, 0.001), tone(0.06, 0.5), tone(2, 0.001));
  const r = speechRegions(frameDb(a, 320), { frameSec: 0.02 });
  assert.equal(r.length, 1, JSON.stringify(r));
});
test('speech finder: a recording that is quiet overall is still detected, silence returns nothing', () => {
  const quiet = cat(tone(2, 0.0002), tone(2, 0.01), tone(2, 0.0002));
  assert.equal(speechRegions(frameDb(quiet, 320), {}).length, 1);
  assert.equal(speechRegions(frameDb(tone(5, 0.0001), 320), {}).length, 0);
});
test('long runs are cut at their quietest point, never mid-word', () => {
  const a = cat(tone(20, 0.3), tone(0.2, 0.002), tone(20, 0.3));
  const db = frameDb(a, 320);
  const parts = splitLong([{ a: 0, b: 40.2 }], db, 0.02);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every(p => p.b - p.a <= 28.01));
  assert.ok(Math.abs(parts[0].b - 20.1) < 0.3, 'cut in the gap: ' + parts[0].b);
});
test('packing: pieces fill a window up to 29 s, with a pad between, nothing lost', () => {
  const p = new Packer(29, 0.4); const jobs = [];
  for (const [a, b] of [[0, 10], [12, 22], [30, 38], [50, 55], [60, 64]]) jobs.push(...p.add({ a, b, data: new Float32Array(Math.round((b - a) * SR)) }));
  jobs.push(p.flush());
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(j => j.len <= 29.001));
  assert.equal(jobs.reduce((n, j) => n + j.segs.length, 0), 5);
  assert.ok(Math.abs(jobs[0].segs[1].off - 10.4) < 1e-9);
});
test('words are mapped back from job time to timeline time (also across pieces)', () => {
  const j = { segs: [{ a: 100, b: 105, off: 0 }, { a: 200, b: 204, off: 5.4 }], len: 9.4 };
  const w = mapWords(j, [{ w: 'a', start: 1, end: 1.5 }, { w: 'b', start: 6, end: 6.5 }, { w: 'c', start: 5.2, end: 5.3 }, { w: 'd', start: 4.9, end: 5.9 }]);
  assert.deepEqual([w[0].start, w[0].end], [101, 101.5]);
  assert.ok(Math.abs(w[1].start - 200.6) < 1e-9 && Math.abs(w[1].end - 201.1) < 1e-9);
  assert.ok(w[2].start >= 104.9 && w[2].start <= 200.1, 'a word in the pad snaps to a piece edge');
  assert.ok(w[3].end <= 105.13, 'a word running into the pad ends with its piece: ' + w[3].end);
  assert.equal(toSource(j, 9.4), 204);
});
test('job audio has the pieces at their offsets', () => {
  const a = new Float32Array(SR).fill(0.5), b = new Float32Array(SR).fill(0.25);
  const j = { segs: [{ a: 0, b: 1, off: 0, data: a }, { a: 5, b: 6, off: 1.4, data: b }], len: 2.4 };
  const au = jobAudio(j, SR);
  assert.equal(au[100], 0.5); assert.equal(au[Math.round(1.2 * SR)], 0); assert.equal(au[Math.round(1.5 * SR)], 0.25);
});
test('retrying the rest of a job after bad word times keeps the right audio and times', () => {
  const j = { segs: [{ a: 10, b: 20, off: 0, data: new Float32Array(10 * SR).fill(1) }, { a: 40, b: 45, off: 10.4, data: new Float32Array(5 * SR).fill(2) }], len: 15.4 };
  const t = jobTail(j, 4, SR);
  assert.equal(t.segs[0].a, 14); assert.equal(t.segs[0].off, 0); assert.equal(t.segs[0].data.length, 6 * SR);
  assert.ok(Math.abs(t.segs[1].off - 6.4) < 1e-9); assert.equal(t.tries, 1);
  assert.ok(Math.abs(t.len - 11.4) < 1e-9);
  const t2 = jobTail(j, 12, SR); assert.equal(t2.segs.length, 1); assert.ok(Math.abs(t2.segs[0].a - 41.6) < 1e-9);
  assert.equal(jobTail(j, 15.4, SR), null);
});
test('collapsed word times are detected and spread evenly', () => {
  const ws = [{ w: 'a', start: 1, end: 1.2 }, { w: 'b', start: 2, end: 2.1 }, { w: 'c', start: 2.0, end: 2.1 }, { w: 'd', start: 2.01, end: 2.1 }];
  assert.equal(trustedCount(ws), 1);
  const sp = spreadWords(ws, 0, 4); assert.ok(sp[0].start === 0 && Math.abs(sp[3].end - 4) < 1e-9);
});
test('engine count: cores/memory aware, phones get two at most, an explicit number is honoured', () => {
  assert.equal(workerCount(0, { cores: 8, mem: 8 }), 4);
  assert.equal(workerCount(0, { cores: 8, mem: 4 }), 3);
  assert.equal(workerCount(0, { cores: 8, mem: 8, phone: true }), 2);
  assert.equal(workerCount(0, { cores: 2, mem: 8 }), 1);
  assert.equal(workerCount(3, { cores: 2 }), 3);
  assert.equal(pickDevice('wasm'), 'wasm');
});
