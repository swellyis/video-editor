// Unit tests for the pure logic (no browser needed): node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newProject, migrate, layout, splitItem, rebaseKeyframes, normalizeClip, newText, sanitizeProject, SCHEMA, clipLen } from '../js/model.js';
import { safeName, tarBlob, isTar, readTar, dataURLToBlob, fmt } from '../js/util.js';

const clip = (id, out, extra = {}) => normalizeClip({ id, mediaId: 'm_' + id, name: id, kind: 'video', srcDuration: 60, in: 0, out, ...extra });
const proj = (...clips) => { const p = newProject('T'); p.clips = clips; return p; };

test('layout places clips back to back and honours speed and crossfades', () => {
  const p = proj(clip('a', 10), clip('b', 10, { speed: 2 }), clip('c', 6, { transition: { type: 'crossfade', duration: 1 } }));
  const lay = layout(p);
  assert.equal(lay.items.length, 3);
  assert.equal(lay.items[1].start, 10);
  assert.equal(clipLen(p.clips[1]), 5);
  assert.ok(Math.abs(lay.total - (10 + 5 + 6 - 1)) < 1e-9, 'crossfade overlaps by its duration: ' + lay.total);
});

test('splitItem splits a clip and a text at the playhead, refuses at the edge', () => {
  const p = proj(clip('a', 10));
  const r = splitItem(p, { type: 'clip', id: 'a' }, 4);
  assert.ok(!r.fail);
  assert.deepEqual(p.clips.map(c => [c.in, c.out]), [[0, 4], [4, 10]]);
  assert.ok(splitItem(p, { type: 'clip', id: 'a' }, 0.01).fail);
  p.texts.push({ ...newText(2, 4, 'Hi'), id: 'txt_a' });
  const rt = splitItem(p, { type: 'text', id: 'txt_a' }, 3);
  assert.ok(!rt.fail);
  assert.deepEqual(p.texts.map(t => [t.start, t.end]).sort(), [[2, 3], [3, 6]]);
});

test('rebaseKeyframes cuts tracks at a split point', () => {
  const kf = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 10, v: 100, ease: 'linear' }] };
  const left = rebaseKeyframes(kf, 0, 4), right = rebaseKeyframes(kf, 4);
  assert.equal(left.x.at(-1).t, 4); assert.ok(Math.abs(left.x.at(-1).v - 40) < 1e-6);
  assert.equal(right.x[0].t, 0); assert.ok(Math.abs(right.x[0].v - 40) < 1e-6);
  assert.equal(right.x.at(-1).t, 6);
});

test('safeName keeps titles readable and safe as file names', () => {
  assert.equal(safeName('Romans 8.28 – Hope'), 'Romans-8.28-Hope');
  assert.equal(safeName('Sermón: ¿Fe?'), 'Sermón-Fe');
  assert.equal(safeName('a/b\\c:*?"<>|d'), 'a-b-c-d');
  assert.equal(safeName('   '), 'video');
  assert.equal(safeName('', 'project'), 'project');
  assert.equal(safeName('..'), 'video');
  assert.equal(safeName('CON'), '_CON');
  assert.ok(Array.from(safeName('x'.repeat(300))).length <= 80);
  assert.equal(safeName('日本語のタイトル'), '日本語のタイトル');
});

test('tar project container round-trips and is a standard tar', async () => {
  const media = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
  const t = tarBlob([{ name: 'project.json', data: JSON.stringify({ a: 1 }) }, { name: 'media/med_1', data: new Blob([media]) }]);
  assert.equal(t.size % 512, 0);
  assert.ok(await isTar(t));
  const m = await readTar(t);
  assert.deepEqual(JSON.parse(await m.get('project.json').text()), { a: 1 });
  assert.deepEqual(new Uint8Array(await m.get('media/med_1').arrayBuffer()), media);
  const f = path.join(os.tmpdir(), 'unit-' + process.pid + '.vedit'); fs.writeFileSync(f, Buffer.from(await t.arrayBuffer()));
  try { assert.deepEqual(execFileSync('tar', ['-tf', f]).toString().trim().split('\n'), ['project.json', 'media/med_1']); } finally { fs.rmSync(f); }
  assert.equal(await isTar(new Blob(['{"not":"tar"}'])), false);
});

test('dataURLToBlob decodes base64 media and rejects anything else', async () => {
  const b = dataURLToBlob('data:video/mp4;base64,' + Buffer.from('hello').toString('base64'));
  assert.equal(b.type, 'video/mp4'); assert.equal(await b.text(), 'hello');
  assert.throws(() => dataURLToBlob('https://example.com/x.mp4'));
  assert.throws(() => dataURLToBlob('data:text/plain,hello'));
});

test('migrate upgrades old projects and sanitizeProject clamps bad values', () => {
  const old = { schema: 3, name: 'Old', settings: { res: 99999, fps: 7, quality: 'x', format: 'gif' }, thumb: { time: 0 }, clips: [{ id: 'c', mediaId: 'm', in: 0, out: 5, srcDuration: 5, speed: 100, volume: -3 }], audio: [{ id: 'a', mediaId: 'mm', in: 0, out: 3, volume: 50 }], texts: [{ id: 't', text: 5, start: 1, end: 0 }], markers: [null, { time: 'x' }], logo: { mediaId: 'l', position: 'middle', size: 9 } };
  const p = migrate(old);
  assert.equal(p.schema, SCHEMA);
  assert.equal(p.thumb.time, null);
  assert.deepEqual([p.settings.res, p.settings.fps, p.settings.quality, p.settings.format], [1080, 30, 'high', 'auto']);
  assert.deepEqual([p.clips[0].speed, p.clips[0].volume], [4, 0]);
  assert.equal(p.audio[0].volume, 2);
  assert.equal(p.texts[0].text, '5'); assert.ok(p.texts[0].end > p.texts[0].start);
  assert.deepEqual(p.markers, [{ time: 0 }]);
  assert.deepEqual([p.logo.position, p.logo.size], ['tr', 1]);
  const legacy = migrate({ ...newProject('Legacy'), youtube: { title: 'Old title', tags: 'a,b', chaptersFrom: 'clips' } });
  assert.equal(legacy.youtube.title, 'Old title', 'old YouTube details in saves are kept untouched (no UI any more)');
  assert.equal('youtube' in newProject(), false);
  const keep = migrate({ ...newProject('New'), thumb: { ...newProject().thumb, time: 0 } });
  assert.equal(keep.thumb.time, 0, 'a v5 project keeps a thumbnail chosen at 0:00');
  assert.equal(sanitizeProject(newProject()).settings.res, 1080);
});

test('fmt formats times', () => {
  assert.equal(fmt(0), '00:00'); assert.equal(fmt(61.9), '01:01'); assert.equal(fmt(3725), '1:02:05'); assert.equal(fmt(NaN), '00:00');
});
