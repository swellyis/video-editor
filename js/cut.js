// Cut ranges of TIME out of the whole timeline (the engine behind "delete words" and "remove fillers").
// Pure project edits: it only changes the project object, so the caller does ONE commit = ONE undo step. Nothing is lost on disk:
// the media files stay as they are and undo (Ctrl+Z) puts every item back. Times are timeline seconds.
import { layout, splitAt, splitItem, overlayLen, audioSpan, MIN_CLIP, rebaseKeyframes } from './model.js';
import * as RAMP from './ramp.js';
import { captionWords } from './captions.js';

export const MICRO_FADE = 0.02; // seconds of fade out / in at each join, so a cut never clicks
const EPS = 1e-4;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Sort, drop empty ones and join ranges closer than `join` seconds. */
export function mergeRanges(ranges, join = 0.03) {
  const s = ranges.map(r => ({ a: +r.a, b: +r.b })).filter(r => Number.isFinite(r.a) && Number.isFinite(r.b) && r.b - r.a > 0.005).sort((x, y) => x.a - y.a);
  const out = [];
  for (const r of s) { if (out.length && r.a <= out[out.length - 1].b + join) out[out.length - 1].b = Math.max(out[out.length - 1].b, r.b); else out.push({ ...r }); }
  return out;
}
/** The seconds the ranges remove from a stretch [a, b]. */
export const overlapOf = (ranges, a, b) => ranges.reduce((n, r) => n + Math.max(0, Math.min(r.b, b) - Math.max(r.a, a)), 0);

/**
 * Time ranges to remove for deleting the words `idx` (indexes into `words`, sorted by time, each { w, start, end }).
 * A run of neighbouring words is one range; it grows half-way into the pauses on both sides (up to `pad` s) so no half-word is left,
 * and never into a neighbouring word.
 */
export function wordRanges(words, idx, { pad = 0.12 } = {}) {
  const set = [...new Set(idx)].filter(i => i >= 0 && i < words.length).sort((a, b) => a - b), out = [];
  for (let k = 0; k < set.length;) {
    let j = k; while (j + 1 < set.length && set[j + 1] === set[j] + 1) j++;
    const first = words[set[k]], last = words[set[j]], prev = words[set[k] - 1], next = words[set[j] + 1];
    const gapB = prev ? Math.max(0, first.start - prev.end) : pad * 2, gapA = next ? Math.max(0, next.start - last.end) : pad * 2;
    out.push({ a: Math.max(0, first.start - Math.min(pad, gapB / 2)), b: last.end + Math.min(pad, gapA / 2) });
    k = j + 1;
  }
  return mergeRanges(out);
}

function extent(kind, it, total) {
  if (kind === 'overlay') return [it.start, it.start + overlayLen(it)];
  if (kind === 'audio') return [it.start, it.start + audioSpan(it, total)];
  return [it.start, it.end];
}
const listFor = (p, kind) => (kind === 'text' ? p.texts : kind === 'blur' ? p.blurs || [] : kind === 'overlay' ? p.overlays || [] : p.audio);
/** Cut one non-main item (text, blur, overlay, voice track) at time t, when t is inside it. */
function chop(project, kind, it, t, total) {
  const [s, e] = extent(kind, it, total);
  if (!(s < t - EPS && e > t + EPS)) return;
  if (t - s < MIN_CLIP || e - t < MIN_CLIP) { // too short to be an item of its own: snap the item's edge to the cut
    if (t - s < MIN_CLIP) { // the head would be tiny: the item starts at the cut instead
      const d = t - s;
      if (kind === 'text' || kind === 'blur') it.start = t;
      else if (kind === 'overlay') { it.start = t; if (it.kind !== 'image') it.in += d * (it.speed || 1); }
      else if (kind === 'audio') { it.start = t; it.in += d * (it.speed > 0 ? it.speed : 1); }
    }
    return;
  }
  const r = splitItem(project, { type: kind, id: it.id }, t);
  if (r && !r.fail && kind === 'audio') { it.fadeOut = Math.max(it.fadeOut || 0, MICRO_FADE); r.item.fadeIn = Math.max(r.item.fadeIn || 0, MICRO_FADE); }
}
function cutHead(c, local, len) {
  if (c.kind === 'image') c.in += local;
  else { const s = c.ramp || c.reverse ? RAMP.sourceAtOffset(c, local) : c.in + local * (c.speed || 1); if (c.reverse) c.out = s; else c.in = s; }
  c.keyframes = rebaseKeyframes(c.keyframes || {}, local);
  const tr = c.transform; if (tr && tr.kenBurns && tr.kenBurns !== 'none') { const f0 = tr.kbFrom ?? 0, f1 = tr.kbTo ?? 1; tr.kbFrom = f0 + (f1 - f0) * (local / len); }
  c.fadeIn = MICRO_FADE;
}
function cutTail(c, local, len) {
  if (c.kind === 'image') c.out = c.in + local;
  else { const s = c.ramp || c.reverse ? RAMP.sourceAtOffset(c, local) : c.in + local * (c.speed || 1); if (c.reverse) c.in = s; else c.out = s; }
  c.keyframes = rebaseKeyframes(c.keyframes || {}, 0, local);
  const tr = c.transform; if (tr && tr.kenBurns && tr.kenBurns !== 'none') { const f0 = tr.kbFrom ?? 0, f1 = tr.kbTo ?? 1; tr.kbTo = f0 + (f1 - f0) * (local / len); }
  c.fadeOut = MICRO_FADE;
}

/** Remove [a, b] from the main track: trims, splits and removes clips; what follows closes up (the main track is always sequential). */
function cutMain(project, a, b) {
  let lay = layout(project), removed = 0;
  // an interior cut first splits the clip in two (the second half is trimmed below)
  const hit = lay.items.find(i => a > i.start + EPS && b < i.end - EPS);
  if (hit) {
    const la = a - hit.start, lb = b - hit.start;
    if (la >= MIN_CLIP && hit.len - lb >= MIN_CLIP) {
      const second = splitAt(project, a, 0.02);
      if (second) { project.clips[hit.index].fadeOut = MICRO_FADE; lay = layout(project); }
    }
  }
  for (const it of [...lay.items].reverse()) {
    const c = it.clip, s = it.start, e = it.end, len = it.len;
    const gap = c.gap > 1e-6 ? c.gap : 0;
    if (gap) { const ov = Math.max(0, Math.min(b, s) - Math.max(a, s - gap)); if (ov > 0) c.gap = Math.max(0, r3(gap - ov)); }
    let lo = Math.max(a, s) - s, hi = Math.min(b, e) - s;
    if (hi - lo <= EPS) continue;
    if (lo < MIN_CLIP) lo = 0;
    if (len - hi < MIN_CLIP) hi = len;
    if (lo <= EPS && hi >= len - EPS) { project.clips.splice(it.index, 1); removed += len; }
    else if (lo <= EPS) { cutHead(c, hi, len); removed += hi; }
    else if (hi >= len - EPS) { cutTail(c, lo, len); removed += len - lo; }
    else { // (the interior case was split above; if the halves were too short for that, trim the tail)
      cutTail(c, lo, len); removed += len - lo;
    }
  }
  return removed;
}

function cutCaptions(project, a, b) {
  const d = b - a, keep = [];
  for (const c of project.captions || []) {
    if (c.end <= a + EPS) { keep.push(c); continue; }
    if (c.start >= b - EPS) { c.start = r3(Math.max(0, c.start - d)); c.end = r3(c.end - d); if (c.words) c.words = c.words.map(w => ({ ...w, start: r3(w.start - d), end: r3(w.end - d) })); keep.push(c); continue; }
    const ws = captionWords(c), kept = [];
    for (const w of ws) {
      const mid = (w.start + w.end) / 2;
      if (mid > a && mid < b) continue;                       // spoken inside the cut: gone
      if (w.start >= b - EPS || mid >= b) kept.push({ ...w, start: r3(w.start - d), end: r3(w.end - d) });
      else kept.push({ ...w, end: Math.min(w.end, a) > w.start ? Math.min(w.end, a) : w.end });
    }
    if (!kept.length) continue;
    c.words = kept.map(w => ({ w: w.w, start: r3(w.start), end: r3(Math.max(w.end, w.start + 0.05)) }));
    c.text = kept.map(w => w.w).join(' ');
    c.start = r3(Math.min(c.start > a ? c.start - d : c.start, c.words[0].start)); c.end = r3(Math.max(c.words[c.words.length - 1].end, c.start + 0.2));
    keep.push(c);
  }
  project.captions = keep;
}

/**
 * Remove the time ranges from the whole timeline. Everything after a range moves earlier by its length.
 *  - main clips (and photos) are trimmed, split or removed; neighbours close up; a 20 ms fade out/in is put at each join
 *  - text, blur regions, picture-in-picture videos and voice / detached-sound tracks are cut the same way
 *  - captions lose the words spoken inside and are re-timed
 *  - music tracks are not cut: they keep playing (opts.music = 'cut' cuts them too)
 *  - markers inside are removed, later ones move
 * Returns { removed (seconds), ranges } or null when nothing was removed.
 */
export function cutRanges(project, ranges, { music = 'keep' } = {}) {
  const rs = mergeRanges(ranges, 0.03); if (!rs.length) return null;
  const before = layout(project).total; let removedMain = 0;
  for (let i = rs.length - 1; i >= 0; i--) {
    const { a, b } = rs[i], d = b - a;
    const total = layout(project).total;
    const kinds = ['text', 'blur', 'overlay', 'audio'];
    const eligible = (kind, it) => kind !== 'audio' || it.voice || music === 'cut' ? !(kind === 'audio' && it.loop) : false;
    for (const kind of kinds) for (const it of [...listFor(project, kind)]) if (eligible(kind, it)) { chop(project, kind, it, b, total); chop(project, kind, it, a, total); }
    for (const kind of kinds) {
      const list = listFor(project, kind);
      for (const it of [...list]) {
        if (!eligible(kind, it)) continue;
        const [s, e] = extent(kind, it, total);
        if (s >= a - EPS && e <= b + MIN_CLIP * 0.99 && s < b - EPS) { list.splice(list.indexOf(it), 1); continue; } // inside (or a sliver left over by the cut)
        if (s < a - EPS && e > a + EPS && e <= a + MIN_CLIP && (kind === 'text' || kind === 'blur')) { it.end = a; continue; } // a sliver reaching into the cut
        if (s >= b - EPS) {
          it.start = Math.max(0, r3(it.start - d));
          if (it.end != null && (kind === 'text' || kind === 'blur')) it.end = r3(it.end - d);
        }
      }
    }
    // shift tracks the music option keeps: nothing. Markers:
    project.markers = (project.markers || []).filter(m => !(m.time > a && m.time < b)).map(m => (m.time >= b ? { ...m, time: Math.max(0, r3(m.time - d)) } : m));
    cutCaptions(project, a, b);
    removedMain += cutMain(project, a, b);
  }
  const after = layout(project).total;
  return before - after > 0.001 || removedMain > 0 ? { removed: Math.max(0, before - after), ranges: rs.length } : { removed: 0, ranges: rs.length };
}
