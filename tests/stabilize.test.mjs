import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMotion, fitSimilarity, gaussSmooth, corrections, correctionAt, jitter, MODES, repairOutliers } from '../js/stabilize.js';
import { normalizeClip, defaultChroma } from '../js/model.js';

// a random-blob texture sampled with a known shift / rotation
const W = 192, H = 108, BIG = 420; const src = new Uint8Array(BIG * BIG);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let k = 0; k < 1100; k++) { const cx = rnd() * BIG, cy = rnd() * BIG, r = 2 + rnd() * 7, v = rnd() * 255; for (let y = Math.max(0, cy - r | 0); y < Math.min(BIG, cy + r); y++) for (let x = Math.max(0, cx - r | 0); x < Math.min(BIG, cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) src[y * BIG + x] = v; }
const bil = (u, v) => { const x = Math.floor(u), y = Math.floor(v), fx = u - x, fy = v - y, g = (i, j) => src[(y + j) * BIG + x + i] || 0; return g(0, 0) * (1 - fx) * (1 - fy) + g(1, 0) * fx * (1 - fy) + g(0, 1) * (1 - fx) * fy + g(1, 1) * fx * fy; };
const frame = (ox, oy, ang = 0) => { const o = new Uint8Array(W * H), c = Math.cos(ang), s = Math.sin(ang); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const X = x - W / 2, Y = y - H / 2; o[y * W + x] = bil(c * X - s * Y + BIG / 2 + ox, s * X + c * Y + BIG / 2 + oy); } return o; };

test('estimateMotion finds whole-pixel and sub-pixel shifts', () => {
  const a = frame(0, 0);
  for (const [sx, sy] of [[3, -2], [-7, 4], [0.5, -1.5], [12, 6]]) {
    const m = estimateMotion(a, frame(-sx, -sy), W, H);
    assert.ok(Math.abs(m.dx - sx) < 0.3 && Math.abs(m.dy - sy) < 0.3, `shift ${sx},${sy} -> ${m.dx.toFixed(2)},${m.dy.toFixed(2)}`);
  }
});
test('estimateMotion finds a small rotation', () => {
  const m = estimateMotion(frame(0, 0), frame(0, 0, 0.02), W, H);
  assert.ok(Math.abs(m.da + 0.02) < 0.006, 'da ' + m.da);
});
test('a flat frame gives no motion (no false shake)', () => {
  const g = new Uint8Array(W * H).fill(90); const m = estimateMotion(g, g, W, H);
  assert.equal(m.dx, 0); assert.equal(m.dy, 0);
});
test('fitSimilarity recovers translation + rotation exactly', () => {
  const a = 0.03, c = Math.cos(a), s = Math.sin(a), pts = [];
  for (const [x, y] of [[-40, -20], [40, -20], [40, 20], [-40, 20], [0, 0]]) pts.push({ x, y, u: c * x - s * y + 5 - x, v: s * x + c * y - 3 - y });
  const f = fitSimilarity(pts); assert.ok(Math.abs(f.tx - 5) < 1e-9 && Math.abs(f.ty + 3) < 1e-9 && Math.abs(Math.atan2(f.b, f.a) - a) < 1e-9);
});
test('gaussSmooth keeps a constant and a ramp, removes zig-zag', () => {
  assert.deepEqual(gaussSmooth([2, 2, 2, 2, 2], 1).map(v => +v.toFixed(9)), [2, 2, 2, 2, 2]);
  const r = Array.from({ length: 40 }, (_, i) => i), sr = gaussSmooth(r, 2); assert.ok(Math.abs(sr[20] - 20) < 1e-9);
  const z = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : -1)), sz = gaussSmooth(z, 3); assert.ok(Math.abs(sz[20]) < 0.05);
});
test('corrections cancel shake, keep a pan, cap the zoom and clamp to the margin', () => {
  const mot = Array.from({ length: 150 }, (_, i) => ({ dx: 0.002 + 0.01 * Math.sin(i * 2.1), dy: 0.006 * Math.sin(i * 3.3), da: 0 }));
  for (const mode of ['smooth', 'strong']) {
    const c = corrections(mot, 30, mode, 9 / 16);
    assert.ok(c.zoom >= 1 && c.zoom <= MODES[mode].maxZoom + 1e-9);
    const res = mot.map((m, i) => ({ dx: m.dx + (i ? c.frames[i].x - c.frames[i - 1].x : 0), dy: m.dy + (i ? c.frames[i].y - c.frames[i - 1].y : 0) }));
    assert.ok(jitter(res, 30) < jitter(mot, 30) * 0.2, mode + ' removes most shake');
    if (mode === 'smooth') assert.ok(Math.abs(res.reduce((a, m) => a + m.dx, 0) / res.length - 0.002) < 0.0008, 'the pan is kept');
    const mX = (c.zoom - 1) / 2; assert.ok(c.frames.every(f => Math.abs(f.x) <= mX + 1e-12));
  }
  const big = Array.from({ length: 60 }, (_, i) => ({ dx: i % 2 ? 0.2 : -0.2, dy: 0, da: 0 }));
  assert.ok(corrections(big, 30, 'smooth').zoom <= MODES.smooth.maxZoom + 1e-9, 'huge shake: zoom stays capped');
});
test('correctionAt picks the frame on screen at t (no blending) and clamps to the ends', () => {
  const c = { frames: [{ x: 0, y: 0, a: 0 }, { x: 1, y: 2, a: 0.1 }] };
  assert.deepEqual(correctionAt(c, 10, 2, 10.25), { x: 0, y: 0, a: 0 });
  assert.deepEqual(correctionAt(c, 10, 2, 10.4999), { x: 1, y: 2, a: 0.1 }, 'a time a hair before the frame start (float error) still gets that frame');
  assert.deepEqual(correctionAt(c, 10, 2, 99), { x: 1, y: 2, a: 0.1 });
  assert.deepEqual(correctionAt(c, 10, 2, 0), { x: 0, y: 0, a: 0 });
});
test('clips get a chroma block and a stabilize mode (default off)', () => {
  const c = normalizeClip({ id: 'c1' }); assert.deepEqual(c.chroma, defaultChroma()); assert.equal(c.stab, 'off');
  assert.equal(normalizeClip({ stab: 'strong' }).stab, 'strong'); assert.equal(normalizeClip({ stab: 'bogus' }).stab, 'off');
  assert.equal(normalizeClip({ chroma: { enabled: true, color: '#00b140' } }).chroma.spill, defaultChroma().spill);
});
test('repairOutliers fixes a one-frame false match but keeps a real move', () => {
  const a = [0.01, -0.01, 0.012, -0.008, 0.13, 0.009, -0.011, 0.01, -0.01];
  assert.equal(repairOutliers(a, 0.03), 1); assert.ok(Math.abs(a[4]) < 0.02);
  const pan = Array.from({ length: 12 }, (_, i) => (i < 6 ? 0 : 0.05)); // a sustained change of speed is not a glitch
  assert.equal(repairOutliers(pan, 0.03), 0);
});
