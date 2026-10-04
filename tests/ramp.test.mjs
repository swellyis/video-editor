// Speed ramps + reverse maths (js/ramp.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/ramp.js';

const clip = (o = {}) => ({ in: 0, out: 10, speed: 1, ...o });
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('constant speed / reverse without a ramp', () => {
  const c = clip({ speed: 2 });
  near(R.lengthOf(c), 5); near(R.sourceAtOffset(c, 1), 2);
  const r = clip({ speed: 2, reverse: true }); near(R.sourceAtOffset(r, 0), 10); near(R.sourceAtOffset(r, 1), 8); near(R.sourceAtOffset(r, 5), 0);
  near(R.offsetOfSource(r, 8), 1);
});
test('a flat ramp equals the constant speed', () => {
  const c = clip({ ramp: { pts: [{ t: 0, s: 2 }, { t: 10, s: 2 }], audio: 'follow' } });
  near(R.lengthOf(c), 5, 1e-3); near(R.sourceAtOffset(c, 2), 4, 1e-3);
});
test('speed eases smoothly between points and holds outside them', () => {
  const r = { pts: [{ t: 2, s: 1 }, { t: 4, s: 3 }] };
  assert.equal(R.speedAt(r, 0), 1); assert.equal(R.speedAt(r, 9), 3); near(R.speedAt(r, 3), 2);
  assert.ok(R.speedAt(r, 2.1) < 1.1, 'flat start (no corner)');
});
test('length integrates 1/speed: slow parts take longer', () => {
  const slow = clip({ ramp: { pts: [{ t: 0, s: 0.5 }, { t: 10, s: 0.5 }] } }), fast = clip({ ramp: { pts: [{ t: 0, s: 4 }, { t: 10, s: 4 }] } });
  near(R.lengthOf(slow), 20); near(R.lengthOf(fast), 2.5);
  const mix = clip({ ramp: { pts: [{ t: 0, s: 1 }, { t: 5, s: 1 }, { t: 5.001, s: 0.25 }, { t: 10, s: 0.25 }] } });
  assert.ok(R.lengthOf(mix) > 5 + 5 / 0.25 - 0.1 && R.lengthOf(mix) < 5 + 20 + 0.1);
});
test('source/timeline mapping is monotonic and inverts', () => {
  for (const id of R.PRESETS.map(p => p.id)) {
    const c = clip({ in: 3, out: 13 }); c.ramp = R.fromPreset(id, c);
    const len = R.lengthOf(c); let prev = -1;
    for (let k = 0; k <= 40; k++) { const tl = len * k / 40, s = R.sourceAtOffset(c, tl); assert.ok(s >= prev - 1e-9, id + ' monotonic'); prev = s; near(R.offsetOfSource(c, s), tl, 1e-2); }
    near(R.sourceAtOffset(c, 0), 3); near(R.sourceAtOffset(c, len), 13, 1e-6);
  }
});
test('reverse with a ramp mirrors the timeline', () => {
  const c = clip({ ramp: R.fromPreset('hero', clip()) }); const len = R.lengthOf(c);
  const rv = { ...c, reverse: true };
  near(R.lengthOf(rv), len);
  for (const k of [0, 0.2, 0.5, 0.8, 1]) near(R.sourceAtOffset(rv, len * k), R.sourceAtOffset(c, len * (1 - k)), 1e-6);
  assert.equal(R.rateAtOffset(rv, 0.1).dir, -1);
});
test('trimming keeps the curve on the same footage', () => {
  const full = clip({ ramp: R.fromPreset('jumper', clip()) });
  const cut = { ...full, in: 4, out: 8 };
  near(R.rateAtOffset(cut, 0).rate, R.speedAt(full.ramp, 4)); near(R.speedAt(cut.ramp, 6), R.speedAt(full.ramp, 6));
  // source second 5 is the same moment of the footage in both
  near(R.speedAt(cut.ramp, 5), R.speedAt(full.ramp, 5));
});
test('audioPieces cover the span with a speed per piece', () => {
  const c = clip({ ramp: R.fromPreset('bullet', clip()) }); const len = R.lengthOf(c), ps = R.audioPieces(c, 0, len, 0.25);
  near(ps[0].off0, 0); near(ps[ps.length - 1].off1, len); assert.ok(ps.every(p => p.speed >= 0.2 && p.speed <= 4.1));
  near(ps[0].src0, 0); near(ps[ps.length - 1].src1, 10, 1e-6);
  const rv = R.audioPieces({ ...c, reverse: true }, 0, len, 0.25); assert.ok(rv[0].src0 > rv[0].src1, 'runs backwards');
});
test('editing helpers: ends fixed, points clamped, limit', () => {
  const c = clip(); let r = R.fromPreset('flashin', c);
  r = R.withEnds(r, c); assert.equal(r.pts[0].t, 0); assert.equal(r.pts[r.pts.length - 1].t, 10);
  const a = R.addPoint(r, c, 5, 9); assert.equal(a.pts.find(p => p.t === 5).s, 4, 'speed clamped to 4');
  assert.equal(R.addPoint(a, c, 5.01, 1), null, 'too close to another point');
  const m = R.movePoint(a, c, 0, 3, 0.1); assert.equal(m.pts[0].t, 0); assert.equal(m.pts[0].s, 0.25);
  const idx = a.pts.findIndex(p => p.t === 5); const m2 = R.movePoint(a, c, idx, 99, 2); assert.ok(m2.pts[idx].t < m2.pts[idx + 1].t);
  const rm = R.removePoint(a, c, idx); assert.equal(rm.pts.length, a.pts.length - 1); assert.equal(R.removePoint(rm, c, 0).pts.length, rm.pts.length);
  let w = r; for (let i = 1; i < 30; i++) w = R.addPoint(w, c, i * 0.3, 1) || w; assert.ok(w.pts.length <= R.RAMP_MAX_POINTS);
});
test('normalize drops junk, sorts, clamps', () => {
  assert.equal(R.normalize(null), null); assert.equal(R.normalize({ pts: [] }), null);
  const n = R.normalize({ pts: [{ t: 5, s: 99 }, { t: 1, s: 'x' }, { t: -1, s: 1 }], audio: 'zzz' });
  assert.deepEqual(n.pts.map(p => [p.t, p.s]), [[1, 1], [5, 4]]); assert.equal(n.audio, 'follow');
});

import { newProject, newClipFromMedia, layout, clipLen, sourceTime, splitAt, migrate } from '../js/model.js';
const vid = { id: 'm1', kind: 'video', name: 'a.mp4', duration: 10, width: 640, height: 360, hasAudio: true };
test('model: clipLen / sourceTime follow the ramp and reverse', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c);
  const plain = clipLen(c); assert.equal(plain, 10);
  c.ramp = R.fromPreset('hero', c); const lay = layout(p), it = lay.items[0];
  near(clipLen(c), R.lengthOf(c)); assert.ok(clipLen(c) > 10, 'slow-mo middle makes it longer than the footage'); near(it.len, clipLen(c));
  near(sourceTime(it, it.start + 1), R.sourceAtOffset(c, 1)); near(sourceTime(it, it.end - 1e-4), 10, 0.01);
  c.reverse = true; near(sourceTime(it, it.start), 9.999, 0.01); near(sourceTime(it, it.start + 1), R.sourceAtOffset(c, 1));
});
test('model: splitting a ramped clip keeps the footage and the curve; reverse swaps the halves', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c); c.ramp = R.fromPreset('jumper', c);
  const len = clipLen(c), pts = JSON.stringify(c.ramp.pts);
  const b = splitAt(p, len / 2); assert.ok(b); near(p.clips[0].out, b.in); assert.equal(JSON.stringify(b.ramp.pts), pts);
  near(clipLen(p.clips[0]) + clipLen(b), len, 0.02);
  const q = newProject('t'); const d = newClipFromMedia(vid, q.settings); q.clips.push(d); d.reverse = true;
  const e = splitAt(q, 3); assert.ok(e);
  near(q.clips[0].in, 7); near(q.clips[0].out, 10); near(e.in, 0); near(e.out, 7); // first on the timeline = the end of the footage
});
test('model: migrate keeps / cleans ramp + reverse', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c); c.ramp = { pts: [{ t: 1, s: 9 }, { t: 3, s: 0.1 }], audio: 'mute' }; c.reverse = true;
  const q = migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q.clips[0].ramp.pts, [{ t: 1, s: 4 }, { t: 3, s: 0.25 }]); assert.equal(q.clips[0].ramp.audio, 'mute'); assert.equal(q.clips[0].reverse, true);
  c.ramp = { pts: 'junk' }; c.reverse = 'yes'; const r = migrate(JSON.parse(JSON.stringify(p)));
  assert.ok(!('ramp' in r.clips[0]) && !('reverse' in r.clips[0]));
});

test('sourceBeyond / startShift: trimming keeps keyframes on the same footage', () => {
  const c = clip({ ramp: R.fromPreset('hero', clip()) }), len = R.lengthOf(c);
  near(R.sourceBeyond(c, len / 2), R.sourceAtOffset(c, len / 2)); assert.ok(R.sourceBeyond(c, len + 1) > 10); assert.ok(R.sourceBeyond(c, -1) < 0);
  const n = { ...c, in: 2 }; near(R.startShift(c, n), R.offsetOfSource(c, 2)); near(R.startShift(n, c), -R.offsetOfSource(c, 2));
  const r = { ...c, reverse: true }, rn = { ...r, out: 8 };
  near(R.startShift(r, rn), R.offsetOfSource(r, 8)); assert.ok(R.startShift(r, rn) > 0);
  const k = clip({ speed: 2 }); near(R.startShift(k, { ...k, in: 2 }), 1);
});
