// Freeze frame model (js/freeze.js): split + still image between the halves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, layout, clipLen } from '../js/model.js';
import { insertFreeze, freezeTarget, freezeLen } from '../js/freeze.js';

const vid = { id: 'm1', kind: 'video', name: 'a.mp4', duration: 10, width: 640, height: 360, hasAudio: true };
const img = { id: 'm2', kind: 'image', name: 'f.jpg', duration: 0, width: 640, height: 360 };
function proj() { const p = newProject('t'); p.clips.push(newClipFromMedia(vid, p.settings)); return p; }

test('freezeLen clamps to 0.5..30 s and defaults to 2', () => {
  assert.equal(freezeLen(2), 2); assert.equal(freezeLen(0), 0.5); assert.equal(freezeLen(99), 30); assert.equal(freezeLen('x'), 2);
});
test('freeze in the middle splits the clip and puts a still between the halves', () => {
  const p = proj(); const total0 = layout(p).total;
  const r = insertFreeze(p, 4, img, 2);
  assert.ok(!r.fail); assert.equal(p.clips.length, 3);
  assert.deepEqual(p.clips.map(c => c.kind), ['video', 'image', 'video']);
  assert.ok(Math.abs(clipLen(p.clips[0]) - 4) < 1e-6); assert.equal(clipLen(p.clips[1]), 2);
  assert.ok(Math.abs(layout(p).total - (total0 + 2)) < 1e-6);
  assert.equal(p.clips[2].in, p.clips[0].out); // nothing lost, nothing repeated
  assert.equal(p.clips[1].transition.type, 'cut');
});
test('freeze at the very start / end does not split', () => {
  const p = proj(); const r = insertFreeze(p, 0, img, 1); assert.equal(p.clips.length, 2); assert.equal(p.clips[0].kind, 'image'); assert.equal(r.left, null);
  const q = proj(); insertFreeze(q, 9.99, img, 1); assert.equal(q.clips.length, 2); assert.equal(q.clips[1].kind, 'image');
});
test('freeze copies the look of the clip, and refuses images / empty timeline', () => {
  const p = proj(); p.clips[0].opacity = 0.5; p.clips[0].color.brightness = 0.2;
  const r = insertFreeze(p, 5, img, 2); assert.equal(r.freeze.opacity, 0.5); assert.equal(r.freeze.color.brightness, 0.2);
  assert.ok(freezeTarget(p, 6.0).fail, 'on the freeze itself (image)');
  assert.ok(freezeTarget(newProject('e'), 1).fail);
});
test('freeze honours the clip speed for the source time', () => {
  const p = proj(); p.clips[0].speed = 2; const tg = freezeTarget(p, 1);
  assert.ok(Math.abs(tg.srcTime - 2) < 1e-6);
});
