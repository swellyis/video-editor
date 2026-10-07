// Filters library: one-tap colour looks (like the Filters tab of CapCut / Filmora). Pure data and maths, no DOM.
// A filter is a set of colour moves done by the ONE colour shader in render.js (the same pass as the manual Clip color sliders), so the preview,
// MP4 streaming, WebM, the thumbnail maker and the small previews in the Filters tab all show the same picture:
//   brightness, contrast, saturation, temperature (warmth), sepia, fade, vignette  - the slider-space numbers the old presets used
//   gamma  - brightens (>1) or darkens (<1) the midtones;  curve - 0..1 blend toward an S-curve (richer blacks and highlights)
//   ts / th - [r, g, b, strength] tint pushed into the shadows / the highlights (split toning, e.g. teal and orange)
// The seven presets of earlier versions (warm, cool, bw, vintage, vivid, dramatic, golden) keep their ids and numbers, so a project saved with
// one looks exactly the same at 100%. The stored field is still color.preset; color.filterAmount (0..1, default 1) is the Intensity.
export const GROUPS = ['Natural', 'Cinematic', 'Vivid', 'Retro', 'Mono'];
const F = (id, label, group, p) => ({ id, label, group, p });
export const FILTERS = [
  // ---- Natural
  F('warm', 'Warm', 'Natural', { temperature: 30, saturation: 8, brightness: 2 }),
  F('cool', 'Cool', 'Natural', { temperature: -30, saturation: -4 }),
  F('golden', 'Golden hour', 'Natural', { temperature: 42, sepia: 12, saturation: 14, vignette: 18 }),
  F('natural', 'Warm natural', 'Natural', { temperature: 14, saturation: 6, contrast: 6, brightness: 2, th: [1, 0.92, 0.8, 0.12] }),
  F('skin', 'Soft skin', 'Natural', { contrast: -10, saturation: -6, brightness: 4, temperature: 8, fade: 6, gamma: 1.08 }),
  F('clean', 'Bright & clean', 'Natural', { brightness: 8, contrast: 8, saturation: 8, temperature: -4, gamma: 1.12 }),
  F('sanctuary', 'Sanctuary glow', 'Natural', { temperature: 22, saturation: 4, brightness: 3, fade: 6, vignette: 14, gamma: 1.06, th: [1, 0.82, 0.5, 0.2] }),
  F('sunrise', 'Sunrise', 'Natural', { temperature: 34, saturation: 14, brightness: 4, fade: 4, ts: [0.9, 0.4, 0.35, 0.15], th: [1, 0.85, 0.5, 0.25] }),
  F('morning', 'Morning light', 'Natural', { brightness: 6, contrast: -4, saturation: 10, temperature: 10, fade: 8, gamma: 1.1 }),
  // ---- Cinematic
  F('dramatic', 'Dramatic', 'Cinematic', { contrast: 28, saturation: -22, vignette: 40, brightness: -4 }),
  F('moody', 'Moody cinematic', 'Cinematic', { contrast: 22, saturation: -14, brightness: -6, vignette: 28, gamma: 0.95, curve: 0.4, ts: [0.1, 0.3, 0.4, 0.25] }),
  F('tealorange', 'Teal & orange', 'Cinematic', { contrast: 14, saturation: 8, curve: 0.3, ts: [0, 0.45, 0.5, 0.5], th: [1, 0.6, 0.25, 0.45] }),
  F('blockbuster', 'Blockbuster', 'Cinematic', { contrast: 20, saturation: -6, vignette: 24, curve: 0.5, ts: [0, 0.4, 0.45, 0.3], th: [1, 0.65, 0.3, 0.25] }),
  F('bleach', 'Bleach bypass', 'Cinematic', { saturation: -40, contrast: 30, curve: 0.3 }),
  F('coldsteel', 'Cold steel', 'Cinematic', { temperature: -30, saturation: -16, contrast: 14, ts: [0.2, 0.4, 0.7, 0.3] }),
  F('epic', 'Epic gold', 'Cinematic', { temperature: 26, contrast: 22, saturation: 10, vignette: 26, curve: 0.4, th: [1, 0.78, 0.35, 0.35] }),
  // ---- Vivid
  F('vivid', 'Vivid', 'Vivid', { saturation: 38, contrast: 14 }),
  F('pop', 'Pop', 'Vivid', { saturation: 55, contrast: 16, brightness: 3 }),
  F('fresh', 'Fresh', 'Vivid', { saturation: 28, temperature: -6, brightness: 6, gamma: 1.08 }),
  F('punch', 'Punch', 'Vivid', { contrast: 30, saturation: 30, curve: 0.5 }),
  // ---- Retro
  F('vintage', 'Vintage', 'Retro', { sepia: 38, contrast: -8, fade: 14, saturation: -12, vignette: 30 }),
  F('fadedfilm', 'Faded film', 'Retro', { contrast: -14, saturation: -18, fade: 22, ts: [0.1, 0.35, 0.4, 0.2], th: [1, 0.9, 0.75, 0.15] }),
  F('seventies', '70s', 'Retro', { temperature: 30, saturation: -6, fade: 20, sepia: 18, ts: [0.4, 0.2, 0.1, 0.3] }),
  F('polaroid', 'Polaroid', 'Retro', { temperature: 12, saturation: -10, contrast: -6, fade: 18, vignette: 20, ts: [0.2, 0.4, 0.45, 0.15] }),
  F('sepia', 'Sepia', 'Retro', { sepia: 90, contrast: 6, fade: 6, vignette: 12 }),
  // ---- Mono
  F('bw', 'B&W', 'Mono', { saturation: -100, contrast: 12 }),
  F('hicontrast', 'High-contrast B&W', 'Mono', { saturation: -100, contrast: 40, curve: 0.5 }),
  F('softbw', 'Soft B&W', 'Mono', { saturation: -100, contrast: -8, fade: 10, gamma: 1.1 }),
  F('silver', 'Silver', 'Mono', { saturation: -100, contrast: 18, th: [0.9, 0.95, 1, 0.1] }),
  F('noir', 'Noir', 'Mono', { saturation: -100, contrast: 36, brightness: -8, vignette: 40, curve: 0.6 }),
];
const BY_ID = new Map(FILTERS.map(f => [f.id, f]));
export const filterInfo = (id) => BY_ID.get(id) || null;
export const filterLabel = (id) => (BY_ID.get(id) ? BY_ID.get(id).label : 'None');
const LEGACY = ['warm', 'cool', 'bw', 'vintage', 'vivid', 'dramatic', 'golden'];
/** The seven presets of earlier versions, in the old slider-space shape (kept for old callers and tests). */
export const PRESETS = { none: { label: 'None' }, ...Object.fromEntries(LEGACY.map(id => [id, { label: BY_ID.get(id).label, ...BY_ID.get(id).p }])) };
export const KEYS = ['brightness', 'contrast', 'saturation', 'temperature', 'vignette', 'sepia', 'fade'];
export const NEUTRAL = { gamma: 1, curve: 0, ts: [0, 0, 0, 0], th: [0, 0, 0, 0] };
export const amountOf = (c) => { const a = c && c.filterAmount; return Number.isFinite(+a) && a !== null && a !== '' ? Math.min(1, Math.max(0, +a)) : 1; };
/** What a filter at `amount` (0..1) adds: slider-space numbers scaled by the amount, plus gamma / curve / tints fading in from neutral. */
export function filterParams(id, amount = 1) {
  const f = BY_ID.get(id), a = Math.min(1, Math.max(0, amount));
  const out = { ...NEUTRAL, ts: [...NEUTRAL.ts], th: [...NEUTRAL.th] };
  for (const k of KEYS) out[k] = 0;
  if (!f) return out;
  for (const k of KEYS) out[k] = (f.p[k] || 0) * a;
  if (f.p.gamma) out.gamma = 1 + (f.p.gamma - 1) * a;
  if (f.p.curve) out.curve = f.p.curve * a;
  if (f.p.ts) out.ts = [f.p.ts[0], f.p.ts[1], f.p.ts[2], f.p.ts[3] * a];
  if (f.p.th) out.th = [f.p.th[0], f.p.th[1], f.p.th[2], f.p.th[3] * a];
  return out;
}
/** Keep a colour object's filter fields tidy (unknown id -> none; amount 0..1). */
export function normFilter(c) {
  if (!c || typeof c !== 'object') return;
  if (c.preset !== 'none' && !BY_ID.has(c.preset)) c.preset = 'none';
  c.filterAmount = amountOf(c);
}
