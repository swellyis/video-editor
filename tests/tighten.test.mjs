// Unit tests for Tighten pauses (silence.js tightenRanges + the micro-fade cut): long pauses shrink to a breath, captions follow, one cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, layout } from '../js/model.js';
import { newCaption } from '../js/captions.js';
import { HOP, tightenRanges, cutSilences, MICRO_FADE, BREATHS } from '../js/silence.js';

function curve(total, pauses, { speech = -20, noise = -60 } = {}) {
  const n = Math.round(total / HOP), db = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i * HOP; db[i] = pauses.some(([a, b]) => t >= a && t < b) ? noise : speech; }
  return db;
}
const near = (a, b, tol = 0.025) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('every pause longer than the breath keeps exactly the breath, centred', () => {
  const db = curve(20, [[2, 3.5], [6, 6.4], [9, 9.42], [12, 15]]);
  const r = tightenRanges(db, { thr: -40, breath: 0.3 });
  // 1.5 s → 0.3 s, 0.4 s → 0.3 s is less than 0.15 s shorter (left alone), 0.42 → 0.3 is under 0.15 too, 3 s → 0.3 s
  assert.equal(r.length, 2);
  near(r[0].a, 2.15); near(r[0].b, 3.35); near(r[1].a, 12.15); near(r[1].b, 14.85);
  for (const x of r) near((x.a - x.from) + (x.to - x.b), 0.3);
  assert.equal(tightenRanges(db, { thr: -40, breath: 0.2 }).length, 4);
  assert.equal(tightenRanges(db, { thr: -40, breath: 1 }).length, 2);
  assert.deepEqual(BREATHS, [0.2, 0.3, 0.5, 0.75, 1]);
});

test('tightening a clip: shorter by the right amount, micro-fades at each join, captions moved with their words', () => {
  const p = newProject('t');
  const c = newClipFromMedia({ id: 'v', name: 'talk', kind: 'video', duration: 20, width: 1920, height: 1080, hasAudio: true }, p.settings); c.id = 'c1'; p.clips.push(c);
  p.captions.push(newCaption(0.5, 2, 'Hello there'), newCaption(3.5, 5.5, 'second line'), newCaption(15.2, 17, 'last words'));
  const db = curve(20, [[2, 3.5], [12, 15]]);
  const r = tightenRanges(db, { thr: -40, breath: 0.3 });
  const res = cutSilences(p, { type: 'clip', id: 'c1' }, r, { ripple: true, fade: MICRO_FADE });
  assert.ok(res); near(res.removed, 1.2 + 2.7, 0.05);
  near(layout(p).total, 20 - 3.9, 0.05);
  assert.equal(p.clips.length, 3);
  assert.equal(p.clips[0].fadeIn, 0); assert.equal(p.clips[0].fadeOut, MICRO_FADE);
  assert.equal(p.clips[1].fadeIn, MICRO_FADE); assert.equal(p.clips[1].fadeOut, MICRO_FADE);
  assert.equal(p.clips[2].fadeIn, MICRO_FADE); assert.equal(p.clips[2].fadeOut, 0);
  // captions: the second starts 1.2 s earlier, the third 3.9 s earlier
  near(p.captions[0].start, 0.5); near(p.captions[1].start, 3.5 - 1.2, 0.05); near(p.captions[2].start, 15.2 - 3.9, 0.05);
  // the pause left between the words is the breath
  const l = layout(p); near(l.items[1].start, 2.15, 0.05); near(l.items[2].start, 2.15 + (12.15 - 3.35), 0.05);
});
