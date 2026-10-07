// Remove silences: the detector (pure functions on a loudness curve) and the cut (a model edit on the project).
// The scan that makes the loudness curve from a file is in silence-scan.js; the control is in silence-ui.js.
import { layout, overlayLen, audioLen, audioSpeed, rebaseKeyframes, MIN_CLIP } from './model.js';
import { uid, deepClone } from './util.js';

export const HOP = 0.02;            // seconds per loudness value (20 ms)
export const BLIP = 0.04;           // a louder blip this short inside a pause (a click, a breath) does not break the pause
export const MIN_REMOVE = 0.05;     // never make a cut smaller than this
export const DEFAULTS = { auto: true, thr: -35, minPause: 1.0, pad: 0.25 };
export const LIMITS = { thr: [-60, -20], minPause: [0.3, 5], pad: [0, 0.5] };

export const toDb = (ms) => (ms > 1e-12 ? 10 * Math.log10(ms) : -120);
const r3 = (v) => Math.round(v * 1000) / 1000;
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normSettings(s) {
  const d = DEFAULTS, o = s || {};
  const num = (v, def, [lo, hi]) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clampN(Number(v), lo, hi) : def);
  return { auto: o.auto !== false, thr: Math.round(num(o.thr, d.thr, LIMITS.thr)), minPause: Math.round(num(o.minPause, d.minPause, LIMITS.minPause) * 10) / 10, pad: Math.round(num(o.pad, d.pad, LIMITS.pad) * 20) / 20 };
}

/** Percentile (0..1) of a Float32Array / array by sampling (sorting a copy of at most ~20k values, so an hour costs nothing). */
function percentile(db, p) {
  const n = db.length; if (!n) return -120;
  const step = Math.max(1, Math.floor(n / 20000)), a = [];
  for (let i = 0; i < n; i += step) a.push(db[i]);
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
}

/**
 * The "Auto" sensitivity: the noise floor is the quiet end of the recording (10th percentile of the loudness values, so hum, fan or
 * room noise count as floor), the voice level is the loud end (90th percentile); silence is anything below the floor plus a quarter
 * of the way to the voice (at least 6 dB above the floor, never above −28 dB). Works the same with or without background noise.
 */
export function autoThreshold(db) {
  const floor = Math.max(-80, percentile(db, 0.10)), loud = Math.max(floor, percentile(db, 0.90));
  // little difference between quiet and loud = no pauses to speak of (steady noise, or non-stop speech): put the line below the floor
  const thr = loud - floor < 8 ? floor - 2 : Math.min(-28, Math.max(-75, floor + Math.max(6, 0.25 * (loud - floor))));
  return { thr: Math.round(thr * 10) / 10, floor: Math.round(floor * 10) / 10, loud: Math.round(loud * 10) / 10 };
}

/**
 * Silent stretches of a loudness curve. `db[i]` is the level of the window [t0 + i*hop, t0 + (i+1)*hop).
 * A pause counts when it lasts at least `minPause` seconds; what is removed is the pause minus `pad` kept on each side (so the speech
 * on both sides keeps its breath). A pause at the very start / end of the scanned part is cut right to the edge (no pad on that side).
 * Returns [{ a, b, from, to }] in seconds: a..b is removed, from..to is the whole quiet stretch.
 */
export function findSilences(db, { thr, minPause = 1, pad = 0.25, hop = HOP, t0 = 0 } = {}) {
  const n = db.length, out = [];
  if (!n || !Number.isFinite(thr)) return out;
  const gapMax = Math.max(1, Math.round(BLIP / hop)); // loud windows allowed inside a pause
  let i = 0;
  while (i < n) {
    if (!(db[i] < thr)) { i++; continue; }
    let s = i, e = i + 1, loud = 0;
    for (let j = i + 1; j < n; j++) {
      if (db[j] < thr) { e = j + 1; loud = 0; } else if (++loud > gapMax) break;
    }
    i = e + 1;
    if ((e - s) * hop + 1e-9 < minPause) continue;
    const from = t0 + s * hop, to = t0 + e * hop;
    const a = s === 0 ? from : from + pad, b = e === n ? to : to - pad;
    if (b - a >= MIN_REMOVE) out.push({ a: r3(a), b: r3(b), from: r3(from), to: r3(to) });
  }
  return out;
}

// ---------- tighten pauses ----------
export const BREATHS = [0.2, 0.3, 0.5, 0.75, 1];   // seconds of pause left after tightening
export const MIN_SHORTEN = 0.15;                   // a pause is only tightened when it gets at least this much shorter
export const MICRO_FADE = 0.02;                    // seconds of fade on each side of a tightened join (no click)
/**
 * Pauses to shorten rather than remove: every quiet stretch longer than `breath` + MIN_SHORTEN keeps `breath` seconds (half on each side,
 * so the speech either side keeps its natural tail and in-breath) and the middle is cut. Returns [{ a, b, from, to }] like findSilences.
 */
export function tightenRanges(db, { thr, breath = 0.3, hop = HOP, t0 = 0, minShorten = MIN_SHORTEN } = {}) {
  const keep = Math.max(0, breath);
  return findSilences(db, { thr, minPause: Math.max(0.05, keep + minShorten), pad: 0, hop, t0 })
    .map(r => ({ a: r3(r.from + keep / 2), b: r3(r.to - keep / 2), from: r.from, to: r.to }))
    .filter(r => r.b - r.a >= Math.max(MIN_REMOVE, minShorten) - 1e-9);
}

// ---------- cutting ----------
const SPEED_OF = { clip: (c) => c.speed || 1, overlay: (o) => o.speed || 1, audio: audioSpeed };
const listOf = (p, type) => (type === 'clip' ? p.clips : type === 'overlay' ? p.overlays || [] : p.audio);
/** An item that can be cut by source time: it has sound and is not a looped track or a photo. */
export function cuttable(type, item) {
  if (!item || !item.mediaId || item.kind === 'image' || item.hasAudio === false) return false;
  if (curvedClip(type, item)) return false; // the cut maths maps source → timeline linearly
  return type === 'audio' ? !item.loop : (type === 'clip' || type === 'overlay');
}
/** A main clip played in reverse or on a speed curve (Remove silences explains instead of cutting it). */
export const curvedClip = (type, item) => type === 'clip' && !!item && item.kind !== 'image' && !!(item.ramp || item.reverse);
/** Where an item sits: start on the timeline, length, speed, source window. */
export function spanOf(project, type, id) {
  const item = listOf(project, type).find(x => x.id === id); if (!item) return null;
  const sp = SPEED_OF[type](item);
  if (type === 'clip') { const it = layout(project).items.find(x => x.clip.id === id); return it ? { item, type, start: it.start, len: it.len, sp, in: item.in, out: item.out } : null; }
  return { item, type, start: item.start, len: type === 'audio' ? audioLen(item) : overlayLen(item), sp, in: item.in, out: item.out };
}
/** Source seconds -> timeline seconds for an item (null when the source time is outside what the item plays). */
export const srcToTimeline = (sp, s) => sp.start + (s - sp.in) / sp.sp;

/**
 * Turn removal ranges (source seconds) into the pieces to keep: clamps to the item's window, merges ranges that leave less than the
 * shortest allowed piece between them and trims slivers at both ends. Returns null when nothing (or everything) would be removed.
 */
export function plan(sp, ranges) {
  const minKeep = MIN_CLIP * sp.sp + 1e-3, a0 = sp.in, b0 = sp.out;
  const rs = (ranges || []).map(r => [Math.max(a0, Math.min(r.a ?? r[0], r.b ?? r[1])), Math.min(b0, Math.max(r.a ?? r[0], r.b ?? r[1]))]).filter(r => r[1] - r[0] >= 0.01).sort((x, y) => x[0] - y[0]);
  const m = [];
  for (const r of rs) {
    const l = m[m.length - 1];
    if (l && r[0] - l[1] < minKeep) l[1] = Math.max(l[1], r[1]); else m.push([r[0], r[1]]);
  }
  if (m.length && m[0][0] - a0 < minKeep) m[0][0] = a0;
  if (m.length && b0 - m[m.length - 1][1] < minKeep) m[m.length - 1][1] = b0;
  if (!m.length) return null;
  const keep = []; let c = a0;
  for (const r of m) { if (r[0] - c > 1e-6) keep.push([c, r[0]]); c = r[1]; }
  if (b0 - c > 1e-6) keep.push([c, b0]);
  if (!keep.length) return null;
  const segs = []; let cum = 0;
  for (const k of keep) { const len = (k[1] - k[0]) / sp.sp; segs.push({ a: k[0], b: k[1], u0: (k[0] - sp.in) / sp.sp, len, cum }); cum += len; }
  const newLen = cum;
  if (newLen < MIN_CLIP - 1e-9) return null;
  return { segs, newLen, removed: sp.len - newLen, removedRanges: m };
}

/** Old timeline time -> new timeline time for something that sat inside the cut item. */
function warpIn(sp, pl, t) {
  const u = t - sp.start;
  for (const s of pl.segs) {
    if (u < s.u0) return sp.start + s.cum;
    if (u <= s.u0 + s.len + 1e-9) return sp.start + s.cum + (u - s.u0);
  }
  return sp.start + pl.newLen;
}

/** Warp the things that sit on the timeline around/inside a cut item. */
function warpOthers(project, sp, pl, shiftAfter, skip) {
  const E = sp.start + sp.len, d = pl.removed, EPS = 1e-6;
  const ws = (t) => (t < sp.start - EPS ? t : t >= E - EPS ? (shiftAfter ? t - d : t) : warpIn(sp, pl, t)); // a start / a point
  const we = (t) => (t < sp.start - EPS ? t : t > E + EPS ? (shiftAfter ? t - d : t) : warpIn(sp, pl, t));  // an end
  for (const b of project.blurs || []) { b.start = Math.max(0, ws(b.start)); b.end = Math.max(b.start + 0.1, we(b.end)); }
  for (const t of project.texts || []) { t.start = Math.max(0, ws(t.start)); t.end = Math.max(t.start + 0.1, we(t.end)); }
  for (const c of project.captions || []) {
    c.start = Math.max(0, ws(c.start)); c.end = Math.max(c.start + 0.05, we(c.end));
    if (c.words) c.words = c.words.map(w => { const s = Math.max(0, ws(w.start)); return { ...w, start: s, end: Math.max(s, we(w.end)) }; });
  }
  for (const m of project.markers || []) m.time = Math.max(0, ws(m.time));
  for (const o of project.overlays || []) if (!skip.has(o.id)) o.start = Math.max(0, ws(o.start));
  for (const a of project.audio || []) if (!skip.has(a.id)) a.start = Math.max(0, ws(a.start));
}

/**
 * Cut `ranges` (source seconds) out of one item and join what is left, in the same place on the timeline:
 * the item becomes consecutive pieces (new ids, same lane, settings, volume / motion keyframes cut where the pieces are, fade in on the
 * first piece and fade out on the last one). `lead` (default true) also moves the things that sit inside the item (captions, text,
 * blur regions, markers, overlays and sounds that start inside it) with their sound, and with `ripple` on a main-track clip everything
 * after it follows. Returns { removed, pieces } or null (nothing cut).
 */
export function cutItem(project, type, id, ranges, { ripple = false, lead = true, fade = 0 } = {}) {
  const sp = spanOf(project, type, id); if (!sp || !cuttable(type, sp.item)) return null;
  const pl = plan(sp, ranges); if (!pl) return null;
  const item = sp.item, list = listOf(project, type), idx = list.indexOf(item);
  const lay0 = type === 'clip' ? layout(project) : null, E = sp.start + sp.len;
  const nextClip = type === 'clip' && lay0.items[idx + 1] ? lay0.items[idx + 1] : null;
  const kf = item.keyframes || {}, orig = deepClone(item);
  const tr = orig.transform || {}, kb = type !== 'audio' && tr.kenBurns && tr.kenBurns !== 'none';
  const f0 = tr.kbFrom ?? 0, f1 = tr.kbTo ?? 1;
  const pieces = [];
  pl.segs.forEach((s, k) => {
    const last = k === pl.segs.length - 1;
    const p = k === 0 ? item : deepClone(orig);
    if (k > 0) {
      p.id = uid(type === 'clip' ? 'clip' : type === 'overlay' ? 'ovl' : 'aud');
      if (type === 'clip') { p.gap = 0; p.transition = { type: 'cut', duration: orig.transition ? orig.transition.duration : 0.5 }; }
      if (p.lane === undefined && orig.lane !== undefined) p.lane = orig.lane;
    }
    p.in = s.a; p.out = s.b;
    if (type !== 'clip') p.start = sp.start + s.cum;
    if (k > 0) p.fadeIn = fade; // a micro-fade at each new join when asked (Tighten pauses), otherwise a plain cut
    if (!last) p.fadeOut = fade;
    p.keyframes = rebaseKeyframes(kf, s.u0, last ? Infinity : s.u0 + s.len);
    if (kb) { p.transform = p.transform || {}; p.transform.kbFrom = f0 + (f1 - f0) * (s.cum / pl.newLen); p.transform.kbTo = f0 + (f1 - f0) * ((s.cum + s.len) / pl.newLen); }
    pieces.push(p);
  });
  list.splice(idx + 1, 0, ...pieces.slice(1));
  if (lead) {
    const shiftAfter = !!ripple && type === 'clip';
    warpOthers(project, sp, pl, shiftAfter, new Set(pieces.map(p => p.id)));
    if (type === 'clip') {
      const lay1 = layout(project);
      // ripple on: later clips follow through the layout (the other lanes were shifted above). Ripple off: what follows stays where it is.
      if (!ripple && nextClip) nextClip.clip.gap = Math.max(0, r3(nextClip.start - (lay1.items.find(x => x.clip.id === pieces[pieces.length - 1].id)?.end ?? E)));
    }
  }
  return { removed: pl.removed, pieces: pieces.map(p => p.id), removedRanges: pl.removedRanges };
}

/**
 * Cut silences out of the family of an item: the pieces of one recording on the same kind of track (earlier cuts and splits), each by its
 * own part of `ranges`, plus (with `linked`) the other tracks that play the same recording at the same moment (a detached sound with its
 * picture, a duplicate). The main-track clip leads; the others are cut in place and sync is kept because the cuts are the same source times.
 * Returns { removed, count, cuts } with removed in timeline seconds of the lead item.
 */
export function cutSilences(project, sel, ranges, { ripple = false, linked = false, fade = 0 } = {}) {
  const start = spanOf(project, sel.type, sel.id); if (!start) return null;
  const mediaId = start.item.mediaId;
  const fam = [];
  for (const type of ['clip', 'overlay', 'audio']) {
    for (const it of listOf(project, type)) {
      if (it.mediaId !== mediaId || !cuttable(type, it)) continue;
      const same = type === sel.type;
      if (!same && !linked) continue;
      const sp = spanOf(project, type, it.id); if (!sp) continue;
      if (!same && !alignedWith(start, sp, ranges)) continue;
      fam.push({ type, id: it.id, start: sp.start, same });
    }
  }
  const leadType = fam.some(f => f.type === 'clip') ? 'clip' : sel.type; // the main track leads: it carries the ripple and the things that sit on the timeline
  fam.sort((x, y) => (x.type === leadType ? 0 : 1) - (y.type === leadType ? 0 : 1) || x.start - y.start);
  let removed = 0, cuts = 0;
  for (const f of fam) {
    const isLead = f.type === leadType;
    const r = cutItem(project, f.type, f.id, ranges, { ripple: ripple && isLead, lead: isLead, fade });
    if (!r) continue;
    cuts += 1; if (isLead) removed += r.removed;
  }
  return cuts ? { removed, cuts } : null;
}
/** Does `other` play the same moment of the recording at the same moment of the timeline as `base`? (within 60 ms) */
export function alignedWith(base, other, ranges) {
  const r = ranges && ranges[0]; if (!r) return false;
  const s = r.a ?? r[0];
  if (s < other.in - 1e-6 || s > other.out + 1e-6) return false;
  return Math.abs(srcToTimeline(base, s) - srcToTimeline(other, s)) < 0.06;
}
