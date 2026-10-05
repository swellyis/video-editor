// Timeline cut engine (js/cut.js): word ranges → cutRanges (ripple, captions re-timed, micro-fade).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, newText, newAudio, layout, ensureLanes } from '../js/model.js';
import { newCaption } from '../js/captions.js';
import { mergeRanges, wordRanges, overlapOf, cutRanges, MICRO_FADE } from '../js/cut.js';

const vid = (id, d = 10) => ({ id, kind: 'video', name: id + '.mp4', duration: d, width: 640, height: 360, hasAudio: true });
function proj() {
  const p = newProject('t');
  p.clips.push(newClipFromMedia(vid('m1', 10), p.settings));
  p.texts.push(newText(2, 3, 'Hello'));
  p.audio.push(Object.assign(newAudio(vid('a1', 8), 0), { voice: true, duck: false }));
  p.captions = [
    newCaption(0.5, 2.5, 'And so my fellow', [{ w: 'And', start: 0.5, end: 0.8 }, { w: 'so', start: 0.8, end: 1.0 }, { w: 'my', start: 1.0, end: 1.2 }, { w: 'fellow', start: 1.2, end: 1.8 }]),
    newCaption(2.5, 5.0, 'Americans ask not', [{ w: 'Americans', start: 2.5, end: 3.2 }, { w: 'ask', start: 3.3, end: 3.6 }, { w: 'not', start: 3.6, end: 4.0 }]),
  ];
  ensureLanes(p); return p;
}

test('mergeRanges sorts, drops empties, joins close ones', () => {
  assert.deepEqual(mergeRanges([{ a: 2, b: 3 }, { a: 0.5, b: 1 }, { a: 1.02, b: 1.5 }, { a: 5, b: 5 }]), [{ a: 0.5, b: 1.5 }, { a: 2, b: 3 }]);
});
test('wordRanges pads into gaps, never into a neighbour, runs of neighbours fuse', () => {
  const ws = [{ w: 'a', start: 1, end: 1.2 }, { w: 'um', start: 1.5, end: 1.7 }, { w: 'uh', start: 1.75, end: 1.9 }, { w: 'b', start: 2.2, end: 2.5 }];
  const r = wordRanges(ws, [1, 2], { pad: 0.12 });
  assert.equal(r.length, 1);
  assert.ok(r[0].a >= 1.2 && r[0].a <= 1.5, 'pad stops at previous word: ' + r[0].a);
  assert.ok(r[0].b >= 1.9 && r[0].b <= 2.2, 'pad stops at next word: ' + r[0].b);
  assert.equal(wordRanges(ws, [1], { pad: 0.12 }).length, 1);
});
test('overlapOf measures how much a stretch loses', () => {
  assert.ok(Math.abs(overlapOf([{ a: 1, b: 2 }, { a: 3, b: 5 }], 0, 10) - 3) < 1e-9);
  assert.ok(Math.abs(overlapOf([{ a: 1, b: 3 }], 2, 4) - 1) < 1e-9);
});
test('cutRanges shortens the timeline by the removed length (ripple)', () => {
  const p = proj(), before = layout(p).total;
  const r = cutRanges(p, [{ a: 1, b: 3 }]);
  assert.ok(r && Math.abs(r.removed - 2) < 0.05, JSON.stringify(r));
  assert.ok(Math.abs(layout(p).total - (before - 2)) < 0.05, 'total ' + layout(p).total);
});
test('cutRanges trims a main clip mid-speech and puts a micro-fade at the join', () => {
  const p = proj();
  cutRanges(p, [{ a: 2, b: 4 }]);
  assert.equal(p.clips.length, 2, 'one split → two pieces: ' + p.clips.length);
  assert.ok(p.clips[0].fadeOut >= MICRO_FADE);
  assert.ok(p.clips[1].fadeIn >= MICRO_FADE);
  assert.ok(layout(p).total < 9);
});
test('cutRanges removes a whole clip when the cut covers it', () => {
  const p = proj(); p.clips.push(newClipFromMedia(vid('m2', 5), p.settings));
  const before = layout(p).total;
  cutRanges(p, [{ a: 0, b: 10.05 }]); // whole first clip
  assert.equal(p.clips.length, 1);
  assert.ok(layout(p).total < before - 9);
});
test('cutRanges keeps captions in sync: words inside gone, later words shifted', () => {
  const p = proj();
  cutRanges(p, [{ a: 1.0, b: 2.0 }]); // removes "my" (and pads into so/fellow)
  const text = p.captions.map(c => c.text).join(' | ');
  assert.ok(!/\bmy\b/i.test(text), 'my removed: ' + text);
  assert.ok(/fellow|Americans/i.test(text), text);
  // everything after 2.0 s moves earlier by ~1 s
  const am = p.captions.find(c => /Americans/.test(c.text));
  assert.ok(am && am.start < 2.0, 'Americans moved earlier: ' + (am && am.start));
});
test('cutRanges cuts a voice track / text layer that overlaps the range', () => {
  const p = proj(); // text 2..5, voice audio 0..8
  const before = p.texts.reduce((n, t) => n + (t.end - t.start), 0);
  cutRanges(p, [{ a: 2.5, b: 3.5 }]);
  assert.ok(p.texts.length >= 1);
  const after = p.texts.reduce((n, t) => n + (t.end - t.start), 0);
  assert.ok(Math.abs(before - after - 1) < 0.05, 'text lost the 1 s cut: ' + before + ' → ' + after);
  // after ripple the pieces join at 2.5 (former 2..2.5 and 3.5..5 → 2.5..4)
  assert.ok(p.texts.some(t => Math.abs(t.end - 2.5) < 0.02) || p.texts.some(t => Math.abs(t.start - 2.5) < 0.02));
});
test('cutRanges is a no-op for empty / nonsense ranges', () => {
  const p = proj(), n = p.clips.length;
  assert.equal(cutRanges(p, []), null);
  assert.equal(p.clips.length, n);
});
test('MICRO_FADE is a short crossfade, not a long dip', () => {
  assert.ok(MICRO_FADE >= 0.01 && MICRO_FADE <= 0.05);
});
