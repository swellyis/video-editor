// Text & title animations: the catalogue shown in the Text tab's library, the maths for the new motions, "apply to all", and the ready-made
// sermon text templates. Pure (no DOM) so it is unit-tested; render.js drawText() does the drawing for preview, MP4 and WebM alike.
import { newText, cleanTextAnim } from './model.js';

const EO = (p) => 1 - Math.pow(1 - p, 3);
const bounceOut = (x) => { const n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75; if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375; return n * (x -= 2.625 / d) * x + 0.984375; };
/** Same pseudo-random number for the same step, everywhere (preview and export must agree). */
export const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// groups give the grid its headings; `old` marks ids that existed before this library (they render exactly as before)
export const ANIMS = [
  { kind: 'in', id: 'fade', group: 'Fade', label: 'Fade', old: 1 },
  { kind: 'in', id: 'blurIn', group: 'Fade', label: 'Blur in' },
  { kind: 'in', id: 'slideUp', group: 'Move', label: 'Slide up', old: 1 },
  { kind: 'in', id: 'rise', group: 'Move', label: 'Rise' },
  { kind: 'in', id: 'slideLeft', group: 'Move', label: 'From right' },
  { kind: 'in', id: 'slideRight', group: 'Move', label: 'From left' },
  { kind: 'in', id: 'bounce', group: 'Move', label: 'Bounce' },
  { kind: 'in', id: 'pop', group: 'Scale', label: 'Pop', old: 1 },
  { kind: 'in', id: 'grow', group: 'Scale', label: 'Grow' },
  { kind: 'in', id: 'typewriter', group: 'Text', label: 'Typewriter', old: 1 },
  { kind: 'in', id: 'wordByWord', group: 'Text', label: 'Word by word', old: 1 },
  { kind: 'in', id: 'wipe', group: 'Text', label: 'Wipe reveal' },
  { kind: 'in', id: 'glitch', group: 'Text', label: 'Glitch' },
  { kind: 'out', id: 'fade', group: 'Fade', label: 'Fade', old: 1 },
  { kind: 'out', id: 'blurOut', group: 'Fade', label: 'Blur out' },
  { kind: 'out', id: 'slideDown', group: 'Move', label: 'Slide down', old: 1 },
  { kind: 'out', id: 'slideUp', group: 'Move', label: 'Slide up' },
  { kind: 'out', id: 'slideLeft', group: 'Move', label: 'To left' },
  { kind: 'out', id: 'slideRight', group: 'Move', label: 'To right' },
  { kind: 'out', id: 'pop', group: 'Scale', label: 'Pop out', old: 1 },
  { kind: 'out', id: 'shrink', group: 'Scale', label: 'Shrink' },
  { kind: 'out', id: 'typewriter', group: 'Text', label: 'Un-type', old: 1 },
  { kind: 'out', id: 'wordByWord', group: 'Text', label: 'Words vanish' },
  { kind: 'out', id: 'wipe', group: 'Text', label: 'Wipe away' },
  { kind: 'out', id: 'glitch', group: 'Text', label: 'Glitch' },
  { kind: 'loop', id: 'pulse', group: 'Motion', label: 'Pulse' },
  { kind: 'loop', id: 'float', group: 'Motion', label: 'Float' },
  { kind: 'loop', id: 'wobble', group: 'Motion', label: 'Wobble' },
  { kind: 'loop', id: 'blink', group: 'Motion', label: 'Blink' },
  { kind: 'loop', id: 'karaoke', group: 'Highlight', label: 'Karaoke' },
];
export const KINDS = { in: 'In', out: 'Out', loop: 'Loop' };
export const FIELD = { in: 'in', out: 'out', loop: 'loop' };
export const SPEED_FIELD = { in: 'inDur', out: 'outDur', loop: 'loopSpeed' };
export const SPEED_RANGE = { in: [0.1, 4, 0.05], out: [0.1, 3, 0.05], loop: [0.25, 3, 0.05] };
export const label = (kind, id) => { const a = ANIMS.find(x => x.kind === kind && x.id === id); return a ? a.label : 'None'; };
export const groupsOf = (kind) => { const g = []; for (const a of ANIMS.filter(x => x.kind === kind)) { let r = g.find(x => x.name === a.group); if (!r) g.push(r = { name: a.group, items: [] }); r.items.push(a); } return g; };
/** Plain words for the current animation of a text layer. */
export const summary = (t) => { const a = cleanTextAnim(t.anim); return 'In: ' + label('in', a.in) + ' · Out: ' + label('out', a.out) + ' · Loop: ' + label('loop', a.loop); };
/** Loops that need the layer to be long enough to be seen; karaoke sweeps ONCE across the whole time the text is on screen. */
export const loopNeedsSpeed = (id) => id !== 'none' && id !== 'karaoke';

/**
 * State for the NEW "in" motions at progress p (0 = hidden .. 1 = settled) — returns null for ids that the original code in drawText still handles.
 * dx/dy are in canvas pixels, sc multiplies the scale, blur is in px, wipe is the visible fraction (left to right), glitch 0..1 strength.
 */
export function newIn(id, p, size, W, local) {
  if (p >= 1) return null;
  switch (id) {
    case 'rise': return { dy: (1 - EO(p)) * size * 0.55, a: EO(p) };
    case 'slideLeft': return { dx: (1 - EO(p)) * W * 0.3, a: EO(Math.min(1, p * 1.6)) };
    case 'slideRight': return { dx: -(1 - EO(p)) * W * 0.3, a: EO(Math.min(1, p * 1.6)) };
    case 'bounce': return { dy: -(1 - bounceOut(p)) * size * 2.2, a: Math.min(1, p * 5) };
    case 'grow': return { sc: 0.15 + 0.85 * EO(p), a: Math.min(1, p * 2.5) };
    case 'blurIn': return { blur: (1 - EO(p)) * size * 0.35, a: EO(p) };
    case 'wipe': return { wipe: EO(p) };
    case 'glitch': { const h = hash01(Math.floor(local * 24)); return { glitch: (1 - p) * (h > 0.3 ? 1 : 0.25), dx: (h - 0.5) * size * 0.35 * (1 - p), a: p < 0.2 ? (h > 0.4 ? 1 : 0.35) : 1 }; }
  }
  return null;
}
/** The NEW "out" motions; p = 1 while fully shown, falling to 0 at the end of the layer. */
export function newOut(id, p, size, W, local) {
  if (p >= 1) return null;
  switch (id) {
    case 'slideUp': return { dy: -(1 - p) * (1 - p) * size * 1.4, a: p };
    case 'slideLeft': return { dx: -(1 - p) * (1 - p) * W * 0.3, a: Math.min(1, p * 1.6) };
    case 'slideRight': return { dx: (1 - p) * (1 - p) * W * 0.3, a: Math.min(1, p * 1.6) };
    case 'shrink': return { sc: 0.15 + 0.85 * p, a: Math.min(1, p * 2.5) };
    case 'blurOut': return { blur: (1 - p) * size * 0.35, a: p };
    case 'wipe': return { wipeOut: 1 - p };           // fraction already wiped away (from the left)
    case 'glitch': { const h = hash01(Math.floor(local * 24) + 7); return { glitch: (1 - p) * (h > 0.3 ? 1 : 0.25), dx: (h - 0.5) * size * 0.35 * (1 - p), a: p > 0.8 ? 1 : (h > 0.35 ? 1 : 0.3) * Math.min(1, p * 3) }; }
    case 'wordByWord': return { words: p };
  }
  return null;
}
/** Looping motions at layer time `lt` (seconds, already multiplied by the speed). All start from "no change" at 0 so they join the in-animation smoothly. */
export function loopFx(id, lt) {
  const w = 2 * Math.PI;
  switch (id) {
    case 'pulse': return { sc: 1 + 0.06 * Math.sin(w * lt / 1.4) };
    case 'float': return { dyEm: 0.12 * Math.sin(w * lt / 2.4) };
    case 'wobble': return { rot: 2.5 * Math.sin(w * lt / 1.3) };
    case 'blink': return { a: 0.7 + 0.3 * Math.cos(w * lt / 1.2) };
  }
  return null;
}
/** How many words are highlighted (karaoke) at layer time `local` of a layer lasting `dur` with the given animation. */
export function karaokeCount(an, local, dur, nWords) {
  const t0 = an.in && an.in !== 'none' ? an.inDur || 0.6 : 0.15, t1 = an.out && an.out !== 'none' ? an.outDur || 0.4 : 0.15;
  const span = Math.max(0.2, dur - t0 - t1);
  const f = Math.min(1, Math.max(0, (local - t0) / span));
  return Math.floor(f * nWords + 1e-6);
}

// ---- editing: every function changes the project in place and returns how many layers changed (the caller makes ONE undo step)
export function setAnim(text, kind, id, speed) {
  const a = text.anim = cleanTextAnim(text.anim), f = FIELD[kind];
  const before = JSON.stringify(a);
  a[f] = id;
  if (id !== 'none') {
    if (speed != null) a[SPEED_FIELD[kind]] = speed;
    else if (kind !== 'loop' && (id === 'typewriter' || id === 'wordByWord')) a[SPEED_FIELD[kind]] = Math.min(Math.max(a[SPEED_FIELD[kind]], 1.2), Math.max(0.3, (text.end - text.start) * 0.6));
    if (kind === 'in') text.fadeIn = 0;                 // the animation replaces the plain fade-in, so they do not stack
    if (kind === 'out') text.fadeOut = 0;
  }
  const d = text.end - text.start;
  if (a.inDur + a.outDur > d) { a.inDur = Math.min(a.inDur, d * 0.6); a.outDur = Math.min(a.outDur, d * 0.35); }
  return JSON.stringify(a) === before ? 0 : 1;
}
/** Give every text layer the same In / Out / Loop animation (and its speed) as `from`; only the chosen kind(s) are touched. */
export function applyToAll(project, from, kinds) {
  const src = cleanTextAnim(from.anim); let n = 0;
  for (const t of project.texts) {
    if (t === from) continue;
    const a = t.anim = cleanTextAnim(t.anim);
    for (const k of kinds) { const f = FIELD[k], sf = SPEED_FIELD[k]; if (a[f] !== src[f] || a[sf] !== src[sf]) n++; a[f] = src[f]; a[sf] = src[sf]; if (k === 'in' && src.in !== 'none') t.fadeIn = 0; if (k === 'out' && src.out !== 'none') t.fadeOut = 0; if (k === 'loop') a.hi = src.hi; }
    const d = t.end - t.start; if (a.inDur + a.outDur > d) { a.inDur = Math.min(a.inDur, d * 0.6); a.outDur = Math.min(a.outDur, d * 0.35); }
  }
  return n;
}
export function removeAnim(text, kind) { return setAnim(text, kind, 'none'); }

// ---- ready-made sermon text (several editable layers each). `tall` = 9:16 (or taller): keep clear of the Shorts bottom UI.
const L = (start, dur, text, o, anim) => { const t = Object.assign(newText(start, dur, text), { fadeIn: 0, fadeOut: 0 }, o); t.anim = cleanTextAnim(Object.assign({ in: 'none', out: 'fade', inDur: 0.6, outDur: 0.5 }, anim || {})); return t; };
export const TEMPLATES = [
  { id: 'title', label: 'Title card', hint: 'Big title and subtitle, centred', dur: 5, make: (s, d, tall) => [
    L(s, d, 'Title goes here', { y: tall ? 0.42 : 0.44, size: tall ? 0.115 : 0.11, font: 'serif', maxWidth: 0.82, style: 'clean' }, { in: 'blurIn', out: 'fade', inDur: 0.9 }),
    L(s + 0.5, d - 0.5, 'Subtitle or speaker', { y: tall ? 0.56 : 0.6, size: tall ? 0.05 : 0.045, font: 'sans', color: '#f3d9a4', maxWidth: 0.8, style: 'clean' }, { in: 'rise', out: 'fade', inDur: 0.7 })] },
  { id: 'lower', label: 'Lower third', hint: 'Name + role', dur: 5, make: (s, d, tall) => [
    L(s, d, 'Pastor John Smith', { x: 0.32, y: tall ? 0.7 : 0.78, size: tall ? 0.062 : 0.055, font: 'sans', style: 'box', align: 'left', bg: '#111111', bgOpacity: 0.82, maxWidth: tall ? 0.6 : 0.5 }, { in: 'slideRight', out: 'slideLeft', inDur: 0.6, outDur: 0.5 }),
    L(s + 0.25, d - 0.25, 'Senior Pastor, Grace Church', { x: 0.32, y: tall ? 0.765 : 0.865, size: tall ? 0.04 : 0.034, font: 'condensed', style: 'box', align: 'left', color: '#111111', bg: '#f0b429', bgOpacity: 0.95, maxWidth: tall ? 0.6 : 0.5 }, { in: 'slideRight', out: 'slideLeft', inDur: 0.6, outDur: 0.5 })] },
  { id: 'scripture', label: 'Scripture bar', hint: 'Verse + reference', dur: 7, make: (s, d, tall) => [
    L(s, d, 'For God so loved the world that he gave his one and only Son.', { y: tall ? 0.66 : 0.8, size: tall ? 0.056 : 0.048, font: 'serif', style: 'band', bg: '#000000', bgOpacity: 0.7, maxWidth: tall ? 0.86 : 0.8 }, { in: 'wipe', out: 'fade', inDur: 0.9 }),
    L(s + 0.6, d - 0.6, 'John 3:16', { y: tall ? 0.755 : 0.92, size: tall ? 0.04 : 0.036, font: 'mono', style: 'clean', color: '#f0b429', maxWidth: 0.6 }, { in: 'rise', out: 'fade' })] },
  { id: 'quote', label: 'Quote card', hint: 'Quote + who said it', dur: 6, make: (s, d, tall) => [
    L(s, d, '“Quote goes here, short and strong.”', { y: 0.45, size: tall ? 0.085 : 0.075, font: 'serifItalic', style: 'clean', maxWidth: 0.78 }, { in: 'rise', out: 'fade', inDur: 0.9 }),
    L(s + 0.8, d - 0.8, '— Name', { y: tall ? 0.62 : 0.65, size: tall ? 0.045 : 0.04, font: 'sans', color: '#f3d9a4', style: 'clean' }, { in: 'fade', out: 'fade', inDur: 0.6 })] },
  { id: 'part', label: 'Part 1/2 badge', hint: 'Small badge, top corner', dur: 4, make: (s, d, tall) => [
    L(s, d, 'PART 1/2', { x: tall ? 0.24 : 0.12, y: tall ? 0.1 : 0.1, size: tall ? 0.05 : 0.04, font: 'condensed', style: 'box', bg: '#df3f34', bgOpacity: 0.95, maxWidth: 0.4 }, { in: 'pop', out: 'fade', inDur: 0.5, outDur: 0.4 })] },
  { id: 'subscribe', label: 'Like & subscribe', hint: 'Call-out that gently pulses', dur: 4, make: (s, d, tall) => [
    L(s, d, 'LIKE & SUBSCRIBE', { y: tall ? 0.74 : 0.84, size: tall ? 0.06 : 0.05, font: 'sans', style: 'box', bg: '#df3f34', bgOpacity: 0.95, maxWidth: 0.8 }, { in: 'bounce', out: 'fade', inDur: 0.8, outDur: 0.4, loop: 'pulse', loopSpeed: 1 })] },
  { id: 'hook', label: 'Big bold hook', hint: 'Huge outlined opener', dur: 3, make: (s, d, tall) => [
    L(s, d, 'WAIT FOR IT…', { y: tall ? 0.4 : 0.46, size: tall ? 0.15 : 0.14, font: 'condensed', style: 'outline', bg: '#000000', maxWidth: 0.9 }, { in: 'pop', out: 'fade', inDur: 0.45, outDur: 0.3 })] },
];
/** Layers for template `id` starting at `at` seconds; the length is cut to fit before the end of the video (never shorter than 1.5 s). */
export function buildTemplate(id, { at = 0, total = 0, ratio = '16:9' } = {}) {
  const tp = TEMPLATES.find(x => x.id === id); if (!tp) return [];
  const tall = ratio === '9:16';
  const dur = total > at + 1.5 ? Math.min(tp.dur, total - at) : tp.dur;
  return tp.make(Math.max(0, at), dur, tall);
}
