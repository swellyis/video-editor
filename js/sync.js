// Sync: find how far two recordings of the same sound are apart (a camera and a separate recorder, or two cameras).
// Pure functions on loudness envelopes (200 values per second, made in sync-scan.js); no audio, no DOM, so they are unit-tested.
// Method: both envelopes are log-compressed and high-passed (so level, EQ and room noise matter little), the whole overlap is searched with a
// normalised cross-correlation by FFT at 50 Hz, then the best candidate is checked and refined at 200 Hz in several windows spread over the
// recording. The windows must agree (consensus); their trend over time gives the clock drift between the two devices.
import { planItem, placeItem, listOf, laneOf, findItem } from './model.js';

export const RATE = 200;      // envelope values per second
const COARSE = 4;             // 200 Hz -> 50 Hz
const MIN_OVERLAP = 4;        // seconds of overlap needed (at least; see minOverlap)
/** Overlap needed for a trustworthy match: half of the shorter recording, but not more than 20 s and not less than 4 s. */
export const minOverlap = (na, nb) => Math.max(MIN_OVERLAP, Math.min(20, 0.5 * Math.min(na, nb) / RATE));

/** In-place radix-2 FFT of (re, im), length a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** dB envelope (RATE per second, source time) -> time-line envelope: resampled for the playing speed. */
export function atSpeed(env, speed) {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-6) return env;
  const n = Math.floor((env.length - 1) / speed), out = new Float32Array(n);
  for (let k = 0; k < n; k++) { const x = k * speed, i = Math.floor(x), f = x - i; out[k] = env[i] * (1 - f) + env[Math.min(env.length - 1, i + 1)] * f; }
  return out;
}
/** Make an envelope comparable: floor the quiet parts, remove the slow level changes (about 1 s), scale to unit spread. */
export function prepare(db) {
  const n = db.length, out = new Float32Array(n); if (!n) return out;
  const srt = Float32Array.from(db.length > 40000 ? db.filter((_, i) => i % Math.ceil(db.length / 40000) === 0) : db).sort();
  const top = srt[Math.min(srt.length - 1, Math.floor(srt.length * 0.95))], floor = top - 40;
  const w = RATE, pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + Math.max(floor, db[i]);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1), m = (pre[b] - pre[a]) / (b - a);
    const v = Math.max(floor, db[i]) - m; out[i] = v; ss += v * v;
  }
  const sd = Math.sqrt(ss / n) || 1;
  for (let i = 0; i < n; i++) out[i] = Math.max(-4, Math.min(4, out[i] / sd));
  return out;
}
const decimate = (x, f) => { const n = Math.floor(x.length / f), o = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < f; k++) s += x[i * f + k]; o[i] = s / f; } return o; };

/**
 * Normalised cross-correlation c[L] = sum_j a[j+L]*b[j] / (|a window| |b window|) for L in [lo, hi] (samples), over the overlap only.
 * L > 0 means b's content appears L samples later in a. Lags with less than `minOv` samples of overlap are -2 (never chosen).
 */
export function ncc(a, b, lo, hi, minOv) {
  const na = a.length, nb = b.length;
  lo = Math.max(lo, -(nb - 1)); hi = Math.min(hi, na - 1);
  const N = pow2(na + nb), ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < N; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  const pa = new Float64Array(na + 1), pb = new Float64Array(nb + 1);
  for (let i = 0; i < na; i++) pa[i + 1] = pa[i] + a[i] * a[i];
  for (let i = 0; i < nb; i++) pb[i + 1] = pb[i] + b[i] * b[i];
  const out = new Float32Array(Math.max(0, hi - lo + 1));
  for (let L = lo; L <= hi; L++) {
    const j0 = Math.max(0, -L), j1 = Math.min(nb, na - L), ov = j1 - j0;
    if (ov < minOv) { out[L - lo] = -2; continue; }
    const ea = pa[j1 + L] - pa[j0 + L], eb = pb[j1] - pb[j0], d = Math.sqrt(ea * eb);
    out[L - lo] = d > 1e-9 ? ar[L >= 0 ? L : N + L] / d : 0;
  }
  return { c: out, lo };
}
/** Highest value of c (skipping -2), with sub-sample position from a parabola through the peak. */
function peakOf(c, lo) {
  let bi = -1, bv = -2;
  for (let i = 0; i < c.length; i++) if (c[i] > bv) { bv = c[i]; bi = i; }
  if (bi < 0) return null;
  let off = 0;
  if (bi > 0 && bi < c.length - 1 && c[bi - 1] > -1.5 && c[bi + 1] > -1.5) { const y0 = c[bi - 1], y2 = c[bi + 1], d = y0 - 2 * bv + y2; if (d < -1e-9) off = 0.5 * (y0 - y2) / d; }
  return { lag: lo + bi + off, index: bi, value: bv };
}
/** Peak-to-sidelobe ratio: the peak against the spread of the correlation away from it (excluding +-excl samples). */
function psr(c, index, excl) {
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < c.length; i++) { if (Math.abs(i - index) <= excl || c[i] < -1.5) continue; n++; s += c[i]; s2 += c[i] * c[i]; }
  if (n < 10) return 0;
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - m * m));
  return (c[index] - m) / sd;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Compare two prepared envelopes (RATE per second, each starting at its own start). Returns
 * { ok, lag (seconds: b's content shows up `lag` s later in a's time), confidence 0..1, psr, agreement, windows, driftPpm, driftMs, reason }.
 * `maxOffset` limits the search (seconds, default 60); when that finds nothing convincing the whole overlap is searched.
 */
export function align(aP, bP, { maxOffset = 60, onStep } = {}) {
  const need = MIN_OVERLAP * RATE;
  if (aP.length < need || bP.length < need) return { ok: false, confidence: 0, reason: 'short' };
  const aC = decimate(aP, COARSE), bC = decimate(bP, COARSE), r = RATE / COARSE;
  let best = null;
  for (const limit of [maxOffset, Infinity]) {
    const lim = limit === Infinity ? Infinity : Math.round(limit * r);
    onStep && onStep(limit === Infinity ? 'wide' : 'near');
    if (limit === Infinity && best && best.ok) break;
    if (limit === Infinity && maxOffset >= (aC.length + bC.length) / r) break;
    const { c, lo } = ncc(aC, bC, -lim, lim, Math.round(minOverlap(aP.length, bP.length) * r));
    const pk = peakOf(c, lo); if (!pk) continue;
    const p = psr(c, pk.index, Math.round(1.0 * r));
    const cand = verify(aP, bP, pk.lag / r, pk.value, p);
    if (!best || cand.confidence > best.confidence) best = cand;
    if (cand.ok) break;
  }
  return best || { ok: false, confidence: 0, reason: 'none' };
}
/** Check a coarse candidate (seconds) in windows at full resolution; the windows vote. */
function verify(aP, bP, lagSec, coarseValue, coarsePsr) {
  const lag0 = Math.round(lagSec * RATE);
  // overlap of b (shifted by lag0) inside a, in b's samples
  const j0 = Math.max(0, -lag0), j1 = Math.min(bP.length, aP.length - lag0), ov = j1 - j0;
  if (ov < minOverlap(aP.length, bP.length) * RATE) return { ok: false, confidence: 0, lag: lagSec, psr: coarsePsr, reason: 'overlap' };
  const ovS = ov / RATE, nWin = Math.max(1, Math.min(8, Math.floor(ovS / 6))), wLen = Math.min(60, ovS / nWin) * RATE | 0;
  const win = [];
  for (let k = 0; k < nWin; k++) {
    const centre = nWin === 1 ? j0 + ov / 2 : j0 + wLen / 2 + (ov - wLen) * (k / (nWin - 1));
    const s = Math.max(j0, Math.min(j1 - wLen, Math.round(centre - wLen / 2)));
    const bw = bP.subarray(s, s + wLen), span = Math.round(0.4 * RATE);
    const a0 = Math.max(0, s + lag0 - span), a1 = Math.min(aP.length, s + lag0 + wLen + span), aw = aP.subarray(a0, a1);
    const exp = s + lag0 - a0;      // where, inside the a-window, b-window's content is expected to start
    const { c, lo } = ncc(aw, bw, exp - span, exp + span, Math.round(wLen * 0.5));
    const pk = peakOf(c, lo); if (!pk || pk.value < -1) continue;
    // lag of this window, in samples relative to lag0
    win.push({ t: (s + wLen / 2) / RATE, lag: a0 + pk.lag - s, value: pk.value, psr: psr(c, pk.index, Math.round(0.05 * RATE)) });
  }
  const good = win.filter(w => w.value > 0.15);
  if (!good.length) return { ok: false, confidence: Math.max(0, Math.min(0.3, coarseValue)), lag: lagSec, psr: coarsePsr, agreement: 0, windows: win.length, reason: 'weak' };
  const med = median(good.map(w => w.lag));
  const agree = good.filter(w => Math.abs(w.lag - med) <= 0.03 * RATE);
  // with drift the windows slowly disagree: allow a line through them
  let driftPpm = 0, fit = null;
  if (good.length >= 3) {
    const n = good.length, mt = good.reduce((s, w) => s + w.t, 0) / n, ml = good.reduce((s, w) => s + w.lag, 0) / n;
    let sxx = 0, sxy = 0; for (const w of good) { sxx += (w.t - mt) ** 2; sxy += (w.t - mt) * (w.lag - ml); }
    const slope = sxx > 1e-9 ? sxy / sxx : 0;             // samples of lag per second
    const resid = good.filter(w => Math.abs(w.lag - (ml + slope * (w.t - mt))) <= 0.03 * RATE);
    if (resid.length > agree.length && resid.length >= 3 && (resid[resid.length - 1].t - resid[0].t) > 120) { driftPpm = slope / RATE * 1e6; fit = { slope, mt, ml }; }
  }
  const inl = fit ? good.filter(w => Math.abs(w.lag - (fit.ml + fit.slope * (w.t - fit.mt))) <= 0.03 * RATE) : agree;
  const agreement = inl.length / Math.max(1, win.length);
  const lagFinal = fit ? (fit.ml + fit.slope * (((j0 + j1) / 2) / RATE - fit.mt)) / RATE : median(inl.map(w => w.lag)) / RATE;
  const mv = inl.reduce((s, w) => s + w.value, 0) / Math.max(1, inl.length);
  // confidence: windows agree, the correlation is clearly above its background
  const conf = Math.max(0, Math.min(1, 0.5 * agreement + 0.3 * Math.min(1, (coarsePsr - 3) / 9) + 0.2 * Math.min(1, mv / 0.5)));
  const ok = agreement >= 0.6 && inl.length >= Math.min(3, win.length) && coarsePsr >= 5 && mv >= 0.2;
  return { ok, lag: lagFinal, confidence: conf, psr: coarsePsr, agreement, windows: win.length, driftPpm, driftMs: driftPpm * ovS / 1000, overlap: ovS, value: mv, reason: ok ? '' : (agreement < 0.6 ? 'disagree' : 'weak') };
}

/**
 * Move one item so that it lands at `start` (seconds). Uses the normal placement rules: it stays on its lane when that spot is free
 * (or nearly), otherwise it gets a new lane; a main clip that would sit over another main clip becomes a layer. Only that one item
 * moves (its own keyframes, fades, speed and trim go with it; captions, text, markers and other items stay where they are).
 * `mute` ({type, id}) also mutes that video's own sound. Returns { start, lane, pushed, stack, type } or { fail, reason }.
 */
export function applySync(project, mover, start, { mute = null } = {}) {
  const f = findItem(project, mover.id); if (!f || f.kind !== mover.type) return { fail: true, reason: 'The item is gone.' };
  if (start < -0.0005) return { fail: true, reason: 'before-start' };
  // The normal drop rules may nudge an item to the nearest free spot; a sync must land exactly, so when the exact spot is taken the item gets a new lane.
  const at = Math.max(0, start), lane0 = laneOf(f.item), want = planItem(project, f.kind, f.item, at, lane0);
  const lane = Math.abs(want.start - at) > 0.0005 ? { newAt: lane0 + 1 } : lane0;
  const plan = placeItem(project, f.kind, f.item, at, lane, { ripple: false });
  if (mute) { const m = listOf(project, mute.type).find(x => x.id === mute.id); if (m) m.muted = true; }
  return { start: Math.max(0, start), lane: plan.lane, pushed: !!plan.pushed, stack: !!plan.stack, type: plan.kind };
}
