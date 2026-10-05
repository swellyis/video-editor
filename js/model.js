// Project data model, timeline layout, edit operations, audio envelopes, history.
import { uid, clamp, deepClone } from './util.js';
import { normalize as normTransition, isOverlap, isDip, typeInfo, effective as effTransition, soundGain } from './transitions.js';
import { normFx } from './effects.js';
import { defaultCaptionStyle, normalizeCaptionStyle, normalizeCaptions, splitCaption } from './captions.js';

export const SCHEMA = 5;
export const MIN_CLIP = 0.1; // seconds on timeline

import * as RAMP from './ramp.js';
import { PRESETS, KEYS as COLOR_KEYS, filterParams, amountOf, normFilter } from './filters.js';
import { normalizeDuck, duckFactor, speechForTrack, DEFAULT_ATTACK, DEFAULT_RELEASE, dbToLevel } from './duck.js';
import { normalizeBgRemove } from './bgremove.js';
export { defaultBgRemove } from './bgremove.js';
export { PRESETS };
export const FONTS = {
  sans: { label: 'Plex Sans Bold', css: '700 {s}px "IBM Plex Sans", system-ui, sans-serif' },
  condensed: { label: 'Plex Condensed', css: '700 {s}px "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif' },
  serif: { label: 'Plex Serif Bold', css: '700 {s}px "IBM Plex Serif", Georgia, serif' },
  serifItalic: { label: 'Plex Serif Italic', css: 'italic 400 {s}px "IBM Plex Serif", Georgia, serif' },
  mono: { label: 'Plex Mono', css: '600 {s}px "IBM Plex Mono", ui-monospace, monospace' },
  anton: { label: 'Anton (impact)', css: '400 {s}px "Anton", Impact, "Arial Narrow", sans-serif' },
  bebas: { label: 'Bebas Neue', css: '400 {s}px "Bebas Neue", Impact, sans-serif' },
  oswald: { label: 'Oswald Bold', css: '700 {s}px "Oswald", "IBM Plex Sans Condensed", sans-serif' },
  montserrat: { label: 'Montserrat ExtraBold', css: '800 {s}px "Montserrat", "IBM Plex Sans", sans-serif' },
  playfair: { label: 'Playfair ExtraBold', css: '800 {s}px "Playfair Display", Georgia, serif' },
  lobster: { label: 'Lobster (script)', css: '400 {s}px "Lobster", "Brush Script MT", cursive' },
  system: { label: 'System', css: '700 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};
export const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

export const defaultColor = () => ({ preset: 'none', filterAmount: 1, brightness: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 });
export const defaultTransform = () => ({ zoom: 1, x: 0, y: 0, rotate: 0, angle: 0, flipH: false, flipV: false, kenBurns: 'none', kbFrom: 0, kbTo: 1 });
export const defaultChroma = () => ({ enabled: false, color: '#00ff00', similarity: 0.4, smoothness: 0.15, spill: 0.5 });

export const PROJECT_NAME_MAX = 80;
/** Friendly dated default for a project: "Project · Sep 29, 8:52 PM" (locale aware; the year is added for another year). */
export function defaultProjectName(time = Date.now(), locale) {
  const d = new Date(Number.isFinite(time) ? time : Date.now());
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  let s; try { s = new Intl.DateTimeFormat(locale, opts).format(d); } catch { s = d.toLocaleString(); }
  return 'Project · ' + s.replace(/[\u202f\u00a0]/g, ' ');
}
/** A name typed by the user: whitespace collapsed, limited to 80 characters; '' when nothing is left. */
export const cleanProjectName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, PROJECT_NAME_MAX) : '');
/** Old projects called "Untitled project" (any case) or with no name get a dated name from their created / updated time; every other name is kept. */
export function isPlaceholderName(n) { return typeof n !== 'string' || !n.trim() || /^untitled( project)?$/i.test(n.trim()); }
export function fixedProjectName(p) {
  return isPlaceholderName(p && p.name) ? defaultProjectName((p && (p.created || p.updated)) || Date.now()) : p.name;
}

export function newProject(name) {
  const now = Date.now();
  name = isPlaceholderName(name) ? defaultProjectName(now) : name;
  return {
    schema: SCHEMA, id: uid('prj'), name, created: now, updated: now,
    settings: { ratio: '16:9', res: 1080, fps: 30, quality: 'high', format: 'auto', fit: 'contain', bg: 'black', bgColor: '#000000', imageDuration: 4, endFade: 0 },
    color: defaultColor(),
    laneModel: 2, clips: [], overlays: [], texts: [], blurs: [], audio: [], markers: [],
    captions: [], captionStyle: defaultCaptionStyle(),
    logo: null,
    thumb: { time: null, text: '', sub: '', color: '#ffffff', accent: '#df3f34', font: 'sans', position: 'left', style: 'shadow', format: 'auto', fit: 'cover', type: 'jpg', pip: true, logo: true, designs: {} },
  };
}

export function migrate(p) {
  const base = newProject(p.name);
  const out = Object.assign(base, p);
  out.name = fixedProjectName(out);
  out.settings = Object.assign(base.settings, p.settings || {});
  out.color = tidyColor(Object.assign(defaultColor(), p.color || {}));
  out.thumb = Object.assign(newProject().thumb, p.thumb || {});
  out.clips = (p.clips || []).map(c => normalizeClip(c));
  out.texts = (p.texts || []).map(t => { const b = newText(0); const r = Object.assign(b, t); r.name = typeof t.name === 'string' ? t.name.slice(0, NAME_MAX) : ''; r.anim = cleanTextAnim(t.anim); r.keyframes = t.keyframes || {}; return r; });
  out.audio = (p.audio || []).map(a => Object.assign(newAudio({ id: a.mediaId, duration: a.srcDuration || 1, name: a.name }, 0), a));
  out.overlays = (p.overlays || []).map(o => normalizeOverlay(o));
  out.blurs = (Array.isArray(p.blurs) ? p.blurs : []).filter(b => b && typeof b === 'object').slice(0, 200).map(b => normalizeBlur(b));
  out.markers = (Array.isArray(p.markers) ? p.markers : []).filter(m => m && typeof m === 'object').map(m => ({ ...m, name: typeof m.name === 'string' ? m.name.slice(0, NAME_MAX) : '', time: num(m.time, 0, 1e6, 0) }));
  out.captions = normalizeCaptions(p.captions);
  out.captionStyle = normalizeCaptionStyle(p.captionStyle);
  if ((p.schema || 0) < 5 && out.thumb.time === 0) out.thumb.time = null; // before v5, 0 meant "not chosen yet"
  sanitizeProject(out);
  out.laneModel = p.laneModel === 2 ? 2 : 0; // 0: saved before every kind of item shared one set of lanes
  ensureLanes(out);
  out.schema = SCHEMA;
  return out;
}
export const NAME_MAX = 80;
/** Display name of a text layer (custom name, else its first line) and of a blur region (custom name, else its kind). */
export const textLabel = (t) => (t.name && t.name.trim()) || (t.text || '(empty)').replace(/\n/g, ' ');
export const blurLabel = (b) => (b.name && b.name.trim()) || (b.invert ? 'Focus' : b.mode === 'pixelate' ? 'Pixelate' : 'Blur');
const cleanName = (o, d) => { o.name = typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, NAME_MAX) : d; };
const num = (v, lo, hi, d) => (v !== null && v !== '' && Number.isFinite(+v) ? clamp(+v, lo, hi) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
/**
 * Keep every setting and numeric field inside the range the UI allows. Protects against damaged or hand-edited
 * project files (e.g. a huge resolution or speed that would exhaust memory in the encoder or canvas).
 */
export function sanitizeProject(p) {
  const s = p.settings;
  s.res = oneOf(+s.res, [720, 1080, 2160], 1080); s.fps = oneOf(+s.fps, [24, 30, 60], 30);
  s.quality = oneOf(s.quality, ['low', 'medium', 'high', 'max'], 'high'); s.format = oneOf(s.format, ['auto', 'mp4', 'webm'], 'auto');
  s.ratio = oneOf(s.ratio, ['original', '16:9', '9:16', '1:1', '4:5'], '16:9'); s.fit = oneOf(s.fit, ['contain', 'cover'], 'contain');
  s.bg = oneOf(s.bg, ['black', 'blur', 'white', 'color'], 'black');
  s.imageDuration = num(s.imageDuration, 0.1, 3600, 4); s.endFade = num(s.endFade, 0, 30, 0);
  if (p.thumb.time !== null) p.thumb.time = num(p.thumb.time, 0, 1e6, null);
  const T = p.thumb;
  T.format = oneOf(T.format, ['auto', ...Object.keys(THUMB_FORMATS)], 'auto'); T.fit = oneOf(T.fit, ['cover', 'contain'], 'cover');
  T.type = oneOf(T.type, ['jpg', 'png'], 'jpg'); T.position = oneOf(T.position, ['left', 'center', 'right', 'top', 'bottom'], 'left');
  T.pip = T.pip !== false; T.logo = T.logo !== false;
  // Designer layers: only the shape is checked here (3 formats, plain objects, bounded size); js/designer.js normDesign() cleans each field when a design is opened.
  const dz = {};
  if (T.designs && typeof T.designs === 'object' && !Array.isArray(T.designs)) {
    for (const k of ['16:9', '9:16', '1:1']) { const d = T.designs[k]; if (d && typeof d === 'object' && !Array.isArray(d) && JSON.stringify(d).length < 400000) dz[k] = d; }
  }
  T.designs = dz;
  for (const c of p.clips) {
    cleanName(c, 'Clip'); c.muted = c.muted === true; c.speed = num(c.speed, 0.25, 4, 1); c.volume = num(c.volume, 0, 2, 1); c.opacity = num(c.opacity, 0, 1, 1);
    c.srcDuration = num(c.srcDuration, 0, 1e6, 1); c.in = num(c.in, 0, 1e6, 0); c.out = num(c.out, c.in + 0.01, 1e6, c.in + 1);
    c.fadeIn = num(c.fadeIn, 0, 60, 0); c.fadeOut = num(c.fadeOut, 0, 60, 0); c.gap = num(c.gap, 0, 1e5, 0);
    { const r = c.kind === 'image' ? null : RAMP.normalize(c.ramp); if (r) c.ramp = r; else delete c.ramp; if (c.reverse === true && c.kind !== 'image') c.reverse = true; else delete c.reverse; } // speed curve + reverse (video clips only)
    c.transition = normTransition(c.transition);
    c.transform.zoom = num(c.transform.zoom, 0.05, 20, 1);
    cleanClipBlur(c.blur);
  }
  for (const o of p.overlays) {
    cleanName(o, 'Overlay'); o.muted = o.muted !== false; o.speed = num(o.speed, 0.25, 4, 1); o.volume = num(o.volume, 0, 2, 1); o.opacity = num(o.opacity, 0, 1, 1);
    o.w = num(o.w, 0.01, 4, 0.36); o.scale = num(o.scale, 0.05, 20, 1); o.start = num(o.start, 0, 1e6, 0);
    o.in = num(o.in, 0, 1e6, 0); o.out = num(o.out, o.in + 0.01, 1e6, o.in + 1);
  }
  for (const t of p.texts) {
    t.size = num(t.size, 0.005, 1, 0.075); t.scale = num(t.scale, 0.05, 20, 1); t.opacity = num(t.opacity, 0, 1, 1);
    t.start = num(t.start, 0, 1e6, 0); t.end = num(t.end, t.start + 0.05, 1e6, t.start + 4);
    if (typeof t.text !== 'string') t.text = String(t.text ?? '');
  }
  for (const b of p.blurs || []) cleanBlur(b);
  for (const a of p.audio) {
    cleanName(a, 'Music'); a.muted = a.muted === true; a.volume = num(a.volume, 0, 2, 0.6); a.duckLevel = num(a.duckLevel, 0, 1, 0.3); normalizeDuck(a); a.start = num(a.start, 0, 1e6, 0);
    a.in = num(a.in, 0, 1e6, 0); a.out = num(a.out, a.in + 0.01, 1e6, a.in + 1); a.loopLen = num(a.loopLen, 0, 1e6, 0); a.phase = num(a.phase, 0, 1e6, 0);
    a.fadeIn = num(a.fadeIn, 0, 60, 0); a.fadeOut = num(a.fadeOut, 0, 60, 0); a.speed = num(a.speed, 0.25, 4, 1);
  }
  for (const it of [...p.clips, ...p.overlays, ...p.audio]) { cleanVolumeKeys(it); cleanClean(it); cleanChange(it); }
  for (const a of p.audio) cleanBeat(a);
  if (p.logo) { const L = p.logo; L.size = num(L.size, 0.01, 1, 0.14); L.opacity = num(L.opacity, 0, 1, 0.85); L.margin = num(L.margin, 0, 0.5, 0.035); L.position = oneOf(L.position, ['tl', 'tr', 'bl', 'br', 'center'], 'tr'); }
  return p;
}


/** Volume envelope keys (keyframes.volume): finite numbers, level 0..VOL_KEY_MAX, valid easing, sorted; anything else is dropped. */
export const VOL_KEY_MAX = 2;
export function cleanVolumeKeys(item) {
  if (!item.keyframes || typeof item.keyframes !== 'object' || Array.isArray(item.keyframes)) item.keyframes = {};
  const tr = item.keyframes.volume;
  if (tr === undefined) return item;
  const keys = Array.isArray(tr) ? tr.filter(k => k && Number.isFinite(+k.t) && Number.isFinite(+k.v) && k.t !== null && k.v !== null && k.t !== '' && k.v !== '').slice(0, 500).map(k => {
    const o = { t: clamp(+k.t, 0, 1e6), v: clamp(+k.v, 0, VOL_KEY_MAX), ease: oneOf(k.ease, ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'], 'linear') };
    if (Number.isFinite(+k.e0) && Number.isFinite(+k.e1)) { o.e0 = clamp(+k.e0, 0, 1); o.e1 = clamp(+k.e1, 0, 1); }
    return o;
  }).sort((a, b) => a.t - b.t).filter((k, i, all) => i === 0 || k.t - all[i - 1].t >= 1 / 120) : []; // one key per moment
  if (keys.length) item.keyframes.volume = keys; else delete item.keyframes.volume;
  return item;
}

// ---------- blur / privacy regions ----------
export const BLUR_SHAPES = ['rect', 'ellipse'], BLUR_MODES = ['blur', 'pixelate'];
/** Whole-clip blur (Clip tab): blur the entire clip, optionally keeping a sharp subject region. */
export const defaultClipBlur = () => ({ enabled: false, mode: 'blur', strength: 0.6, keep: false, shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.62, radius: 0.3, feather: 0.35 });
export function newBlur(start, dur = 4) {
  return {
    id: uid('blr'), name: '', shape: 'rect', mode: 'blur', x: 0.5, y: 0.5, w: 0.3, h: 0.3, radius: 0.15, strength: 0.7, feather: 0.1, invert: false,
    start, end: start + dur, fadeIn: 0.2, fadeOut: 0.2, keyframes: {},
  };
}
export function normalizeBlur(b) {
  const r = Object.assign(newBlur(0), b, { keyframes: b.keyframes && typeof b.keyframes === 'object' ? b.keyframes : {} });
  if (!r.id || typeof r.id !== 'string') r.id = uid('blr');
  return cleanBlur(r);
}
const BLUR_KF = ['x', 'y', 'w', 'h'];
export function cleanBlur(b) {
  b.name = typeof b.name === 'string' ? b.name.slice(0, NAME_MAX) : '';
  b.shape = oneOf(b.shape, BLUR_SHAPES, 'rect'); b.mode = oneOf(b.mode, BLUR_MODES, 'blur');
  b.x = num(b.x, -0.5, 1.5, 0.5); b.y = num(b.y, -0.5, 1.5, 0.5); b.w = num(b.w, 0.01, 3, 0.3); b.h = num(b.h, 0.01, 3, 0.3);
  b.radius = num(b.radius, 0, 1, 0.15); b.strength = num(b.strength, 0, 1, 0.7); b.feather = num(b.feather, 0, 1, 0.1);
  b.invert = b.invert === true; b.start = num(b.start, 0, 1e6, 0); b.end = num(b.end, b.start + 0.05, 1e6, b.start + 4);
  b.fadeIn = num(b.fadeIn, 0, 60, 0); b.fadeOut = num(b.fadeOut, 0, 60, 0);
  const kf = {};
  for (const prop of BLUR_KF) {
    const tr = b.keyframes && Array.isArray(b.keyframes[prop]) ? b.keyframes[prop] : null; if (!tr) continue;
    const keys = tr.filter(k => k && Number.isFinite(+k.t) && Number.isFinite(+k.v)).slice(0, 500).map(k => {
      const o = { t: Math.max(0, +k.t), v: prop === 'x' || prop === 'y' ? clamp(+k.v, -0.5, 1.5) : clamp(+k.v, 0.01, 3), ease: oneOf(k.ease, ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'], 'linear') };
      if (Number.isFinite(+k.e0) && Number.isFinite(+k.e1)) { o.e0 = clamp(+k.e0, 0, 1); o.e1 = clamp(+k.e1, 0, 1); }
      return o;
    }).sort((a, c) => a.t - c.t);
    if (keys.length) kf[prop] = keys;
  }
  b.keyframes = kf;
  return b;
}
export function cleanClipBlur(b) {
  b.enabled = b.enabled === true; b.keep = b.keep === true; b.mode = oneOf(b.mode, BLUR_MODES, 'blur'); b.shape = oneOf(b.shape, BLUR_SHAPES, 'ellipse');
  b.strength = num(b.strength, 0, 1, 0.6); b.x = num(b.x, -0.5, 1.5, 0.5); b.y = num(b.y, -0.5, 1.5, 0.5); b.w = num(b.w, 0.02, 3, 0.5); b.h = num(b.h, 0.02, 3, 0.62);
  b.radius = num(b.radius, 0, 1, 0.3); b.feather = num(b.feather, 0, 1, 0.35);
  return b;
}
/** Region geometry and fade amount (0..1) of a blur item at sequence time t (null when it isn't active). */
export function blurAt(b, t) {
  if (t < b.start || t >= b.end) return null;
  const local = t - b.start, len = b.end - b.start, A = animated('blur', b, local);
  const amount = Math.min(b.fadeIn > 0 ? local / b.fadeIn : 1, b.fadeOut > 0 ? (len - local) / b.fadeOut : 1);
  return { shape: b.shape, mode: b.mode, radius: b.radius, strength: b.strength, feather: b.feather, invert: b.invert, x: A.x, y: A.y, w: A.w, h: A.h, amount: clamp(amount, 0, 1) };
}

const tidyColor = (c) => { normFilter(c); return c; };
export function normalizeClip(c) {
  return Object.assign({
    id: uid('clip'), kind: 'video', mediaId: null, name: 'Clip', srcDuration: 1, width: 0, height: 0, hasAudio: true,
    in: 0, out: 1, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, fit: 'inherit', bg: 'inherit', opacity: 1, gap: 0,
    transition: { type: 'cut', duration: 0.6 }, keyframes: {},
  }, c, {
    keyframes: c.keyframes || {},
    color: tidyColor(Object.assign(defaultColor(), c.color || {})),
    transform: Object.assign(defaultTransform(), c.transform || {}),
    transition: normTransition(c.transition),
    blur: Object.assign(defaultClipBlur(), c.blur && typeof c.blur === 'object' ? c.blur : {}),
    bgremove: normalizeBgRemove(c.bgremove),
    fx: normFx(c.fx),
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
    id: uid('txt'), name: '', text, start, end: start + dur, x: 0.5, y: 0.82, size: 0.075,
    color: '#ffffff', bg: '#000000', bgOpacity: 0.62, style: 'clean', font: 'sans', align: 'center',
    fadeIn: 0.3, fadeOut: 0.3, maxWidth: 0.86,
    scale: 1, rotation: 0, opacity: 1, anim: { in: 'none', out: 'none', inDur: 0.6, outDur: 0.4, loop: 'none', loopSpeed: 1, hi: '#ffd24a', phase: 0 }, keyframes: {},
  };
}
/** Text animation ids (the library is in textanim.js). Old projects only ever use the first few of each list; unknown ids become 'none'. */
export const TEXT_IN_IDS = ['none', 'fade', 'typewriter', 'slideUp', 'pop', 'wordByWord', 'rise', 'slideLeft', 'slideRight', 'bounce', 'grow', 'blurIn', 'wipe', 'glitch'];
export const TEXT_OUT_IDS = ['none', 'fade', 'slideDown', 'pop', 'typewriter', 'slideUp', 'slideLeft', 'slideRight', 'shrink', 'blurOut', 'wipe', 'glitch', 'wordByWord'];
export const TEXT_LOOP_IDS = ['none', 'pulse', 'float', 'wobble', 'blink', 'karaoke'];
/** A text layer's animation settings with every field present and valid (old saves lack loop / loopSpeed / hi / phase). */
export function cleanTextAnim(a) {
  const d = newText(0).anim, r = Object.assign(d, a || {});
  const n = (v, lo, hi, dv) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dv; };
  if (!TEXT_IN_IDS.includes(r.in)) r.in = 'none'; if (!TEXT_OUT_IDS.includes(r.out)) r.out = 'none'; if (!TEXT_LOOP_IDS.includes(r.loop)) r.loop = 'none';
  r.inDur = n(r.inDur, 0.05, 10, 0.6); r.outDur = n(r.outDur, 0.05, 10, 0.4); r.loopSpeed = n(r.loopSpeed, 0.25, 4, 1); r.phase = n(r.phase, 0, 1e6, 0);
  if (!/^#[0-9a-f]{6}$/i.test(r.hi)) r.hi = '#ffd24a';
  return r;
}
export function newAudio(media, start = 0) {
  return {
    id: uid('aud'), mediaId: media.id, name: (media.name || 'Music').replace(/\.[^/.]+$/, ''), srcDuration: media.duration,
    start, in: 0, out: media.duration, volume: 0.6, muted: false, fadeIn: 1, fadeOut: 2, duck: true, duckLevel: dbToLevel(10), duckDb: 10, duckAttack: DEFAULT_ATTACK, duckRelease: DEFAULT_RELEASE, duckTrigger: 'any', loop: false, voice: false,
    loopLen: 0, // looped length on the timeline in seconds (0 = repeat until the end of the video)
    phase: 0, // looped tracks: offset into the loop at the track start (set when a looped track is split)
    speed: 1, // playback speed (a detached video clip keeps its speed); 1 for ordinary music
    keyframes: {}, // volume envelope: { volume: [{ t, v, ease }] } (t = seconds from the start of the track, v = multiplier of the Volume slider)
  };
}


export function normalizeOverlay(o) {
  return Object.assign({
    id: uid('ovl'), kind: 'video', mediaId: null, name: 'Overlay', srcDuration: 1, width: 16, height: 9, hasAudio: false,
    start: 0, in: 0, out: 1, speed: 1, x: 0.76, y: 0.26, w: 0.36, radius: 0.12, opacity: 1, rotation: 0, scale: 1,
    border: 0, borderColor: '#ffffff', shadow: true, volume: 1, muted: true, fadeIn: 0.25, fadeOut: 0.25,
  }, o, { chroma: Object.assign(defaultChroma(), o.chroma || {}), bgremove: normalizeBgRemove(o.bgremove), keyframes: o.keyframes || {}, fx: normFx(o.fx), color: tidyColor({ preset: 'none', filterAmount: 1, ...(o.color && typeof o.color === 'object' ? { preset: o.color.preset, filterAmount: o.color.filterAmount } : {}) }) });
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
  return byLane((project.overlays || []).filter(o => t >= o.start && t < o.start + overlayLen(o)));
}
export function overlayGain(o, t) {
  if (o.kind !== 'video' || o.muted || !o.hasAudio) return 0;
  const len = overlayLen(o), local = t - o.start;
  if (local < 0 || local > len) return 0;
  // audio follows the overlay's picture fades (with a short de-click ramp when there is no fade)
  const fi = Math.max(0.05, o.fadeIn || 0), fo = Math.max(0.05, o.fadeOut || 0);
  return o.volume * volumeEnv(o, local) * Math.min(clamp(local / fi, 0, 1), clamp((len - local) / fo, 0, 1));
}

// ---------- keyframes ----------
export const EASES = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - Math.pow(1 - p, 3),
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  hold: () => 0,
};
export const MOTION_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'w', 'h'];
export const ANIM_PROPS = [...MOTION_PROPS, 'volume'];
/** The properties a given item type can animate (blur regions animate position and size). */
/** Clips and overlays that have an audio track can also animate their volume (a multiplier of the Volume slider); music/voice tracks animate only that. */

// ---- Clean voice: a per-item setting. The cleaned sound is a derived media file (id from cleanId) made on this device;
// the original file is never touched, and "off" simply plays the original again.
export const CLEAN_LEVELS = ['off', 'light', 'strong'];
export const CLEAN_VERSION = 1; // bump when the cleaning changes so older derived copies are ignored and made again
export const cleanId = (mediaId, level) => 'cln_' + String(mediaId) + '_' + level + '_v' + CLEAN_VERSION;
export const cleanLevelOf = (item) => (item && item.clean && (item.clean.level === 'light' || item.clean.level === 'strong') ? item.clean.level : 'off');
/** Id of the derived (cleaned) media of an item, or null while its Clean voice is off. */
export const cleanTarget = (item) => { const l = cleanLevelOf(item); return l === 'off' || !item.mediaId ? null : cleanId(item.mediaId, l); };
/** Every derived id an item may refer to (kept alive by storage cleanup even while switched off, so switching back is instant). */
export const cleanIdsOf = (item) => (item && item.clean && item.mediaId ? [cleanId(item.mediaId, 'light'), cleanId(item.mediaId, 'strong')] : []);
// ---- Change voice: a per-item setting { pitch, tone, radio } (semitones, semitones of colour, telephone/radio effect). The changed sound is a derived
// media file made from the cleaned copy when Clean voice is on (Clean voice first, then Change voice), else from the original.
export const CHANGE_VERSION = 1;
export const CHANGE_PRESETS = {
  off: { pitch: 0, tone: 0, radio: false },
  deeper: { pitch: -4, tone: -1, radio: false },
  higher: { pitch: 4, tone: 1, radio: false },
  radio: { pitch: 0, tone: 0, radio: true },
};
const q5 = (v, lim) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, Math.round(n * 2) / 2)) : 0; };
export const normChange = (c) => ({ pitch: q5(c && c.pitch, 12), tone: q5(c && c.tone, 6), radio: !!(c && c.radio === true) });
export const changeIsOn = (c) => { const n = normChange(c); return n.pitch !== 0 || n.tone !== 0 || n.radio; };
/** Which preset (off / deeper / higher / radio) the settings are, or 'custom'. */
export const changePresetOf = (c) => { const n = normChange(c); for (const [k, p] of Object.entries(CHANGE_PRESETS)) if (p.pitch === n.pitch && p.tone === n.tone && p.radio === n.radio) return k; return 'custom'; };
export const changeKey = (c) => { const n = normChange(c); return String(Math.round(n.pitch * 2)).replace('-', 'n') + '_' + String(Math.round(n.tone * 2)).replace('-', 'n') + '_' + (n.radio ? 'r' : 'x'); };
export const changeId = (mediaId, cleanLevel, c) => 'chg_' + String(mediaId) + '_' + (cleanLevel === 'light' || cleanLevel === 'strong' ? cleanLevel : 'off') + '_' + changeKey(c) + '_v' + CHANGE_VERSION;
export const changeTarget = (item) => (item && item.change && changeIsOn(item.change) && item.mediaId ? changeId(item.mediaId, cleanLevelOf(item), item.change) : null);
/** Derived ids kept alive by storage cleanup while Change voice is on (any Clean voice level, so switching it keeps the copy). */
export const changeIdsOf = (item) => (item && item.change && changeIsOn(item.change) && item.mediaId ? ['off', 'light', 'strong'].map(l => changeId(item.mediaId, l, item.change)) : []);
/** Derived sounds to play / export instead of the original, best first (changed voice, else cleaned). The caller uses the first one that is stored here. */
export const soundTargets = (item) => [changeTarget(item), cleanTarget(item)].filter(Boolean);
function cleanChange(it) {
  if (!it.change || typeof it.change !== 'object') { delete it.change; return; }
  if (!changeIsOn(it.change)) { delete it.change; return; }
  it.change = normChange(it.change);
}
/** A stored beat record from a file or an undo state: only finite, ascending numbers, a sane tempo; anything else is dropped. */
export function cleanBeat(item) {
  const b = item.beat;
  if (!b || typeof b !== 'object' || !Array.isArray(b.t)) { delete item.beat; return item; }
  const t = []; let prev = -1;
  for (const v of b.t) { const x = +v; if (v !== null && v !== '' && Number.isFinite(x) && x >= 0 && x < 1e6 && x > prev) { t.push(Math.round(x * 1000) / 1000); prev = x; if (t.length >= 100000) break; } }
  if (t.length < 4) { delete item.beat; return item; }
  const num = (v, lo, hi, d) => (v !== null && v !== '' && Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
  item.beat = { on: b.on !== false, bpm: num(b.bpm, 20, 400, 120), conf: num(b.conf, 0, 1, 0.5), from: num(b.from, 0, 1e6, t[0]), to: num(b.to, 0, 1e6, t[t.length - 1]), t };
  return item;
}

function cleanClean(it) {
  if (!it.clean || typeof it.clean !== 'object') { delete it.clean; return; }
  it.clean = { level: CLEAN_LEVELS.includes(it.clean.level) ? it.clean.level : 'off' };
}

export const hasSound = (item) => !!item && item.kind !== 'image' && item.hasAudio !== false;
export const animPropsOf = (type, item) => (type === 'blur' ? ['x', 'y', 'w', 'h'] : type === 'audio' ? ['volume']
  : ['x', 'y', 'scale', 'rotation', 'opacity', ...(item && (type === 'clip' || type === 'overlay') && hasKeyframes(item, 'volume') ? ['volume'] : [])]);

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
  if (prop === 'volume') return 1; // the envelope is a multiplier of the item's Volume slider
  if (type === 'clip') {
    const tr = item.transform || {};
    return prop === 'x' ? tr.x || 0 : prop === 'y' ? tr.y || 0 : prop === 'scale' ? tr.zoom || 1 : prop === 'rotation' ? tr.angle || 0 : item.opacity ?? 1;
  }
  const d = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, w: 0.3, h: 0.3 }[prop];
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
  for (const p of animPropsOf(type, item)) out[p] = kfValue(kf[p], local, animBase(type, item, p));
  return out;
}
export function hasKeyframes(item, prop) {
  const kf = item && item.keyframes; if (!kf) return false;
  return prop ? !!(kf[prop] && kf[prop].length) : ANIM_PROPS.some(p => kf[p] && kf[p].length);
}
/** True when the item has motion keys (position, scale, rotation, opacity, size); volume keys alone don't count. */
export function hasMotion(item) {
  const kf = item && item.keyframes; if (!kf) return false;
  return MOTION_PROPS.some(p => kf[p] && kf[p].length);
}
/** Volume envelope multiplier (1 = the slider's level) at local time `local` seconds from the start of the item. */
export function volumeEnv(item, local) {
  const tr = item && item.keyframes && item.keyframes.volume;
  return tr && tr.length ? Math.max(0, kfValue(tr, local, 1)) : 1;
}
export function setKeyframe(item, prop, local, v, ease) {
  item.keyframes = item.keyframes || {};
  const tr = item.keyframes[prop] = item.keyframes[prop] || [];
  const ex = tr.find(k => Math.abs(k.t - local) < 1 / 120);
  if (ex) { ex.v = v; if (ease) { ex.ease = ease; delete ex.e0; delete ex.e1; } }
  else {
    for (const k of tr) if (k.t < local) { delete k.e0; delete k.e1; } // segment shape changes: drop cut windows before the new key
    tr.push({ t: Math.max(0, local), v, ease: ease || (tr.length ? tr[tr.length - 1].ease : prop === 'volume' ? 'linear' : 'easeInOut') || 'easeInOut' }); tr.sort((a, b) => a.t - b.t); }
}
export function kfTimes(item, withVolume = true) {
  const s = new Set();
  const kf = item && item.keyframes || {};
  for (const p of ANIM_PROPS) if (withVolume || p !== 'volume') for (const k of kf[p] || []) s.add(Math.round(k.t * 1000) / 1000);
  return [...s].sort((a, b) => a - b);
}
export function removeKeyframesAt(item, local, props = ANIM_PROPS) {
  const kf = item.keyframes || {};
  for (const p of props) if (kf[p]) { kf[p] = kf[p].filter(k => Math.abs(k.t - local) > 1 / 120); if (!kf[p].length) delete kf[p]; }
}
export function setEaseAt(item, local, ease, props = ANIM_PROPS) {
  const kf = item.keyframes || {};
  for (const p of props) for (const k of kf[p] || []) if (Math.abs(k.t - local) < 1 / 120) { k.ease = ease; delete k.e0; delete k.e1; }
}

export const clipLen = (c) => Math.max(MIN_CLIP, c.kind === 'image' ? c.out - c.in : c.ramp ? RAMP.lengthOf(c) : (c.out - c.in) / (c.speed || 1));
export const audioSpeed = (a) => a.speed > 0 ? a.speed : 1;
/** Length on the timeline of one pass of an audio track (its trimmed source section divided by its speed). */
export const audioLen = (a) => Math.max(0.05, (a.out - a.in) / audioSpeed(a));
/** Length of an audio track on the timeline: one pass, or (looped) repeated to loopLen / the end of the video. */
export const audioSpan = (a, total) => !a.loop ? audioLen(a) : Math.max(0.05, a.loopLen > 0 ? a.loopLen : (total ?? 0) - a.start);
/** Source position of an audio track at sequence time t (handles looping). */
export function audioSourceTime(a, t) {
  const local = Math.max(0, t - a.start), L = audioLen(a);
  if (!a.loop) return a.in + Math.min(local, L) * audioSpeed(a);
  return a.in + ((local + (a.phase || 0)) % L) * audioSpeed(a);
}
/** Loop seams (sequence times where a looped track jumps back to its in-point). */
export function loopSeams(a, total) {
  if (!a.loop) return [];
  const L = audioLen(a), span = audioSpan(a, total), out = [];
  for (let s = L - ((a.phase || 0) % L); s < span - 1e-3 && out.length < 10000; s += L) if (s > 1e-3) out.push(a.start + s);
  return out;
}

/**
 * Compute timeline placement for clips. The main track keeps its order (a clip never overlaps its neighbour except for a crossfade),
 * but a clip may start later than the previous one ends: `clip.gap` is the empty time before it (black picture, no sound).
 * A gap cancels a crossfade into that clip (there is nothing to blend with).
 */
export function layout(project) {
  const items = []; let t = 0;
  const clips = project.clips;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i], len = clipLen(c), gap = c.gap > 1e-6 ? c.gap : 0;
    let start = t + gap, xIn = 0, fadeIn = 0, xType = 'cut', dipColor = '#000000', xa = 'cross';
    const tr = c.transition || { type: 'cut' };
    if (i > 0 && isOverlap(tr.type) && !gap) {
      const prev = items[i - 1];
      xIn = Math.max(0, effTransition(tr.type, tr.duration, prev.len, len));
      start = prev.end - xIn; xType = tr.type; xa = tr.audio === 'cut' ? 'cut' : 'cross';
    } else if (isDip(tr.type)) {
      const dip = i > 0 && !gap;
      const prevLen = dip ? items[i - 1].len : Infinity;
      fadeIn = Math.max(0, Math.min(tr.duration / (dip ? 2 : 1), len / 2, prevLen / 2));
      dipColor = typeInfo(tr.type).color;
      if (dip) { items[i - 1].fadeOutBlack = fadeIn; items[i - 1].dipColorOut = dipColor; }
    }
    const it = { clip: c, index: i, start, end: start + len, len, xIn, xOut: 0, xType, xaudio: xa, xaudioOut: 'cross', xTypeOut: 'cut', fadeInBlack: fadeIn, fadeOutBlack: 0, dipColor, dipColorOut: '#000000' };
    if (i > 0) { items[i - 1].xOut = xIn; items[i - 1].xTypeOut = xType; items[i - 1].xaudioOut = xa; }
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
  if (c.ramp || c.reverse) return clamp(RAMP.sourceAtOffset(c, t - it.start), c.in, Math.max(c.in, c.out - 0.001));
  return clamp(c.in + (t - it.start) * c.speed, c.in, Math.max(c.in, c.out - 0.001));
}
/** Active clips at time t with their visual alpha (bottom first). */
export function activeAt(lay, t) {
  const out = [];
  for (const it of lay.items) {
    if (t < it.start || t >= it.end) continue;
    let a = 1, tr = null;
    if (it.xIn > 0 && t < it.start + it.xIn) { const p = (t - it.start) / it.xIn; a = p; tr = { role: 'in', type: it.xType, p }; } // transition in (drawn on top)
    else if (it.xOut > 0 && t > it.end - it.xOut) tr = { role: 'out', type: it.xTypeOut, p: 1 - (it.end - t) / it.xOut };
    let black = 1, white = 0, dipOut = false;
    if (it.fadeInBlack > 0 && t < it.start + it.fadeInBlack) black = Math.min(black, (t - it.start) / it.fadeInBlack);
    if (it.fadeOutBlack > 0 && t > it.end - it.fadeOutBlack) { const f = (it.end - t) / it.fadeOutBlack; if (f < black) { black = f; dipOut = true; } }
    // a dip to white is drawn as a white veil over the picture instead of darkening it
    if (black < 1 && (dipOut ? it.dipColorOut : it.dipColor) === '#ffffff') { white = 1 - black; black = 1; }
    out.push({ it, alpha: clamp(a, 0, 1), black: clamp(black, 0, 1), white: clamp(white, 0, 1), tr });
  }
  if (!out.length && lay.items.length && t >= lay.total - 1e-3 && t <= lay.total + 1e-3) {
    const it = lay.items[lay.items.length - 1];
    out.push({ it, alpha: 1, black: it.fadeOutBlack > 0 ? 0 : 1, white: 0, tr: null });
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
  let g = c.volume * volumeEnv(c, local);
  g *= Math.min(ramp(local, c.fadeIn), ramp(rem, c.fadeOut));
  if (it.xIn > 0) g *= soundGain(it.xaudio, local, it.xIn);          // equal-power crossfade (or a hard cut) over a transition
  if (it.xOut > 0) g *= soundGain(it.xaudioOut, rem, it.xOut);
  if (it.fadeInBlack > 0) g *= ramp(local, it.fadeInBlack);
  if (it.fadeOutBlack > 0) g *= ramp(rem, it.fadeOutBlack);
  return g;
}
/** Intervals (sequence time) where `gainOf(t)` stays above the ducking threshold; sampled every 0.1 s only when an envelope is present. */
function audibleIntervals(t0, t1, item, base, thr, gainOf) {
  if (!hasKeyframes(item, 'volume')) return base > thr ? [[t0, t1]] : [];
  const out = []; let open = null;
  for (let t = t0; t <= t1 + 1e-9; t += 0.1) {
    const on = gainOf(Math.min(t, t1)) > thr;
    if (on && open === null) open = Math.min(t, t1);
    if (!on && open !== null) { out.push([open, Math.min(t, t1)]); open = null; }
  }
  if (open !== null) out.push([open, t1]);
  return out;
}
/** Intervals where clip audio is audible (for ducking). */
export function speechIntervals(lay, project, excludeId) {
  const iv = [];
  for (const it of lay.items) {
    const c = it.clip;
    if (c.kind === 'video' && !c.muted && c.hasAudio && c.volume > 0.02) iv.push(...audibleIntervals(it.start, it.end, c, c.volume, 0.02, (t) => c.volume * volumeEnv(c, t - it.start)));
  }
  if (project) {
    for (const o of project.overlays || []) if (o.kind === 'video' && !o.muted && o.hasAudio && o.volume > 0.02) iv.push(...audibleIntervals(o.start, o.start + overlayLen(o), o, o.volume, 0.02, (t) => o.volume * volumeEnv(o, t - o.start)));
    // a voice track drives ducking of OTHER tracks only: never of itself
    for (const a of project.audio || []) if (a.voice && !a.muted && a.volume > 0.02 && a.id !== excludeId) iv.push(...audibleIntervals(a.start, a.start + audioSpan(a, lay.total), a, a.volume, 0.02, (t) => a.volume * volumeEnv(a, t - a.start)));
  }
  // merge
  iv.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const x of iv) { if (m.length && x[0] <= m[m.length - 1][1] + 0.05) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]); else m.push([...x]); }
  return m;
}
export { duckFactor, normalizeDuck }; // from duck.js (attack/release aware)
/** Speech intervals that duck audio track `a` (trigger + VAD/captions aware). `shared` is ignored when the track has its own trigger. */
export function duckIntervalsFor(a, lay, project, shared, peaksOf) {
  normalizeDuck(a);
  // voice tracks never duck under themselves
  if (a.voice && (a.duckTrigger === 'any' || a.duckTrigger === 'voice' || a.duckTrigger === 'detached' || !a.duckTrigger)) {
    return speechForTrack(a, lay, project, { peaksOf, excludeId: a.id });
  }
  if (a.duckTrigger && a.duckTrigger !== 'any') return speechForTrack(a, lay, project, { peaksOf });
  // default "any": prefer the richer speechForTrack (peaks + captions), fall back to the classic audible list
  const rich = speechForTrack(a, lay, project, { peaksOf });
  return rich.length ? rich : (shared || speechIntervals(lay, project));
}
/** Music gain at sequence time t */
export function musicGain(a, t, intervals, total) {
  if (a.muted) return 0;
  const len = audioSpan(a, total);
  if (t < a.start || t > a.start + len) return 0;
  const local = t - a.start, rem = Math.min(a.start + len, total ?? Infinity) - t;
  let g = a.volume * volumeEnv(a, local) * Math.min(ramp(local, a.fadeIn), ramp(rem, a.fadeOut));
  if (a.loop) { // 12 ms dip at each loop seam so the jump back to the in-point doesn't click
    const L = audioLen(a), ph = (local + (a.phase || 0)) % L, d = Math.min(ph, L - ph);
    if (local > 0.02 && rem > 0.02 && L > 0.1) g *= ramp(d, 0.012);
  }
  if (a.duck && intervals) { normalizeDuck(a); g *= duckFactor(intervals, t, a.duckLevel ?? 0.3, { attack: a.duckAttack, release: a.duckRelease }); }
  return Math.max(0, g);
}

/** Effective color = global sliders + clip sliders + the global and clip filters (each at its own intensity) */
export function effectiveColor(project, clip) {
  const g = project.color || defaultColor(), c = clip?.color || defaultColor();
  const fg = filterParams(g.preset, amountOf(g)), fc = filterParams(c.preset, amountOf(c));
  const out = {};
  for (const k of COLOR_KEYS) out[k] = (g[k] || 0) + (c[k] || 0) + fg[k] + fc[k];
  out.saturation = clamp(out.saturation, -100, 150);
  out.vignette = clamp(out.vignette, 0, 100);
  out.sepia = clamp(out.sepia, 0, 100);
  out.fade = clamp(out.fade, 0, 100);
  out.brightness = clamp(out.brightness, -100, 100);
  out.contrast = clamp(out.contrast, -100, 100);
  out.temperature = clamp(out.temperature, -100, 100);
  out.gamma = clamp(fg.gamma * fc.gamma, 0.5, 2);
  out.curve = clamp(fg.curve + fc.curve, 0, 1);
  out.ts = fc.ts[3] > 0 ? fc.ts : fg.ts; // the clip's own tint wins over the project's
  out.th = fc.th[3] > 0 ? fc.th : fg.th;
  return out;
}
export const colorIsNeutral = (c) => !c.brightness && !c.contrast && !c.saturation && !c.temperature && !c.vignette && !c.sepia && !c.fade && (c.gamma ?? 1) === 1 && !c.curve && !(c.ts && c.ts[3]) && !(c.th && c.th[3]);

/** Thumbnail formats: widescreen (1280x720), vertical for Shorts (1080x1920) and square. */
export const THUMB_FORMATS = {
  '16:9': { key: '16:9', label: 'Widescreen 16:9', short: 'widescreen', width: 1280, height: 720 },
  '9:16': { key: '9:16', label: 'Vertical 9:16 (Shorts)', short: 'shorts', width: 1080, height: 1920 },
  '1:1': { key: '1:1', label: 'Square 1:1', short: 'square', width: 1080, height: 1080 },
};
/** The thumbnail format for a choice ('auto' follows the project's aspect ratio). */
export function thumbFormat(project, choice) {
  let k = choice || (project.thumb && project.thumb.format) || 'auto';
  if (!THUMB_FORMATS[k]) {
    const r = project.settings.ratio;
    if (r === '9:16') k = '9:16';
    else if (r === '1:1' || r === '4:5') k = '1:1';
    else if (r === 'original') {
      const first = project.clips.find(c => c.width && c.height), a = first ? first.width / first.height : 16 / 9;
      k = a < 0.8 ? '9:16' : a < 1.25 ? '1:1' : '16:9';
    } else k = '16:9';
  }
  return THUMB_FORMATS[k];
}

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
  if (texts) for (const b of project.blurs || []) if (b.start >= from - 1e-6) { b.start = Math.max(0, b.start + delta); b.end = Math.max(b.start + 0.1, b.end + delta); }
  if (texts) for (const c of project.captions || []) if (c.start >= from - 1e-6) { c.start = Math.max(0, c.start + delta); c.end = Math.max(c.start + 0.05, c.end + delta); if (c.words) c.words = c.words.map(w => ({ ...w, start: Math.max(0, w.start + delta), end: Math.max(0, w.end + delta) })); }
  if (texts) for (const t of project.texts) if (t.start >= from - 1e-6) { t.start = Math.max(0, t.start + delta); t.end = Math.max(t.start + 0.1, t.end + delta); }
  if (audio) for (const a of project.audio) if (a.start >= from - 1e-6) a.start = Math.max(0, a.start + delta);
  if (audio) for (const o of project.overlays || []) if (o.start >= from - 1e-6) o.start = Math.max(0, o.start + delta);
  if (markers) for (const m of project.markers) if (m.time >= from - 1e-6) m.time = Math.max(0, m.time + delta);
}

export function splitAt(project, t, minLen = MIN_CLIP) {
  const lay = layout(project);
  const it = clipAt(lay, t);
  if (!it) return null;
  const c = it.clip;
  const local = t - it.start;
  if (local < minLen || it.end - t < minLen) return null;
  const b = deepClone(c);
  b.id = uid('clip'); b.gap = 0; // the second half follows the first directly
  b.transition = { type: 'cut', duration: c.transition.duration };
  if (c.kind === 'image') {
    b.in = c.in + local; b.out = c.out; c.out = c.in + local; // image in-point = animation (GIF) time offset
  } else {
    const s = c.ramp || c.reverse ? RAMP.sourceAtOffset(c, local) : c.in + local * c.speed;
    if (c.reverse) { c.in = s; b.out = s; } // reversed: the first part on the timeline is the END of the footage
    else { c.out = s; b.in = s; }
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
    a.anim = { ...(a.anim || {}), out: 'none' }; b.anim = { ...(b.anim || {}), in: 'none', phase: (a.anim && a.anim.phase || 0) + u };
    project.texts.push(b);
    return { type: 'text', item: b };
  }
  if (sel.type === 'caption') {
    const a = (project.captions || []).find(x => x.id === sel.id); if (!a) return fail('Nothing to split.');
    const parts = splitCaption(a, t);
    if (!parts) return fail('Move the playhead inside the selected caption (not at its edge) to split it.');
    const i = project.captions.indexOf(a); project.captions.splice(i, 1, parts[0], parts[1]);
    return { type: 'caption', item: parts[1] };
  }
  if (sel.type === 'blur') {
    const a = (project.blurs || []).find(x => x.id === sel.id); if (!a) return fail('Nothing to split.');
    const u = t - a.start;
    if (u < MIN_CLIP || a.end - t < MIN_CLIP) return fail('Move the playhead inside the selected blur region (not at its edge) to split it.');
    const b = deepClone(a); b.id = uid('blr');
    const kf = a.keyframes || {};
    a.keyframes = rebaseKeyframes(kf, 0, u); b.keyframes = rebaseKeyframes(kf, u);
    a.end = t; b.start = t; a.fadeOut = 0; b.fadeIn = 0;
    project.blurs.splice(project.blurs.indexOf(a) + 1, 0, b);
    return { type: 'blur', item: b };
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
      a.out = a.in + u * audioSpeed(a); b.in = a.out;
    }
    a.fadeOut = 0; b.fadeIn = 0;
    const kf = a.keyframes || {}; // the volume envelope continues seamlessly across the cut
    a.keyframes = rebaseKeyframes(kf, 0, u); b.keyframes = rebaseKeyframes(kf, u);
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
  return fail('Markers can’t be split. Select a clip, text, overlay, caption, blur region or audio track.');
}

/**
 * Detach audio: a new audio-track item carrying the audio of a main clip or a video overlay with the same start, in-point, length,
 * speed, volume, fades and volume envelope, and the original is muted. After that they are independent (no link kept). Returns
 * { audio } or { fail, reason }. Nothing is changed when it fails. The new track is flagged as a voice track so music keeps ducking under it.
 */
/**
 * Match audio: plan (no changes) for making a main-track image clip end where the relevant audio ends.
 * `sel` is the selection ({type:'clip'} for an image, or {type:'audio'} for a track that starts over a main-track image).
 * Returns { fail, reason } or { clip, item, audio, len, oldLen, end, capped }.
 * Audio choice: a track that overlaps the image's start, or starts within 0.5 s after it (a voice or detached track beats music, then the closest start wins); otherwise the unmuted track that ends last. A looped track without a set length repeats to the
 * end of the video, so it has no end of its own and is never used. `len` is rounded up to a whole frame so the picture covers the sound.
 */
export function planMatchAudio(project, sel) {
  const fail = (reason) => ({ fail: true, reason });
  const lay = layout(project), fps = project.settings?.fps || 30, total = lay.total;
  const aud = project.audio || [];
  const OPEN = (a) => 'Looped track “' + a.name + '” repeats until the video ends, so it has no end to match. Set its length in the Audio tab (or turn Loop off), then tap Match audio.';
  let it = null, pinned = null;
  if (!sel) return fail('Nothing selected. Tap an image clip on the timeline first, then tap Match audio.');
  if (sel.type === 'clip') {
    it = lay.items.find(i => i.clip.id === sel.id);
    if (!it) return fail('Nothing selected. Tap an image clip on the timeline first, then tap Match audio.');
    if (it.clip.kind !== 'image') return fail('A video clip can’t be stretched to fit the audio: its length is the length of the footage. Change its Speed in the Clip tab, or select an image clip and tap Match audio.');
  } else if (sel.type === 'audio') {
    pinned = aud.find(a => a.id === sel.id);
    if (!pinned) return fail('Nothing selected. Tap an image clip on the timeline first, then tap Match audio.');
    for (const i of lay.items) if (pinned.start >= i.start - 1e-3 && pinned.start < i.end - 1e-3) it = i;
    if (!it) return fail('This audio doesn’t start over a clip. Select an image clip (or a track that starts over one), then tap Match audio.');
    if (it.clip.kind !== 'image') return fail('The clip under the start of this audio is a video, not an image. Select an image clip, then tap Match audio.');
  } else return fail('Match audio works on an image clip. Tap an image on the timeline first (or a music/voice track that starts over one), then tap Match audio.');
  const c = it.clip, cs = it.start;
  const span = (a) => (a.loop && !(a.loopLen > 0)) ? null : audioSpan(a, total);
  const info = (a) => { const sp = span(a); return { a, start: a.start, end: sp == null ? null : a.start + sp }; };
  let chosen;
  if (pinned) {
    const x = info(pinned);
    if (x.end == null) return fail(OPEN(pinned));
    if (x.end <= cs + MIN_CLIP) return fail('This audio ends before the image starts, so there is nothing to match.');
    chosen = x;
  } else {
    if (!aud.length) return fail('There is no music, voice or detached audio on the timeline yet. Add some in the Audio tab, then tap Match audio.');
    const live = aud.filter(a => !a.muted);
    if (!live.length) return fail('All audio tracks are muted, so there is no sound to match. Unmute one in the Audio tab first.');
    const all = live.map(info), open = all.filter(x => x.end == null);
    const valid = all.filter(x => x.end != null && x.end > cs + MIN_CLIP);
    if (!valid.length) return fail(open.length ? OPEN(open[0].a) : 'The audio on the timeline ends before this image starts, so there is nothing to match.');
    const rel = valid.filter(x => (x.start <= cs + 0.05 && x.end > cs + 0.05) || (x.start > cs + 0.05 && x.start <= cs + 0.5));
    if (rel.length) rel.sort((p, q) => (q.a.voice ? 1 : 0) - (p.a.voice ? 1 : 0) || Math.abs(p.start - cs) - Math.abs(q.start - cs) || q.end - p.end);
    else valid.sort((p, q) => q.end - p.end);
    chosen = (rel.length ? rel : valid)[0];
  }
  let len = Math.max(MIN_CLIP, Math.ceil((chosen.end - cs) * fps - 1e-3) / fps);
  const cap = Math.max(MIN_CLIP, (c.srcDuration || 3600) - (c.in || 0)); let capped = false;
  if (len > cap) { len = cap; capped = true; }
  return { clip: c, item: it, audio: chosen.a, len, oldLen: it.len, end: cs + len, capped };
}
export function detachAudio(project, sel) {
  const fail = (reason) => ({ fail: true, reason });
  let src, start, fadeIn, fadeOut, speed, vol;
  if (sel && sel.type === 'overlay') {
    src = (project.overlays || []).find(x => x.id === sel.id); if (!src) return fail('Nothing selected to detach.');
    start = src.start; speed = src.speed || 1; vol = src.volume;
    fadeIn = Math.max(0.05, src.fadeIn || 0); fadeOut = Math.max(0.05, src.fadeOut || 0); // overlay audio always follows its picture fades
  } else {
    const it = sel && layout(project).items.find(i => i.clip.id === sel.id);
    if (!it) return fail('Select a video clip first, then tap Detach audio.');
    src = it.clip; start = it.start; speed = src.speed || 1; vol = src.volume;
    fadeIn = Math.max(src.fadeIn || 0, it.xIn || 0, it.fadeInBlack || 0); fadeOut = Math.max(src.fadeOut || 0, it.xOut || 0, it.fadeOutBlack || 0); // picture transitions become audio fades
  }
  if (src.kind !== 'video') return fail('Only video clips have audio to detach.');
  if (src.hasAudio === false) return fail('This video has no audio, so there is nothing to detach.');
  if (src.ramp || src.reverse) return fail('Detach audio is not available on a clip with a speed curve or Reverse (the detached sound would play at a constant speed). Switch to a constant speed first.');
  if (src.muted && sel.type !== 'overlay') return fail('This clip is muted (its audio may already be detached). Unmute it first if you want to detach its audio again.');
  if ((project.audio || []).some(x => x.mediaId === src.mediaId && Math.abs(x.start - start) < 0.002 && Math.abs(x.in - src.in) < 0.002 && Math.abs(x.out - src.out) < 0.002)) return fail('This audio is already detached (see the Audio tab).');
  const a = newAudio({ id: src.mediaId, duration: src.srcDuration, name: src.name }, start);
  Object.assign(a, {
    name: ((src.name || 'Video') + ' (audio)').slice(0, NAME_MAX), in: src.in, out: src.out, srcDuration: src.srcDuration, speed, volume: vol, muted: false,
    fadeIn, fadeOut, duck: false, loop: false, voice: true, keyframes: {},
  });
  if (src.change) a.change = deepClone(src.change);
  if (src.clean) a.clean = deepClone(src.clean); // the detached sound keeps the cleaning of the picture it came from
  if (hasKeyframes(src, 'volume')) a.keyframes.volume = deepClone(src.keyframes.volume);
  project.audio.push(a);
  src.muted = true;
  return { audio: a };
}

/** A transition belongs to one join (this clip after that clip). When a clip's neighbour before it changes (delete, reorder), the transition is removed. */
const joinsOf = (project) => new Map(project.clips.map((c, i) => [c.id, i ? project.clips[i - 1].id : null]));
function dropBrokenJoins(project, before) {
  project.clips.forEach((c, i) => {
    if (before.get(c.id) !== (i ? project.clips[i - 1].id : null) && c.transition.type !== 'cut') c.transition = { type: 'cut', duration: c.transition.duration };
  });
}

export function removeClip(project, id, ripple) {
  const lay = layout(project), joins = joinsOf(project);
  const it = lay.items.find(x => x.clip.id === id);
  if (!it) return;
  const next = lay.items[it.index + 1], prevEnd = it.index > 0 ? lay.items[it.index - 1].end : 0;
  project.clips.splice(it.index, 1);
  dropBrokenJoins(project, joins);
  if (ripple) { rippleShift(project, it.end - 1e-3, layout(project).total - lay.total); }
  else if (next) next.clip.gap = Math.max(0, round3(next.start - prevEnd)); // not rippling: what follows stays where it is (the hole stays empty)
}
export function duplicateClip(project, id, ripple) {
  const lay = layout(project);
  const it = lay.items.find(x => x.clip.id === id);
  if (!it) return null;
  const b = deepClone(it.clip); b.id = uid('clip'); b.gap = 0; b.transition = { type: 'cut', duration: b.transition.duration };
  project.clips.splice(it.index + 1, 0, b);
  if (ripple) rippleShift(project, it.end - 1e-3, layout(project).total - lay.total);
  return b;
}
export function moveClip(project, from, to) {
  if (from === to || from < 0 || from >= project.clips.length) return;
  const joins = joinsOf(project);
  const [c] = project.clips.splice(from, 1);
  c.gap = 0;
  project.clips.splice(clamp(to, 0, project.clips.length), 0, c);
  dropBrokenJoins(project, joins);
}


// ---------- free placement: one stack of lanes for every kind of item, and gaps on the main sequence ----------
const round3 = (v) => Math.round(v * 1000) / 1000;
const EPS = 1e-3;
/**
 * Every item of the timeline (main clips, overlays, text, blur regions, music/voice, captions) sits on a `lane`: an integer, 0 = the
 * bottom lane. Lanes are generic: any kind of item can be on any lane, and lanes only exist while an item is on them. A higher lane is
 * drawn on top in the preview and the export (audio from every lane is mixed). Markers belong to the ruler, not to a lane.
 * RANK is only used to choose a lane for something that has none yet (it goes where the old fixed tracks used to be) and to convert
 * projects saved before lanes were shared: picture < overlays < blur < text < captions, with sound below everything.
 */
export const ITEM_KINDS = ['audio', 'clip', 'overlay', 'blur', 'text', 'caption'];
const RANK = { audio: 0, clip: 1, overlay: 2, blur: 3, text: 4, caption: 5 };
export const listOf = (project, kind) => (kind === 'clip' ? project.clips : kind === 'overlay' ? project.overlays : kind === 'text' ? project.texts : kind === 'blur' ? project.blurs : kind === 'audio' ? project.audio : kind === 'caption' ? project.captions : null) || [];
export const laneOf = (it) => (Number.isInteger(it.lane) && it.lane >= 0 ? it.lane : 0);
const hasLane = (it) => Number.isInteger(it.lane) && it.lane >= 0;
/** Spans (start/end on the timeline) of all items, computed once per call: `span(kind, item)`. */
export function spanCtx(project) {
  const lay = layout(project), cs = new Map(lay.items.map(i => [i.clip, [i.start, i.end]]));
  return { lay, total: lay.total, span: (kind, it) => (kind === 'clip' ? cs.get(it) || [0, 0] : laneSpan(kind, it, lay.total)) };
}
/** [start, end] on the timeline of a lane item (not main clips: those come from layout). */
export function laneSpan(kind, it, total) {
  if (kind === 'overlay') return [it.start, it.start + overlayLen(it)];
  if (kind === 'audio') return [it.start, it.start + audioSpan(it, total)];
  return [it.start, it.end];
}
/** Items in stacking order: lower lanes first (drawn first, so higher lanes end up on top); same lane keeps list order. */
export function byLane(list) {
  if (!list.some(x => laneOf(x))) return list;
  return list.map((x, i) => [x, i]).sort((a, b) => laneOf(a[0]) - laneOf(b[0]) || a[1] - b[1]).map(a => a[0]);
}
export function allItems(project, ctx = spanCtx(project)) {
  const out = [];
  for (const kind of ITEM_KINDS) for (const item of listOf(project, kind)) out.push({ kind, item, span: ctx.span(kind, item) });
  return out;
}
const overlaps = (a, b) => a[0] < b[1] - EPS && b[0] < a[1] - EPS;
/** Open a new, empty lane at index `at` (items at `at` and above move up one). */
export function insertLane(project, at) { for (const k of ITEM_KINDS) for (const it of listOf(project, k)) if (hasLane(it) && it.lane >= at) it.lane += 1; }
export const laneCount = (project) => ITEM_KINDS.reduce((n, k) => listOf(project, k).reduce((m, it) => Math.max(m, laneOf(it) + 1), n), 0);
/** Lanes used before lanes were shared by all kinds (one set of lanes per kind): stack them in the order the kinds used to be drawn. */
function legacyLanes(project) {
  const total = layout(project).total;
  const perKind = (kind, list, span) => {
    if (!list.length) return 0;
    const sp = new Map(list.map(it => [it, span(it)]));
    const placed = list.filter(hasLane);
    for (const it of list) {
      if (hasLane(it)) continue;
      let l = 0; for (const o of placed) if (overlaps(sp.get(it), sp.get(o))) l = Math.max(l, laneOf(o) + 1);
      it.lane = l; placed.push(it);
    }
    const byStart = [...list].sort((a, b) => laneOf(a) - laneOf(b) || sp.get(a)[0] - sp.get(b)[0]), done = new Set();
    for (const it of byStart) {
      const own = laneOf(it);
      const fits = (l) => !list.some(o => o !== it && laneOf(o) === l && (l !== own || done.has(o)) && overlaps(sp.get(it), sp.get(o)));
      if (!fits(own)) { let l = own + 1; while (!fits(l)) l++; it.lane = l; }
      done.add(it);
    }
    const used = [...new Set(list.map(laneOf))].sort((a, b) => a - b);
    for (const it of list) it.lane = used.indexOf(laneOf(it));
    return used.length;
  };
  let base = 0;
  for (const kind of ITEM_KINDS) {
    const list = listOf(project, kind);
    const n = kind === 'clip' ? (list.length ? 1 : 0) : perKind(kind, list, (it) => laneSpan(kind, it, total));
    if (kind === 'clip') for (const c of list) c.lane = 0;
    for (const it of list) it.lane += base;
    base += n;
  }
}
/**
 * Give every item a lane and keep the lanes tidy. Items without a lane (just added, or a project from before lanes) go to a free lane
 * that holds the same kind of item, else to a new lane where that kind used to sit (sound at the bottom, pictures above it, captions
 * on top). Two items that overlap inside one lane (after a trim, a ripple or a typed time) are separated: the later one gets a new
 * lane just above. Main clips never push each other (a crossfade overlaps by design). Empty lanes are closed up.
 * Returns true if anything changed.
 */
export function ensureLanes(project) {
  let changed = false;
  if (project.laneModel !== 2) { legacyLanes(project); project.laneModel = 2; changed = true; }
  const ctx = spanCtx(project), items = allItems(project, ctx);
  // 1. items without a lane
  for (const x of items) {
    if (hasLane(x.item)) continue;
    const placed = items.filter(y => hasLane(y.item));
    const lanes = [...new Set(placed.map(y => y.item.lane))].sort((a, b) => a - b);
    let pick = lanes.find(l => placed.every(y => y.item.lane !== l || (y.kind === x.kind && (x.kind === 'clip' || !overlaps(y.span, x.span)))) && placed.some(y => y.item.lane === l));
    if (pick === undefined) {
      let at = 0;
      if (x.kind !== 'audio') for (const y of placed) if (RANK[y.kind] <= RANK[x.kind]) at = Math.max(at, y.item.lane + 1);
      insertLane(project, at); pick = at;
    }
    x.item.lane = pick; changed = true;
  }
  // 2. overlaps inside one lane
  for (let round = 0; round < 40; round++) {
    const byL = new Map();
    for (const x of items) { const l = x.item.lane; if (!byL.has(l)) byL.set(l, []); byL.get(l).push(x); }
    let moved = false;
    for (const l of [...byL.keys()].sort((a, b) => a - b).reverse()) {
      const list = byL.get(l).sort((a, b) => a.span[0] - b.span[0] || (a.kind === 'clip' ? -1 : 0) - (b.kind === 'clip' ? -1 : 0));
      const movers = []; let last = null;
      for (const x of list) {
        if (last && x.span[0] < last.span[1] - EPS && !(x.kind === 'clip' && last.kind === 'clip')) {
          // keep the main clip where it is; otherwise the later one moves up
          if (last.kind === 'clip' || x.kind !== 'clip') movers.push(x); else { movers.push(last); last = x; }
        } else if (!last || x.span[1] > last.span[1]) last = x;
      }
      if (movers.length) { insertLane(project, l + 1); for (const x of movers) x.item.lane = l + 1; moved = true; changed = true; break; }
    }
    if (!moved) break;
  }
  // 3. close up empty lanes
  const used = [...new Set(items.map(x => x.item.lane))].sort((a, b) => a - b);
  if (used.some((l, i) => l !== i)) { for (const x of items) x.item.lane = used.indexOf(x.item.lane); changed = true; }
  return changed;
}
/** The nearest start to `desired` where an item of length `len` fits between `spans` (sorted or not). Returns { start, dist }. */
export function nearestFree(spans, len, desired) {
  const want = Math.max(0, desired);
  const fits = (s) => s >= -1e-9 && spans.every(o => s + len <= o[0] + EPS || s >= o[1] - EPS);
  let best = null;
  for (const c of [want, 0, ...spans.map(o => o[1]), ...spans.map(o => o[0] - len)]) {
    if (!fits(c)) continue;
    const d = Math.abs(c - want);
    if (!best || d < best.dist - 1e-9) best = { start: Math.max(0, c), dist: d };
  }
  return best || { start: want, dist: 0 };
}
/** The item {kind,item} lookup by id across every list. */
export function findItem(project, id) {
  for (const kind of ITEM_KINDS) { const item = listOf(project, kind).find(x => x.id === id); if (item) return { kind, item }; }
  return null;
}
/**
 * Where would this item land if dropped at `start` on `lane`? `lane` is an existing lane number or { newAt: n } (a new lane opened at n).
 * Never overlaps inside a lane (CapCut): the item takes the nearest free spot of the lane when that is close (half its length, at least
 * half a second), otherwise it gets a new lane just above. Captions also never overlap each other in time (there is one caption
 * line on screen). A main clip that would sit over another main clip is `stack`ed: it becomes a full-frame layer.
 * Returns { lane, newAt, start, pushed, stack }.
 */
export function planItem(project, kind, item, start, lane, ctx = spanCtx(project)) {
  const [s0, e0] = ctx.span(kind, item), len = e0 - s0;
  const others = (l) => {
    const sp = [];
    for (const k of ITEM_KINDS) for (const o of listOf(project, k)) {
      if (o === item) continue;
      if (laneOf(o) === l || (kind === 'caption' && k === 'caption')) sp.push(ctx.span(k, o));
    }
    return sp;
  };
  let plan;
  if (lane && typeof lane === 'object') {
    const sp = others(-1), spot = kind === 'caption' ? nearestFree(sp, len, start) : { start: Math.max(0, start) };
    plan = { lane: lane.newAt, newAt: lane.newAt, start: spot.start, pushed: false };
  } else {
    const spot = nearestFree(others(lane), len, start);
    plan = spot.dist <= Math.max(len / 2, 0.5) + 1e-9
      ? { lane, newAt: null, start: spot.start, pushed: false }
      : { lane: lane + 1, newAt: lane + 1, start: kind === 'caption' ? nearestFree(others(-1), len, start).start : Math.max(0, start), pushed: true };
  }
  plan.stack = kind === 'clip' && ctx.lay.items.some(i => i.clip !== item && overlaps([plan.start, plan.start + len], [i.start, i.end]));
  return plan;
}
/** Move any item to `start` on `lane` (see planItem). A main clip over another main clip becomes a layer. Returns the plan (+ `item`, the item now on the timeline). */
export function placeItem(project, kind, item, start, lane, opts = {}) {
  const plan = planItem(project, kind, item, start, lane);
  if (plan.newAt != null) insertLane(project, plan.newAt);
  plan.item = item; plan.kind = kind;
  if (kind === 'clip') {
    if (plan.stack) {
      const o = clipToOverlay(project, item.id, opts.ripple, plan.start); o.lane = plan.lane; plan.item = o; plan.kind = 'overlay';
    } else { item.lane = plan.lane; setClipStart(project, item.id, plan.start); }
  } else { setItemStart(kind, item, plan.start); item.lane = plan.lane; }
  ensureLanes(project);
  return plan;
}
/** Set where a non-clip item starts (texts, blurs and captions keep their length; caption words move along). */
export function setItemStart(kind, item, start) {
  start = Math.max(0, start);
  if (kind === 'text' || kind === 'blur' || kind === 'caption') {
    const len = item.end - item.start, d = start - item.start; item.start = start; item.end = start + len;
    if (kind === 'caption' && item.words) for (const w of item.words) { w.start += d; w.end += d; }
  } else item.start = start;
}

/**
 * Free move of a main-track clip (used when Ripple is off): the clip goes to the nearest free spot of the track (never over another
 * clip), the clips keep their own positions, and the order of the track follows the new positions. Gaps are stored in `clip.gap`.
 * Returns the start it actually got, or null.
 */
export function moveClipTo(project, id, desired) {
  const lay = layout(project), it = lay.items.find(i => i.clip.id === id);
  if (!it) return null;
  const others = lay.items.filter(i => i !== it).map(i => [i.start, i.end]).sort((a, b) => a[0] - b[0]);
  return setClipStart(project, id, nearestFree(others, it.len, desired).start);
}
/** Put a main clip exactly at `start` (order and gaps follow; the caller made sure it does not run into another clip). */
export function setClipStart(project, id, start) {
  const lay = layout(project), it = lay.items.find(i => i.clip.id === id);
  if (!it) return null;
  const entries = lay.items.map(i => ({ clip: i.clip, start: i.clip === it.clip ? start : i.start, prev: i.index ? lay.items[i.index - 1].clip : null }));
  arrangeMain(project, entries);
  return round3(start);
}
/** Rewrite order and gaps of the main track from absolute start times. A clip whose neighbour changed loses its crossfade / dip (it would shift it). */
export function arrangeMain(project, entries) {
  entries.sort((a, b) => a.start - b.start || project.clips.indexOf(a.clip) - project.clips.indexOf(b.clip));
  let prevEnd = 0, prevClip = null;
  for (const e of entries) {
    const c = e.clip, len = clipLen(c);
    const sameNeighbour = e.prev !== undefined && e.prev === prevClip && c.transition && isOverlap(c.transition.type);
    if (sameNeighbour && e.start < prevEnd - 1e-6) c.gap = 0;
    else {
      c.gap = Math.max(0, round3(e.start - prevEnd));
      if (c.gap < 1e-6 && e.prev !== prevClip && c.transition && c.transition.type !== 'cut' && e.prev !== undefined) c.transition = { ...c.transition, type: 'cut' };
    }
    prevEnd = e.start + len; prevClip = c;
  }
  project.clips = entries.map(e => e.clip);
}
/**
 * Not rippling: after main clip `id` changed length (lay0 = layout before), the clip after it stays where it was: the gap between them
 * grows or shrinks. It is pushed along only when the clip now reaches it (no gap left).
 */
export function holdNextClip(project, id, lay0) {
  const i = project.clips.findIndex(c => c.id === id), next = project.clips[i + 1], n0 = lay0.items[i + 1];
  if (!next || !n0) return;
  const want = n0.start - layout(project).items[i].end;
  next.gap = want > 1e-3 ? round3(want) : 0;
}
const volumeOnly = (item) => { const k = {}; if (item.keyframes && item.keyframes.volume) k.volume = deepClone(item.keyframes.volume); return k; };
/**
 * A main clip that is dropped over another main clip becomes a layer on top of it: an overlay that covers the frame the way the clip did
 * (same time, source range, speed, volume, mute, opacity and fades). Transitions, colour grade, motion keyframes and fit do not carry over.
 * `ripple` closes the hole it leaves on the main sequence. Returns the overlay.
 */
export function clipToOverlay(project, id, ripple, start) {
  const it = layout(project).items.find(i => i.clip.id === id); if (!it) return null;
  const c = it.clip, { width: W, height: H } = outputDims(project);
  const aspect = c.width > 0 && c.height > 0 ? c.width / c.height : W / H;
  const o = normalizeOverlay({
    kind: c.kind, mediaId: c.mediaId, name: c.name, srcDuration: c.srcDuration, width: c.width, height: c.height, hasAudio: c.hasAudio,
    start: start ?? it.start, in: c.in, out: c.out, speed: c.ramp || c.reverse ? clamp(RAMP.meanSpeed(c), 0.25, 4) : c.speed, volume: c.volume, muted: c.muted, opacity: c.opacity, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    x: 0.5, y: 0.5, w: Math.min(1, H * aspect / W), radius: 0, shadow: false, keyframes: volumeOnly(c),
  });
  o.fx = normFx(c.fx); if (c.color) { o.color = tidyColor({ preset: c.color.preset, filterAmount: c.color.filterAmount }); }
  if (c.change) o.change = deepClone(c.change);
  if (c.clean) o.clean = deepClone(c.clean);
  removeClip(project, id, ripple);
  if (!project.overlays) project.overlays = [];
  project.overlays.push(o);
  return o;
}

// ---------- History (snapshot based) ----------
export const MERGE_MS = 1000;
export class History {
  constructor(limit = 120) { this.limit = limit; this.undoStack = []; this.redoStack = []; this.current = null; }
  reset(project) { this.undoStack = []; this.redoStack = []; this.current = JSON.stringify(project); this.mergeKey = null; }
  /** Record a new state after a mutation. */
  commit(project, mergeKey) {
    const s = JSON.stringify(project);
    if (s === this.current) return false;
    // Repeated edits with the same key within MERGE_MS of each other (e.g. a burst of Volume up taps) are ONE undo step.
    const now = Date.now();
    if (mergeKey && this.mergeKey === mergeKey && now - this.mergeAt <= MERGE_MS && this.undoStack.length) {
      this.current = s; this.redoStack = []; this.mergeAt = now;
      return true;
    }
    this.mergeKey = mergeKey || null; this.mergeAt = now;
    if (this.current != null) this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    // captions for an hour-long video make each snapshot large: also bound the total memory (~80 MB of JSON)
    for (let n = this.undoStack.reduce((a, x) => a + x.length, 0); n > 80e6 && this.undoStack.length > 5; n -= (this.undoStack.shift() || '').length);
    this.current = s; this.redoStack = [];
    return true;
  }
  undo() { this.mergeKey = null; if (!this.undoStack.length) return null; this.redoStack.push(this.current); this.current = this.undoStack.pop(); return JSON.parse(this.current); }
  redo() { this.mergeKey = null; if (!this.redoStack.length) return null; this.undoStack.push(this.current); this.current = this.redoStack.pop(); return JSON.parse(this.current); }
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

/**
 * Base-volume step (the Volume slider, not keyframes). `level` and `max` are multipliers (1 = 100%), `dir` is +1 / -1,
 * `fine` uses 1-point steps instead of 10. Works in whole percentage points so repeated taps never drift.
 * Returns { level, atLimit } where atLimit is true when the level could not move (already at 0 or at max).
 */
export function stepVolume(level, dir, { fine = false, max = 2 } = {}) {
  const cur = Math.round((Number.isFinite(level) ? level : 1) * 100), top = Math.round(max * 100);
  const next = Math.min(top, Math.max(0, cur + (dir < 0 ? -1 : 1) * (fine ? 1 : 10)));
  return { level: next / 100, atLimit: next === Math.min(top, Math.max(0, cur)) };
}
