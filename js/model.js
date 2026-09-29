// Project data model, timeline layout, edit operations, audio envelopes, history.
import { uid, clamp, deepClone, fmt } from './util.js';

export const SCHEMA = 4;
export const MIN_CLIP = 0.1; // seconds on timeline

export const PRESETS = {
  none: { label: 'None' },
  warm: { label: 'Warm', temperature: 30, saturation: 8, brightness: 2 },
  cool: { label: 'Cool', temperature: -30, saturation: -4 },
  bw: { label: 'B&W', saturation: -100, contrast: 12 },
  vintage: { label: 'Vintage', sepia: 38, contrast: -8, fade: 14, saturation: -12, vignette: 30 },
  vivid: { label: 'Vivid', saturation: 38, contrast: 14 },
  dramatic: { label: 'Dramatic', contrast: 28, saturation: -22, vignette: 40, brightness: -4 },
  golden: { label: 'Golden hour', temperature: 42, sepia: 12, saturation: 14, vignette: 18 },
};
export const FONTS = {
  sans: { label: 'Plex Sans Bold', css: '700 {s}px "IBM Plex Sans", system-ui, sans-serif' },
  condensed: { label: 'Plex Condensed', css: '700 {s}px "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif' },
  serif: { label: 'Plex Serif Bold', css: '700 {s}px "IBM Plex Serif", Georgia, serif' },
  serifItalic: { label: 'Plex Serif Italic', css: 'italic 400 {s}px "IBM Plex Serif", Georgia, serif' },
  mono: { label: 'Plex Mono', css: '600 {s}px "IBM Plex Mono", ui-monospace, monospace' },
  system: { label: 'System', css: '700 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};
export const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

export const defaultColor = () => ({ preset: 'none', brightness: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 });
export const defaultTransform = () => ({ zoom: 1, x: 0, y: 0, rotate: 0, angle: 0, flipH: false, flipV: false, kenBurns: 'none', kbFrom: 0, kbTo: 1 });
export const defaultChroma = () => ({ enabled: false, color: '#00ff00', similarity: 0.4, smoothness: 0.15, spill: 0.5 });

export function newProject(name = 'Untitled project') {
  const now = Date.now();
  return {
    schema: SCHEMA, id: uid('prj'), name, created: now, updated: now,
    settings: { ratio: '16:9', res: 1080, fps: 30, quality: 'high', format: 'auto', fit: 'contain', bg: 'black', bgColor: '#000000', imageDuration: 4, endFade: 0 },
    color: defaultColor(),
    clips: [], overlays: [], texts: [], audio: [], markers: [],
    logo: null,
    youtube: { title: '', description: '', tags: '', chaptersFrom: 'auto' },
    thumb: { time: 0, text: '', sub: '', color: '#ffffff', accent: '#df3f34', font: 'sans', position: 'left', style: 'shadow' },
  };
}

export function migrate(p) {
  const base = newProject(p.name);
  const out = Object.assign(base, p);
  out.settings = Object.assign(base.settings, p.settings || {});
  out.color = Object.assign(defaultColor(), p.color || {});
  out.youtube = Object.assign(newProject().youtube, p.youtube || {});
  out.thumb = Object.assign(newProject().thumb, p.thumb || {});
  out.clips = (p.clips || []).map(c => normalizeClip(c));
  out.texts = (p.texts || []).map(t => { const b = newText(0); const r = Object.assign(b, t); r.anim = Object.assign(newText(0).anim, t.anim || {}); r.keyframes = t.keyframes || {}; return r; });
  out.audio = (p.audio || []).map(a => Object.assign(newAudio({ id: a.mediaId, duration: a.srcDuration || 1, name: a.name }, 0), a));
  out.overlays = (p.overlays || []).map(o => normalizeOverlay(o));
  out.markers = p.markers || [];
  out.schema = SCHEMA;
  return out;
}

export function normalizeClip(c) {
  return Object.assign({
    id: uid('clip'), kind: 'video', mediaId: null, name: 'Clip', srcDuration: 1, width: 0, height: 0, hasAudio: true,
    in: 0, out: 1, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, fit: 'inherit', bg: 'inherit', opacity: 1,
    transition: { type: 'cut', duration: 0.6 }, keyframes: {},
  }, c, {
    keyframes: c.keyframes || {},
    color: Object.assign(defaultColor(), c.color || {}),
    transform: Object.assign(defaultTransform(), c.transform || {}),
    transition: Object.assign({ type: 'cut', duration: 0.6 }, c.transition || {}),
  });
}

export function newClipFromMedia(media, settings) {
  const isImg = media.kind === 'image';
  // animated GIFs default to at least one full loop (max 60 s)
  const dur = isImg ? Math.max(settings?.imageDuration || 4, media.animated ? Math.min(60, media.duration || 0) : 0) : media.duration;
  return normalizeClip({
    kind: isImg ? 'image' : 'video', mediaId: media.id, name: media.name.replace(/\.[^/.]+$/, ''),
    srcDuration: isImg ? 3600 : media.duration, width: media.width, height: media.height,
    hasAudio: !isImg && media.hasAudio !== false, in: 0, out: dur,
  });
}

export function newText(start, dur = 4, text = 'Your text here') {
  return {
    id: uid('txt'), text, start, end: start + dur, x: 0.5, y: 0.82, size: 0.075,
    color: '#ffffff', bg: '#000000', bgOpacity: 0.62, style: 'clean', font: 'sans', align: 'center',
    fadeIn: 0.3, fadeOut: 0.3, maxWidth: 0.86,
    scale: 1, rotation: 0, opacity: 1, anim: { in: 'none', out: 'none', inDur: 0.6, outDur: 0.4 }, keyframes: {},
  };
}
export function newAudio(media, start = 0) {
  return {
    id: uid('aud'), mediaId: media.id, name: (media.name || 'Music').replace(/\.[^/.]+$/, ''), srcDuration: media.duration,
    start, in: 0, out: media.duration, volume: 0.6, fadeIn: 1, fadeOut: 2, duck: true, duckLevel: 0.3, loop: false, voice: false,
    loopLen: 0, // looped length on the timeline in seconds (0 = repeat until the end of the video)
    phase: 0, // looped tracks: offset into the loop at the track start (set when a looped track is split)
  };
}


export function normalizeOverlay(o) {
  return Object.assign({
    id: uid('ovl'), kind: 'video', mediaId: null, name: 'Overlay', srcDuration: 1, width: 16, height: 9, hasAudio: false,
    start: 0, in: 0, out: 1, speed: 1, x: 0.76, y: 0.26, w: 0.36, radius: 0.12, opacity: 1, rotation: 0, scale: 1,
    border: 0, borderColor: '#ffffff', shadow: true, volume: 1, muted: true, fadeIn: 0.25, fadeOut: 0.25,
  }, o, { chroma: Object.assign(defaultChroma(), o.chroma || {}), keyframes: o.keyframes || {} });
}
export function newOverlay(media, start, settings) {
  const isImg = media.kind === 'image';
  const dur = isImg ? (settings?.imageDuration || 4) : media.duration;
  return normalizeOverlay({
    kind: isImg ? 'image' : 'video', mediaId: media.id, name: (media.name || 'Overlay').replace(/\.[^/.]+$/, ''),
    srcDuration: isImg ? 3600 : media.duration, width: media.width, height: media.height, hasAudio: !isImg && media.hasAudio !== false,
    start, in: 0, out: dur,
  });
}
export const overlayLen = (o) => Math.max(MIN_CLIP, (o.out - o.in) / (o.kind === 'image' ? 1 : (o.speed || 1)));
export const overlaySourceTime = (o, t) => o.kind === 'image' ? 0 : clamp(o.in + (t - o.start) * (o.speed || 1), o.in, Math.max(o.in, o.out - 0.001));
export function overlaysAt(project, t) {
  return (project.overlays || []).filter(o => t >= o.start && t < o.start + overlayLen(o));
}
export function overlayGain(o, t) {
  if (o.kind !== 'video' || o.muted || !o.hasAudio) return 0;
  const len = overlayLen(o), local = t - o.start;
  if (local < 0 || local > len) return 0;
  // audio follows the overlay's picture fades (with a short de-click ramp when there is no fade)
  const fi = Math.max(0.05, o.fadeIn || 0), fo = Math.max(0.05, o.fadeOut || 0);
  return o.volume * Math.min(clamp(local / fi, 0, 1), clamp((len - local) / fo, 0, 1));
}

// ---------- keyframes ----------
export const EASES = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - Math.pow(1 - p, 3),
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  hold: () => 0,
};
export const ANIM_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
/** Eased progress 0..1 of the segment starting at key `a`. A key may carry an ease window [e0, e1] (set when a
 *  segment is cut by a split or trim) so each piece continues exactly along the original curve. */
export function easeFrac(a, p) {
  const E = EASES[a.ease] || EASES.linear;
  if (a.ease === 'hold') return 0;
  const e0 = a.e0 ?? 0, e1 = a.e1 ?? 1;
  if (e0 === 0 && e1 === 1) return E(p);
  const d = E(e1) - E(e0);
  if (Math.abs(d) < 1e-9) return p;
  return (E(e0 + (e1 - e0) * p) - E(e0)) / d;
}
/** Cut a keyframe track at local time `t`: returns { v, left, right } where left/right are the ease windows for the
 *  pieces before and after t of the segment containing t (null when t is outside the keyed range). */
function cutTrack(track, t) {
  const n = track.length;
  if (!n) return null;
  if (t <= track[0].t || t >= track[n - 1].t) return { v: kfValue(track, t, 0), seg: -1 };
  for (let i = 0; i < n - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (Math.abs(t - a.t) < 1e-6) return { v: a.v, seg: -1 };
    if (t >= a.t && t < b.t) {
      const p = (t - a.t) / Math.max(1e-6, b.t - a.t);
      const e0 = a.e0 ?? 0, e1 = a.e1 ?? 1, m = e0 + (e1 - e0) * p;
      return { v: kfValue(track, t, 0), seg: i, ease: a.ease, left: [e0, m], right: [m, e1] };
    }
  }
  return { v: kfValue(track, t, 0), seg: -1 };
}
const winKey = (k, w) => { if (!w || k.ease === 'hold' || (w[0] === 0 && w[1] === 1)) { delete k.e0; delete k.e1; } else { k.e0 = w[0]; k.e1 = w[1]; } return k; };
/**
 * Re-base keyframes to the window [from, to] of the item's old local time (to = Infinity keeps the tail).
 * Times are shifted by -from; a key is inserted at each cut with the interpolated value, so motion continues
 * seamlessly. `from` < 0 just shifts keys later (e.g. the start of a clip was extended).
 */
export function rebaseKeyframes(kf, from, to = Infinity) {
  const out = {};
  for (const prop of ANIM_PROPS) {
    const tr = kf && kf[prop];
    if (!tr || !tr.length) continue;
    let keys = tr.map(k => ({ ...k }));
    if (to < Infinity) {
      const c = cutTrack(keys, to);
      const kept = keys.filter(k => c.seg >= 0 ? k.t < to - 1e-6 : k.t <= to + 1e-6);
      if (c.seg >= 0) { winKey(kept[kept.length - 1], c.left); kept.push({ t: to, v: c.v, ease: c.ease }); }
      else if (!kept.length) kept.push({ t: Math.max(0, to), v: c.v, ease: keys[0].ease });
      keys = kept;
    }
    if (from > 0) {
      const c = cutTrack(keys, from);
      const kept = keys.filter(k => c.seg >= 0 ? k.t > from + 1e-6 : k.t >= from - 1e-6);
      if (c.seg >= 0) kept.unshift(winKey({ t: from, v: c.v, ease: c.ease }, c.right));
      else if (!kept.length) kept.push({ t: from, v: c.v, ease: keys[keys.length - 1].ease });
      keys = kept;
    }
    out[prop] = keys.map(k => ({ ...k, t: Math.max(0, Math.round((k.t - from) * 1e6) / 1e6) }));
  }
  return out;
}
/** base (non-animated) value of a property for an item of a given type */
export function animBase(type, item, prop) {
  if (type === 'clip') {
    const tr = item.transform || {};
    return prop === 'x' ? tr.x || 0 : prop === 'y' ? tr.y || 0 : prop === 'scale' ? tr.zoom || 1 : prop === 'rotation' ? tr.angle || 0 : item.opacity ?? 1;
  }
  const d = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }[prop];
  return item[prop] ?? d;
}
export function kfValue(track, local, base) {
  if (!track || !track.length) return base;
  if (local <= track[0].t) return track[0].v;
  const n = track.length;
  if (local >= track[n - 1].t) return track[n - 1].v;
  for (let i = 0; i < n - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (local >= a.t && local < b.t) {
      const p = (local - a.t) / Math.max(1e-6, b.t - a.t);
      return a.v + (b.v - a.v) * easeFrac(a, p);
    }
  }
  return base;
}
export function animated(type, item, local) {
  const kf = item.keyframes || {}, out = {};
  for (const p of ANIM_PROPS) out[p] = kfValue(kf[p], local, animBase(type, item, p));
  return out;
}
export function hasKeyframes(item, prop) {
  const kf = item && item.keyframes; if (!kf) return false;
  return prop ? !!(kf[prop] && kf[prop].length) : ANIM_PROPS.some(p => kf[p] && kf[p].length);
}
export function setKeyframe(item, prop, local, v, ease) {
  item.keyframes = item.keyframes || {};
  const tr = item.keyframes[prop] = item.keyframes[prop] || [];
  const ex = tr.find(k => Math.abs(k.t - local) < 1 / 120);
  if (ex) { ex.v = v; if (ease) { ex.ease = ease; delete ex.e0; delete ex.e1; } }
  else {
    for (const k of tr) if (k.t < local) { delete k.e0; delete k.e1; } // segment shape changes: drop cut windows before the new key
    tr.push({ t: Math.max(0, local), v, ease: ease || (tr.length ? tr[tr.length - 1].ease : 'easeInOut') || 'easeInOut' }); tr.sort((a, b) => a.t - b.t); }
}
export function kfTimes(item) {
  const s = new Set();
  const kf = item && item.keyframes || {};
  for (const p of ANIM_PROPS) for (const k of kf[p] || []) s.add(Math.round(k.t * 1000) / 1000);
  return [...s].sort((a, b) => a - b);
}
export function removeKeyframesAt(item, local) {
  const kf = item.keyframes || {};
  for (const p of ANIM_PROPS) if (kf[p]) { kf[p] = kf[p].filter(k => Math.abs(k.t - local) > 1 / 120); if (!kf[p].length) delete kf[p]; }
}
export function setEaseAt(item, local, ease) {
  const kf = item.keyframes || {};
  for (const p of ANIM_PROPS) for (const k of kf[p] || []) if (Math.abs(k.t - local) < 1 / 120) { k.ease = ease; delete k.e0; delete k.e1; }
}

export const clipLen = (c) => Math.max(MIN_CLIP, (c.out - c.in) / (c.kind === 'image' ? 1 : (c.speed || 1)));
export const audioLen = (a) => Math.max(0.05, a.out - a.in);
/** Length of an audio track on the timeline: one pass, or (looped) repeated to loopLen / the end of the video. */
export const audioSpan = (a, total) => !a.loop ? audioLen(a) : Math.max(0.05, a.loopLen > 0 ? a.loopLen : (total ?? 0) - a.start);
/** Source position of an audio track at sequence time t (handles looping). */
export function audioSourceTime(a, t) {
  const local = Math.max(0, t - a.start), L = audioLen(a);
  if (!a.loop) return a.in + Math.min(local, L);
  return a.in + ((local + (a.phase || 0)) % L);
}
/** Loop seams (sequence times where a looped track jumps back to its in-point). */
export function loopSeams(a, total) {
  if (!a.loop) return [];
  const L = audioLen(a), span = audioSpan(a, total), out = [];
  for (let s = L - ((a.phase || 0) % L); s < span - 1e-3 && out.length < 10000; s += L) if (s > 1e-3) out.push(a.start + s);
  return out;
}

/** Compute timeline placement for clips (magnetic main track with overlapping crossfades). */
export function layout(project) {
  const items = []; let t = 0;
  const clips = project.clips;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i], len = clipLen(c);
    let start = t, xIn = 0, fadeIn = 0;
    const tr = c.transition || { type: 'cut' };
    if (i > 0 && tr.type === 'crossfade') {
      const prev = items[i - 1];
      xIn = Math.max(0, Math.min(tr.duration, prev.len / 2, len / 2));
      start = prev.end - xIn;
    } else if (tr.type === 'fade') {
      const prevLen = i > 0 ? items[i - 1].len : Infinity;
      fadeIn = Math.max(0, Math.min(tr.duration / (i > 0 ? 2 : 1), len / 2, prevLen / 2));
      if (i > 0) items[i - 1].fadeOutBlack = fadeIn;
    }
    const it = { clip: c, index: i, start, end: start + len, len, xIn, xOut: 0, fadeInBlack: fadeIn, fadeOutBlack: 0 };
    if (i > 0) items[i - 1].xOut = xIn;
    items.push(it); t = it.end;
  }
  const endFade = project.settings?.endFade || 0;
  if (items.length && endFade > 0) { const last = items[items.length - 1]; last.fadeOutBlack = Math.max(last.fadeOutBlack, Math.min(endFade, last.len / 2)); }
  return { items, total: t };
}
export function totalDuration(project) {
  return layout(project).total;
}
/** Source time for a clip at sequence time t */
export function sourceTime(it, t) {
  const c = it.clip;
  if (c.kind === 'image') return 0;
  return clamp(c.in + (t - it.start) * c.speed, c.in, Math.max(c.in, c.out - 0.001));
}
/** Active clips at time t with their visual alpha (bottom first). */
export function activeAt(lay, t) {
  const out = [];
  for (const it of lay.items) {
    if (t < it.start || t >= it.end) continue;
    let a = 1;
    if (it.xIn > 0 && t < it.start + it.xIn) a = (t - it.start) / it.xIn; // crossfade in (drawn on top)
    let black = 1;
    if (it.fadeInBlack > 0 && t < it.start + it.fadeInBlack) black = Math.min(black, (t - it.start) / it.fadeInBlack);
    if (it.fadeOutBlack > 0 && t > it.end - it.fadeOutBlack) black = Math.min(black, (it.end - t) / it.fadeOutBlack);
    out.push({ it, alpha: clamp(a, 0, 1), black: clamp(black, 0, 1) });
  }
  if (!out.length && lay.items.length && t >= lay.total - 1e-3 && t <= lay.total + 1e-3) {
    const it = lay.items[lay.items.length - 1];
    out.push({ it, alpha: 1, black: it.fadeOutBlack > 0 ? 0 : 1 });
  }
  return out;
}
export function clipAt(lay, t) {
  // prefer the clip that "owns" t (the incoming clip after a crossfade midpoint)
  let best = null;
  for (const it of lay.items) if (t >= it.start && t < it.end) best = it;
  if (!best && lay.items.length && t >= lay.total) best = lay.items[lay.items.length - 1];
  return best;
}

/** Linear fade helper: 0..1 */
function ramp(x, len) { return len > 0 ? clamp(x / len, 0, 1) : 1; }

/** Gain of a clip's own audio at sequence time t (0 outside). */
export function clipGain(it, t) {
  const c = it.clip;
  if (c.kind !== 'video' || c.muted || !c.hasAudio) return 0;
  if (t < it.start || t > it.end) return 0;
  const local = t - it.start, rem = it.end - t;
  let g = c.volume;
  g *= Math.min(ramp(local, c.fadeIn), ramp(rem, c.fadeOut));
  if (it.xIn > 0) g *= ramp(local, it.xIn);
  if (it.xOut > 0) g *= ramp(rem, it.xOut);
  if (it.fadeInBlack > 0) g *= ramp(local, it.fadeInBlack);
  if (it.fadeOutBlack > 0) g *= ramp(rem, it.fadeOutBlack);
  return g;
}
/** Intervals where clip audio is audible (for ducking). */
export function speechIntervals(lay, project, excludeId) {
  const iv = [];
  for (const it of lay.items) {
    const c = it.clip;
    if (c.kind === 'video' && !c.muted && c.hasAudio && c.volume > 0.02) iv.push([it.start, it.end]);
  }
  if (project) {
    for (const o of project.overlays || []) if (o.kind === 'video' && !o.muted && o.hasAudio && o.volume > 0.02) iv.push([o.start, o.start + overlayLen(o)]);
    // a voice track drives ducking of OTHER tracks only: never of itself
    for (const a of project.audio || []) if (a.voice && a.volume > 0.02 && a.id !== excludeId) iv.push([a.start, a.start + audioSpan(a, lay.total)]);
  }
  // merge
  iv.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const x of iv) { if (m.length && x[0] <= m[m.length - 1][1] + 0.05) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]); else m.push([...x]); }
  return m;
}
const DUCK_RAMP = 0.35;
export function duckFactor(intervals, t, level) {
  let f = 1;
  for (const [a, b] of intervals) {
    if (t < a - DUCK_RAMP || t > b + DUCK_RAMP) continue;
    let d;
    if (t < a) d = (a - t) / DUCK_RAMP; else if (t > b) d = (t - b) / DUCK_RAMP; else d = 0;
    f = Math.min(f, level + (1 - level) * clamp(d, 0, 1));
  }
  return f;
}
/** Speech intervals that duck audio track `a` (its own audio excluded). */
export function duckIntervalsFor(a, lay, project, shared) {
  return a.voice ? speechIntervals(lay, project, a.id) : (shared || speechIntervals(lay, project));
}
/** Music gain at sequence time t */
export function musicGain(a, t, intervals, total) {
  const len = audioSpan(a, total);
  if (t < a.start || t > a.start + len) return 0;
  const local = t - a.start, rem = Math.min(a.start + len, total ?? Infinity) - t;
  let g = a.volume * Math.min(ramp(local, a.fadeIn), ramp(rem, a.fadeOut));
  if (a.loop) { // 12 ms dip at each loop seam so the jump back to the in-point doesn't click
    const L = audioLen(a), ph = (local + (a.phase || 0)) % L, d = Math.min(ph, L - ph);
    if (local > 0.02 && rem > 0.02 && L > 0.1) g *= ramp(d, 0.012);
  }
  if (a.duck && intervals) g *= duckFactor(intervals, t, a.duckLevel ?? 0.3);
  return Math.max(0, g);
}

/** Effective color = global + per-clip + presets */
export function effectiveColor(project, clip) {
  const g = project.color || defaultColor(), c = clip?.color || defaultColor();
  const pg = PRESETS[g.preset] || {}, pc = PRESETS[c.preset] || {};
  const keys = ['brightness', 'contrast', 'saturation', 'temperature', 'vignette', 'sepia', 'fade'];
  const out = {};
  for (const k of keys) out[k] = (g[k] || 0) + (c[k] || 0) + (pg[k] || 0) + (pc[k] || 0);
  out.saturation = clamp(out.saturation, -100, 150);
  out.vignette = clamp(out.vignette, 0, 100);
  out.sepia = clamp(out.sepia, 0, 100);
  out.fade = clamp(out.fade, 0, 100);
  out.brightness = clamp(out.brightness, -100, 100);
  out.contrast = clamp(out.contrast, -100, 100);
  out.temperature = clamp(out.temperature, -100, 100);
  return out;
}
export const colorIsNeutral = (c) => !c.brightness && !c.contrast && !c.saturation && !c.temperature && !c.vignette && !c.sepia && !c.fade;

/** Output dimensions */
export function outputDims(project, overrideRes) {
  const s = project.settings, res = overrideRes || s.res || 1080;
  let ratio = RATIOS[s.ratio];
  if (!ratio) {
    const first = project.clips.find(c => c.width && c.height);
    ratio = first ? first.width / first.height : 16 / 9;
  }
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  if (ratio >= 1) return { width: even(res * ratio), height: even(res) };
  return { width: even(res), height: even(res / ratio) };
}

// ---------- edit operations (mutate project, return info) ----------
export function rippleShift(project, from, delta, { texts = true, audio = true, markers = true } = {}) {
  if (!delta) return;
  if (texts) for (const t of project.texts) if (t.start >= from - 1e-6) { t.start = Math.max(0, t.start + delta); t.end = Math.max(t.start + 0.1, t.end + delta); }
  if (audio) for (const a of project.audio) if (a.start >= from - 1e-6) a.start = Math.max(0, a.start + delta);
  if (audio) for (const o of project.overlays || []) if (o.start >= from - 1e-6) o.start = Math.max(0, o.start + delta);
  if (markers) for (const m of project.markers) if (m.time >= from - 1e-6) m.time = Math.max(0, m.time + delta);
}

export function splitAt(project, t) {
  const lay = layout(project);
  const it = clipAt(lay, t);
  if (!it) return null;
  const c = it.clip;
  const local = t - it.start;
  if (local < MIN_CLIP || it.end - t < MIN_CLIP) return null;
  const b = deepClone(c);
  b.id = uid('clip');
  b.transition = { type: 'cut', duration: c.transition.duration };
  if (c.kind === 'image') {
    b.in = c.in + local; b.out = c.out; c.out = c.in + local; // image in-point = animation (GIF) time offset
  } else {
    const s = c.in + local * c.speed;
    c.out = s; b.in = s;
  }
  b.fadeIn = 0; c.fadeOut = 0;
  // keyframes: first half ends at the interpolated value, second half continues from it
  const kf = c.keyframes || {};
  c.keyframes = rebaseKeyframes(kf, 0, local);
  b.keyframes = rebaseKeyframes(kf, local);
  // Ken Burns: each half covers its share of the original motion range
  const tr = c.transform || {};
  if (tr.kenBurns && tr.kenBurns !== 'none') {
    const f0 = tr.kbFrom ?? 0, f1 = tr.kbTo ?? 1, m = f0 + (f1 - f0) * (local / it.len);
    c.transform.kbTo = m; b.transform.kbFrom = m; b.transform.kbTo = f1;
  }
  project.clips.splice(it.index + 1, 0, b);
  return b;
}

/**
 * Split the item `sel` ({type, id}) at sequence time t. Works for clips, text layers, audio tracks and overlays.
 * Returns the new (second) item or null (with .reason) when t isn't safely inside the item.
 */
export function splitItem(project, sel, t) {
  const fail = (reason) => ({ fail: true, reason });
  if (!sel || sel.type === 'clip') {
    if (sel) { const it = layout(project).items.find(i => i.clip.id === sel.id); if (it && (t <= it.start + MIN_CLIP - 1e-9 || t >= it.end - MIN_CLIP + 1e-9)) return fail('Move the playhead inside the selected clip (not at its edge) to split it.'); }
    const nb = splitAt(project, t);
    return nb ? { type: 'clip', item: nb } : fail('Move the playhead inside a clip (not at its edge) to split.');
  }
  if (sel.type === 'text') {
    const a = project.texts.find(x => x.id === sel.id); if (!a) return fail('Nothing to split.');
    const u = t - a.start;
    if (u < MIN_CLIP || a.end - t < MIN_CLIP) return fail('Move the playhead inside the selected text (not at its edge) to split it.');
    const b = deepClone(a); b.id = uid('txt');
    const kf = a.keyframes || {};
    a.keyframes = rebaseKeyframes(kf, 0, u); b.keyframes = rebaseKeyframes(kf, u);
    a.end = t; b.start = t;
    a.fadeOut = 0; b.fadeIn = 0;
    a.anim = { ...(a.anim || {}), out: 'none' }; b.anim = { ...(b.anim || {}), in: 'none' };
    project.texts.push(b);
    return { type: 'text', item: b };
  }
  if (sel.type === 'audio') {
    const a = project.audio.find(x => x.id === sel.id); if (!a) return fail('Nothing to split.');
    const total = layout(project).total, span = audioSpan(a, total), u = t - a.start;
    if (u < MIN_CLIP || span - u < MIN_CLIP) return fail('Move the playhead inside the selected audio track (not at its edge) to split it.');
    const b = deepClone(a); b.id = uid('aud'); b.start = t;
    if (a.loop) {
      const L = audioLen(a);
      b.phase = ((a.phase || 0) + u) % L;
      b.loopLen = a.loopLen > 0 ? a.loopLen - u : 0;
      a.loopLen = u;
    } else {
      a.out = a.in + u; b.in = a.in + u;
    }
    a.fadeOut = 0; b.fadeIn = 0;
    project.audio.splice(project.audio.indexOf(a) + 1, 0, b);
    return { type: 'audio', item: b };
  }
  if (sel.type === 'overlay') {
    const o = (project.overlays || []).find(x => x.id === sel.id); if (!o) return fail('Nothing to split.');
    const len = overlayLen(o), u = t - o.start;
    if (u < MIN_CLIP || len - u < MIN_CLIP) return fail('Move the playhead inside the selected overlay (not at its edge) to split it.');
    const b = deepClone(o); b.id = uid('ovl'); b.start = t;
    const sp = o.kind === 'image' ? 1 : (o.speed || 1);
    const s = o.in + u * sp;
    o.out = s; b.in = s;
    o.fadeOut = 0; b.fadeIn = 0;
    const kf = o.keyframes || {};
    o.keyframes = rebaseKeyframes(kf, 0, u); b.keyframes = rebaseKeyframes(kf, u);
    project.overlays.splice(project.overlays.indexOf(o) + 1, 0, b);
    return { type: 'overlay', item: b };
  }
  return fail('Markers can’t be split. Select a clip, text, overlay or audio track.');
}

export function removeClip(project, id, ripple) {
  const lay = layout(project);
  const it = lay.items.find(x => x.clip.id === id);
  if (!it) return;
  project.clips.splice(it.index, 1);
  if (ripple) rippleShift(project, it.end - 1e-3, layout(project).total - lay.total);
}
export function duplicateClip(project, id, ripple) {
  const lay = layout(project);
  const it = lay.items.find(x => x.clip.id === id);
  if (!it) return null;
  const b = deepClone(it.clip); b.id = uid('clip'); b.transition = { type: 'cut', duration: b.transition.duration };
  project.clips.splice(it.index + 1, 0, b);
  if (ripple) rippleShift(project, it.end - 1e-3, layout(project).total - lay.total);
  return b;
}
export function moveClip(project, from, to) {
  if (from === to || from < 0 || from >= project.clips.length) return;
  const [c] = project.clips.splice(from, 1);
  project.clips.splice(clamp(to, 0, project.clips.length), 0, c);
}

// ---------- YouTube chapters ----------
export function chapters(project) {
  const lay = layout(project);
  let pts = [];
  const useMarkers = project.markers.length > 0 && project.youtube.chaptersFrom !== 'clips';
  if (useMarkers) pts = project.markers.map(m => ({ t: m.time, name: m.name || 'Chapter' }));
  else pts = lay.items.map(it => ({ t: it.start + (it.xIn || 0) / 2, name: it.clip.name || 'Part ' + (it.index + 1) }));
  pts.sort((a, b) => a.t - b.t);
  if (!pts.length) return { list: [], warnings: ['Add clips or markers to generate chapters.'] };
  if (pts[0].t > 0.5) pts.unshift({ t: 0, name: 'Intro' }); else pts[0].t = 0;
  // YouTube requires >= 10s per chapter: merge short ones into previous
  const out = [];
  let merged = 0;
  for (const p of pts) {
    if (out.length && p.t - out[out.length - 1].t < 10) { merged++; continue; }
    out.push({ ...p });
  }
  const warnings = [];
  if (merged) warnings.push(merged + ' chapter point(s) closer than 10 s to the previous one were skipped (YouTube minimum).');
  if (out.length && lay.total - out[out.length - 1].t < 10 && out.length > 1) { out.pop(); warnings.push('The last chapter would be shorter than 10 s, so it was dropped.'); }
  if (out.length < 3) warnings.push('YouTube needs at least 3 chapters of 10 seconds or longer — add markers to fine-tune.');
  return { list: out, warnings, text: out.map(p => fmt(p.t) + ' ' + p.name).join('\n') };
}

// ---------- History (snapshot based) ----------
export class History {
  constructor(limit = 120) { this.limit = limit; this.undoStack = []; this.redoStack = []; this.current = null; }
  reset(project) { this.undoStack = []; this.redoStack = []; this.current = JSON.stringify(project); }
  /** Record a new state after a mutation. */
  commit(project) {
    const s = JSON.stringify(project);
    if (s === this.current) return false;
    if (this.current != null) this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.current = s; this.redoStack = [];
    return true;
  }
  undo() { if (!this.undoStack.length) return null; this.redoStack.push(this.current); this.current = this.undoStack.pop(); return JSON.parse(this.current); }
  redo() { if (!this.redoStack.length) return null; this.undoStack.push(this.current); this.current = this.redoStack.pop(); return JSON.parse(this.current); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  mediaIds() {
    const ids = new Set();
    for (const s of [...this.undoStack, ...this.redoStack, this.current || '{}']) {
      const re = /"mediaId":"([^"]+)"/g; let m; while ((m = re.exec(s))) ids.add(m[1]);
    }
    return ids;
  }
}
