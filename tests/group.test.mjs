// Multi-select + clipboard model (js/group.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, newText, newAudio, newOverlay, layout, ensureLanes, laneOf, audioSpan } from '../js/model.js';
import * as G from '../js/group.js';

const vid = (id, d = 10) => ({ id, kind: 'video', name: id + '.mp4', duration: d, width: 640, height: 360, hasAudio: true });
function proj() {
  const p = newProject('t');
  p.clips.push(newClipFromMedia(vid('m1', 5), p.settings), newClipFromMedia(vid('m2', 5), p.settings));
  p.texts.push(newText(1, 2, 'A'), newText(6, 2, 'B'));
  p.audio.push(newAudio(vid('a1', 8), 0));
  ensureLanes(p); return p;
}
const ids = (arr) => arr.map(x => x.id);

test('everything / clean / toggle', () => {
  const p = proj(); const all = G.everything(p);
  assert.equal(all.length, 5); assert.deepEqual(new Set(all.map(s => s.type)), new Set(['clip', 'text', 'audio']));
  assert.equal(G.clean(p, [...all, { type: 'text', id: 'nope' }, all[0]]).length, 5);
  let l = G.toggle([], all[0]); assert.equal(l.length, 1); l = G.toggle(l, all[0]); assert.equal(l.length, 0);
});
test('deleteMany removes all, one go (ripple closes the holes)', () => {
  const p = proj(); const total = layout(p).total;
  const n = G.deleteMany(p, [{ type: 'clip', id: p.clips[0].id }, { type: 'text', id: p.texts[1].id }, { type: 'audio', id: p.audio[0].id }], true);
  assert.equal(n, 3); assert.equal(p.clips.length, 1); assert.equal(p.texts.length, 1); assert.equal(p.audio.length, 0);
  assert.ok(layout(p).total < total);
});
test('duplicateMany puts each copy after its original', () => {
  const p = proj(); const sel = G.duplicateMany(p, [{ type: 'clip', id: p.clips[0].id }, { type: 'text', id: p.texts[0].id }], false);
  assert.equal(sel.length, 2); assert.equal(p.clips.length, 3); assert.equal(p.texts.length, 3);
  const t = p.texts.find(x => x.id === sel[1].id); assert.equal(t.start, 3);
});
test('splitMany splits only items under the playhead', () => {
  const p = proj(); const r = G.splitMany(p, G.everything(p), 2);
  assert.equal(r.split, 3, 'clip 1, text A and the audio are under 2 s'); assert.equal(p.clips.length, 3); assert.equal(p.texts.length, 3); assert.equal(p.audio.length, 2);
  assert.equal(r.skipped, 2);
});
test('muteMany mutes everything with sound, then unmutes', () => {
  const p = proj(); const l = G.everything(p);
  assert.deepEqual(G.muteMany(p, l), { muted: true, n: 3 }); assert.ok(p.clips.every(c => c.muted) && p.audio[0].muted);
  assert.equal(G.muteMany(p, l).muted, false);
  assert.equal(G.muteMany(p, [{ type: 'text', id: p.texts[0].id }]).muted, null);
});
test('moveMany moves the lane items by the same amount, never before 0', () => {
  const p = proj(); const l = [{ type: 'text', id: p.texts[0].id }, { type: 'text', id: p.texts[1].id }, { type: 'audio', id: p.audio[0].id }];
  const lane = p.texts.map(laneOf);
  let r = G.moveMany(p, l, 1.5, false); assert.equal(r.dt, 1.5);
  assert.deepEqual([p.texts[0].start, p.texts[0].end, p.texts[1].start, p.audio[0].start], [2.5, 4.5, 7.5, 1.5]);
  r = G.moveMany(p, l, -10, false); assert.equal(r.dt, -1.5, 'stops when the audio hits 0:00');
  assert.equal(p.audio[0].start, 0); assert.equal(p.texts[0].start, 1);
  assert.deepEqual(p.texts.map(laneOf), lane);
});
test('moveMany leaves ripple-joined clips alone and reports them', () => {
  const p = proj(); const r = G.moveMany(p, [{ type: 'clip', id: p.clips[0].id }, { type: 'text', id: p.texts[0].id }], 1, true);
  assert.equal(r.held, 1); assert.equal(r.moved, 1); assert.equal(p.texts[0].start, 2);
});
test('moveMany moves several clips together when Ripple is off', () => {
  const p = proj(); p.clips[1].gap = 0;
  const r = G.moveMany(p, p.clips.map(c => ({ type: 'clip', id: c.id })), 2, false);
  const lay = layout(p); assert.equal(r.moved, 2);
  assert.ok(Math.abs(lay.items[0].start - 2) < 1e-6 && Math.abs(lay.items[1].start - 7) < 1e-6, JSON.stringify(lay.items.map(i => i.start)));
});
test('copy + paste: relative spacing kept, new ids, same lane, overlaps get a new lane', () => {
  const p = proj(); const clip = G.copyItems(p, [{ type: 'text', id: p.texts[0].id }, { type: 'text', id: p.texts[1].id }]);
  assert.equal(clip.items[0].rel, 0); assert.equal(clip.items[1].rel, 5);
  const sel = G.pasteItems(p, clip, 20, false); assert.equal(sel.length, 2); assert.equal(p.texts.length, 4);
  const [a, b] = sel.map(s => p.texts.find(x => x.id === s.id)); assert.equal(a.start, 20); assert.equal(b.start, 25);
  assert.ok(!p.texts.some(x => x.id === p.texts[0].id && x !== p.texts[0]));
  // paste on top of the originals: ensureLanes opens a new lane
  const lanes0 = new Set(p.texts.map(laneOf)).size;
  G.pasteItems(p, clip, 1, false); ensureLanes(p);
  assert.ok(new Set(p.texts.map(laneOf)).size > lanes0);
});
test('paste of clips goes into the sequence at the playhead, keeping effects and keyframes', () => {
  const p = proj(); p.clips[0].fx = { ...(p.clips[0].fx || {}), list: [{ id: 'x' }] }; p.clips[0].keyframes = { opacity: [{ t: 0, v: 1 }, { t: 1, v: 0.5 }] };
  const clip = G.copyItems(p, [{ type: 'clip', id: p.clips[0].id }]);
  const sel = G.pasteItems(p, clip, 8, false);
  assert.equal(p.clips.length, 3); assert.equal(p.clips[2].id, sel[0].id, 'playhead in the second half of the last clip: pasted after it');
  assert.deepEqual(p.clips[2].keyframes, p.clips[0].keyframes); assert.deepEqual(p.clips[2].fx, p.clips[0].fx);
  const q = proj(); G.pasteItems(q, clip, 1, false); assert.equal(q.clips[0].id !== clip.items[0].data.id, true); assert.equal(q.clips.length, 3);
  const r = proj(); const total = layout(r).total; G.pasteItems(r, clip, 0, true); assert.ok(layout(r).total > total);
});
test('paste attributes copies the look onto every selected item of a matching kind', () => {
  const p = proj(); p.texts[0].color = '#ff0000'; p.texts[0].anim = { ...p.texts[0].anim, in: 'pop' };
  p.clips[0].opacity = 0.4; p.clips[0].volume = 0.3;
  const clip = G.copyItems(p, [{ type: 'text', id: p.texts[0].id }, { type: 'clip', id: p.clips[0].id }]);
  const n = G.pasteAttributes(p, clip, [{ type: 'text', id: p.texts[1].id }, { type: 'clip', id: p.clips[1].id }, { type: 'audio', id: p.audio[0].id }]);
  assert.equal(n, 2); assert.equal(p.texts[1].color, '#ff0000'); assert.equal(p.texts[1].anim.in, 'pop'); assert.equal(p.texts[1].text, 'B', 'the words stay');
  assert.equal(p.clips[1].opacity, 0.4); assert.equal(p.clips[1].volume, 0.3); assert.equal(p.clips[1].mediaId, 'm2');
  assert.equal(p.audio[0].volume, 0.6, 'no copied audio item: unchanged');
});
test('marquee hit test', () => {
  const hit = G.rectsHit({ l: 10, t: 10, r: 50, b: 50 }, [{ key: 'a', l: 0, t: 0, r: 20, b: 20 }, { key: 'b', l: 60, t: 0, r: 80, b: 20 }, { key: 'c', l: 40, t: 40, r: 90, b: 90 }]);
  assert.deepEqual(hit, ['a', 'c']);
});
test('overlay items are selectable and have spans', () => {
  const p = proj(); p.overlays.push(newOverlay(vid('o1', 3), 2, p.settings)); ensureLanes(p);
  assert.ok(G.everything(p).some(s => s.type === 'overlay'));
  assert.equal(audioSpan(p.audio[0], 10) > 0, true);
  assert.equal(ids(G.resolve(p, G.everything(p))).length, 6);
});
