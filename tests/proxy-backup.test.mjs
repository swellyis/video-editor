import test from 'node:test';
import assert from 'node:assert/strict';
import { needsProxy, proxyDims, proxyBitrate, proxyEstimate } from '../js/proxy.js';
import { tarHeader, tarSize, tarBytes, tarBlob, readTar, isTar, TAR_OCTAL_MAX } from '../js/util.js';
import { backupPlan, restorePlan, roomFor } from '../js/backup.js';

test('needsProxy: 4K, 1440p+ and long videos above 720p only', () => {
  assert.equal(needsProxy({ kind: 'video', width: 3840, height: 2160, duration: 10 }), true);
  assert.equal(needsProxy({ kind: 'video', width: 2560, height: 1440, duration: 10 }), true);
  assert.equal(needsProxy({ kind: 'video', width: 1920, height: 1080, duration: 60 }), false);
  assert.equal(needsProxy({ kind: 'video', width: 1920, height: 1080, duration: 900 }), true);
  assert.equal(needsProxy({ kind: 'video', width: 1280, height: 720, duration: 900 }), false, 'a long 720p file is small enough already');
  assert.equal(needsProxy({ kind: 'video', width: 640, height: 360, duration: 3600 }), false);
  assert.equal(needsProxy({ kind: 'video', width: 1080, height: 1920, duration: 30 }), false);
  assert.equal(needsProxy({ kind: 'audio', duration: 9000 }), false);
  assert.equal(needsProxy({ kind: 'image', width: 8000, height: 6000 }), false);
});
test('proxyDims: 540 short side, even, aspect kept, never upscaled', () => {
  assert.deepEqual(proxyDims(3840, 2160), { width: 960, height: 540 });
  assert.deepEqual(proxyDims(2160, 3840), { width: 540, height: 960 });
  assert.deepEqual(proxyDims(4096, 2160), { width: 1024, height: 540 });
  const d = proxyDims(640, 360); assert.deepEqual(d, { width: 640, height: 360 });
  const o = proxyDims(1001, 3001); assert.equal(o.width % 2, 0); assert.equal(o.height % 2, 0);
});
test('proxy bitrate and size estimate are sane', () => {
  assert.ok(proxyBitrate(960, 540, 30) >= 600000 && proxyBitrate(960, 540, 30) < 3e6);
  const e = proxyEstimate({ kind: 'video', width: 3840, height: 2160, duration: 30, fps: 30 });
  assert.ok(e > 2e6 && e < 15e6, 'estimate ' + e);
});
test('tar: octal sizes below 8 GiB, GNU base-256 above, both read back', () => {
  for (const n of [0, 1, 511, 512, 123456789, TAR_OCTAL_MAX, TAR_OCTAL_MAX + 1, 9e9, 2 ** 40 + 3]) assert.equal(tarSize(tarHeader('x', n)), n);
  assert.equal(tarHeader('x', 100)[124] & 0x80, 0);
  assert.equal(tarHeader('x', 9e9)[124], 0x80);
  // checksum stays valid with base-256
  const h = tarHeader('big', 9e9); const stored = parseInt(new TextDecoder().decode(h.subarray(148, 154)), 8);
  const c = h.slice(); c.fill(32, 148, 156); assert.equal(c.reduce((a, b) => a + b, 0), stored);
});
test('tar round-trip and tarBytes match', async () => {
  const a = new Blob([new Uint8Array(1000).fill(7)]), b = new Blob([new Uint8Array(513).fill(9)]);
  const t = tarBlob([{ name: 'project.json', data: '{"a":1}' }, { name: 'media/a', data: a }, { name: 'media/b', data: b }]);
  assert.equal(t.size, tarBytes([7, 1000, 513]));
  assert.ok(await isTar(t));
  const m = await readTar(t);
  assert.equal(await m.get('project.json').text(), '{"a":1}');
  assert.equal(m.get('media/a').size, 1000); assert.equal(m.get('media/b').size, 513);
  assert.equal(new Uint8Array(await m.get('media/b').arrayBuffer())[512], 9);
});
test('backupPlan: media meta without blobs/peaks, files only when embedding, exact file size', () => {
  const recs = { m1: { id: 'm1', kind: 'video', name: 'a.mp4', blob: new Blob([new Uint8Array(3000)]), peaks: [1, 2] }, m2: { id: 'm2', kind: 'audio', name: 'b.wav' } };
  const p = { id: 'p', name: 'P', clips: [] };
  const w = backupPlan(p, ['m1', 'm2', 'gone'], (id) => recs[id], true);
  assert.equal(w.files.length, 1); assert.equal(w.mediaBytes, 3000); assert.equal(w.missing, 1);
  assert.ok(w.meta.every(m => !('blob' in m) && !('peaks' in m)));
  assert.equal(w.meta[0].file, 'media/m1');
  assert.equal(w.fileBytes, tarBytes([new TextEncoder().encode(w.json).length, 3000]));
  const n = backupPlan(p, ['m1'], (id) => recs[id], false);
  assert.equal(n.files.length, 0); assert.equal(n.fileBytes, n.json.length); assert.equal(JSON.parse(n.json).format, 1);
});
test('restorePlan skips media already here and lists missing bytes', () => {
  const entries = new Map([['media/a', new Blob([new Uint8Array(10)])]]);
  const data = { media: [{ id: 'a', file: 'media/a' }, { id: 'b', file: 'media/b' }, { id: 'c', file: 'media/a' }] };
  const r = restorePlan(data, entries, (id) => id === 'c');
  assert.equal(r.store.length, 1); assert.equal(r.bytes, 10); assert.deepEqual(r.missing.map(m => m.id), ['b']);
});
test('roomFor: refuses when free space is short, allows unknown quota', () => {
  assert.equal(roomFor(null, 5e9).ok, true);
  assert.equal(roomFor({ quota: 1e9, usage: 0 }, 2e9).ok, false);
  assert.equal(roomFor({ quota: 10e9, usage: 1e9 }, 2e9).ok, true);
  assert.equal(roomFor({ quota: 100, usage: 100 }, 0).ok, true);
});
