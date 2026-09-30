// Unit tests for the pure logic (no browser needed): node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textLabel, blurLabel, newProject, migrate, layout, splitItem, newBlur, blurAt, animated, setKeyframe, defaultClipBlur, newAudio, clipGain, musicGain, speechIntervals, rebaseKeyframes, normalizeClip, newText, sanitizeProject, SCHEMA, clipLen, thumbFormat, THUMB_FORMATS } from '../js/model.js';
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
  assert.deepEqual(p.markers, [{ name: '', time: 0 }]);
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

test('thumbnail formats: sizes, auto follows the project aspect, old projects and bad values are repaired', () => {
  assert.deepEqual([THUMB_FORMATS['16:9'].width, THUMB_FORMATS['16:9'].height], [1280, 720]);
  assert.deepEqual([THUMB_FORMATS['9:16'].width, THUMB_FORMATS['9:16'].height], [1080, 1920]);
  assert.deepEqual([THUMB_FORMATS['1:1'].width, THUMB_FORMATS['1:1'].height], [1080, 1080]);
  const p = newProject('x'); assert.equal(thumbFormat(p).key, '16:9');
  p.settings.ratio = '9:16'; assert.equal(thumbFormat(p).key, '9:16'); assert.equal(thumbFormat(p, '1:1').key, '1:1');
  p.settings.ratio = '4:5'; assert.equal(thumbFormat(p).key, '1:1');
  const old = JSON.parse(JSON.stringify(newProject('o'))); delete old.thumb.format; delete old.thumb.type; old.thumb.text = 'Hi';
  const m = migrate(old); assert.equal(m.thumb.format, 'auto'); assert.equal(m.thumb.type, 'jpg'); assert.equal(m.thumb.text, 'Hi');
  const bad = JSON.parse(JSON.stringify(newProject('b'))); bad.thumb.format = 'x'; bad.thumb.type = 'gif';
  const mb = migrate(bad); assert.equal(mb.thumb.format, 'auto'); assert.equal(mb.thumb.type, 'jpg');
});

test('mute: muted clips/tracks are silent, do not duck, survive split, and old projects default to sound on', () => {
  const p = proj(clip('a', 10), clip('b', 10)); p.clips[0].muted = true;
  let lay = layout(p);
  assert.equal(clipGain(lay.items[0], 5), 0); assert.ok(clipGain(lay.items[1], 15) > 0);
  assert.deepEqual(speechIntervals(lay, p).map(x => x.map(Math.round)), [[10, 20]]); // only the unmuted clip counts as speech
  const mu = newAudio({ id: 'm', duration: 30, name: 'song' }, 0); mu.fadeIn = 0; assert.equal(mu.muted, false);
  const iv = speechIntervals(lay, p);
  assert.ok(musicGain(mu, 5, iv, 20) > 0.59, 'no ducking under the muted clip'); assert.ok(musicGain(mu, 15, iv, 20) < 0.3, 'ducks under the unmuted one');
  mu.muted = true; assert.equal(musicGain(mu, 5, iv, 20), 0);
  const v = newAudio({ id: 'v', duration: 30, name: 'vo' }, 0); v.voice = true; p.audio = [v]; p.clips.forEach(c => c.muted = true); lay = layout(p);
  assert.equal(speechIntervals(lay, p).length, 1); v.muted = true; assert.equal(speechIntervals(lay, p).length, 0);
  const q = proj(clip('s', 10, { muted: true })); const r = splitItem(q, { type: 'clip', id: 's' }, 4);
  assert.ok(r && q.clips.length === 2 && q.clips.every(c => c.muted));
  const old = { schema: 5, clips: [{ id: 'c', mediaId: 'x', in: 0, out: 2 }], audio: [{ id: 'a', mediaId: 'y', srcDuration: 5 }], overlays: [] };
  const m = migrate(old); assert.equal(m.clips[0].muted, false); assert.equal(m.audio[0].muted, false);
  const bad = migrate({ clips: [{ id: 'c', mediaId: 'x', in: 0, out: 2, muted: 'yes' }], audio: [{ id: 'a', mediaId: 'y', srcDuration: 5, muted: 1 }] });
  assert.equal(bad.clips[0].muted, false); assert.equal(bad.audio[0].muted, false);
});

test('blur regions: defaults, timing + fades, keyframed motion, split, ripple, migration and damaged input', () => {
  const p = proj(clip('a', 10)); assert.deepEqual(p.blurs, []);
  const b = newBlur(2, 4); Object.assign(b, { x: 0.2, w: 0.2, fadeIn: 1, fadeOut: 1 }); p.blurs.push(b);
  assert.equal(blurAt(b, 1.9), null); assert.equal(blurAt(b, 6), null);
  assert.ok(Math.abs(blurAt(b, 2.5).amount - 0.5) < 1e-9); assert.equal(blurAt(b, 4).amount, 1); assert.ok(blurAt(b, 5.5).amount < 0.6);
  setKeyframe(b, 'x', 0, 0.2, 'linear'); setKeyframe(b, 'x', 4, 0.8, 'linear');
  assert.ok(Math.abs(animated('blur', b, 2).x - 0.5) < 1e-9); assert.ok(Math.abs(blurAt(b, 4).x - 0.5) < 1e-9);
  assert.equal(animated('blur', b, 1).scale, undefined, 'blur regions animate position and size only');
  const r = splitItem(p, { type: 'blur', id: b.id }, 4);
  assert.ok(r && !r.fail && p.blurs.length === 2 && Math.abs(p.blurs[0].end - 4) < 1e-9 && Math.abs(p.blurs[1].start - 4) < 1e-9);
  assert.ok(Math.abs(animated('blur', p.blurs[1], 0).x - 0.5) < 1e-6, 'second half continues from the interpolated position');
  assert.ok(splitItem(p, { type: 'blur', id: p.blurs[0].id }, 2.001).fail, 'cannot split at the very edge');
  const old = migrate({ schema: 5, clips: [{ id: 'c', mediaId: 'x', in: 0, out: 2 }] });
  assert.deepEqual(old.blurs, []); assert.deepEqual(old.clips[0].blur, defaultClipBlur()); assert.equal(old.clips[0].blur.enabled, false);
  const bad = migrate({ blurs: [null, 'x', { shape: 'star', mode: 'zap', x: 99, w: 0, strength: 9, invert: 'yes', start: -3, end: -9, keyframes: { x: [{ t: 'z', v: 1 }, { t: 1, v: 1e9 }] } }, ...Array.from({ length: 300 }, () => ({}))],
    clips: [{ id: 'c', mediaId: 'x', in: 0, out: 2, blur: { enabled: 'yes', strength: 7, mode: 'evil' } }] });
  const q = bad.blurs[0]; assert.ok(bad.blurs.length <= 200);
  assert.equal(q.shape, 'rect'); assert.equal(q.mode, 'blur'); assert.equal(q.invert, false); assert.ok(q.x <= 1.5 && q.w >= 0.01 && q.strength === 1 && q.end > q.start && q.start >= 0);
  assert.deepEqual(q.keyframes.x.map(k => k.v), [1.5]);
  assert.equal(bad.clips[0].blur.enabled, false); assert.equal(bad.clips[0].blur.strength, 1); assert.equal(bad.clips[0].blur.mode, 'blur');
});

test('item names: defaults, trimming to 80 chars, blank clip names fall back, labels', () => {
  const p = migrate({ clips: [{ id: 'c1', mediaId: 'm', name: '  ' }, { id: 'c2', mediaId: 'm', name: 'x'.repeat(200) }], texts: [{ id: 't', text: 'Hello', name: 5 }], markers: [{ time: 1, name: 'y'.repeat(100) }] });
  sanitizeProject(p);
  assert.equal(p.clips[0].name, 'Clip');
  assert.equal(p.clips[1].name.length, 80);
  assert.equal(p.texts[0].name, '');
  assert.equal(textLabel(p.texts[0]), 'Hello');
  assert.equal(textLabel({ text: 'Hello', name: 'Title' }), 'Title');
  assert.equal(p.markers[0].name.length, 80);
  assert.equal(blurLabel({ mode: 'blur' }), 'Blur');
  assert.equal(blurLabel({ mode: 'pixelate' }), 'Pixelate');
  assert.equal(blurLabel({ invert: true }), 'Focus');
  assert.equal(blurLabel({ name: 'Face' }), 'Face');
});

test('connect: https-only URL validation, shared-text link extraction', async () => {
  const c = await import('../js/connect.js');
  const good = { 'https://a.com/x.mp4': 'https://a.com/x.mp4', 'a.com/x': 'https://a.com/x', '//a.com/x': 'https://a.com/x', 'a.com:8080/x': 'https://a.com:8080/x', '  https://A.com/Path?q=1  ': 'https://a.com/Path?q=1' };
  for (const [i, o] of Object.entries(good)) assert.deepEqual(c.parseHttpsUrl(i), { ok: true, url: o }, i);
  for (const bad of ['', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'blob:https://a.com/x', 'file:///etc/passwd', 'http://a.com', 'ftp://a.com', 'https://u:p@a.com', 'https://a b.com', 'localhost', 'https://localhost/', 'https:a.com', 'x'.repeat(3000)]) assert.equal(c.parseHttpsUrl(bad).ok, false, bad);
  assert.equal(c.extractUrl('Look at this https://x.com/a.mp4, wow'), 'https://x.com/a.mp4');
  assert.equal(c.extractUrl('no link'), '');
});

test('connect: media type / file name detection', async () => {
  const c = await import('../js/connect.js');
  assert.equal(c.mediaTypeOf('video/mp4; codecs=avc1', 'https://a.com/x'), 'video/mp4');
  assert.equal(c.mediaTypeOf('application/octet-stream', 'https://a.com/clip.MOV?x=1'), 'video/quicktime');
  assert.equal(c.mediaTypeOf('', 'https://a.com/a.mp3'), 'audio/mpeg');
  for (const [t, u] of [['text/html', 'https://a.com/a.mp4'], ['application/octet-stream', 'https://a.com/data.bin'], ['application/vnd.apple.mpegurl', 'https://a.com/a.m3u8'], ['image/svg+xml', 'https://a.com/a.svg'], ['application/json', 'https://a.com/a.mp4']]) assert.throws(() => c.mediaTypeOf(t, u), (e) => e.code === 'notmedia', t);
  assert.equal(c.nameFromUrl('https://a.com/dir/clip%20one.mp4?x=1', 'video/mp4'), 'clip one.mp4');
  assert.equal(c.nameFromUrl('https://a.com/dl', 'video/webm'), 'dl.webm');
  assert.equal(c.nameFromUrl('https://a.com/', 'image/png'), 'linked-media.png');
});

test('project names: dated default, placeholder migration, cleaning', async () => {
  const m = await import('../js/model.js');
  const t = Date.UTC(2026, 8, 29, 20, 52);
  assert.match(m.defaultProjectName(t, 'en-US'), /^Project · Sep 29, \d{1,2}:52 (AM|PM)$/);
  assert.match(m.defaultProjectName(Date.UTC(2020, 0, 5, 12, 5), 'en-US'), /2020/);
  assert.notEqual(m.defaultProjectName(t, 'en-US'), m.defaultProjectName(t, 'de-DE'));
  assert.match(m.newProject().name, /^Project · /);
  assert.match(m.newProject('').name, /^Project · /);
  assert.equal(m.newProject('Sunday').name, 'Sunday');
  for (const bad of ['Untitled project', 'untitled project', ' UNTITLED ', '', '   ', undefined, null, 5]) assert.equal(m.isPlaceholderName(bad), true, String(bad));
  for (const good of ['Sunday', 'Untitled project 2', 'My first video', 'Untitled — mine']) assert.equal(m.isPlaceholderName(good), false, good);
  const old = m.migrate({ ...m.newProject('x'), name: 'Untitled project', created: Date.UTC(2025, 2, 3, 15, 30) });
  assert.match(old.name, /^Project · Mar 3, 2025/);
  assert.equal(m.migrate({ ...m.newProject('x'), name: 'Kept as is' }).name, 'Kept as is');
  assert.equal(m.migrate({ ...m.newProject('x'), name: 'Untitled project 2' }).name, 'Untitled project 2');
  assert.equal(m.SCHEMA, 5);
  assert.equal(m.cleanProjectName('  a   b  '), 'a b');
  assert.equal(m.cleanProjectName('x'.repeat(200)).length, 80);
  assert.equal(m.cleanProjectName(null), '');
});
