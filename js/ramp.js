// Speed ramps + reverse (pure maths, no DOM). A ramp is a speed curve over the clip's SOURCE time:
//   clip.ramp = { pts: [{ t: sourceSeconds, s: speed 0.25..4 }, ...] sorted by t, audio: 'follow' | 'mute' }
// Points sit on the footage itself (not on the timeline), so trimming or splitting a clip keeps the curve on the same moments.
// Between two points the speed eases with a smoothstep (no corners, no overshoot); before the first / after the last point it holds.
// The clip's timeline length is the integral of 1/speed over [in, out]; mapFor() tabulates it once per curve.
export const RAMP_MIN = 0.25, RAMP_MAX = 4, RAMP_MAX_POINTS = 12, MIN_GAP = 0.05;
const clampS = (s) => Math.min(RAMP_MAX, Math.max(RAMP_MIN, Number.isFinite(+s) ? +s : 1));
const smooth = (u) => u * u * (3 - 2 * u);

export const PRESETS = [
  { id: 'montage', name: 'Montage', hint: 'slow, fast, slow, fast', pts: [[0, 1], [0.2, 0.4], [0.45, 2.6], [0.7, 0.4], [1, 1.8]] },
  { id: 'hero', name: 'Hero time', hint: 'normal, slow-mo in the middle, normal', pts: [[0, 1], [0.3, 1], [0.45, 0.3], [0.65, 0.3], [0.8, 1], [1, 1]] },
  { id: 'bullet', name: 'Bullet', hint: 'fast, a long freeze-like slow-mo, fast', pts: [[0, 2.2], [0.3, 2.2], [0.44, 0.25], [0.56, 0.25], [0.7, 2.2], [1, 2.2]] },
  { id: 'jumper', name: 'Jumper', hint: 'beats of slow and fast', pts: [[0, 0.4], [0.25, 2.6], [0.5, 0.4], [0.75, 2.6], [1, 0.4]] },
  { id: 'flashin', name: 'Flash-in', hint: 'bursts in fast, settles to normal', pts: [[0, 4], [0.3, 4], [0.55, 1], [1, 1]] },
  { id: 'flashout', name: 'Flash-out', hint: 'normal, then speeds away', pts: [[0, 1], [0.45, 1], [0.7, 4], [1, 4]] },
];
export const presetById = (id) => PRESETS.find(p => p.id === id) || null;

/** A ramp from a preset, laid over the clip's current in..out. */
export function fromPreset(id, c) {
  const p = presetById(id); if (!p) return null;
  const span = Math.max(0.01, c.out - c.in);
  return { pts: p.pts.map(([u, s]) => ({ t: c.in + u * span, s })), audio: 'follow', preset: id };
}
/** Clean up a ramp read from a saved project (or null if it is not a usable ramp). */
export function normalize(r) {
  if (!r || !Array.isArray(r.pts)) return null;
  const pts = r.pts.map(p => ({ t: +p.t, s: clampS(p.s) })).filter(p => Number.isFinite(p.t) && p.t >= 0).sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of pts) if (!out.length || p.t - out[out.length - 1].t >= 1e-4) out.push(p);
  if (!out.length) return null;
  const res = { pts: out.slice(0, RAMP_MAX_POINTS * 2), audio: r.audio === 'mute' ? 'mute' : 'follow' };
  if (typeof r.preset === 'string' && presetById(r.preset)) res.preset = r.preset;
  return res;
}
/** Speed (x) at source time t. */
export function speedAt(r, t) {
  const p = r.pts, n = p.length;
  if (n === 1 || t <= p[0].t) return p[0].s;
  if (t >= p[n - 1].t) return p[n - 1].s;
  let i = 1; while (i < n - 1 && p[i].t < t) i++;
  const a = p[i - 1], b = p[i], u = (t - a.t) / (b.t - a.t);
  return a.s + (b.s - a.s) * smooth(u);
}

const SUB = 48; // slices per segment for the tabulated integral
const cache = new Map();
/**
 * Timeline <-> source mapping for a clip with a ramp. `len` = timeline seconds for in..out; `fwd(tl)` = source time `tl` seconds after
 * the clip start (playing forward); `back(src)` = timeline offset of a source time (forward).
 */
export function mapFor(c) {
  const r = c.ramp; if (!r) return null;
  const key = c.in + '|' + c.out + '|' + r.pts.map(p => p.t.toFixed(4) + ':' + p.s.toFixed(4)).join(',');
  let m = cache.get(key); if (m) return m;
  // breakpoints: in, every ramp point inside (in, out), out; each slice integrates 1/speed (Simpson over 3 samples)
  const xs = [c.in];
  for (const p of r.pts) if (p.t > c.in + 1e-6 && p.t < c.out - 1e-6) xs.push(p.t);
  xs.push(Math.max(c.in + 1e-6, c.out));
  const S = [c.in], T = [0]; // tabulated source times and cumulative timeline seconds
  for (let k = 0; k < xs.length - 1; k++) {
    const a = xs[k], b = xs[k + 1], h = (b - a) / SUB;
    for (let j = 0; j < SUB; j++) {
      const x0 = a + j * h, x1 = x0 + h;
      const f = (x) => 1 / speedAt(r, x);
      T.push(T[T.length - 1] + h * (f(x0) + 4 * f((x0 + x1) / 2) + f(x1)) / 6); S.push(x1);
    }
  }
  const len = T[T.length - 1];
  const find = (arr, v) => { let lo = 0, hi = arr.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; } return lo; };
  m = {
    len,
    fwd(tl) { // source time after tl seconds
      if (tl <= 0) return c.in; if (tl >= len) return c.out;
      const i = find(T, tl), u = (tl - T[i]) / Math.max(1e-12, T[i + 1] - T[i]);
      return S[i] + (S[i + 1] - S[i]) * u;
    },
    back(src) { // timeline offset of a source time
      if (src <= c.in) return 0; if (src >= c.out) return len;
      const i = find(S, src), u = (src - S[i]) / Math.max(1e-12, S[i + 1] - S[i]);
      return T[i] + (T[i + 1] - T[i]) * u;
    },
  };
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  cache.set(key, m);
  return m;
}

/** Timeline length (s) of a video clip's in..out given speed / ramp. */
export function lengthOf(c) {
  if (c.ramp) return mapFor(c).len;
  return (c.out - c.in) / (c.speed || 1);
}
/** Source time `tl` seconds after the clip's start on the timeline (honours speed, ramp and reverse). Not clamped. */
export function sourceAtOffset(c, tl) {
  const len = lengthOf(c);
  const f = c.reverse ? Math.max(0, len - tl) : tl; // reverse plays the same curve from the end
  if (c.ramp) return mapFor(c).fwd(f);
  return c.in + f * (c.speed || 1);
}
/** Timeline offset of source time `src` (inverse of sourceAtOffset). */
export function offsetOfSource(c, src) {
  const len = lengthOf(c);
  const f = c.ramp ? mapFor(c).back(src) : Math.max(0, (src - c.in) / (c.speed || 1));
  return c.reverse ? Math.max(0, len - f) : f;
}
/** Playback speed (x, always > 0) of the clip `tl` seconds after its start; `dir` is -1 while reversed. */
export function rateAtOffset(c, tl) {
  const src = sourceAtOffset(c, tl);
  return { rate: c.ramp ? speedAt(c.ramp, src) : (c.speed || 1), dir: c.reverse ? -1 : 1, src };
}
/** Mean speed over the clip (what the plain Speed number would be). */
export const meanSpeed = (c) => { const l = lengthOf(c); return l > 0 ? (c.out - c.in) / l : (c.speed || 1); };

/**
 * Pieces of constant speed for the audio mixer, covering the clip's timeline span from `from` to `to` (offsets in seconds from
 * the clip start): [{ off0, off1, src0, src1, speed }] where src0 -> src1 may run backwards when reversed.
 */
export function audioPieces(c, from, to, step = 0.25) {
  const out = [];
  for (let a = from; a < to - 1e-6; a += step) {
    const b = Math.min(to, a + step), s0 = sourceAtOffset(c, a), s1 = sourceAtOffset(c, b);
    const dur = b - a, spd = dur > 0 ? Math.abs(s1 - s0) / dur : 1;
    out.push({ off0: a, off1: b, src0: s0, src1: s1, speed: Math.min(RAMP_MAX * 1.01, Math.max(RAMP_MIN * 0.99, spd)) });
  }
  return out;
}

// ---- editing helpers for the curve editor ----
/** Make sure there is a point exactly at in and at out (the editor works on those two as fixed ends) and drop points outside. */
export function withEnds(r, c) {
  const pts = r.pts.filter(p => p.t > c.in + MIN_GAP && p.t < c.out - MIN_GAP).map(p => ({ ...p }));
  return { ...r, pts: [{ t: c.in, s: speedAt(r, c.in) }, ...pts, { t: c.out, s: speedAt(r, c.out) }] };
}
export function addPoint(r, c, t, s) {
  const w = withEnds(r, c);
  if (w.pts.length >= RAMP_MAX_POINTS) return null;
  t = Math.min(c.out - MIN_GAP, Math.max(c.in + MIN_GAP, t));
  if (w.pts.some(p => Math.abs(p.t - t) < MIN_GAP)) return null;
  w.pts.push({ t, s: clampS(s) }); w.pts.sort((a, b) => a.t - b.t); delete w.preset;
  return w;
}
/** Move point i (ends keep their time, only their speed changes). Returns a new ramp. */
export function movePoint(r, c, i, t, s) {
  const w = withEnds(r, c); const p = w.pts[i]; if (!p) return w;
  const last = w.pts.length - 1;
  if (i > 0 && i < last) p.t = Math.min(w.pts[i + 1].t - MIN_GAP, Math.max(w.pts[i - 1].t + MIN_GAP, t));
  p.s = clampS(s); delete w.preset;
  return w;
}
export function removePoint(r, c, i) {
  const w = withEnds(r, c); if (i <= 0 || i >= w.pts.length - 1) return w;
  w.pts.splice(i, 1); delete w.preset; return w;
}
export const clampSpeed = clampS;
