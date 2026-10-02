// Free placement: gaps on the main track, stacked lanes, no same-lane overlap, clip <-> overlay conversion, old-project migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, migrate, layout, normalizeClip, newText, newBlur, newAudio, normalizeOverlay, ensureLanes, laneOf, placeItem, planItem, moveClipTo, removeClip, overlaysAt, insertLane, nearestFree, splitItem, findItem, laneCount } from '../js/model.js';

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

const laneIds = (p, kind) => p[{ text: 'texts', overlay: 'overlays', audio: 'audio', blur: 'blurs', clip: 'clips', caption: 'captions' }[kind]].map(x => [x.id, laneOf(x)]);
const cap = (id, s, e) => ({ id, start: s, end: e, text: id });

test('new items without a lane: same kind shares a free lane, overlap opens a lane above, kinds sit where the old tracks were', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)];
  p.texts = [txt('t1', 0, 5), txt('t2', 8, 9), txt('t3', 3, 6)];
  p.overlays = [ovl('o1', 0, 4)]; p.audio = [Object.assign(newAudio({ id: 'm1', duration: 30 }, 1), { id: 'au1' })];
  ensureLanes(p);
  // audio at the bottom, then the clip, the overlay above it, and the texts on top (t3 overlaps t1, so it gets its own lane)
  assert.equal(laneOf(p.audio[0]), 0); assert.equal(laneOf(p.clips[0]), 1); assert.equal(laneOf(p.overlays[0]), 2);
  assert.deepEqual(p.texts.map(laneOf), [3, 3, 4]);
  assert.equal(laneCount(p), 5);
});

test('lanes are generic: any kind of item can share a lane when they do not overlap in time, and overlap splits them', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)];
  p.texts = [{ ...txt('t1', 0, 5), lane: 0 }]; p.captions = [{ ...cap('c1', 10, 12), lane: 0 }]; p.audio = [{ ...newAudio({ id: 'm1', duration: 30 }, 14), id: 'au', lane: 0, out: 4 }];
  p.clips[0].lane = 1; p.laneModel = 2;
  ensureLanes(p);
  assert.deepEqual([laneOf(p.texts[0]), laneOf(p.captions[0]), laneOf(p.audio[0])], [0, 0, 0]); // text, caption and music on ONE lane
  p.texts[0].start = 9.5; p.texts[0].end = 11; ensureLanes(p); // now over the caption
  assert.notEqual(laneOf(p.captions[0]), laneOf(p.texts[0])); // one of them moved to a new lane
  assert.equal(laneOf(p.clips[0]), 2); // the lane above was opened and everything higher moved up
});

test('empty lanes close up', () => {
  const p = newProject('T'); p.clips = [clip('a', 20)]; p.clips[0].lane = 5;
  p.texts = [{ ...txt('t1', 0, 5), lane: 2 }, { ...txt('t2', 4, 8), lane: 9 }]; p.laneModel = 2;
  ensureLanes(p);
  assert.deepEqual([laneOf(p.texts[0]), laneOf(p.texts[1]), laneOf(p.clips[0])], [0, 2, 1]);
});

test('placeItem: nearest free spot when close, otherwise a new lane above; new-lane drops at either end', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)];
  p.texts = [txt('t1', 0, 4), txt('t2', 8, 12), txt('m', 20, 22)]; ensureLanes(p);
  const m = p.texts[2], L = laneOf(p.texts[0]);
  let r = placeItem(p, 'text', m, 4.5, L); // free gap 4..8 holds 2 s
  assert.deepEqual([r.lane, r.start, r.pushed], [L, 4.5, false]);
  r = placeItem(p, 'text', m, 3, L); // overlaps t1: nearest free is 4 (within half its length)
  assert.equal(r.start, 4); assert.equal(r.lane, L);
  r = placeItem(p, 'text', m, 9, L); // inside t2: nearest free spot is far -> a new lane above
  assert.equal(r.pushed, true); assert.equal(laneOf(m), L + 1); assert.equal(m.start, 9); assert.equal(m.end, 11);
  placeItem(p, 'text', m, 30, { newAt: 0 }); // a new lane below everything (the text now sits under the clip)
  assert.equal(laneOf(m), 0); assert.ok(laneOf(p.texts[0]) > laneOf(p.clips[0]) - 1);
});

test('any item on any lane: text under the clip, music above, a video on a lane with captions', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)]; p.texts = [txt('t', 2, 4)]; p.audio = [Object.assign(newAudio({ id: 'm1', duration: 30 }, 0), { id: 'au', out: 4 })];
  p.captions = [cap('c1', 5, 8)]; ensureLanes(p);
  const t = p.texts[0], au = p.audio[0], c = p.captions[0];
  placeItem(p, 'text', t, 2, { newAt: 0 }); // the text goes to a new lowest lane
  assert.equal(laneOf(t), 0); assert.ok(laneOf(p.clips[0]) > 0);
  const top = laneCount(p);
  placeItem(p, 'audio', au, 0, { newAt: top }); // music on the very top lane
  assert.equal(laneOf(au), laneCount(p) - 1);
  placeItem(p, 'caption', c, 12, laneOf(au)); // a caption onto the music lane (free there)
  assert.equal(laneOf(c), laneOf(au)); assert.equal(c.start, 12);
});

test('captions never overlap each other, even on different lanes', () => {
  const p = newProject('T'); p.clips = [clip('a', 30)]; p.captions = [cap('c1', 1, 3), cap('c2', 6, 8)]; ensureLanes(p);
  const r = placeItem(p, 'caption', p.captions[1], 2, { newAt: 0 });
  assert.ok(r.start >= 3 - 1e-6 || r.start + 2 <= 1 + 1e-6);
});

test('a main clip dropped over another main clip becomes a full-frame layer; elsewhere it stays a clip with its lane', () => {
  const p = proj(clip('a', 4), clip('b', 4, { speed: 2, volume: 0.5, width: 1920, height: 1080 }), clip('c', 4)); ensureLanes(p);
  p.texts = [txt('t', 0, 2)]; ensureLanes(p);
  const l0 = laneOf(p.clips[0]);
  const r = placeItem(p, 'clip', p.clips[1], 1, { newAt: l0 + 1 }); // over clip a (0..4) on a new lane
  assert.equal(r.stack, true); assert.equal(r.kind, 'overlay');
  assert.equal(p.overlays.length, 1); assert.equal(p.overlays[0].start, 1); assert.equal(p.overlays[0].speed, 2); assert.equal(p.overlays[0].volume, 0.5);
  assert.equal(p.overlays[0].x, 0.5); assert.equal(p.overlays[0].w, 1); assert.equal(laneOf(p.overlays[0]), l0 + 1);
  const q = proj(clip('a', 4), clip('b', 4)); ensureLanes(q);
  const r2 = placeItem(q, 'clip', q.clips[1], 9, { newAt: 5 }); // far past the end, on a lane of its own: stays a clip
  assert.equal(r2.kind, 'clip'); assert.equal(q.clips[1].gap, 5); assert.equal(laneOf(q.clips[1]) > laneOf(q.clips[0]), true);
});

test('overlays: higher lane is drawn later (on top)', () => {
  const p = newProject('T'); p.clips = [clip('a', 20)];
  p.overlays = [ovl('o1', 0, 10), ovl('o2', 0, 10)]; ensureLanes(p);
  assert.deepEqual(overlaysAt(p, 1).map(o => o.id), ['o1', 'o2']);
  p.overlays[0].lane = laneOf(p.overlays[1]) + 1; ensureLanes(p);
  assert.deepEqual(overlaysAt(p, 1).map(o => o.id), ['o2', 'o1']);
});

test('migrate: an old project (no lanes at all) keeps its drawing order: sound below, clips, overlays, blur, text, captions', () => {
  const old = { schema: 5, name: 'Old', clips: [clip('a', 4), clip('b', 4)], texts: [txt('t1', 0, 3), txt('t2', 1, 2)], overlays: [ovl('o1', 0, 3), ovl('o2', 1, 2)], audio: [newAudio({ id: 'm1', duration: 30 }, 2)], blurs: [newBlur(0, 2)], captions: [cap('c1', 0, 2)] };
  for (const c of old.clips) delete c.gap;
  const p = migrate(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(layout(p).items.map(i => [i.start, i.end]), [[0, 4], [4, 8]]);
  assert.ok(p.clips.every(c => c.gap === 0));
  const ln = (x) => laneOf(x);
  assert.equal(p.laneModel, 2);
  assert.ok(ln(p.audio[0]) < ln(p.clips[0]) && ln(p.clips[0]) === ln(p.clips[1]));
  assert.ok(ln(p.clips[0]) < ln(p.overlays[0]) && ln(p.overlays[0]) < ln(p.overlays[1]));
  assert.ok(ln(p.overlays[1]) < ln(p.blurs[0]) && ln(p.blurs[0]) < ln(p.texts[0]) && ln(p.texts[0]) < ln(p.texts[1]) && ln(p.texts[1]) < ln(p.captions[0]));
});

test('migrate: a project saved with per-kind lanes (the previous version) keeps its stacking inside each kind', () => {
  const old = { schema: 5, name: 'Prev', clips: [clip('a', 20)], texts: [{ ...txt('t1', 0, 3), lane: 0 }, { ...txt('t2', 1, 2), lane: 1 }], overlays: [{ ...ovl('o1', 0, 3), lane: 1 }, { ...ovl('o2', 1, 2), lane: 0 }] };
  const p = migrate(JSON.parse(JSON.stringify(old)));
  assert.ok(laneOf(p.overlays[1]) < laneOf(p.overlays[0]));
  assert.ok(laneOf(p.texts[0]) < laneOf(p.texts[1]));
  assert.ok(laneOf(p.overlays[0]) < laneOf(p.texts[0]));
  const again = migrate(JSON.parse(JSON.stringify(p))); // migrating twice changes nothing
  assert.deepEqual(laneIds(again, 'text'), laneIds(p, 'text')); assert.deepEqual(laneIds(again, 'overlay'), laneIds(p, 'overlay'));
});

test('splitting a clip after a gap keeps the gap before the first half only', () => {
  const p = proj(clip('a', 4), clip('b', 6, { gap: 3 }));
  const r = splitItem(p, { type: 'clip', id: 'b' }, 10);
  assert.ok(!r.fail);
  assert.deepEqual(layout(p).items.map(i => [i.start, i.end]), [[0, 4], [7, 10], [10, 13]]);
});

test('insertLane / findItem / nearestFree basics', () => {
  assert.equal(nearestFree([[2, 4]], 1, 3).dist, 1);
  assert.equal(nearestFree([[2, 4], [5, 9]], 1, 4.2).start, 4);
  const p = newProject('T'); p.clips = [clip('a', 30)]; p.laneModel = 2; p.clips[0].lane = 0; p.texts = [{ ...txt('t', 0, 2), lane: 1 }, { ...txt('u', 0, 2), lane: 2 }];
  insertLane(p, 1); assert.deepEqual(p.texts.map(laneOf), [2, 3]);
  assert.equal(findItem(p, 'u').kind, 'text'); assert.equal(findItem(p, 'a').kind, 'clip'); assert.equal(findItem(p, 'zzz'), null);
  assert.ok(planItem(p, 'text', p.texts[0], 5, 3));
});
