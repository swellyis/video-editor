// Unit tests for Multi-angle (js/multicam.js): grouping, angle switching, splitting at the playhead, the sound track and editing afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { angleOk, anglesOf, planGroup, createGroup, setAngle, switchAt, expectedAudio, audioInSync, rebuildAudio, setAudioSource, angleTimes, piecesOf, prune, groupOf } from '../js/multicam.js';
import { newProject, newClipFromMedia, newOverlay, layout, splitAt, removeClip } from '../js/model.js';

const vid = (id, dur, extra = {}) => ({ id, name: id, kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: true, ...extra });
/** Three cameras of one 30 s moment: cam A (main track, 40 s file), cam B (overlay, starts recording 3 s later), cam C (overlay, 5 s earlier). */
function setup() {
  const p = newProject('t'); p.settings.fps = 30;
  const intro = newClipFromMedia(vid('intro', 4), p.settings); intro.id = 'intro'; p.clips.push(intro);
  const a = newClipFromMedia(vid('camA', 40), p.settings); a.id = 'A'; a.name = 'Cam A'; p.clips.push(a);
  const out = newClipFromMedia(vid('outro', 3), p.settings); out.id = 'outro'; p.clips.push(out);
  const b = newOverlay(vid('camB', 40), 0, p.settings); b.id = 'B'; b.name = 'Cam B'; p.overlays.push(b);
  const c = newOverlay(vid('camC', 50), 0, p.settings); c.id = 'C'; c.name = 'Cam C'; p.overlays.push(c);
  return p;
}
const SEL = [{ type: 'clip', id: 'A' }, { type: 'overlay', id: 'B' }, { type: 'overlay', id: 'C' }];
// lined up: A's 0 plays at 4 (after the intro), B started 3 s later (its 0 = A's 3), C started 5 s earlier (its 5 = A's 0)
const STARTS = [4, 7, -1];

test('which items can be angles', () => {
  assert.equal(angleOk('clip', { kind: 'video', speed: 1 }).ok, true);
  assert.equal(angleOk('clip', { kind: 'image' }).ok, false);
  assert.equal(angleOk('clip', { kind: 'video', speed: 2 }).ok, false);
  assert.equal(angleOk('overlay', { kind: 'video', ramp: { pts: [] } }).ok, false);
  assert.equal(angleOk('audio', { kind: 'video' }).ok, false);
  const p = setup();
  assert.match(anglesOf(p, SEL.slice(0, 1)).reason, /2 to 4/);
  assert.equal(anglesOf(p, SEL).angles.length, 3);
});

test('planGroup: the overlap of all angles, each angle\'s source time at group time 0', () => {
  const p = setup(), { angles } = anglesOf(p, SEL);
  const pl = planGroup(angles, STARTS);
  // A covers 4..44, B 7..47, C -1..49 → overlap 7..44 = 37 s; at 7: A plays 3, B plays 0, C plays 8
  assert.equal(pl.len, 37); assert.deepEqual(pl.bases, [3, 0, 8]);
  assert.ok(planGroup(angles, [0, 100, 0]).fail);
});

test('createGroup: one muted main clip in the first angle\'s place, the angles leave the timeline, sound from the chosen angle', () => {
  const p = setup();
  const r = createGroup(p, SEL, STARTS, { audio: 1, name: 'Interview' });
  assert.ok(!r.fail, r.reason);
  assert.deepEqual(p.clips.map(c => c.id).filter(id => id !== r.clip.id), ['intro', 'outro']);
  assert.equal(p.clips[1].id, r.clip.id); assert.equal(p.overlays.length, 0);
  const c = p.clips[1]; assert.equal(c.mediaId, 'camA'); assert.equal(c.in, 3); assert.equal(c.out, 40); assert.equal(c.muted, true); assert.deepEqual(c.mc, { g: r.group.id, a: 0 });
  const segs = p.audio.filter(a => a.mcAudio === r.group.id);
  assert.equal(segs.length, 1); assert.equal(segs[0].mediaId, 'camB'); assert.equal(segs[0].in, 0); assert.equal(segs[0].out, 37); assert.equal(segs[0].start, 4);
  assert.equal(segs[0].duck, false); assert.equal(segs[0].voice, true);
  assert.ok(audioInSync(p, r.group.id));
  assert.equal(groupOf(p, r.group.id).name, 'Interview');
});

test('setAngle swaps the file at the same moment; switchAt splits at the playhead', () => {
  const p = setup(), { group, clip } = createGroup(p, SEL, STARTS, { audio: 0 });
  assert.ok(setAngle(p, clip.id, 2).ok);
  assert.equal(clip.mediaId, 'camC'); assert.equal(clip.in, 8); assert.equal(clip.out, 45);
  assert.ok(setAngle(p, clip.id, 0).ok);
  // switch to B at 10 s on the timeline (6 s into the group), then to C at 20 s
  assert.ok(switchAt(p, 10, 1).ok); assert.ok(switchAt(p, 20, 2).ok);
  const ps = piecesOf(p, group.id);
  assert.deepEqual(ps.map(it => it.clip.mc.a), [0, 1, 2]);
  assert.deepEqual(ps.map(it => [it.start, it.end].map(v => Math.round(v * 1000) / 1000)), [[4, 10], [10, 20], [20, 41]]);
  assert.equal(ps[1].clip.mediaId, 'camB'); assert.equal(ps[1].clip.in, 6); assert.equal(ps[1].clip.out, 16);
  assert.equal(ps[2].clip.in, 8 + 16);
  assert.equal(layout(p).total, 4 + 37 + 3, 'nothing moved');
  // the sound stays one continuous segment (it did not jump)
  assert.equal(expectedAudio(p, group.id).length, 1); assert.ok(audioInSync(p, group.id));
  assert.deepEqual(angleTimes(p, group.id), [6, 10, 21]);
});

test('switching back joins the pieces again; near a piece start the whole piece switches', () => {
  const p = setup(), { group } = createGroup(p, SEL, STARTS);
  switchAt(p, 10, 1); switchAt(p, 15, 0);
  assert.equal(piecesOf(p, group.id).length, 3);
  switchAt(p, 10.02, 0); // within 0.1 s of the B piece's start: it all goes back to A, and the three pieces become one
  assert.equal(piecesOf(p, group.id).length, 1);
  assert.match(switchAt(p, 2, 1).reason, /not on a multi-angle/);
});

test('a missing stretch of footage is refused; the audio source can change; edits keep working', () => {
  const p = setup(), { group, clip } = createGroup(p, SEL, STARTS);
  clip.in = 0; // trimmed out beyond the overlap: B has no footage before its own 0
  assert.match(setAngle(p, clip.id, 1).reason, /no footage/);
  clip.in = 3;
  assert.ok(setAudioSource(p, group.id, 2).ok);
  const s = p.audio.filter(a => a.mcAudio === group.id); assert.equal(s.length, 1); assert.equal(s[0].mediaId, 'camC'); assert.equal(s[0].in, 8);
  // ordinary edits: split and delete a middle piece with ripple → the sound is out of sync until rebuilt, then it follows the pieces
  splitAt(p, 10); splitAt(p, 20);
  const mid = piecesOf(p, group.id)[1].clip.id; removeClip(p, mid, true);
  assert.equal(audioInSync(p, group.id), false);
  assert.equal(rebuildAudio(p, group.id), 2); assert.ok(audioInSync(p, group.id));
  const e = expectedAudio(p, group.id); assert.deepEqual(e.map(x => [x.start, x.in, x.out]), [[4, 8, 14], [10, 24, 45]]);
});

test('volume / Clean voice of the sound track survive a rebuild; groups without pieces are pruned', () => {
  const p = setup(), { group } = createGroup(p, SEL, STARTS);
  const s0 = p.audio.find(a => a.mcAudio === group.id); s0.volume = 1.4; s0.clean = { level: 'light' };
  switchAt(p, 12, 2); rebuildAudio(p, group.id);
  const s1 = p.audio.find(a => a.mcAudio === group.id); assert.equal(s1.volume, 1.4); assert.deepEqual(s1.clean, { level: 'light' });
  p.clips = p.clips.filter(c => !c.mc);
  assert.equal(prune(p), 1); assert.equal(p.multicams.length, 0); assert.equal(p.audio.filter(a => a.mcAudio).length, 0);
});

test('angles that are already lined up on the timeline can be grouped from their positions', () => {
  const p = setup(); p.overlays[0].start = 7; p.overlays[1].start = 0; p.overlays[1].in = 1; // C: its 1 s plays at 0 → its 5 at 4
  const { angles } = anglesOf(p, SEL), starts = angles.map(a => a.start);
  assert.deepEqual(starts, [4, 7, 0]);
  const pl = planGroup(angles, starts); assert.deepEqual(pl.bases, [3, 0, 8]);
});
