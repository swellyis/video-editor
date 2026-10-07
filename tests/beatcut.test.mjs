// Unit tests for Cut to beat (js/beatcut.js): the beat grid, re-timing, cutting, fitting photos, and beat-centred transitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { beatPeriod, beatGrid, transitionLength, maxLenOf, tailRoom, headRoom, setLen, moveHead, cutOf, cutToBeat, describe, TOL } from '../js/beatcut.js';
import { newProject, newClipFromMedia, newAudio, newOverlay, layout, clipLen } from '../js/model.js';
import { fromPreset } from '../js/ramp.js';

const vid = (id, dur) => ({ id, name: id, kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: true });
const img = (id) => ({ id, name: id, kind: 'image', duration: 0, width: 800, height: 600 });
/** 120 BPM music (beats every 0.5 s from `phase`) and the given clips: 'v3.3' = 3.3 s video from a 20 s file trimmed at 2 s, 'i' = 4 s photo. */
function setup(kinds, { phase = 0, bpm = 120, musicStart = 0 } = {}) {
  const p = newProject('t'); p.settings.fps = 30;
  kinds.forEach((k, i) => {
    const c = k[0] === 'i' ? newClipFromMedia(img('im' + i), p.settings) : newClipFromMedia(vid('v' + i, 20), p.settings);
    c.id = 'c' + i; c.name = 'C' + i;
    if (k[0] === 'v') { c.in = 2; c.out = 2 + parseFloat(k.slice(1)); }
    if (k[0] === 'i' && k.length > 1) c.out = parseFloat(k.slice(1));
    p.clips.push(c);
  });
  const a = newAudio({ id: 'mus', name: 'Song', duration: 60 }, musicStart); a.id = 'a1';
  const t = []; for (let x = phase; x < 60; x += 60 / bpm) t.push(Math.round(x * 1000) / 1000);
  a.beat = { on: true, bpm, conf: 0.99, from: 0, to: 60, t };
  p.audio.push(a);
  return p;
}
const C = (i) => ({ type: 'clip', id: 'c' + i });
const joins = (p) => { const lay = layout(p); return lay.items.slice(0, -1).map((_, i) => cutOf(lay, i)); };
const onGrid = (t, step, phase = 0) => Math.abs(((t - phase) / step) - Math.round((t - phase) / step)) * step < 0.002;

test('grid: period, every N beats, anchored at the first chosen clip', () => {
  const b = [0.2, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2, 3.7, 4.2];
  assert.equal(beatPeriod(b), 0.5);
  assert.deepEqual(beatGrid(b, 1, 1.0), [1.2, 1.7, 2.2, 2.7, 3.2, 3.7, 4.2]);
  assert.deepEqual(beatGrid(b, 4, 0), [0.2, 2.2, 4.2]);
  assert.deepEqual(beatGrid(b, 2, 1.19), [1.2, 2.2, 3.2, 4.2]); // a beat a hair before the clip still counts
  assert.equal(transitionLength('h', 0.5), 0.25); assert.equal(transitionLength('b', 0.5), 0.5); assert.equal(transitionLength('s1', 0.5), 1);
  assert.equal(transitionLength('q', 0.2), 0.1); // never below the shortest transition
});

test('re-time: every join lands on a beat, music and other lanes untouched, one step per photo', () => {
  const p = setup(['v1.3', 'i', 'v2.2', 'i']);
  const before = JSON.stringify(p.audio);
  const r = cutToBeat(p, [C(0), C(1), C(2), C(3)], p.audio[0], { mode: 'retime', every: 2, fitPhotos: true });
  assert.ok(r.ok, r.reason); assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(JSON.stringify(p.audio), before);
  for (const j of joins(p)) assert.ok(onGrid(j, 1), 'join ' + j);
  const lay = layout(p); assert.ok(onGrid(lay.total, 1), 'end ' + lay.total);
  assert.ok(Math.abs(lay.items[1].len - 1) < 0.002 && Math.abs(lay.items[3].len - 1) < 0.002, 'photos are one grid step');
  assert.equal(r.onBeat, 3); assert.ok(/re-timed/.test(describe(r)));
});

test('re-time: the nearest beat that the footage allows; a too-short clip is left alone and reported', () => {
  const p = setup(['v1.2', 'v0.3', 'v3.1']);
  p.clips[1].in = 19.7; p.clips[1].out = 20; // only 0.3 s of footage left
  const r = cutToBeat(p, [], p.audio[0], { mode: 'retime', every: 1 });
  assert.ok(r.ok);
  const lay = layout(p);
  assert.ok(Math.abs(lay.items[0].end - 1) < 0.002, 'clip 0 → nearest beat 1.0, got ' + lay.items[0].end);
  assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, /too short/);
  assert.ok(onGrid(lay.items[2].end, 0.5) && Math.abs(lay.items[2].len - 3.1) <= 0.25 + 1e-6, 'clip 2 ' + lay.items[2].end);
});

test('re-time honours speed, reverse and speed curves', () => {
  const p = setup(['v1.3', 'v1.3', 'v1.3']);
  p.clips[0].speed = 2; p.clips[0].out = p.clips[0].in + 2.6;   // 1.3 s on the timeline
  p.clips[1].reverse = true;
  p.clips[2].out = p.clips[2].in + 3; p.clips[2].ramp = fromPreset('montage', p.clips[2]); const rampLen = clipLen(p.clips[2]);
  const r = cutToBeat(p, [], p.audio[0], { mode: 'retime', every: 1 });
  assert.ok(r.ok); const lay = layout(p);
  assert.ok(Math.abs(lay.items[0].len - 1.5) < 0.002 || Math.abs(lay.items[0].len - 1) < 0.002, 'speed 2 clip ' + lay.items[0].len);
  assert.equal(p.clips[1].out, 3.3, 'reversed: the start (source out) stays');
  for (const j of joins(p)) assert.ok(onGrid(j, 0.5), 'join ' + j);
  assert.ok(onGrid(lay.total, 0.5) && clipLen(p.clips[2]) <= rampLen + 1e-6, 'speed curve only shortened');
});

test('handles: room and length setters', () => {
  const p = setup(['v2', 'i']); const v = p.clips[0], im = p.clips[1];
  assert.equal(maxLenOf(v), 18); assert.equal(tailRoom(v), 16); assert.equal(headRoom(v), 2);
  v.reverse = true; assert.equal(maxLenOf(v), 4); assert.equal(tailRoom(v), 2); assert.equal(headRoom(v), 16); v.reverse = false;
  setLen(v, 3); assert.equal(v.out, 5); moveHead(v, 1); assert.equal(v.in, 1); assert.equal(clipLen(v), 4);
  assert.equal(headRoom(im), Infinity); setLen(im, 1.5); assert.equal(clipLen(im), 1.5);
});

test('cut mode: long clips are split exactly on the beats, nothing moves', () => {
  const p = setup(['v4.3', 'v2.1']);
  const total = layout(p).total;
  const r = cutToBeat(p, [C(0)], p.audio[0], { mode: 'cut', every: 2 });
  assert.ok(r.ok); assert.equal(r.splits, 4); // 1, 2, 3, 4 inside 0-4.3
  assert.ok(Math.abs(layout(p).total - total) < 1e-9);
  const j = joins(p); assert.deepEqual(j.slice(0, 4).map(x => Math.round(x * 1000) / 1000), [1, 2, 3, 4]);
  assert.equal(p.clips.length, 6);
});

test('beat transitions are centred on the beat and do not move anything after them', () => {
  const p = setup(['v1.3', 'v1.3', 'i', 'v2']);
  cutToBeat(p, [], p.audio[0], { mode: 'retime', every: 2, fitPhotos: true });
  const lay0 = layout(p), ends0 = lay0.items.map(it => it.end), j0 = joins(p);
  const r = cutToBeat(p, [], p.audio[0], { mode: 'transitions', every: 2, transition: { type: 'crossfade', length: 'h' } });
  assert.ok(r.ok); assert.equal(r.transitions, 3, JSON.stringify(r.skipped));
  const lay = layout(p);
  assert.ok(Math.abs(lay.total - lay0.total) < 0.002, 'total unchanged');
  j0.forEach((j, i) => assert.ok(Math.abs(cutOf(lay, i) - j) < 0.002, 'join ' + i + ' stays on its beat'));
  assert.ok(Math.abs(lay.items[3].end - ends0[3]) < 0.002);
  for (let i = 1; i < lay.items.length; i++) assert.ok(Math.abs(lay.items[i].xIn - 0.25) < 0.002, 'x ' + lay.items[i].xIn);
  // dips keep the timing
  const q = setup(['v1', 'v1']);
  const r2 = cutToBeat(q, [], q.audio[0], { mode: 'transitions', every: 1, transition: { type: 'fade', length: 'b' } });
  assert.equal(r2.transitions, 1); assert.equal(q.clips[1].transition.type, 'fade'); assert.equal(layout(q).items[1].start, 1);
});

test('one-sided handles: the overlap uses the side that has footage; none at all is skipped', () => {
  const p = setup(['v1', 'v1']);
  p.clips[0].in = 19; p.clips[0].out = 20;          // no footage after clip 0
  const r = cutToBeat(p, [], p.audio[0], { mode: 'transitions', every: 1, transition: { type: 'wipeleft', length: 'h' } });
  assert.equal(r.transitions, 1); const lay = layout(p);
  assert.ok(Math.abs(lay.items[0].end - 1) < 0.002, 'prev end stays at the beat'); assert.ok(Math.abs(lay.items[1].start - 0.75) < 0.002);
  const q = setup(['v1', 'v1']); q.clips[0].in = 19; q.clips[0].out = 20; q.clips[1].in = 0; q.clips[1].out = 1;
  const r2 = cutToBeat(q, [], q.audio[0], { mode: 'transitions', every: 1, transition: { type: 'crossfade', length: 'h' } });
  assert.equal(r2.transitions, 0); assert.match(r2.skipped[0].reason, /spare footage/);
});

test('joins off the beat get no transition in transitions-only mode; no beats is refused', () => {
  const p = setup(['v1.27', 'v1']);
  const r = cutToBeat(p, [], p.audio[0], { mode: 'transitions', every: 1, transition: { type: 'crossfade', length: 'h' } });
  assert.equal(r.onBeat, 0); assert.equal(r.transitions, 0);
  const p2 = setup(['v1.01', 'v1']); assert.ok(0.01 <= TOL);
  assert.equal(cutToBeat(p2, [], p2.audio[0], { mode: 'transitions', every: 1, transition: { type: 'crossfade', length: 'h' } }).transitions, 1);
  const q = setup(['v1']); delete q.audio[0].beat;
  const r3 = cutToBeat(q, [], q.audio[0], { mode: 'retime' }); assert.equal(r3.ok, false); assert.match(describe(r3), /beats/);
});

test('music placed later and offset beats: the grid follows the music on the timeline', () => {
  const p = setup(['i1', 'i1', 'i1'], { phase: 0.13, musicStart: 0.5 });
  const r = cutToBeat(p, [], p.audio[0], { mode: 'retime', every: 1, fitPhotos: true });
  assert.ok(r.ok); for (const j of joins(p)) assert.ok(onGrid(j, 0.5, 0.63), 'join ' + j);
});

test('overlays in the selection start on a beat; photo overlays last one step', () => {
  const p = setup(['v3']);
  const o = newOverlay(img('ov'), 1.13, p.settings); o.id = 'o1'; p.overlays.push(o);
  const r = cutToBeat(p, [C(0), { type: 'overlay', id: 'o1' }], p.audio[0], { mode: 'retime', every: 2, fitPhotos: true });
  assert.equal(r.overlays, 1); assert.equal(o.start, 1); assert.ok(Math.abs(o.out - o.in - 1) < 1e-6);
});
