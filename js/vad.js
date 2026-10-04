// Voice-activity detection from frame loudness (pure, no browser APIs): where is there sound worth transcribing / ducking for?
// It finds "something is being said" (energy above the room's noise floor, with hangover), not "this is speech rather than noise".

/** dB (RMS, 0 dBFS = full scale) of consecutive frames of `frame` samples. */
export function frameDb(samples, frame) {
  const n = Math.floor(samples.length / frame), out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0; const o = f * frame;
    for (let i = 0; i < frame; i++) { const v = samples[o + i]; s += v * v; }
    const r = Math.sqrt(s / frame);
    out[f] = r > 1e-5 ? 20 * Math.log10(r) : -100;
  }
  return out;
}
const pct = (a, p) => { if (!a.length) return -100; const b = Float32Array.from(a).sort(); return b[Math.min(b.length - 1, Math.max(0, Math.floor(p * (b.length - 1))))]; };
/** Level of the quiet parts (10th percentile of the frame levels). */
export const noiseFloor = (db) => pct(db, 0.1);
/**
 * Regions [{a, b}] (seconds) where the level stays above a threshold set from the noise floor.
 * opts: frameSec, floorDb (default: measured), marginDb (above the floor), minDb (never below), hang (keep open after it drops),
 *       minLen (drop shorter bursts), mergeGap (join regions closer than this), pre/post (padding added around a region).
 */
export function speechRegions(db, { frameSec = 0.02, floorDb = null, marginDb = 9, minDb = -58, absMin = -66, hang = 0.3, minLen = 0.2, mergeGap = 0.5, pre = 0.15, post = 0.2 } = {}) {
  const floor = floorDb == null ? noiseFloor(db) : floorDb, top = pct(db, 0.95);
  // quiet recordings: never ask for more than 14 dB below the loud parts; below absMin (-66 dBFS) is always silence
  const thr = Math.max(absMin, Math.min(Math.max(minDb, floor + marginDb), top - 14));
  const regs = []; let start = -1, last = -1;
  const hangF = Math.round(hang / frameSec);
  for (let f = 0; f < db.length; f++) {
    if (db[f] >= thr) { if (start < 0) start = f; last = f; }
    else if (start >= 0 && f - last > hangF) { regs.push([start, last + 1]); start = -1; }
  }
  if (start >= 0) regs.push([start, last + 1]);
  let out = regs.map(([a, b]) => ({ a: a * frameSec, b: b * frameSec })).filter(r => r.b - r.a >= minLen);
  const total = db.length * frameSec;
  out = out.map(r => ({ a: Math.max(0, r.a - pre), b: Math.min(total, r.b + post) }));
  const m = [];
  for (const r of out) { if (m.length && r.a - m[m.length - 1].b <= mergeGap) m[m.length - 1].b = Math.max(m[m.length - 1].b, r.b); else m.push({ ...r }); }
  return m;
}
/** Is time t (seconds) inside any region? (regions sorted) */
export function inRegions(regs, t) { for (const r of regs) { if (t < r.a) return false; if (t <= r.b) return true; } return false; }
