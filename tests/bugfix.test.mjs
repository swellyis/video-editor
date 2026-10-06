// Regression tests for the Oct 2026 bug batch (freeze on keyframed clips, reframe time/coordinate mapping, clipboard media,
// AI cache versioning, unknown durations). Each was written failing first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, layout, animated, mediaSourceEnd } from '../js/model.js';
import { insertFreeze } from '../js/freeze.js';
import { buildReframe } from '../js/reframe.js';
import { mediaIdsOf } from '../js/db.js';

const vid = { id: 'm1', kind: 'video', name: 'a.mp4', duration: 10, width: 640, height: 360, hasAudio: true };
const img = { id: 'm2', kind: 'image', name: 'f.jpg', duration: 0, width: 640, height: 360 };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// ---------------------------------------------------------------- bug 2: freeze frame on keyframed clips
test('bug 2: the freeze holds the keyframed transform/opacity at the playhead (no jump)', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c);
  c.keyframes = { x: [{ t: 0, v: 0 }, { t: 4, v: 0.8 }], scale: [{ t: 0, v: 1 }, { t: 4, v: 2 }], rotation: [{ t: 0, v: 0 }, { t: 4, v: 40 }], opacity: [{ t: 0, v: 1 }, { t: 4, v: 0.5 }] };
  const want = animated('clip', c, 2);
  const r = insertFreeze(p, 2, img, 1);
  assert.ok(!r.fail);
  const f = r.freeze;
  assert.ok(near(f.transform.x, want.x), 'x ' + f.transform.x + ' vs ' + want.x);
  assert.ok(near(f.transform.zoom, want.scale), 'zoom ' + f.transform.zoom + ' vs ' + want.scale);
  assert.ok(near(f.transform.angle, want.rotation), 'angle');
  assert.ok(near(f.opacity, want.opacity), 'opacity ' + f.opacity);
  // the halves continue the motion from the same value
  assert.ok(near(animated('clip', r.left, 2 - 1e-6).x, want.x, 2e-3), 'left half ends at the freeze value');
  assert.ok(near(animated('clip', r.right, 0).x, want.x), 'right half starts at the freeze value');
});
test('bug 2: a freeze on a Ken Burns clip holds the Ken Burns position of that moment', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c);
  c.transform.kenBurns = 'in';
  const r = insertFreeze(p, 5, img, 1);
  const f = r.freeze;
  assert.equal(f.transform.kenBurns, 'in');
  assert.ok(near(f.transform.kbFrom, 0.5) && near(f.transform.kbTo, 0.5), JSON.stringify(f.transform));
});
test('bug 2: a freeze at the very start / end uses the first / last keyframed pose', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); p.clips.push(c);
  c.keyframes = { x: [{ t: 0, v: -0.5 }, { t: 10, v: 0.5 }] };
  const a = insertFreeze(p, 0.02, img, 1); assert.ok(near(a.freeze.transform.x, -0.5, 0.01), 'start ' + a.freeze.transform.x);
  const total = layout(p).total; const b = insertFreeze(p, total - 0.02, img, 1); assert.ok(near(b.freeze.transform.x, 0.5, 0.01), 'end ' + b.freeze.transform.x);
});

// ---------------------------------------------------------------- bug 3: auto reframe coordinate mapping / target
const face = (cx, cy, w = 0.1, h = 0.18) => ({ x: cx - w / 2, y: cy - h / 2, w, h, score: 0.9 });
test('bug 3: target "project" uses the project ratio (not always 9:16)', () => {
  const r = buildReframe([{ t: 0, faces: [face(0.8, 0.5)] }], 1920, 1080, 'project', { projectRatio: '1:1' });
  assert.equal(r.target.key, '1:1');
});
test('bug 3: a horizontally flipped clip pans the other way (face is drawn mirrored)', () => {
  const plain = buildReframe([{ t: 0, faces: [face(0.8, 0.5)] }], 1920, 1080, '9:16');
  const flip = buildReframe([{ t: 0, faces: [face(0.8, 0.5)] }], 1920, 1080, '9:16', { transform: { flipH: true } });
  assert.ok(plain.poses[0].x > 0.2 && flip.poses[0].x < -0.2, plain.poses[0].x + ' / ' + flip.poses[0].x);
});
test('bug 3: a clip rotated 90° uses the rotated frame (portrait source, face position rotated)', () => {
  // landscape 1920x1080 file rotated 90° clockwise shows as 1080x1920: a face at the TOP of the file (cy 0.2) ends up on the RIGHT
  const r = buildReframe([{ t: 0, faces: [face(0.5, 0.2)] }], 1920, 1080, '16:9', { transform: { rotate: 90 } });
  assert.ok(r.poses[0].x > 0.2, 'face at the TOP of the file → RIGHT of the rotated picture → positive x, got ' + r.poses[0].x);
  const r2 = buildReframe([{ t: 0, faces: [face(0.2, 0.5)] }], 1920, 1080, '16:9', { transform: { rotate: 90 } });
  assert.ok(r2.poses[0].y < -0.2, 'face at the LEFT of the file → TOP of the rotated picture → negative y, got ' + r2.poses[0].y);
});

// ---------------------------------------------------------------- bug 1 (sweep): media referenced only by a background-remove image is kept
test('bug 1/sweep: mediaIdsOf keeps a background-remove image (gc must not delete it)', () => {
  const p = newProject('t'); const c = newClipFromMedia(vid, p.settings); c.bgremove = { mode: 'image', mediaId: 'medBG' }; p.clips.push(c);
  assert.ok(mediaIdsOf(p).has('medBG'));
});

// ---------------------------------------------------------------- bug 6: unknown file length falls back to what the timeline uses
test('bug 6: mediaSourceEnd = the furthest trimmed source end of the items using a file (finite only)', () => {
  const p = newProject('x');
  p.clips.push({ ...newClipFromMedia(vid), in: 1, out: 6 }, { ...newClipFromMedia(vid), in: 2, out: 8.5 });
  p.audio.push({ id: 'a1', mediaId: 'm3', in: 0, out: Infinity, start: 0 }, { id: 'a2', mediaId: 'm3', in: 0, out: 4, start: 1 });
  assert.equal(mediaSourceEnd(p, 'm1'), 8.5);
  assert.equal(mediaSourceEnd(p, 'm3'), 4);
  assert.equal(mediaSourceEnd(p, 'nope'), 0);
});

// ---------------------------------------------------------------- bug 5: AI model cache versioning
test('bug 5: AI files have content-hash cache keys, and sw.js carries the same manifest', async () => {
  const fs = await import('node:fs'), crypto = await import('node:crypto'), path = await import('node:path');
  const { AI_FILES, AI_ROOT, aiKey } = await import('../js/ai-manifest.js');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const want = ['vendor/mediapipe/models/selfie_segmenter.tflite', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm', 'vendor/whisper/transformers.min.js', 'vendor/clean-strong/dpdfnet2_48khz_hr.onnx'];
  for (const rel of want) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    assert.ok(AI_FILES[rel] && h.startsWith(AI_FILES[rel]) && AI_FILES[rel].length >= 12, rel + ' hash is current');
    assert.equal(aiKey(AI_ROOT + rel), AI_ROOT + rel + '?h=' + AI_FILES[rel]);
    assert.equal(aiKey(AI_ROOT + rel + '?x=1'), AI_ROOT + rel + '?h=' + AI_FILES[rel], 'query ignored');
  }
  assert.equal(aiKey(AI_ROOT + 'js/app.js'), AI_ROOT + 'js/app.js', 'other files are untouched');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const m = /const AI_FILES = (\{[^;]*\});/.exec(sw);
  assert.ok(m, 'sw.js has the manifest');
  assert.deepEqual(JSON.parse(m[1]), AI_FILES);
  assert.ok(/'\.\/js\/ai-manifest\.js'/.test(sw), 'the manifest module is part of the app shell');
});
