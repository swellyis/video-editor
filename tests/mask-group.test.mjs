import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, normalizeClip, newText, newOverlay, migrate, normalizeMask, defaultMask, maskActive, animated, setKeyframe, layout, ANIM_PROPS } from '../js/model.js';
import { maskAt, pathFromPoints } from '../js/mask.js';
import { makeGroup, groupOf, groupIs, ungroup, tidyGroups, groupSpan, trimGroup, moveMany, duplicateMany } from '../js/group.js';

test('mask defaults, clamping and activity', () => {
  assert.deepEqual(normalizeMask(null), defaultMask());
  const m = normalizeMask({ shape: 'ellipse', x: 5, w: -1, feather: 9, opacity: 2, points: [[0.1, 0.2], ['a', 1], [2, 0.5]] });
  assert.equal(m.shape, 'ellipse'); assert.equal(m.x, 2); assert.equal(m.w, 0.01); assert.equal(m.feather, 0.5); assert.equal(m.opacity, 1);
  assert.deepEqual(m.points, [[0.1, 0.2], [1, 0.5]]);
  assert.equal(normalizeMask({ shape: 'star' }).shape, 'none');
  assert.equal(maskActive({ mask: { ...defaultMask(), shape: 'rect' } }), true);
  assert.equal(maskActive({ mask: { ...defaultMask(), shape: 'path', points: [[0, 0], [1, 1]] } }), false, 'a pen mask needs 3 points');
  assert.equal(normalizeClip({}).mask.shape, 'none');
});
test('mask position / size are keyframable (mx, my, mw, mh) and are not "motion"', () => {
  const c = normalizeClip({ mask: { shape: 'rect', x: 0.2, y: 0.5, w: 0.3, h: 0.3 } });
  setKeyframe(c, 'mx', 0, 0.2); setKeyframe(c, 'mx', 2, 0.8); setKeyframe(c, 'mw', 0, 0.3); setKeyframe(c, 'mw', 2, 0.5);
  const m = maskAt(c, 1); assert.ok(Math.abs(m.x - 0.5) < 1e-9 && Math.abs(m.w - 0.4) < 1e-9);
  assert.equal(animated('clip', c, 1).mx, m.x);
  assert.ok(ANIM_PROPS.includes('mx'));
  assert.equal(maskAt(normalizeClip({}), 0), null);
});
test('pathFromPoints: box + points relative to it, thinned', () => {
  const r = pathFromPoints([[0.2, 0.2], [0.2005, 0.2], [0.6, 0.2], [0.6, 0.8], [0.2, 0.8]]);
  assert.ok(Math.abs(r.x - 0.4) < 1e-9 && Math.abs(r.y - 0.5) < 1e-9 && Math.abs(r.w - 0.4) < 1e-9 && Math.abs(r.h - 0.6) < 1e-9);
  assert.equal(r.points.length, 4); assert.deepEqual(r.points[0], [0, 0]); assert.deepEqual(r.points[2], [1, 1]);
  assert.equal(pathFromPoints([[0, 0], [1, 1]]), null);
});
function proj() {
  const p = newProject('t');
  p.clips.push(normalizeClip({ id: 'c1', mediaId: 'm1', in: 0, out: 4, srcDuration: 10 }), normalizeClip({ id: 'c2', mediaId: 'm2', in: 0, out: 4, srcDuration: 10 }));
  const t = newText(1); t.id = 't1'; t.start = 1; t.end = 6; t.text = 'Hi'; p.texts.push(t);
  const o = newOverlay({ id: 'm3', kind: 'image', width: 100, height: 100, duration: 0 }, 2); o.id = 'o1'; o.start = 2; o.in = 0; o.out = 3; p.overlays.push(o);
  return migrate(p);
}
test('makeGroup / groupOf / groupIs / ungroup / tidyGroups', () => {
  const p = proj();
  const g = makeGroup(p, [{ type: 'clip', id: 'c2' }, { type: 'text', id: 't1' }, { type: 'overlay', id: 'o1' }]);
  assert.equal(g.items.length, 3); assert.equal(groupOf(p, { type: 'text', id: 't1' }).id, g.id);
  assert.equal(groupIs(p, [{ type: 'overlay', id: 'o1' }, { type: 'clip', id: 'c2' }, { type: 'text', id: 't1' }]).id, g.id);
  assert.equal(groupIs(p, [{ type: 'overlay', id: 'o1' }, { type: 'clip', id: 'c2' }]), null);
  assert.equal(makeGroup(p, [{ type: 'clip', id: 'c1' }]), null, 'one item is not a group');
  p.texts = []; p.overlays = []; tidyGroups(p); assert.equal(p.groups.length, 0, 'a group left with one member dissolves');
  const g2 = makeGroup(proj(), [{ type: 'clip', id: 'c1' }, { type: 'clip', id: 'c2' }]); assert.ok(g2);
  const q = proj(); const g3 = makeGroup(q, [{ type: 'clip', id: 'c1' }, { type: 'text', id: 't1' }]); assert.ok(ungroup(q, g3.id)); assert.equal(q.groups.length, 0);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(q))).groups, []);
});
test('a group moves and duplicates as one block', () => {
  const p = proj(); const g = makeGroup(p, [{ type: 'text', id: 't1' }, { type: 'overlay', id: 'o1' }]);
  const [a0, b0] = groupSpan(p, g); assert.deepEqual([a0, b0], [1, 6]);
  moveMany(p, g.items, 2, false); assert.deepEqual(groupSpan(p, g), [3, 8]);
  const dup = duplicateMany(p, g.items, false); const g2 = makeGroup(p, dup); assert.equal(p.groups.length, 2); assert.equal(g2.items.length, 2);
});
test('trimGroup cuts every member at the new ends and drops what falls outside', () => {
  const p = proj(); const g = makeGroup(p, [{ type: 'clip', id: 'c2' }, { type: 'text', id: 't1' }, { type: 'overlay', id: 'o1' }]);
  assert.deepEqual(groupSpan(p, g), [1, 8]);
  const before = layout(p).items.find(i => i.clip.id === 'c2').start;
  trimGroup(p, g, 2.5, 5);
  const [a, b] = groupSpan(p, p.groups[0]); assert.ok(Math.abs(a - 2.5) < 1e-6 && Math.abs(b - 5) < 1e-6, a + '..' + b);
  const t = p.texts[0]; assert.ok(Math.abs(t.start - 2.5) < 1e-6 && Math.abs(t.end - 5) < 1e-6);
  const c1 = layout(p).items.find(i => i.clip.id === 'c1'); assert.equal(c1.start, 0, 'clips outside the group are untouched');
  assert.equal(before, 4);
  assert.ok(p.groups[0].items.length === 3);
});
