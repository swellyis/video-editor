import test from 'node:test';
import assert from 'node:assert/strict';
import { duckFactor, mergeIntervals, intervalsFromCaptions, intervalsFromPeaks, speechForTrack, normalizeDuck, dbToLevel, levelToDb, duckEnvelope, DEFAULT_DB } from '../js/duck.js';
import { newProject, newClipFromMedia, newAudio, layout, musicGain } from '../js/model.js';
import { newCaption } from '../js/captions.js';

test('db ↔ level round-trip (10 dB ≈ 0.316)', () => {
  assert.ok(Math.abs(dbToLevel(10) - 0.3162) < 0.002);
  assert.ok(Math.abs(levelToDb(0.3) - 10.46) < 0.1);
  assert.equal(dbToLevel(0), 1);
  assert.ok(levelToDb(1) < 0.01);
});
test('normalizeDuck migrates duckLevel → duckDb and fills attack/release/trigger', () => {
  const a = { duck: true, duckLevel: 0.3 };
  normalizeDuck(a);
  assert.ok(Math.abs(a.duckDb - 10.5) < 0.5);
  assert.ok(a.duckAttack > 0 && a.duckRelease > 0);
  assert.equal(a.duckTrigger, 'any');
  assert.ok(Math.abs(a.duckLevel - dbToLevel(a.duckDb)) < 1e-9);
});
test('duckFactor: fully ducked inside speech, 1 outside, attack before / release after', () => {
  const iv = [[2, 4]];
  assert.equal(duckFactor(iv, 3, 0.25, { attack: 0.2, release: 0.4 }), 0.25);
  assert.equal(duckFactor(iv, 0, 0.25, { attack: 0.2, release: 0.4 }), 1);
  assert.equal(duckFactor(iv, 10, 0.25, { attack: 0.2, release: 0.4 }), 1);
  // mid-attack: halfway from full to ducked
  const mid = duckFactor(iv, 2 - 0.1, 0.25, { attack: 0.2, release: 0.4 });
  assert.ok(Math.abs(mid - (0.25 + 0.75 * 0.5)) < 1e-6, String(mid));
  // mid-release
  const rel = duckFactor(iv, 4 + 0.2, 0.25, { attack: 0.2, release: 0.4 });
  assert.ok(Math.abs(rel - (0.25 + 0.75 * 0.5)) < 1e-6, String(rel));
});
test('mergeIntervals joins close gaps', () => {
  assert.deepEqual(mergeIntervals([[0, 1], [1.05, 2], [5, 6]], 0.1), [[0, 2], [5, 6]]);
});
test('intervalsFromCaptions uses word timings with pad', () => {
  const caps = [newCaption(1, 3, 'hello um world', [
    { w: 'hello', start: 1, end: 1.4 }, { w: 'um', start: 1.5, end: 1.7 }, { w: 'world', start: 2, end: 2.5 },
  ])];
  const iv = intervalsFromCaptions(caps, { pad: 0.05, mergeGap: 0.4 });
  assert.ok(iv.length >= 1);
  assert.ok(iv[0][0] <= 1 && iv[iv.length - 1][1] >= 2.5);
});
test('intervalsFromPeaks skips quiet frames', () => {
  const data = new Array(100).fill(5);
  for (let i = 30; i < 50; i++) data[i] = 200; // 1 s of loud at 20 Hz → 30..50 = 1.5..2.5 s
  const peaks = { rate: 20, data };
  const iv = intervalsFromPeaks(peaks, { src0: 0, src1: 5, mapSrc: (s) => s, thrRatio: 0.22, pad: 0 });
  assert.equal(iv.length, 1);
  assert.ok(iv[0][0] >= 1.3 && iv[0][0] <= 1.7, String(iv[0]));
  assert.ok(iv[0][1] >= 2.3 && iv[0][1] <= 2.7, String(iv[0]));
});
test('speechForTrack respects trigger: clips vs voice vs captions', () => {
  const vid = (id, d = 6) => ({ id, kind: 'video', name: id, duration: d, width: 640, height: 360, hasAudio: true });
  const p = newProject('t');
  p.clips.push(newClipFromMedia(vid('c1', 6), p.settings));
  p.audio.push(Object.assign(newAudio(vid('v1', 6), 0), { voice: true, duck: false }));
  p.audio.push(Object.assign(newAudio(vid('m1', 10), 0), { duck: true, duckTrigger: 'clips' }));
  p.captions = [newCaption(1, 2, 'hi', [{ w: 'hi', start: 1, end: 1.5 }])];
  const lay = layout(p);
  const music = p.audio[1];
  music.duckTrigger = 'clips';
  const clipIv = speechForTrack(music, lay, p);
  assert.ok(clipIv.some(x => x[0] <= 0.1 && x[1] >= 5), 'clips cover the main clip');
  music.duckTrigger = 'voice';
  const voiceIv = speechForTrack(music, lay, p);
  assert.ok(voiceIv.length >= 1);
  music.duckTrigger = 'captions';
  const capIv = speechForTrack(music, lay, p);
  assert.ok(capIv.some(x => x[0] < 1.2 && x[1] > 1.3), JSON.stringify(capIv));
});
test('musicGain applies duck envelope (preview = export path)', () => {
  const a = normalizeDuck({ duck: true, duckLevel: 0.25, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, start: 0, in: 0, out: 10, loop: false, speed: 1 });
  const iv = [[2, 4]];
  const gFull = musicGain(a, 0.5, iv, 10);
  const gDuck = musicGain(a, 3, iv, 10);
  assert.ok(Math.abs(gFull - 1) < 1e-6);
  assert.ok(Math.abs(gDuck - 0.25) < 0.02, String(gDuck));
});
test('duckEnvelope samples for the timeline draw', () => {
  const e = duckEnvelope([[1, 2]], 0, 3, 0.5, { attack: 0.1, release: 0.2 }, 0.5);
  assert.ok(e.length >= 6);
  assert.ok(e.find(p => p.t >= 1 && p.t <= 2).g <= 0.51);
});
test('DEFAULT_DB is a sensible starting point (~10 dB)', () => {
  assert.equal(DEFAULT_DB, 10);
});
