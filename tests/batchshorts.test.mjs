import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQueue, summarize, Skip } from '../js/queue.js';
import { shortFileName, NAME_PATTERN, makeShortProject } from '../js/shorts.js';
import { newProject } from '../js/model.js';

test('queue runs in order, one at a time, with per-item results', async () => {
  const seen = [], ups = [];
  let running = 0, maxRunning = 0;
  const rows = await runQueue([1, 2, 3], async (x, { progress }) => { running++; maxRunning = Math.max(maxRunning, running); progress(0.5, 'half'); await new Promise(r => setTimeout(r, 5)); seen.push(x); running--; return x * 10; }, { onUpdate: (r, f) => ups.push(f) });
  assert.deepEqual(seen, [1, 2, 3]); assert.equal(maxRunning, 1);
  assert.deepEqual(rows.map(r => [r.state, r.result]), [['done', 10], ['done', 20], ['done', 30]]);
  assert.equal(ups[ups.length - 1], 1); assert.ok(ups.some(f => f > 0 && f < 1));
  assert.equal(summarize(rows), '3 exported');
});
test('a failed or skipped item does not stop the queue', async () => {
  const rows = await runQueue(['a', 'b', 'c'], async (x) => { if (x === 'a') throw new Skip('missing'); if (x === 'b') throw new Error('boom'); return x; });
  assert.deepEqual(rows.map(r => r.state), ['skipped', 'failed', 'done']);
  assert.equal(rows[0].error, 'missing'); assert.equal(rows[1].error, 'boom');
  assert.equal(summarize(rows), '1 exported · 1 skipped · 1 failed');
});
test('cancel stops the running item and everything still waiting; finished ones stay done', async () => {
  const ac = new AbortController();
  const rows = await runQueue([1, 2, 3, 4], async (x, { signal }) => {
    if (x === 2) { setTimeout(() => ac.abort(), 5); await new Promise((res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'ExportCancelled' })))); }
    return x;
  }, { signal: ac.signal });
  assert.deepEqual(rows.map(r => r.state), ['done', 'cancelled', 'cancelled', 'cancelled']);
  assert.equal(summarize(rows), '1 exported · 3 cancelled');
});
test('file names: pattern tokens, padding, safe characters, unique', () => {
  const used = new Set(), d = new Date(2026, 9, 7);
  assert.equal(shortFileName(NAME_PATTERN, { name: 'Weekly update', n: 3, count: 12, start: 75, date: d }, used), 'Weekly-update-Short-03');
  assert.equal(shortFileName('{date}_{start}_{score}', { name: 'x', n: 1, count: 1, start: 75.9, score: 81.6, date: d }), '2026-10-07_1m15s_82');
  assert.equal(shortFileName('{name}', { name: 'A/B: "c"', n: 1, count: 1 }), 'A-B-c');
  assert.equal(shortFileName('{name}', { name: 'Same', n: 1, count: 2 }, used), 'Same-1');
  assert.equal(shortFileName('{name}', { name: 'Same', n: 1, count: 2 }, used), 'Same-1-2');
  assert.equal(shortFileName('', { name: '', n: 1 }), 'Video-Short-1');
});
test('makeShortProject takes any caption style pack (default Bold)', () => {
  const p = newProject('x');
  p.clips = [{ id: 'c1', mediaId: 'm', kind: 'video', in: 0, out: 60, srcDuration: 60, speed: 1 }];
  p.captions = [{ id: 'k', start: 1, end: 3, text: 'hello there' }];
  assert.equal(makeShortProject(p, 0, 30, { has: () => true }).project.captionStyle.preset, 'shorts');
  assert.equal(makeShortProject(p, 0, 30, { has: () => true, captionPreset: 'karaoke' }).project.captionStyle.preset, 'karaoke');
  assert.equal(makeShortProject(p, 0, 30, { has: () => true, captionPreset: 'nope' }).project.captionStyle.preset, 'shorts');
});
