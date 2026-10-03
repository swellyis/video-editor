// Unit tests for the Effects library data: the list, tidying fx lists, adding / reordering, and how the model keeps them (old projects, split, duplicate, overlays).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, GROUPS, MAX_FX, fxInfo, normFx, activeFx, addFx, moveFx, newFx } from '../js/effects.js';
import { newProject, newClipFromMedia, normalizeClip, normalizeOverlay, migrate, splitAt, duplicateClip, clipToOverlay, layout } from '../js/model.js';

const media = (id, d) => ({ id, name: id, kind: 'video', duration: d, width: 1280, height: 720, hasAudio: true });
const proj = () => { const p = newProject('T'); p.clips = [Object.assign(newClipFromMedia(media('m', 10)), { id: 'c0' })]; return p; };

test('the library: 15 effects in 5 groups, unique ids and shader modes', () => {
  assert.equal(EFFECTS.length, 15);
  assert.equal(new Set(EFFECTS.map(e => e.id)).size, 15);
  assert.equal(new Set(EFFECTS.map(e => e.mode)).size, 15);
  assert.deepEqual([...new Set(EFFECTS.map(e => e.group))], GROUPS);
  for (const e of EFFECTS) assert.ok(e.amount >= 0 && e.amount <= 1 && e.label);
  // colour looks are not repeated here: they live in Clip color
  for (const id of ['bw', 'sepia', 'vintage', 'vignette']) assert.equal(fxInfo(id), null);
});
test('normFx keeps known effects only, clamps strength, drops repeats and caps the stack', () => {
  assert.deepEqual(normFx(undefined), []);
  assert.deepEqual(normFx('x'), []);
  const n = normFx([{ type: 'glow', amount: 5 }, { type: 'nope', amount: 1 }, null, { type: 'glow', amount: 0.2 }, { type: 'grain', amount: 'x' }, { type: 'blur', amount: -1 }, { type: 'bars', amount: 1 }]);
  assert.deepEqual(n, [{ type: 'glow', amount: 1 }, { type: 'grain', amount: fxInfo('grain').amount }, { type: 'blur', amount: 0 }]);
  assert.equal(n.length, MAX_FX);
});
test('activeFx skips effects with no strength (but keeps fixed ones)', () => {
  assert.deepEqual(activeFx([{ type: 'blur', amount: 0 }, { type: 'mirror', amount: 0 }, { type: 'glow', amount: 0.3 }]).map(f => f.type), ['mirror', 'glow']);
  assert.deepEqual(activeFx(null), []);
});
test('addFx: adds with the default strength, refuses repeats and a 4th effect; moveFx reorders', () => {
  let l = [];
  for (const id of ['glow', 'grain', 'shake']) { const r = addFx(l, id); assert.equal(r.why, null); l = r.list; }
  assert.deepEqual(l[0], newFx('glow'));
  assert.equal(addFx(l, 'glow').why, 'have');
  assert.equal(addFx(l, 'blur').why, 'full');
  assert.equal(addFx(l, 'bogus').why, 'unknown');
  assert.deepEqual(moveFx(l, 0, 1).map(f => f.type), ['grain', 'glow', 'shake']);
  assert.equal(moveFx(l, 0, -1), l);
  assert.equal(moveFx(l, 2, 1), l);
});
test('old projects load with no effects; saved effects survive migrate; bad data is tidied', () => {
  const old = normalizeClip({ id: 'a', in: 0, out: 3 });
  assert.deepEqual(old.fx, []);
  assert.deepEqual(normalizeOverlay({ id: 'o' }).fx, []);
  const p = proj(); p.clips[0].fx = [{ type: 'glitch', amount: 0.4 }]; p.clips[0].fx.push({ type: 'zzz' });
  const m = migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(m.clips[0].fx, [{ type: 'glitch', amount: 0.4 }]);
  const o = normalizeOverlay({ id: 'o', fx: [{ type: 'rays', amount: 0.9 }] });
  assert.deepEqual(o.fx, [{ type: 'rays', amount: 0.9 }]);
});
test('split keeps the effects on both halves (separate copies); duplicate too', () => {
  const p = proj(); p.clips[0].fx = [{ type: 'leak', amount: 0.6 }];
  const b = splitAt(p, 4);
  assert.deepEqual(b.fx, [{ type: 'leak', amount: 0.6 }]);
  b.fx[0].amount = 0.1; assert.equal(p.clips[0].fx[0].amount, 0.6);
  const d = duplicateClip(p, 'c0', false);
  assert.deepEqual(d.fx, [{ type: 'leak', amount: 0.6 }]);
  d.fx.push({ type: 'blur', amount: 1 }); assert.equal(p.clips[0].fx.length, 1);
});
test('moving a clip up to an overlay carries its effects', () => {
  const p = proj(); p.clips.push(Object.assign(newClipFromMedia(media('m2', 5)), { id: 'c1' })); p.clips[1].fx = [{ type: 'pixel', amount: 0.3 }];
  const o = clipToOverlay(p, 'c1', false, 0);
  assert.deepEqual(o.fx, [{ type: 'pixel', amount: 0.3 }]);
  assert.equal(layout(p).items.length, 1);
});
