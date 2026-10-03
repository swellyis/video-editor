// Unit tests for Remove silences: the detector (loudness curve -> silent stretches) and the cut (model edit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, newClipFromMedia, newAudio, newText, normalizeOverlay, layout, ensureLanes, clipLen, MIN_CLIP } from '../js/model.js';
import { newCaption } from '../js/captions.js';
import { HOP, DEFAULTS, normSettings, autoThreshold, findSilences, plan, cutItem, cutSilences, spanOf, cuttable } from '../js/silence.js';

// a loudness curve: speech (-20 dB) with pauses given as [from, to] seconds, over `noise` dB background
function curve(total, pauses, { speech = -20, noise = -60, jitter = 2 } = {}) {
  const n = Math.round(total / HOP), db = new Float32Array(n);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < n; i++) {
    const t = i * HOP, quiet = pauses.some(([a, b]) => t >= a && t < b);
    db[i] = (quiet ? noise : speech) + rnd() * jitter;
  }
  return db;
}
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('detector finds the pauses with the padding kept on each side', () => {
  const db = curve(20, [[3, 5], [9, 9.5], [12, 15.4]]);
  const s = findSilences(db, { thr: -40, minPause: 1, pad: 0.25 });
  assert.equal(s.length, 2); // the 0.5 s pause is below the minimum
  near(s[0].from, 3); near(s[0].to, 5); near(s[0].a, 3.25); near(s[0].b, 4.75);
  near(s[1].a, 12.25); near(s[1].b, 15.15);
});
test('minimum pause and padding change the result; short blips do not break a pause', () => {
  const db = curve(20, [[2, 2.6], [6, 8]]);
  assert.equal(findSilences(db, { thr: -40, minPause: 1 }).length, 1);
  assert.equal(findSilences(db, { thr: -40, minPause: 0.5 }).length, 2);
  const blip = curve(20, [[2, 5]]); blip[Math.round(3.5 / HOP)] = -20; blip[Math.round(3.5 / HOP) + 1] = -20; // a 40 ms click
  const s = findSilences(blip, { thr: -40, minPause: 1, pad: 0 });
  assert.equal(s.length, 1); near(s[0].a, 2); near(s[0].b, 5);
  const wide = findSilences(db, { thr: -40, minPause: 1, pad: 0.5 });
  near(wide[0].a, 6.5); near(wide[0].b, 7.5);
  assert.equal(findSilences(db, { thr: -40, minPause: 1, pad: 0.5 + 0.5 }).length, 0); // nothing left to remove
});
test('a pause at the start or end is cut to the edge, the speech side keeps its pad', () => {
  const s = findSilences(curve(10, [[0, 2], [8, 10]]), { thr: -40, minPause: 1, pad: 0.25 });
  assert.equal(s.length, 2);
  near(s[0].a, 0); near(s[0].b, 1.75); near(s[1].a, 8.25); near(s[1].b, 10);
});
test('t0 offsets the result (source time)', () => {
  const s = findSilences(curve(10, [[3, 5]]), { thr: -40, minPause: 1, pad: 0, t0: 100 });
  near(s[0].a, 103); near(s[0].b, 105);
});
test('auto threshold follows the noise floor (quiet room and loud hum)', () => {
  for (const noise of [-75, -60, -48, -42]) {
    const db = curve(120, [[10, 13], [40, 42], [70, 74], [95, 97], [105, 110]], { noise, speech: -22 });
    const a = autoThreshold(db);
    assert.ok(a.thr > noise + 3 && a.thr < -28.1, `thr ${a.thr} for floor ${noise}`);
    const s = findSilences(db, { thr: a.thr, minPause: 1, pad: 0 });
    assert.equal(s.length, 5, 'floor ' + noise);
    near(s[0].a, 10); near(s[4].b, 110);
  }
  // a fixed -50 dB would miss the hum pauses: the whole point of Auto
  assert.equal(findSilences(curve(60, [[10, 13]], { noise: -42 }), { thr: -50, minPause: 1 }).length, 0);
});
test('auto threshold on steady noise or empty input does not invent pauses', () => {
  const flat = curve(60, [], { speech: -30, jitter: 3 });
  assert.equal(findSilences(flat, { thr: autoThreshold(flat).thr, minPause: 1 }).length, 0);
  assert.deepEqual(findSilences(new Float32Array(0), { thr: -40 }), []);
  assert.ok(Number.isFinite(autoThreshold(new Float32Array(0)).thr));
});
test('settings are normalised', () => {
  assert.deepEqual(normSettings(null), DEFAULTS);
  const n = normSettings({ auto: false, thr: -99, minPause: 99, pad: -3 });
  assert.equal(n.auto, false); assert.equal(n.thr, -60); assert.equal(n.minPause, 5); assert.equal(n.pad, 0);
  assert.equal(normSettings({ minPause: 'x' }).minPause, 1);
});

// ---------- cutting ----------
const media = (id, dur) => ({ id, name: id, kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: true });
function proj(dur = 60, extra) {
  const p = newProject('T'); p.clips = [newClipFromMedia(media('m1', dur))];
  p.clips[0].id = 'c1';
  if (extra) extra(p);
  ensureLanes(p); return p;
}
const R = (...r) => r.map(([a, b]) => ({ a, b }));

test('plan: clamps, merges close ranges and trims slivers', () => {
  const pl = plan({ in: 10, out: 40, sp: 1, len: 30 }, R([5, 12], [20, 25], [25.05, 30], [39.95, 50]));
  assert.deepEqual(pl.segs.map(s => [s.a, s.b]), [[12, 20], [30, 39.95]]);
  near(pl.segs[1].cum, 8, 1e-9); near(pl.newLen, 17.95, 1e-9); near(pl.removed, 12.05, 1e-9);
  const pl2 = plan({ in: 0, out: 10, sp: 1, len: 10 }, R([0.05, 3])); // a 50 ms sliver at the start goes too
  assert.deepEqual(pl2.segs.map(s => [s.a, s.b]), [[3, 10]]);
});
test('plan returns null when nothing or everything goes', () => {
  assert.equal(plan({ in: 0, out: 10, sp: 1 }, []), null);
  assert.equal(plan({ in: 0, out: 10, sp: 1 }, R([-1, 11])), null);
});
test('plan at 2x speed: lengths are source / speed', () => {
  const pl = plan({ in: 0, out: 20, sp: 2, len: 10 }, R([4, 10]));
  near(pl.newLen, 7, 1e-9); near(pl.removed, 3, 1e-9); near(pl.segs[1].u0, 5, 1e-9); near(pl.segs[1].cum, 2, 1e-9);
});

test('cut a main clip: pieces are contiguous, total shrinks by the removed time, one lane, ids unique', () => {
  const p = proj(60);
  const r = cutItem(p, 'clip', 'c1', R([10, 14], [30, 33]), { ripple: true });
  assert.equal(r.pieces.length, 3); near(r.removed, 7, 1e-9);
  const lay = layout(p);
  near(lay.total, 53, 1e-6);
  assert.deepEqual(p.clips.map(c => [c.in, c.out]), [[0, 10], [14, 30], [33, 60]]);
  assert.equal(new Set(p.clips.map(c => c.id)).size, 3);
  lay.items.forEach((it, i) => { if (i) near(it.start, lay.items[i - 1].end, 1e-6); });
  assert.ok(p.clips.slice(1).every(c => c.transition.type === 'cut' && !c.gap));
});
test('cut keeps keyframes in time with the picture and fades only at the ends', () => {
  const p = proj(60, (q) => {
    const c = q.clips[0]; c.fadeIn = 1; c.fadeOut = 2;
    c.keyframes = { volume: [{ t: 0, v: 0.5, ease: 'linear' }, { t: 20, v: 1, ease: 'linear' }, { t: 40, v: 0.2, ease: 'linear' }], x: [{ t: 5, v: 0.4, ease: 'linear' }, { t: 55, v: 0.6, ease: 'linear' }] };
  });
  cutItem(p, 'clip', 'c1', R([10, 20]), { ripple: true });
  const [a, b] = p.clips;
  assert.equal(a.fadeIn, 1); assert.equal(a.fadeOut, 0); assert.equal(b.fadeIn, 0); assert.equal(b.fadeOut, 2);
  const v = (c, t) => { const k = c.keyframes.volume; for (let i = 1; i < k.length; i++) if (t <= k[i].t) return k[i - 1].v + (k[i].v - k[i - 1].v) * (t - k[i - 1].t) / (k[i].t - k[i - 1].t); return k[k.length - 1].v; };
  near(v(a, 10), 0.75, 1e-6);            // end of the first piece: the value at source 10 s
  near(v(b, 0), 0.5 + 0.5 * 20 / 20, 1e-6); // start of the second piece: the value at source 20 s (=1)
  near(v(b, 20), 0.2 + 0.0, 1e-6);       // source 40 s
});
test('cut warps captions, text, markers and overlay/audio starts that sit in the item; ripple moves what comes after', () => {
  const mk = (q) => {
    q.clips.push(Object.assign(newClipFromMedia(media('m2', 30)), { id: 'c2' }));
    q.captions = [newCaption(5, 8, 'a'), newCaption(25, 28, 'b'), newCaption(70, 72, 'c')];
    q.captions[1].words = [{ w: 'x', start: 25, end: 26 }, { w: 'y', start: 27, end: 28 }];
    q.texts = [Object.assign(newText(22, 3, 't'), { id: 't1' })];
    q.markers = [{ id: 'mk1', time: 12, name: 'in the silence' }, { id: 'mk2', time: 40, name: 'after' }, { id: 'mk3', time: 62, name: 'later' }];
    q.audio = [Object.assign(newAudio({ id: 'mu', duration: 100 }, 26), { id: 'mus' }), Object.assign(newAudio({ id: 'mu', duration: 100 }, 65), { id: 'mus2' })];
  };
  const p = proj(60, mk);
  cutItem(p, 'clip', 'c1', R([10, 20]), { ripple: true });
  const cap = (i) => p.captions[i];
  near(cap(0).start, 5, 1e-9); near(cap(1).start, 15, 1e-9); near(cap(1).end, 18, 1e-9); near(cap(1).words[1].end, 18, 1e-9); near(cap(1).words[0].start, 15, 1e-9);
  near(cap(2).start, 60, 1e-9);                       // after the clip: moves with ripple
  near(p.texts[0].start, 12, 1e-9); near(p.texts[0].end, 15, 1e-9);
  near(p.markers[0].time, 10, 1e-9); near(p.markers[1].time, 30, 1e-9); near(p.markers[2].time, 52, 1e-9);
  near(p.audio[0].start, 16, 1e-9); near(p.audio[1].start, 55, 1e-9);
  // ripple off: only what is inside moves, what is after stays and the clip after keeps its place (gap)
  const q = proj(60, mk);
  cutItem(q, 'clip', 'c1', R([10, 20]), { ripple: false });
  near(q.captions[1].start, 15, 1e-9); near(q.captions[2].start, 70, 1e-9); near(q.markers[1].time, 30, 1e-9); near(q.markers[2].time, 62, 1e-9); near(q.audio[1].start, 65, 1e-9);
  const lay = layout(q); near(lay.items[lay.items.length - 1].start, 60, 1e-6);
});
test('cut an item that is trimmed, sped up and not at time 0 (audio track)', () => {
  const p = proj(10, (q) => { const a = Object.assign(newAudio({ id: 'mu', duration: 120 }, 7), { id: 'au1', in: 20, out: 80, speed: 2 }); q.audio = [a]; });
  const sp0 = spanOf(p, 'audio', 'au1'); near(sp0.len, 30, 1e-9);
  const r = cutItem(p, 'audio', 'au1', R([30, 40], [60, 64]));
  near(r.removed, 7, 1e-9);
  assert.deepEqual(p.audio.map(a => [a.in, a.out, a.start]), [[20, 30, 7], [40, 60, 12], [64, 80, 22]]);
  assert.ok(p.audio.every(a => a.speed === 2));
  assert.equal(p.audio.length, 3);
});
test('cutSilences: only the selected recording unless linked; linked tracks stay in sync; one project mutation', () => {
  const p = proj(60, (q) => {
    q.audio = [Object.assign(newAudio({ id: 'm1', duration: 60 }, 0), { id: 'det', voice: true })];
    q.clips.push(Object.assign(newClipFromMedia(media('m3', 20)), { id: 'c3' }));
  });
  const q = JSON.parse(JSON.stringify(p));
  const r1 = cutSilences(p, { type: 'clip', id: 'c1' }, R([10, 14]), { ripple: true, linked: false });
  assert.equal(r1.cuts, 1); assert.equal(p.audio.length, 1);
  const r2 = cutSilences(q, { type: 'clip', id: 'c1' }, R([10, 14], [30, 32]), { ripple: true, linked: true });
  assert.equal(r2.cuts, 2); near(r2.removed, 6, 1e-9);
  assert.equal(q.clips.length, 4); assert.equal(q.audio.length, 3);
  assert.deepEqual(q.audio.map(a => [a.in, a.out, a.start]), [[0, 10, 0], [14, 30, 10], [32, 60, 26]]);
  const lay = layout(q); assert.deepEqual(lay.items.slice(0, 3).map(i => [i.clip.in, i.start]), [[0, 0], [14, 10], [32, 26]]);
  near(lay.total, 54 + 20, 1e-6);
  // a different recording is never touched
  const other = proj(60, (z) => { z.clips[0].mediaId = 'zzz'; z.audio = [Object.assign(newAudio({ id: 'm1', duration: 60 }, 0), { id: 'det' })]; });
  assert.equal(cutSilences(other, { type: 'clip', id: 'c1' }, R([10, 14]), { linked: true }).cuts, 1);
  assert.equal(other.audio.length, 1);
});
test('cuttable: photos, looped music and silent clips are out', () => {
  assert.equal(cuttable('clip', { mediaId: 'a', kind: 'video', hasAudio: true }), true);
  assert.equal(cuttable('clip', { mediaId: 'a', kind: 'image' }), false);
  assert.equal(cuttable('clip', { mediaId: 'a', kind: 'video', hasAudio: false }), false);
  assert.equal(cuttable('audio', { mediaId: 'a', loop: true }), false);
  assert.equal(cuttable('overlay', normalizeOverlay({ kind: 'video', mediaId: 'a', hasAudio: true })), true);
  assert.ok(MIN_CLIP > 0 && clipLen);
});
