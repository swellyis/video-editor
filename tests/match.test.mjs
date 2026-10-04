import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, targetsFor, defaultTarget, available, levelOf, gainPlan, applyMatch, pictureRun, volToDb, dbToVol, say } from '../js/match.js';
import { newProject, newClipFromMedia, newAudio, layout, audioLen } from '../js/model.js';

const vid = (id, dur, extra = {}) => ({ id, name: id, kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: true, ...extra });
const img = (id) => ({ id, name: id, kind: 'image', duration: 0, width: 800, height: 600 });
function setup({ images = 1, audioLen: AL = 12.34, voice = true } = {}) {
  const p = newProject('t'); p.settings.fps = 30;
  for (let i = 0; i < images; i++) { const c = newClipFromMedia(img('im' + i), p.settings); c.id = 'c' + i; p.clips.push(c); }
  const a = newAudio({ id: 'm1', name: 'Voiceover', duration: AL }, 0); a.id = 'a1'; a.voice = voice; a.fadeIn = 0; a.fadeOut = 0; p.audio.push(a);
  return p;
}
const C = (i) => ({ type: 'clip', id: 'c' + i }), A = (id = 'a1') => ({ type: 'audio', id });

test('say: plain seconds and minutes', () => {
  assert.equal(say(4), '4 s'); assert.equal(say(12.345), '12.35 s'); assert.equal(say(65), '1:05'); assert.equal(say(119.7), '2:00');
});

test('levelOf: pauses do not drag the level down; silence gives null', () => {
  const speech = [], mixed = [];
  for (let i = 0; i < 500; i++) { speech.push(-20); mixed.push(i % 2 ? -20 : -70); }
  assert.ok(Math.abs(levelOf(speech).db - -20) < 0.01);
  assert.ok(Math.abs(levelOf(mixed).db - -20) < 0.5);       // the quiet half is ignored
  assert.ok(levelOf(mixed).loud < 0.6);
  assert.equal(levelOf(new Array(100).fill(-120)), null);
  assert.equal(levelOf([-20, -20]), null);
});

test('gainPlan: equal level, 12 dB under, accounts for current volumes, capped at 200 %', () => {
  let g = gainPlan({ selDb: -20, tgtDb: -20 });
  assert.equal(g.vol, 1);
  g = gainPlan({ selDb: -20, tgtDb: -20, offsetDb: -12 });
  assert.ok(Math.abs(g.vol - dbToVol(-12)) < 0.002 && !g.capped);
  assert.ok(Math.abs(g.changeDb - -12) < 0.05);
  g = gainPlan({ selDb: -14, tgtDb: -26, selVol: 1, tgtVol: 1, offsetDb: -12 });   // music is 12 dB louder than the voice: 24 dB down
  assert.ok(Math.abs(volToDb(g.vol) - -24) < 0.05);
  g = gainPlan({ selDb: -20, tgtDb: -20, tgtVol: 0.5, offsetDb: 0 });                // target plays at 50 %: so does it
  assert.ok(Math.abs(g.vol - 0.5) < 0.002);
  g = gainPlan({ selDb: -40, tgtDb: -10 });
  assert.equal(g.vol, 2); assert.equal(g.capped, true);
});

test('targets and default: a picture goes with the audio under it, audio with the picture under its start', () => {
  const p = setup({ images: 2 });
  const t = targetsFor(p, C(0));
  assert.ok(t.some(x => x.ref.type === 'clip' && x.ref.id === 'c1') && t.some(x => x.ref.type === 'audio') && t[t.length - 1].ref.type === 'whole');
  assert.ok(!t.some(x => x.ref.type === 'clip' && x.ref.id === 'c0'));
  assert.equal(defaultTarget(p, C(0)).ref.id, 'a1');
  assert.equal(defaultTarget(p, A()).ref.id, 'c0');
  assert.deepEqual(targetsFor(p, { type: 'clip', id: 'nope' }), []);
});

test('single picture = exactly the audio length (rounded up to a frame), keyframes scale, one call', () => {
  const p = setup({ audioLen: 12.34 }); p.clips[0].keyframes = { zoom: [{ t: 0, v: 1 }, { t: 2, v: 1.5 }] };
  const r = applyMatch(p, C(0), A(), { length: true });
  assert.ok(r.ok && r.changed); assert.match(r.lines[0], /Image now 12\.37 s, matching Voiceover/);
  assert.ok(Math.abs(layout(p).items[0].len - 12.3667) < 0.001);
  assert.ok(layout(p).items[0].len >= 12.34);
  assert.ok(Math.abs(p.clips[0].keyframes.zoom[1].t - 2 * 12.3667 / 4) < 0.01);
  const again = applyMatch(p, C(0), A(), { length: true });
  assert.equal(again.changed, false); assert.match(again.lines[0], /already/);
});

test('ripple moves later items by the change; without ripple nothing else moves', () => {
  const mk = () => { const p = setup({ images: 2 }); p.audio[0].start = 0; const t = { id: 't1', start: 6, end: 8 }; p.texts.push(t); const m = newAudio({ id: 'm2', name: 'Later', duration: 5 }, 9); m.id = 'a2'; p.audio.push(m); return p; };
  let p = mk();
  applyMatch(p, C(0), A(), { length: true, ripple: true });
  assert.ok(p.texts[0].start > 6 + 5); assert.ok(p.audio[1].start > 9 + 5); assert.equal(p.audio[0].start, 0);
  p = mk();
  applyMatch(p, C(0), A(), { length: true, ripple: false });
  assert.equal(p.texts[0].start, 6); assert.equal(p.audio[1].start, 9);
});

test('several pictures share the audio evenly, in order; the run is the pictures in a row', () => {
  const p = setup({ images: 5, audioLen: 30 });
  const v = newClipFromMedia(vid('v', 20), p.settings); v.id = 'cv'; p.clips.push(v);          // a video after the pictures ends the run
  assert.deepEqual(pictureRun(p, 'c2'), [0, 4]); assert.equal(pictureRun(p, 'cv'), null);
  const r = applyMatch(p, C(2), A(), { length: true, spread: true, ripple: true });
  assert.ok(r.ok); assert.match(r.lines[0], /5 pictures now share 30 s/);
  const lens = layout(p).items.slice(0, 5).map(i => i.len);
  assert.ok(Math.abs(lens.reduce((a, b) => a + b, 0) - 30) < 0.04, lens.join(','));
  assert.ok(lens.every(l => Math.abs(l - 6) < 0.05));
  assert.deepEqual(p.clips.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'cv']);
  assert.ok(Math.abs(layout(p).items[5].start - 30) < 0.04);                                      // the video follows right after
  const bad = setup({ images: 30, audioLen: 2 });
  const f = applyMatch(bad, C(0), A(), { length: true, spread: true });
  assert.equal(f.ok, false); assert.match(f.fail, /Too short/);
});

test('a video is only shortened, never stretched; the reason is plain', () => {
  const p = newProject('v'); const v = newClipFromMedia(vid('v', 30), p.settings); v.id = 'cv'; v.out = 30; p.clips.push(v);
  const a = newAudio({ id: 'm', name: 'Song', duration: 10 }, 0); a.id = 'a1'; p.audio.push(a);
  const r = applyMatch(p, { type: 'clip', id: 'cv' }, A(), { length: true });
  assert.ok(r.ok && r.changed); assert.match(r.lines[0], /trimmed from 30 s to 10 s/i); assert.equal(v.out, 10);
  const short = newProject('s'); const w = newClipFromMedia(vid('w', 5), short.settings); w.id = 'cw'; w.out = 5; short.clips.push(w);
  const b = newAudio({ id: 'm', name: 'Song', duration: 10 }, 0); b.id = 'a1'; short.audio.push(b);
  const av = available(short, { type: 'clip', id: 'cw' }, A());
  assert.equal(av.length.ok, false); assert.match(av.length.why, /cannot be stretched/);
  assert.equal(applyMatch(short, { type: 'clip', id: 'cw' }, A(), { length: true }).ok, false);
});

test('audio longer than the picture: trimmed with a smooth fade-out; shorter: looped or told it ends early', () => {
  const p = setup({ images: 1, audioLen: 60, voice: false }); p.clips[0].out = 20;
  let r = applyMatch(p, A(), C(0), { length: true });
  assert.ok(r.ok && r.changed); assert.match(r.lines[0], /Trimmed from 1:00 to 20 s/);
  assert.ok(Math.abs(audioLen(p.audio[0]) - 20) < 1e-6); assert.ok(p.audio[0].fadeOut >= 0.4 && p.audio[0].fadeOut <= 3);
  const q = setup({ images: 1, audioLen: 8, voice: false }); q.clips[0].out = 20;
  r = applyMatch(q, A(), C(0), { length: true, loop: false });
  assert.equal(r.changed, false); assert.match(r.lines[0], /12 s shorter/); assert.equal(q.audio[0].loop, false);
  r = applyMatch(q, A(), C(0), { length: true, loop: true });
  assert.ok(r.changed && q.audio[0].loop === true && q.audio[0].loopLen === 20); assert.match(r.lines[0], /Looped to fill 20 s/);
  assert.ok(q.audio[0].fadeOut > 0);
});

test('audio to the whole video, and to another audio track', () => {
  const p = setup({ images: 1, audioLen: 50, voice: false }); p.clips[0].out = 15;
  const w = applyMatch(p, A(), { type: 'whole' }, { length: true });
  assert.ok(w.ok && Math.abs(audioLen(p.audio[0]) - 15) < 1e-6);
  const q = setup({ images: 1, audioLen: 40, voice: false });
  const v = newAudio({ id: 'm2', name: 'Narration', duration: 17 }, 0); v.id = 'a2'; v.voice = true; q.audio.push(v);
  applyMatch(q, A('a1'), A('a2'), { length: true });
  assert.ok(Math.abs(audioLen(q.audio[0]) - 17) < 1e-6);
});

test('start & end: audio moves to the other item’s start or end; a main clip moves to the nearest free place', () => {
  const p = setup({ images: 2, audioLen: 5, voice: false }); p.clips[0].out = 10; p.clips[1].out = 10;     // c0 0-10, c1 10-20
  p.audio[0].start = 3;
  let r = applyMatch(p, A(), C(1), { align: 'start' });
  assert.ok(r.ok && r.changed); assert.equal(p.audio[0].start, 10);
  r = applyMatch(p, A(), C(1), { align: 'end' });
  assert.ok(Math.abs(p.audio[0].start - 15) < 1e-6); assert.match(r.lines[0], /Ends with im1 at 20 s/);
  r = applyMatch(p, A(), C(1), { align: 'end' });
  assert.equal(r.changed, false); assert.match(r.lines[0], /Already ends/);
  const q = setup({ images: 1, audioLen: 5, voice: true }); q.clips[0].out = 4; q.audio[0].start = 6;
  const z = applyMatch(q, C(0), A(), { align: 'start' });
  assert.ok(z.ok); assert.ok(Math.abs(layout(q).items[0].start - 6) < 1e-6);
});

test('loudness: sets the volume (not the file), 12 dB under the voice; both measurements are needed', () => {
  const p = setup({ images: 1, audioLen: 30, voice: true });
  const m = newAudio({ id: 'm2', name: 'Piano', duration: 40 }, 0); m.id = 'a2'; m.voice = false; m.volume = 0.8; p.audio.push(m);
  const r = applyMatch(p, A('a2'), A('a1'), { loudness: { selDb: -14, tgtDb: -26, offsetDb: -12 } });
  assert.ok(r.ok && r.changed);
  const want = dbToVol(-26 - -14 - 12) * 0.6;   // the voice plays at 60 %, the piano goes 12 dB under that
  assert.ok(Math.abs(p.audio[1].volume - want) < 0.002, p.audio[1].volume + ' vs ' + want);
  assert.match(r.lines[0], /12 dB quieter than Voiceover/);
  assert.equal(p.audio[0].volume, 0.6);                                                       // the voice is untouched
  assert.equal(available(p, C(0), A()).loud.ok, false);                                       // a picture has no sound
  assert.equal(available(p, A('a2'), { type: 'whole' }).loud.ok, false);
  assert.equal(applyMatch(p, A('a2'), A('a1'), {}).ok, false);
});

test('everything together in order: length, then end alignment, then loudness; failures change nothing', () => {
  const p = setup({ images: 1, audioLen: 50, voice: false }); p.clips[0].out = 20;
  const v = newAudio({ id: 'm2', name: 'Speech', duration: 20 }, 0); v.id = 'a2'; v.voice = true; p.audio.push(v);
  const r = applyMatch(p, A('a1'), A('a2'), { length: true, align: 'end', loudness: { selDb: -20, tgtDb: -20, offsetDb: -6 } });
  assert.ok(r.ok && r.lines.length === 3);
  assert.ok(Math.abs(audioLen(p.audio[0]) - 20) < 1e-6);
  const snap = JSON.stringify(p);
  assert.equal(applyMatch(p, A('a1'), A('a1'), { length: true }).ok, false);
  assert.equal(applyMatch(p, A('a1'), A('missing'), { length: true }).ok, false);
  assert.equal(JSON.stringify(p), snap);
  assert.equal(describe(p, { type: 'whole' }).len, layout(p).total);
});
