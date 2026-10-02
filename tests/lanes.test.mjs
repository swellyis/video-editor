// Free placement: gaps on the main track, stacked lanes, no same-lane overlap, clip <-> overlay conversion, old-project migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, migrate, layout, normalizeClip, newText, newBlur, newAudio, normalizeOverlay, ensureLanes, laneOf, byLane, placeLaneItem, moveClipTo, removeClip, clipToOverlay, overlayToClip, overlaysAt, insertLane, freeSpot, nearestFree, splitItem } from '../js/model.js';

const clip = (id, out, extra = {}) => normalizeClip({ id, mediaId: 'm_' + id, name: id, kind: 'video', srcDuration: 60, in: 0, out, ...extra });
const proj = (...clips) => { const p = newProject('T'); p.clips = clips; return p; };
const txt = (id, s, e) => ({ ...newText(s, e - s, id), id });
const ovl = (id, s, len, extra = {}) => normalizeOverlay({ id, mediaId: 'm', kind: 'video', srcDuration: 60, start: s, in: 0, out: len, ...extra });

test('a gap before a clip leaves empty time, shifts what follows and ends the timeline later', () => {
  const p = proj(clip('a', 4), clip('b', 3, { gap: 2 }), clip('c', 2));
  const lay = layout(p);
  assert.deepEqual(lay.items.map(i => [i.start, i.end]), [[0, 4], [6, 9], [9, 11]]);
  assert.equal(lay.total, 11);
  p.clips[0].gap = 1.5; // a leading gap: the picture starts black
  assert.equal(layout(p).items[0].start, 1.5);
});

test('a gap cancels a crossfade into that clip, no gap keeps it', () => {
  const p = proj(clip('a', 4), clip('b', 4, { transition: { type: 'crossfade', duration: 1 } }));
  assert.equal(layout(p).items[1].start, 3);
  p.clips[1].gap = 1; assert.equal(layout(p).items[1].start, 5); assert.equal(layout(p).items[1].xIn, 0);
});

test('moveClipTo: free move leaves a gap, other clips stay, no overlap, order follows position', () => {
  const p = proj(clip('a', 4), clip('b', 4), clip('c', 4));
  assert.equal(moveClipTo(p, 'a', 20), 20);
  assert.deepEqual(p.clips.map(c => c.id), ['b', 'c', 'a']);
  assert.deepEqual(layout(p).items.map(i => [i.clip.id, i.start]), [['b', 4], ['c', 8], ['a', 20]]);
  // dropping onto another clip takes the nearest free spot
  const q = proj(clip('a', 4), clip('b', 4), clip('c', 4));
  assert.equal(moveClipTo(q, 'a', 9), 12); // b and c are in the way: the nearest free spot is after c
  assert.deepEqual(layout(q).items.map(i => [i.clip.id, i.start]), [['b', 4], ['c', 8], ['a', 12]]);
  // never before 0
  assert.equal(moveClipTo(q, 'c', -3), 0);
});

test('deleting a clip: Ripple on closes the hole, Ripple off keeps the next clip where it was', () => {
  const a = proj(clip('a', 4), clip('b', 4), clip('c', 4)); removeClip(a, 'b', true);
  assert.deepEqual(layout(a).items.map(i => i.start), [0, 4]);
  const b = proj(clip('a', 4), clip('b', 4), clip('c', 4)); removeClip(b, 'b', false);
  assert.deepEqual(layout(b).items.map(i => [i.clip.id, i.start]), [['a', 0], ['c', 8]]);
  const c = proj(clip('a', 4), clip('b', 4)); removeClip(c, 'a', false);
  assert.equal(layout(c).items[0].start, 4);
});

test('texts without lanes stack on what they overlap, in list order (same picture as before lanes)', () => {
  const p = newProject('T'); p.clips = [clip('a', 20)];
  p.texts = [txt('t1', 0, 5), txt('t2', 2, 6), txt('t3', 10, 12), txt('t4', 3, 4)];
  ensureLanes(p);
  assert.deepEqual(p.texts.map(laneOf), [0, 1, 0, 2]);
  assert.deepEqual(byLane(p.texts).map(t => t.id), ['t1', 't3', 't2', 't4']);
});

test('overlap inside one lane is split into a new lane; empty lanes close up', () => {
  const p = newProject('T'); p.clips = [clip('a', 20)];
  p.texts = [{ ...txt('t1', 0, 5), lane: 0 }, { ...txt('t2', 4, 8), lane: 0 }, { ...txt('t3', 9, 10), lane: 3 }];
  ensureLanes(p);
  assert.deepEqual(p.texts.map(laneOf), [0, 1, 2]); // t2 pushed up, t3's empty lanes closed
});

test('placeLaneItem: nearest free spot when close, otherwise a new lane above; new lane zones', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)];
  p.texts = [txt('t1', 0, 4), txt('t2', 8, 12), txt('m', 20, 22)]; ensureLanes(p);
  const m = p.texts[2];
  let r = placeLaneItem(p, 'text', m, 4.5, 0); // free gap 4..8 holds 2 s
  assert.deepEqual([r.lane, r.start, r.pushed], [0, 4.5, false]);
  r = placeLaneItem(p, 'text', m, 3, 0); // overlaps t1: nearest free is 4 (1 s away, within half the length 1.0)
  assert.equal(r.start, 4); assert.equal(r.lane, 0);
  r = placeLaneItem(p, 'text', m, 9, 0); // inside t2: nearest free spot is far -> new lane above
  assert.equal(r.pushed, true); assert.equal(m.lane, 1); assert.equal(m.start, 9); assert.equal(m.end, 11);
  placeLaneItem(p, 'text', m, 30, { newAt: 0 }); // a new lane below everything
  assert.equal(m.lane, 0); assert.deepEqual(p.texts.filter(t => t.id !== 'm').map(laneOf), [1, 1]);
});

test('clipToOverlay and overlayToClip convert in place and keep the timing', () => {
  const p = proj(clip('a', 4), clip('b', 4, { speed: 2, volume: 0.5 }), clip('c', 4));
  const o = clipToOverlay(p, 'b', false);
  assert.equal(o.start, 4); assert.equal(o.speed, 2); assert.equal(o.volume, 0.5);
  assert.deepEqual(layout(p).items.map(i => [i.clip.id, i.start]), [['a', 0], ['c', 6]]); // Ripple off: c stays where it was
  const c2 = overlayToClip(p, o.id, 4.2);
  assert.equal(p.overlays.length, 0);
  assert.deepEqual(layout(p).items.map(i => [i.clip.id === 'a' || i.clip.id === 'c' ? i.clip.id : 'new', i.start]), [['a', 0], ['new', 4], ['c', 6]]);
  assert.equal(c2.speed, 2);
});

test('overlays: higher lane is drawn later (on top)', () => {
  const p = newProject('T'); p.clips = [clip('a', 20)];
  p.overlays = [ovl('o1', 0, 10), ovl('o2', 0, 10)]; ensureLanes(p);
  assert.deepEqual(overlaysAt(p, 1).map(o => o.id), ['o1', 'o2']);
  p.overlays[0].lane = 1; p.overlays[1].lane = 0;
  assert.deepEqual(overlaysAt(p, 1).map(o => o.id), ['o2', 'o1']);
});

test('migrate: old projects keep clips, order and timing; gaps and lanes default to the old look', () => {
  const old = { schema: 5, name: 'Old', clips: [clip('a', 4), clip('b', 4)], texts: [txt('t1', 0, 3), txt('t2', 1, 2)], overlays: [], audio: [newAudio({ id: 'm1', duration: 30 }, 2)], blurs: [newBlur(0, 2)] };
  for (const c of old.clips) delete c.gap;
  const p = migrate(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(layout(p).items.map(i => [i.start, i.end]), [[0, 4], [4, 8]]);
  assert.deepEqual(p.texts.map(laneOf), [0, 1]); assert.equal(p.audio[0].lane, 0); assert.equal(p.blurs[0].lane, 0);
  assert.ok(p.clips.every(c => c.gap === 0));
});

test('splitting a clip after a gap keeps the gap before the first half only', () => {
  const p = proj(clip('a', 4), clip('b', 6, { gap: 3 }));
  const r = splitItem(p, { type: 'clip', id: 'b' }, 10);
  assert.ok(!r.fail);
  assert.deepEqual(layout(p).items.map(i => [i.start, i.end]), [[0, 4], [7, 10], [10, 13]]);
});

test('insertLane / freeSpot / nearestFree basics', () => {
  assert.equal(nearestFree([[2, 4]], 1, 3).dist, 1);
  assert.equal(nearestFree([[2, 4], [5, 9]], 1, 4.2).start, 4);
  const p = newProject('T'); p.clips = [clip('a', 30)]; p.texts = [{ ...txt('t', 0, 2), lane: 0 }, { ...txt('u', 0, 2), lane: 1 }];
  insertLane(p, 'text', 1); assert.deepEqual(p.texts.map(laneOf), [0, 2]);
  assert.equal(freeSpot(p, 'text', 0, p.texts[1], 2, 1, 30).start, 2);
});
