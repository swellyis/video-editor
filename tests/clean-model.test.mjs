// Unit tests for the Clean voice data model: ids, setting, repair of junk, old projects, split / duplicate / detach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, migrate, sanitizeProject, newClipFromMedia, newAudio, splitItem, detachAudio, cleanId, cleanTarget, cleanLevelOf, cleanIdsOf, CLEAN_VERSION } from '../js/model.js';

const vid = { id: 'm1', kind: 'video', name: 'sermon.mp4', duration: 20, width: 1280, height: 720, hasAudio: true };
const proj = () => { const p = newProject('t'); p.clips.push(newClipFromMedia(vid, {})); return p; };

test('derived ids are stable per source and level, and versioned', () => {
  assert.equal(cleanId('m1', 'light'), 'cln_m1_light_v' + CLEAN_VERSION);
  assert.notEqual(cleanId('m1', 'light'), cleanId('m1', 'strong'));
});
test('off / missing setting means the original sound', () => {
  const c = proj().clips[0];
  assert.equal(cleanLevelOf(c), 'off'); assert.equal(cleanTarget(c), null); assert.deepEqual(cleanIdsOf(c), []);
  c.clean = { level: 'off' }; assert.equal(cleanTarget(c), null); assert.equal(cleanIdsOf(c).length, 2); // kept alive so switching back is instant
  c.clean = { level: 'strong' }; assert.equal(cleanTarget(c), cleanId('m1', 'strong'));
});
test('old projects (no setting) stay unchanged through migrate and sanitize', () => {
  const p = proj(); const a = JSON.stringify(p.clips[0]);
  const q = migrate(JSON.parse(JSON.stringify(p))); assert.equal(q.clips[0].clean, undefined);
  assert.equal(JSON.stringify(q.clips[0]).includes('clean'), false); assert.ok(a.length > 0);
});
test('junk settings are repaired', () => {
  const p = proj(); p.clips[0].clean = { level: 'ultra' }; p.audio.push({ ...newAudio({ id: 'm2', name: 'x', duration: 5 }), clean: 'yes' });
  const q = sanitizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(q.clips[0].clean.level, 'off'); assert.equal(q.audio[0].clean, undefined);
});
test('split keeps the setting on both halves (same media, so the same cleaned copy)', () => {
  const p = proj(); p.clips[0].clean = { level: 'light' };
  const r = splitItem(p, { type: 'clip', id: p.clips[0].id }, 5);
  assert.ok(!r || !r.fail);
  assert.equal(p.clips.length, 2);
  assert.equal(cleanTarget(p.clips[0]), cleanTarget(p.clips[1]));
});
test('detach audio carries the setting to the detached sound', () => {
  const p = proj(); p.clips[0].clean = { level: 'strong' };
  const r = detachAudio(p, { type: 'clip', id: p.clips[0].id });
  assert.ok(!r || !r.fail);
  const v = p.audio.find(a => a.voice); assert.ok(v);
  assert.equal(cleanLevelOf(v), 'strong'); assert.equal(cleanTarget(v), cleanId('m1', 'strong'));
});
