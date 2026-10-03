// Unit tests for transitions: kinds, limits, how the layout overlaps clips, the picture parameters and the sound blend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, normalize, maxDuration, effective, look, soundGain, isOverlap, isDip, easeOf } from '../js/transitions.js';
import { removeClip, moveClip, newProject, newClipFromMedia, layout, activeAt, clipGain, migrate, splitAt, duplicateClip, arrangeMain, clipLen } from '../js/model.js';

const media = (id, d) => ({ id, name: id, kind: 'video', duration: d, width: 1280, height: 720, hasAudio: true });
function proj(lens, trs = {}) {
  const p = newProject('T'); p.clips = lens.map((d, i) => Object.assign(newClipFromMedia(media('m' + i, d)), { id: 'c' + i, fadeIn: 0, fadeOut: 0 }));
  for (const [i, tr] of Object.entries(trs)) p.clips[i].transition = { type: 'cut', duration: 0.5, ...tr };
  return p;
}
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);

test('all kinds are known, grouped, and either overlap or dip (or cut)', () => {
  assert.equal(TYPES.length, 15); assert.equal(new Set(TYPES.map(t => t.id)).size, 15);
  for (const t of TYPES) assert.ok(['cut', 'overlap', 'dip'].includes(t.kind));
  assert.ok(isOverlap('wipeleft') && isOverlap('crossfade') && isOverlap('blur') && !isOverlap('fade') && isDip('fade') && isDip('dipwhite'));
});
test('normalize: unknown types become cut, durations are limited, audio mode kept only when it is cut', () => {
  assert.deepEqual(normalize(null), { type: 'cut', duration: 0.6 });
  assert.deepEqual(normalize({ type: 'crossfade', duration: 0.6 }), { type: 'crossfade', duration: 0.6 });   // an old project, unchanged
  assert.equal(normalize({ type: 'sparkle', duration: 2 }).type, 'cut');
  assert.equal(normalize({ type: 'blur', duration: 99 }).duration, 10); assert.equal(normalize({ type: 'blur', duration: -3 }).duration, 0);
  assert.equal(normalize({ type: 'blur', duration: 1, audio: 'cut' }).audio, 'cut'); assert.equal('audio' in normalize({ type: 'blur', duration: 1, audio: 'x' }), false);
});
test('limits: at most half of the shorter clip for overlaps; the shorter clip for dips; clamped, never negative', () => {
  assert.equal(maxDuration('crossfade', 4, 10), 2); assert.equal(maxDuration('slideleft', 10, 3), 1.5);
  assert.equal(maxDuration('fade', 4, 10), 4); assert.equal(maxDuration('fade', Infinity, 6), 3); assert.equal(maxDuration('cut', 4, 4), 0);
  assert.equal(effective('wipeup', 3, 2, 8), 1); assert.equal(effective('wipeup', 0.5, 2, 8), 0.5);
});
test('layout: an overlap kind pulls the next clip earlier by the (clamped) duration, a dip keeps the length', () => {
  const p = proj([4, 4, 4], { 1: { type: 'wipeleft', duration: 0.5 }, 2: { type: 'fade', duration: 1 } });
  const l = layout(p);
  near(l.items[1].start, 3.5); near(l.items[1].xIn, 0.5); near(l.items[0].xOut, 0.5); assert.equal(l.items[1].xType, 'wipeleft'); assert.equal(l.items[0].xTypeOut, 'wipeleft');
  near(l.items[2].start, l.items[1].end); near(l.total, 3.5 + 4 + 4);                  // the dip does not shorten anything
  near(l.items[1].fadeOutBlack, 0.5); near(l.items[2].fadeInBlack, 0.5);
  const q = proj([4, 1], { 1: { type: 'slideup', duration: 3 } });
  near(layout(q).items[1].xIn, 0.5);                                                 // clamped to half of the 1 s clip
  const r = proj([4, 4], { 1: { type: 'zoomin', duration: 1 } }); r.clips[1].gap = 1;
  assert.equal(layout(r).items[1].xIn, 0);                                          // a gap cancels it
  const s = proj([4, 4], { 0: { type: 'crossfade', duration: 1 } });
  assert.equal(layout(s).items[0].xIn, 0);                                          // nothing before the first clip to blend with
});
test('old projects: crossfade and fade lay out exactly as before and migrate untouched', () => {
  const p = proj([4, 4, 4], { 1: { type: 'crossfade', duration: 0.6 }, 2: { type: 'fade', duration: 0.6 } });
  const m = migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(m.clips.map(c => c.transition), [{ type: 'cut', duration: 0.6 }, { type: 'crossfade', duration: 0.6 }, { type: 'fade', duration: 0.6 }].map((t, i) => (i ? t : p.clips[0].transition)));
  const l = layout(m); near(l.items[1].start, 3.4); near(l.items[2].fadeInBlack, 0.3); near(l.items[1].fadeOutBlack, 0.3);
  assert.equal(migrate({ name: 'x', clips: [{ ...p.clips[1], transition: { type: 'spin3d', duration: 2 } }] }).clips[0].transition.type, 'cut');
});
test('activeAt: the incoming clip carries progress; the outgoing clip is told too; a dip to white is a veil, not darkening', () => {
  const p = proj([4, 4, 4], { 1: { type: 'wiperight', duration: 1 }, 2: { type: 'dipwhite', duration: 1 } });
  const l = layout(p);
  let a = activeAt(l, 3.5); assert.equal(a.length, 2);
  assert.equal(a[0].tr.role, 'out'); near(a[0].tr.p, 0.5); assert.equal(a[1].tr.role, 'in'); near(a[1].tr.p, 0.5); assert.equal(a[1].tr.type, 'wiperight');
  a = activeAt(l, 1); assert.equal(a.length, 1); assert.equal(a[0].tr, null);
  const t = l.items[2].start;                                                         // the middle of the dip: fully white
  a = activeAt(l, t + 1e-9); near(a[0].white, 1, 1e-6); assert.equal(a[0].black, 1);
  a = activeAt(l, t - 0.25); near(a[0].white, 0.5, 1e-6);                             // outgoing half
  a = activeAt(l, t + 0.25); near(a[0].white, 0.5, 1e-6);
  const b = proj([4, 4], { 1: { type: 'fade', duration: 1 } }); a = activeAt(layout(b), layout(b).items[1].start + 0.25); near(a[0].black, 0.5, 1e-6); assert.equal(a[0].white, 0);
});
test('look: wipes reveal from the arrow side, slides push, zooms and blur are symmetric and tasteful', () => {
  let L = look('wipeleft', 0.5); assert.ok(L.inn.clip.x0 > 0.4 && L.inn.clip.x1 === 1 && L.inn.alpha === 1 && L.out.alpha === 1);
  L = look('wiperight', 0.5); assert.ok(L.inn.clip.x0 === 0 && L.inn.clip.x1 < 0.6);
  L = look('wipeup', 0.5); assert.ok(L.inn.clip.y0 > 0.4 && L.inn.clip.y1 === 1); L = look('wipedown', 0.5); assert.ok(L.inn.clip.y1 < 0.6 && L.inn.clip.y0 === 0);
  L = look('slideleft', 0.5); near(L.out.dx, -0.5); near(L.inn.dx, 0.5); L = look('slideright', 1); near(L.out.dx, 1); near(L.inn.dx, 0);
  L = look('slideup', 0.25); assert.ok(L.out.dy < 0 && L.inn.dy > 0);
  L = look('crossfade', 0.3); near(L.inn.alpha, 0.3); assert.equal(L.out.alpha, 1);       // the dissolve stays linear
  assert.ok(look('zoomin', 1).out.scale > 1.2 && look('zoomout', 1).out.scale < 1); assert.ok(look('blur', 0.5).inn.blur > 0 && look('blur', 0).inn.blur > look('blur', 0.5).inn.blur);
  for (const t of TYPES) if (t.kind === 'overlap') { const a = look(t.id, 0), z = look(t.id, 1); assert.ok(a.inn.alpha <= 0.001 || a.inn.clip || a.inn.dx || a.inn.dy, t.id + ' start'); assert.ok(Math.abs(z.out.dx) <= 1 && z.inn.alpha >= 0.999 && !z.inn.dx && !z.inn.dy && z.inn.scale === 1 && z.inn.blur === 0, t.id + ' end'); }
  assert.ok(easeOf('wipeleft', 0.25) < 0.25 && easeOf('crossfade', 0.25) === 0.25);
});
test('sound: equal power across the overlap, or a hard cut in the middle', () => {
  for (const p of [0, 0.25, 0.5, 0.75, 1]) { const i = soundGain('cross', p, 1), o = soundGain('cross', 1 - p, 1); near(i * i + o * o, 1, 1e-9); }
  near(soundGain('cross', 0.5, 1), Math.SQRT1_2, 1e-9);
  assert.equal(soundGain('cut', 0.2, 1), 0); assert.equal(soundGain('cut', 0.8, 1), 1); near(soundGain('cut', 0.5, 1), 0.5); assert.equal(soundGain('cross', 0.3, 0), 1);
  const p = proj([4, 4], { 1: { type: 'wipeleft', duration: 1 } }); const l = layout(p);
  const mid = l.items[1].start + 0.5;
  near(clipGain(l.items[1], mid), Math.SQRT1_2, 1e-9); near(clipGain(l.items[0], mid), Math.SQRT1_2, 1e-9);
  p.clips[1].transition.audio = 'cut'; const l2 = layout(p);
  assert.equal(clipGain(l2.items[0], l2.items[1].start + 0.2), 1); assert.equal(clipGain(l2.items[1], l2.items[1].start + 0.2), 0); assert.equal(clipGain(l2.items[1], l2.items[1].start + 0.8), 1); assert.equal(clipGain(l2.items[0], l2.items[1].start + 0.8), 0);
});
test('split and duplicate: the outer transitions stay, the new inner join is a cut', () => {
  const p = proj([6, 6], { 1: { type: 'slideleft', duration: 1 } });
  const lay = layout(p); const b = splitAt(p, lay.items[0].start + 3); assert.ok(b);
  assert.deepEqual(p.clips.map(c => c.transition.type), ['cut', 'cut', 'slideleft']);
  const q = proj([6, 6], { 1: { type: 'blur', duration: 1 } }); duplicateClip(q, 'c0', false);
  assert.deepEqual(q.clips.map(c => c.transition.type), ['cut', 'cut', 'blur']);
});
test('moving: a clip keeps its transition only while it still follows the same clip', () => {
  const p = proj([4, 4, 4], { 1: { type: 'zoomout', duration: 0.5 }, 2: { type: 'wipeup', duration: 0.5 } });
  const lay = layout(p);
  // same neighbour, same place: nothing changes
  arrangeMain(p, lay.items.map(i => ({ clip: i.clip, start: i.start, prev: i.index ? lay.items[i.index - 1].clip : null })));
  assert.deepEqual(p.clips.map(c => c.transition.type), ['cut', 'zoomout', 'wipeup']);
  // clip 2 moved to the front: it follows nothing, c0 follows it, c1 follows c0 again -> c0 and the old joins lose theirs when the neighbour changed
  const c = p.clips; const ents = [{ clip: c[2], start: 0, prev: null }, { clip: c[0], start: 4, prev: c[2] }, { clip: c[1], start: 8, prev: c[0] }];
  arrangeMain(p, ents);
  assert.deepEqual(p.clips.map(x => x.id), ['c2', 'c0', 'c1']); assert.equal(p.clips[1].transition.type, 'cut'); assert.equal(clipLen(p.clips[0]), 4);
  assert.equal(p.clips[0].transition.type, 'wipeup');                                    // first clip: nothing before it, left as data
});

test('delete and reorder: a transition belongs to one join, so it is removed when the clip before changes', () => {
  const p = proj([4, 4, 4, 4], { 1: { type: 'zoomout', duration: 0.5 }, 2: { type: 'wipeup', duration: 0.5 }, 3: { type: 'blur', duration: 0.5 } });
  removeClip(p, 'c1', true);
  assert.deepEqual(p.clips.map(c => c.transition.type), ['cut', 'cut', 'blur']);          // c2 now follows c0 (was c1): removed; c3 still follows c2: kept
  const q = proj([4, 4, 4], { 1: { type: 'zoomout', duration: 0.5 }, 2: { type: 'wipeup', duration: 0.5 } });
  moveClip(q, 2, 0);
  assert.deepEqual(q.clips.map(c => c.id + ':' + c.transition.type), ['c2:cut', 'c0:cut', 'c1:zoomout']);
  const r = proj([4, 4, 4], { 1: { type: 'zoomout', duration: 0.5 }, 2: { type: 'wipeup', duration: 0.5 } });
  moveClip(r, 1, 1); assert.deepEqual(r.clips.map(c => c.transition.type), ['cut', 'zoomout', 'wipeup']);
});
