// Snap to beat, the maths (pure, no browser): from an "onset strength" curve (how much new sound starts at each moment, ORATE values per
// second) find the tempo (autocorrelation) and the beat times (a dynamic-programming tracker: every beat should fall on a strong onset and
// be one beat period after the previous one). Also says how sure it is, and says "no clear beat" for noise, pads and speech.
import { fft } from './sync.js';

export const ORATE = 200;                 // onset values per second (5 ms)
export const MIN_BPM = 60, MAX_BPM = 200;
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** Make the curve comparable: remove the slow level (about 1 s moving mean), keep only the rises, scale to unit spread. */
export function prepare(o) {
  const n = o.length, out = new Float32Array(n); if (!n) return out;
  const w = ORATE, pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + o[i];
  let ss = 0;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n, i + w + 1), v = Math.max(0, o[i] - (pre[b] - pre[a]) / (b - a)); out[i] = v; ss += v * v; }
  const sd = Math.sqrt(ss / n) || 1;
  for (let i = 0; i < n; i++) out[i] = Math.min(8, out[i] / sd);
  return out;
}

/** Autocorrelation of the curve for lags 0..maxLag (samples), normalised so that lag 0 is 1. */
export function autocorr(o, maxLag) {
  const n = o.length, N = pow2(n + maxLag + 1), re = new Float64Array(N), im = new Float64Array(N);
  let m = 0; for (let i = 0; i < n; i++) m += o[i]; m /= n || 1;
  for (let i = 0; i < n; i++) re[i] = o[i] - m;
  fft(re, im);
  for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  const out = new Float32Array(maxLag + 1), z = re[0] || 1;
  for (let l = 0; l <= maxLag; l++) out[l] = re[l] / z;
  return out;
}

/** The tempo: { period (samples, fractional), bpm, strength (how much the autocorrelation peak stands out, 0..1) }. */
export function tempo(o) {
  const maxLag = Math.round(ORATE * 60 / MIN_BPM * 2.05), ac = autocorr(o, Math.min(maxLag, o.length - 1));
  const lo = Math.round(ORATE * 60 / MAX_BPM), hi = Math.min(Math.round(ORATE * 60 / MIN_BPM), (ac.length - 1) >> 0);
  if (hi <= lo + 2) return { period: 0, bpm: 0, strength: 0 };
  const lag0 = ORATE * 60 / 120, at = (l) => (l < ac.length ? ac[l] : 0);
  const score = new Float32Array(hi + 1);
  // a beat period also repeats at twice the period (and a half-period pulse shows at half): add those, prefer ordinary tempos a little
  for (let l = lo; l <= hi; l++) { const wgt = Math.exp(-0.5 * (Math.log2(l / lag0) / 1.3) ** 2); score[l] = wgt * (at(l) + 0.5 * at(2 * l) + 0.25 * at(Math.round(l / 2))); }
  let bi = lo; for (let l = lo; l <= hi; l++) if (score[l] > score[bi]) bi = l;
  let off = 0;
  if (bi > lo && bi < hi) { const y0 = ac[bi - 1], y1 = ac[bi], y2 = ac[bi + 1], d = y0 - 2 * y1 + y2; if (d < -1e-12) off = Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / d)); }
  const period = bi + off;
  let sum = 0, cnt = 0; for (let l = lo; l <= hi; l++) { sum += ac[l]; cnt++; }
  const mean = sum / cnt; let sd = 0; for (let l = lo; l <= hi; l++) sd += (ac[l] - mean) ** 2; sd = Math.sqrt(sd / cnt) || 1;
  const strength = Math.max(0, Math.min(1, ((ac[bi] - mean) / sd - 1.5) / 5));
  return { period, bpm: 60 * ORATE / period, strength, peak: ac[bi] };
}

/** Dynamic-programming beat tracker (Ellis): beat sample indices for a steady `period` (samples). */
export function track(o, period, tight = 400) {
  const n = o.length, P = period, lo = Math.max(1, Math.round(P * 0.55)), hi = Math.round(P * 1.8);
  const pen = new Float32Array(hi + 1); for (let t = lo; t <= hi; t++) pen[t] = tight * Math.log(t / P) ** 2 / 100;
  const C = new Float32Array(n), prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = 0, bj = -1;
    for (let t = lo; t <= hi && t <= i; t++) { const s = C[i - t] - pen[t]; if (s > best) { best = s; bj = i - t; } }
    C[i] = o[i] + best; prev[i] = bj;
  }
  // start from the best score among the last period of samples
  let end = Math.max(0, n - Math.round(P)); for (let i = end; i < n; i++) if (C[i] > C[end]) end = i;
  const beats = []; for (let i = end; i >= 0; i = prev[i]) { beats.push(i); if (prev[i] < 0) break; }
  return beats.reverse();
}

/** Position of the local maximum of o near i (within +-r samples), with a parabola for the fraction. */
function refine(o, i, r) {
  let b = Math.max(0, Math.min(o.length - 1, i));
  for (let k = Math.max(0, i - r); k <= Math.min(o.length - 1, i + r); k++) if (o[k] > o[b]) b = k;
  let f = 0; if (b > 0 && b < o.length - 1) { const y0 = o[b - 1], y1 = o[b], y2 = o[b + 1], d = y0 - 2 * y1 + y2; if (d < -1e-9) f = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d)); }
  return b + f;
}

/**
 * Analyse an onset curve (ORATE per second, starting at the item's source time 0 = `t0` s).
 * Returns { ok, bpm, confidence 0..1, beats (seconds, ascending), regularity, reason }. Never guesses: `ok` is false for noise, pads, speech.
 */
export function analyze(raw, t0 = 0) {
  const n = raw.length;
  if (n < ORATE * 8) return { ok: false, confidence: 0, beats: [], reason: 'short' };
  const o = prepare(raw);
  const tp = tempo(o); if (!tp.period) return { ok: false, confidence: 0, beats: [], reason: 'none' };
  let idx = track(o, tp.period);
  // drop the beats at the ends that nothing supports (a quiet intro or outro)
  const sup = (i) => { let m = 0; for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (o[k] > m) m = o[k]; return m; };
  const mean = o.reduce((s, v) => s + v, 0) / n, typical = median(idx.map(sup)), thr = Math.max(0.5, mean * 1.2, 0.3 * typical);
  while (idx.length && sup(idx[0]) < thr) idx.shift();
  while (idx.length && sup(idx[idx.length - 1]) < thr) idx.pop();
  // the tracker has to end somewhere: a last (or first) beat that is not one beat from its neighbour is an off-beat hit, not a beat
  for (let g = 0; g < 6 && idx.length > 4; g++) {
    const m0 = median(idx.slice(1).map((v, k) => v - idx[k])), dev = (d) => Math.abs(d - m0) > 0.15 * m0;
    if (dev(idx[idx.length - 1] - idx[idx.length - 2])) idx.pop(); else if (dev(idx[1] - idx[0])) idx.shift(); else break;
  }
  if (idx.length < 6) return { ok: false, confidence: 0, bpm: tp.bpm, beats: [], reason: 'weak' };
  const pos = idx.map(i => refine(o, i, 3));
  const ibi = []; for (let k = 1; k < pos.length; k++) ibi.push(pos[k] - pos[k - 1]);
  const med = median(ibi), regular = ibi.filter(d => Math.abs(d - med) <= 0.08 * med).length / ibi.length;
  // how strongly the beats stand out from everything else
  let on = 0; for (const i of idx) on += sup(i); on /= idx.length;
  const ratio = on / (mean || 1), standOut = Math.max(0, Math.min(1, (ratio - 1.5) / 4));
  const confidence = Math.max(0, Math.min(1, 0.4 * regular + 0.3 * standOut + 0.3 * tp.strength));
  // steady tempo: median spacing of the tracked beats (more exact than the autocorrelation peak)
  let per = med;
  if (regular >= 0.8) { // a straight line through the beats (beat number against time) is more exact than the median of single gaps
    let k = 0; const ks = [0]; for (const d of ibi) { k += Math.max(1, Math.round(d / med)); ks.push(k); }
    const mk = ks.reduce((a, b) => a + b, 0) / ks.length, mp = pos.reduce((a, b) => a + b, 0) / pos.length;
    let sxx = 0, sxy = 0; for (let j = 0; j < ks.length; j++) { sxx += (ks[j] - mk) ** 2; sxy += (ks[j] - mk) * (pos[j] - mp); }
    if (sxx > 0 && Math.abs(sxy / sxx - med) < 0.05 * med) per = sxy / sxx;
  }
  const bpm = 60 * ORATE / per;
  const ok = confidence >= 0.5 && regular >= 0.7 && standOut > 0.1 && idx.length >= 8;
  return { ok, bpm, confidence, regularity: regular, standOut, strength: tp.strength, beats: pos.map(p => t0 + p / ORATE), reason: ok ? '' : regular < 0.7 ? 'irregular' : 'weak' };
}

/** Tell the time range of a beat list that falls inside [a, b] (binary search); returns [i0, i1). */
export function rangeOf(beats, a, b) {
  let lo = 0, hi = beats.length; while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < a) lo = m + 1; else hi = m; }
  let l2 = lo, h2 = beats.length; while (l2 < h2) { const m = (l2 + h2) >> 1; if (beats[m] <= b) l2 = m + 1; else h2 = m; }
  return [lo, l2];
}

/** Beat times of an audio item on the timeline (seconds): only the part that plays (trim), moved to the item's start and scaled by its speed. */
export function timelineBeats(item) {
  const b = item && item.beat; if (!b || !Array.isArray(b.t) || !b.t.length) return [];
  const sp = item.speed > 0 ? item.speed : 1, [i0, i1] = rangeOf(b.t, item.in - 1e-6, item.out + 1e-6), out = new Array(i1 - i0);
  for (let i = i0; i < i1; i++) out[i - i0] = item.start + (b.t[i] - item.in) / sp;
  return out;
}
/** Every 1st, 2nd, 4th… beat so that neighbours are at least `minPx` apart on screen (a zoomed-out hour would be a solid wall otherwise). */
export function thin(times, pps, minPx = 14) {
  if (times.length < 3) return times;
  const gap = (times[times.length - 1] - times[0]) / (times.length - 1);
  let step = 1; while (gap * pps * step < minPx && step < 1024) step *= 2;
  return step === 1 ? times : times.filter((_, i) => i % step === 0);
}
