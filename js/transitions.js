// Transitions between two joined clips of the main sequence: the list of kinds, how long one can be, how it looks (progress -> picture
// parameters) and how the two sounds blend. Pure functions (no browser), used by model.js (layout, sound), render.js (preview AND export) and the UI.
//
// Data (unchanged for old projects): clip.transition = { type, duration, audio? } is the transition INTO that clip from the clip before it.
//  - 'cut'                                   nothing
//  - overlap kinds (crossfade = "Dissolve", wipe*, slide*, zoom*, blur): the next clip starts `duration` seconds before the previous one
//    ends, both play during the overlap, so the video gets that much shorter. No hidden media is needed, so it works for every clip
//    (photos too) and never "runs out of handles"; it can use at most half of the shorter clip.
//  - dip kinds ('fade' = black, 'dipwhite'): the picture goes to the colour and back, half the duration on each side; the length is unchanged.
//  audio: 'cross' (default, also when missing) = equal-power crossfade over the overlap; 'cut' = hard cut at the middle of the overlap.

export const MIN_DUR = 0.1, MAX_DUR = 3, DEFAULT_DUR = 0.5;

export const TYPES = [
  { id: 'cut', label: 'Cut', kind: 'cut', group: 'Basic' },
  { id: 'crossfade', label: 'Dissolve', kind: 'overlap', group: 'Basic' },
  { id: 'fade', label: 'Dip to black', kind: 'dip', color: '#000000', group: 'Basic' },
  { id: 'dipwhite', label: 'Dip to white', kind: 'dip', color: '#ffffff', group: 'Basic' },
  { id: 'wipeleft', label: 'Wipe ←', kind: 'overlap', dir: [-1, 0], group: 'Wipe' },
  { id: 'wiperight', label: 'Wipe →', kind: 'overlap', dir: [1, 0], group: 'Wipe' },
  { id: 'wipeup', label: 'Wipe ↑', kind: 'overlap', dir: [0, -1], group: 'Wipe' },
  { id: 'wipedown', label: 'Wipe ↓', kind: 'overlap', dir: [0, 1], group: 'Wipe' },
  { id: 'slideleft', label: 'Slide ←', kind: 'overlap', dir: [-1, 0], group: 'Slide' },
  { id: 'slideright', label: 'Slide →', kind: 'overlap', dir: [1, 0], group: 'Slide' },
  { id: 'slideup', label: 'Slide ↑', kind: 'overlap', dir: [0, -1], group: 'Slide' },
  { id: 'slidedown', label: 'Slide ↓', kind: 'overlap', dir: [0, 1], group: 'Slide' },
  { id: 'zoomin', label: 'Zoom in', kind: 'overlap', group: 'More' },
  { id: 'zoomout', label: 'Zoom out', kind: 'overlap', group: 'More' },
  { id: 'blur', label: 'Blur dissolve', kind: 'overlap', group: 'More' },
];
const BY_ID = new Map(TYPES.map(t => [t.id, t]));
export const typeInfo = (id) => BY_ID.get(id) || BY_ID.get('cut');
export const isKnown = (id) => BY_ID.has(id);
export const isOverlap = (id) => typeInfo(id).kind === 'overlap';
export const isDip = (id) => typeInfo(id).kind === 'dip';
export const labelOf = (id) => typeInfo(id).label;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A clean transition record: known type, duration 0..10 s (the UI offers 0.1..3), audio 'cross' | 'cut'. */
export function normalize(tr) {
  const t = tr && typeof tr === 'object' ? tr : {};
  const d = Number.isFinite(+t.duration) && t.duration !== null && t.duration !== '' ? clamp(+t.duration, 0, 10) : 0.6;
  const out = { type: isKnown(t.type) ? t.type : 'cut', duration: d };
  if (t.audio === 'cut') out.audio = 'cut';
  return out;
}
/** Longest duration that fits for a join: the previous clip's and this clip's lengths on the timeline (prevLen = Infinity at the very start). */
export function maxDuration(type, prevLen, len) {
  if (isOverlap(type)) return Math.max(0, Math.min(prevLen / 2, len / 2));
  if (isDip(type)) return Number.isFinite(prevLen) ? Math.max(0, Math.min(prevLen, len)) : Math.max(0, len / 2);
  return 0;
}
/** What is actually used: the asked duration, limited to what fits. */
export function effective(type, duration, prevLen, len) { return Math.min(duration, maxDuration(type, prevLen, len)); }

/** Smooth progress for the moving kinds (the plain dissolve stays linear, as it always was). */
export const smooth = (p) => { p = clamp(p, 0, 1); return p * p * (3 - 2 * p); };
export const easeOf = (type, p) => (type === 'crossfade' ? clamp(p, 0, 1) : smooth(p));

/**
 * How to draw the two pictures at progress p (0..1) of a transition of `type`. Returns, for the outgoing picture `out` and the incoming
 * one `inn`: { alpha, dx, dy (fractions of the frame), scale, blur (fraction of the frame height), clip: {x0,y0,x1,y1} fractions | null }.
 */
export function look(type, p) {
  const e = easeOf(type, p), info = typeInfo(type);
  const out = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null }, inn = { alpha: e, dx: 0, dy: 0, scale: 1, blur: 0, clip: null };
  if (type.startsWith('wipe')) {
    const [x, y] = info.dir; inn.alpha = 1;
    // the edge travels in the direction of the arrow; the new picture is on the side the edge has already passed
    if (x < 0) inn.clip = { x0: 1 - e, y0: 0, x1: 1, y1: 1 }; else if (x > 0) inn.clip = { x0: 0, y0: 0, x1: e, y1: 1 };
    else if (y < 0) inn.clip = { x0: 0, y0: 1 - e, x1: 1, y1: 1 }; else inn.clip = { x0: 0, y0: 0, x1: 1, y1: e };
  } else if (type.startsWith('slide')) {
    const [x, y] = info.dir; inn.alpha = 1;
    out.dx = x * e; out.dy = y * e; inn.dx = -x * (1 - e); inn.dy = -y * (1 - e);
  } else if (type === 'zoomin') { out.scale = 1 + 0.3 * e; inn.scale = 1 + 0.15 * (1 - e); }
  else if (type === 'zoomout') { out.scale = 1 - 0.2 * e; inn.scale = 1 + 0.25 * (1 - e); }
  else if (type === 'blur') { out.blur = 0.025 * e; inn.blur = 0.025 * (1 - e); }
  return { out, inn, e };
}

/** Sound gain of the incoming clip `local` seconds into an overlap of length x (and of the outgoing clip `rem` seconds before its end). */
export function soundGain(mode, pos, x) {
  if (!(x > 0)) return 1;
  if (mode === 'cut') return clamp((pos - x / 2) / 0.01 + 0.5, 0, 1);       // hard cut at the middle, 10 ms ramp so it does not click
  return Math.sin(Math.PI / 2 * clamp(pos / x, 0, 1));                      // equal power: out^2 + in^2 = 1
}
