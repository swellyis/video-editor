// Speech-aware ducking maths (pure). The music track stores duck / duckLevel / duckDb / duckAttack / duckRelease / duckTrigger;
// this module turns speech intervals + those settings into a gain multiplier identical in the preview and both exporters.
import { captionWords } from './captions.js';

export const DUCK_TRIGGERS = [
  { id: 'any', label: 'Any speech (clips, voice, overlays)' },
  { id: 'voice', label: 'Voice tracks' },
  { id: 'detached', label: 'Detached audio & voice tracks' },
  { id: 'clips', label: 'Main video clips only' },
  { id: 'captions', label: 'Transcript / captions (when available)' },
];
export const DEFAULT_ATTACK = 0.12;   // seconds to reach the ducked level
export const DEFAULT_RELEASE = 0.45;  // seconds to return to full
export const DEFAULT_DB = 10;         // duck by 10 dB ≈ level 0.316 (was duckLevel 0.3)
export const DB_MIN = 0, DB_MAX = 24;

export const levelToDb = (level) => (level <= 0 ? DB_MAX : Math.min(DB_MAX, Math.max(DB_MIN, -20 * Math.log10(Math.max(1e-6, level)))));
export const dbToLevel = (db) => (db <= 0 ? 1 : Math.pow(10, -Math.min(DB_MAX, Math.max(DB_MIN, db)) / 20));

/** Migrate / normalise duck fields on an audio track (keeps duckLevel in sync with duckDb for older projects). */
export function normalizeDuck(a) {
  if (!a || typeof a !== 'object') return a;
  if (a.duckDb == null && a.duckLevel != null) a.duckDb = Math.round(levelToDb(a.duckLevel) * 10) / 10;
  if (a.duckDb == null) a.duckDb = DEFAULT_DB;
  a.duckDb = Math.min(DB_MAX, Math.max(DB_MIN, +a.duckDb || DEFAULT_DB));
  a.duckLevel = dbToLevel(a.duckDb);
  a.duckAttack = Math.min(2, Math.max(0.02, a.duckAttack == null ? DEFAULT_ATTACK : +a.duckAttack));
  a.duckRelease = Math.min(4, Math.max(0.05, a.duckRelease == null ? DEFAULT_RELEASE : +a.duckRelease));
  if (!DUCK_TRIGGERS.some(t => t.id === a.duckTrigger)) a.duckTrigger = 'any';
  a.duck = a.duck === true;
  return a;
}

/** Merge [[a,b],…] intervals (sorted), joining gaps ≤ gap seconds. */
export function mergeIntervals(iv, gap = 0.08) {
  const s = iv.map(x => [x[0], x[1]]).filter(x => x[1] > x[0] + 1e-4).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of s) { if (out.length && x[0] <= out[out.length - 1][1] + gap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]); else out.push([...x]); }
  return out;
}

/**
 * Gain multiplier at time t. `level` is the linear gain while fully ducked (0..1).
 * Attack reaches the ducked level before the speech starts (lookahead = attack);
 * release returns after the speech ends.
 */
export function duckFactor(intervals, t, level, { attack = DEFAULT_ATTACK, release = DEFAULT_RELEASE } = {}) {
  if (!intervals || !intervals.length) return 1;
  const lo = Math.max(0, Math.min(1, level));
  let f = 1;
  for (const [a, b] of intervals) {
    if (t < a - attack || t > b + release) continue;
    let d; // 0 = fully ducked, 1 = full level
    if (t < a) d = attack > 1e-6 ? (a - t) / attack : 0;
    else if (t > b) d = release > 1e-6 ? (t - b) / release : 0;
    else d = 0;
    f = Math.min(f, lo + (1 - lo) * Math.max(0, Math.min(1, d)));
  }
  return f;
}

/** Sample the duck envelope over [t0,t1] for drawing (values = multiplier 0..1). */
export function duckEnvelope(intervals, t0, t1, level, opts, step = 0.05) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) out.push({ t, g: duckFactor(intervals, t, level, opts) });
  return out;
}

/** Caption / transcript word spans → speech intervals (with a little pad). */
export function intervalsFromCaptions(captions, { pad = 0.08, mergeGap = 0.25 } = {}) {
  const iv = [];
  for (const c of captions || []) {
    const ws = captionWords(c);
    if (ws.length) for (const w of ws) iv.push([Math.max(0, w.start - pad), w.end + pad]);
    else if (c.end > c.start) iv.push([c.start, c.end]);
  }
  return mergeIntervals(iv, mergeGap);
}

/**
 * Loudness peaks → speech-ish intervals in SOURCE seconds, then mapped with mapSrc(src) → timeline.
 * peaks: { rate, data: 0..255 }. Quiet frames below thr (relative to the loud parts) are skipped.
 */
export function intervalsFromPeaks(peaks, { src0 = 0, src1 = Infinity, mapSrc = (s) => s, thrRatio = 0.22, hang = 0.2, minLen = 0.15, pad = 0.1 } = {}) {
  if (!peaks || !peaks.data || !peaks.rate) return [];
  const d = peaks.data, rate = peaks.rate, i0 = Math.max(0, Math.floor(src0 * rate)), i1 = Math.min(d.length, Math.ceil(Math.min(src1, d.length / rate) * rate));
  if (i1 <= i0) return [];
  let max = 1; for (let i = i0; i < i1; i++) if (d[i] > max) max = d[i];
  const thr = Math.max(8, max * thrRatio);
  const hangN = Math.round(hang * rate);
  const regs = []; let start = -1, last = -1;
  for (let i = i0; i < i1; i++) {
    if (d[i] >= thr) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > hangN) { regs.push([start / rate, (last + 1) / rate]); start = -1; }
  }
  if (start >= 0) regs.push([start / rate, (last + 1) / rate]);
  const out = [];
  for (const [a, b] of regs) {
    if (b - a < minLen) continue;
    const ta = mapSrc(Math.max(src0, a - pad)), tb = mapSrc(Math.min(src1, b + pad));
    if (tb > ta + 1e-3) out.push([ta, tb]);
  }
  return mergeIntervals(out, 0.12);
}

/** Build the speech intervals that should duck track `track`, honouring its duckTrigger. */
export function speechForTrack(track, lay, project, { peaksOf, excludeId } = {}) {
  const trig = (track && track.duckTrigger) || 'any';
  const ex = excludeId != null ? excludeId : (track && track.voice ? track.id : null);

  if (trig === 'captions') {
    const fromCaps = intervalsFromCaptions(project.captions || []);
    if (fromCaps.length) return fromCaps;
    // fall through to any speech when there are no captions yet
  }

  const iv = [];
  const wantClips = trig === 'any' || trig === 'clips' || trig === 'captions';
  const wantVoice = trig === 'any' || trig === 'voice' || trig === 'detached' || trig === 'captions';
  const wantOvl = trig === 'any' || trig === 'detached' || trig === 'captions';

  const pushPeaksOrSpan = (spanStart, spanEnd, item, srcIn, srcOut, speed) => {
    const peaks = peaksOf && item.mediaId ? peaksOf(item.mediaId) : null;
    if (peaks) {
      const mapSrc = (src) => spanStart + (src - srcIn) / Math.max(1e-6, speed || 1);
      const got = intervalsFromPeaks(peaks, { src0: srcIn, src1: srcOut, mapSrc });
      if (got.length) { iv.push(...got); return; }
    }
    iv.push([spanStart, spanEnd]);
  };

  if (wantClips) {
    for (const it of lay.items) {
      const c = it.clip;
      if (c.kind !== 'video' || c.muted || c.hasAudio === false || c.volume <= 0.02) continue;
      pushPeaksOrSpan(it.start, it.end, c, c.in, c.out, c.speed || 1);
    }
  }
  if (wantOvl) {
    for (const o of project.overlays || []) {
      if (o.kind !== 'video' || o.muted || o.hasAudio === false || o.volume <= 0.02) continue;
      const len = Math.max(0.05, (o.out - o.in) / (o.speed || 1));
      pushPeaksOrSpan(o.start, o.start + len, o, o.in, o.out, o.speed || 1);
    }
  }
  if (wantVoice) {
    for (const a of project.audio || []) {
      if (!a.voice || a.muted || a.volume <= 0.02 || a.id === ex) continue;
      const total = lay.total, len = a.loop ? Math.max(0.05, a.loopLen > 0 ? a.loopLen : total - a.start) : Math.max(0.05, (a.out - a.in) / (a.speed > 0 ? a.speed : 1));
      pushPeaksOrSpan(a.start, a.start + len, a, a.in, a.out, a.speed > 0 ? a.speed : 1);
    }
  }

  // Prefer caption word timings when available — they follow speech pauses; whole-clip spans would keep music ducked for the entire clip
  if ((trig === 'any' || trig === 'captions') && (project.captions || []).length) {
    const caps = intervalsFromCaptions(project.captions);
    if (caps.length) return caps;
  }
  return mergeIntervals(iv, 0.1);
}
