// Thumbnail designer: the data (layers), templates, geometry / snapping and the drawing of a design onto a canvas. No DOM: the dialog is in designer-ui.js.
// A design is kept PER FORMAT ('16:9', '9:16', '1:1') in project.thumb.designs, so each format has its own layout. Positions are fractions of the canvas
// (x, y = centre of the layer, w = width / canvas width, h = height / canvas height); text size is a fraction of the canvas WIDTH (so a template looks alike in every format).
import { FONTS } from './model.js';
import { fontCss } from './render.js';

export const MAX_LAYERS = 30;
export const DESIGN_FORMATS = ['16:9', '9:16', '1:1'];
export const SIZES = { '16:9': [1280, 720], '9:16': [1080, 1920], '1:1': [1080, 1080] };
/** Safe area per format (px). 16:9 keeps clear of YouTube's duration badge (bottom-right); Shorts of the app's bottom UI and the top bar. */
export const SAFE = {
  '16:9': { x: 70, y: 60, w: 1140, h: 600 },
  '1:1': { x: 70, y: 70, w: 940, h: 940 },
  '9:16': { x: 80, y: 150, w: 920, h: 1410 },
};
/** The area YouTube covers with the video-length badge on a 16:9 thumbnail (fractions of the canvas). */
export const DURATION_BADGE = { x: 0.82, y: 0.86, w: 0.18, h: 0.14 };
export const STICKERS = ['🙏', '✝️', '📖', '🕊️', '🔥', '❤️', '✨', '👑', '⭐', '✅', '⚡', '😮'];
export const SHAPES = ['rect', 'round', 'ellipse', 'triangle', 'line', 'arrow'];
export const VECTOR_STICKERS = ['cross', 'burst', 'play', 'arrow'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, a, b, d) => { v = typeof v === 'string' && v.trim() !== '' ? +v : v; return typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d; };
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const str = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
let seq = 0;
export const newId = () => 'L' + Date.now().toString(36) + (seq++).toString(36);

export const defaultAdjust = () => ({ preset: 'none', filterAmount: 1, brightness: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0, darken: 0.25 });
export const defaultBg = () => ({ type: 'frame', color: '#14213d', color2: '#e63946', angle: 135, mediaId: '', fit: 'cover' });

const base = (type, o = {}) => ({ id: newId(), type, name: '', x: 0.5, y: 0.5, w: 0.3, h: 0.2, rot: 0, opacity: 1, locked: false, ...o });
export function newText(o = {}) {
  return base('text', {
    name: 'Text', text: 'YOUR TEXT', font: 'anton', size: 0.1, color: '#ffffff', align: 'center', lineH: 1.05, spacing: 0, upper: false, w: 0.6, h: 0.2,
    stroke: { on: true, w: 0.06, color: '#000000' }, shadow: { on: true, color: '#000000', blur: 0.25, dx: 0, dy: 0.05 }, glow: { on: false, color: '#ffd166', blur: 0.4 },
    box: { on: false, color: '#df3f34', pad: 0.25, radius: 0.15 }, ...o,
  });
}
export const newShape = (o = {}) => base('shape', { name: 'Shape', shape: 'rect', fill: '#df3f34', fill2: '', stroke: { on: false, w: 0.01, color: '#ffffff' }, radius: 0.15, shadow: false, w: 0.3, h: 0.2, ...o });
export const newSticker = (o = {}) => base('sticker', { name: 'Sticker', kind: 'emoji', char: '🙏', color: '#ffd166', w: 0.14, h: 0.14 * 1280 / 720, ...o });
export const newImage = (o = {}) => base('image', { name: 'Picture', mediaId: '', ar: 1, radius: 0, border: { on: false, w: 0.008, color: '#ffffff' }, flipH: false, shadow: false, w: 0.3, h: 0.3, ...o });

/** Make any stored layer safe (types, ranges, lengths); returns null for junk. */
export function normLayer(l) {
  if (!l || typeof l !== 'object') return null;
  const type = oneOf(l.type, ['text', 'shape', 'sticker', 'image'], null); if (!type) return null;
  const o = { id: str(l.id, 40, '') || newId(), type, name: str(l.name, 40), x: num(l.x, -1, 2, 0.5), y: num(l.y, -1, 2, 0.5), w: num(l.w, 0.01, 3, 0.3), h: num(l.h, 0.01, 3, 0.2), rot: num(l.rot, -360, 360, 0), opacity: num(l.opacity, 0, 1, 1), locked: l.locked === true };
  const sub = (v, d) => (v && typeof v === 'object' ? v : d);
  if (type === 'text') {
    const s = sub(l.stroke, {}), sh = sub(l.shadow, {}), g = sub(l.glow, {}), b = sub(l.box, {});
    Object.assign(o, {
      text: str(l.text, 300), font: oneOf(l.font, Object.keys(FONTS), 'anton'), size: num(l.size, 0.01, 0.6, 0.1), color: hex(l.color, '#ffffff'), align: oneOf(l.align, ['left', 'center', 'right'], 'center'),
      lineH: num(l.lineH, 0.7, 2, 1.05), spacing: num(l.spacing, -0.1, 0.5, 0), upper: l.upper === true,
      stroke: { on: s.on === true, w: num(s.w, 0, 0.3, 0.06), color: hex(s.color, '#000000') },
      shadow: { on: sh.on === true, color: hex(sh.color, '#000000'), blur: num(sh.blur, 0, 2, 0.25), dx: num(sh.dx, -1, 1, 0), dy: num(sh.dy, -1, 1, 0.05) },
      glow: { on: g.on === true, color: hex(g.color, '#ffd166'), blur: num(g.blur, 0, 2, 0.4) },
      box: { on: b.on === true, color: hex(b.color, '#df3f34'), pad: num(b.pad, 0, 1.5, 0.25), radius: num(b.radius, 0, 1, 0.15) },
    });
  } else if (type === 'shape') {
    const s = sub(l.stroke, {});
    Object.assign(o, { shape: oneOf(l.shape, SHAPES, 'rect'), fill: hex(l.fill, '#df3f34'), fill2: hex(l.fill2, ''), stroke: { on: s.on === true, w: num(s.w, 0, 0.2, 0.01), color: hex(s.color, '#ffffff') }, radius: num(l.radius, 0, 0.5, 0.15), shadow: l.shadow === true });
  } else if (type === 'sticker') {
    Object.assign(o, { kind: oneOf(l.kind, ['emoji', ...VECTOR_STICKERS], 'emoji'), char: str(l.char, 8, '🙏'), color: hex(l.color, '#ffd166') });
  } else {
    const b = sub(l.border, {});
    Object.assign(o, { mediaId: str(l.mediaId, 80), ar: num(l.ar, 0.05, 20, 1), radius: num(l.radius, 0, 0.5, 0), border: { on: b.on === true, w: num(b.w, 0, 0.1, 0.008), color: hex(b.color, '#ffffff') }, flipH: l.flipH === true, shadow: l.shadow === true });
  }
  return o;
}
export function normDesign(d) {
  const x = d && typeof d === 'object' ? d : {};
  const bg = x.bg && typeof x.bg === 'object' ? x.bg : {}, a = x.adjust && typeof x.adjust === 'object' ? x.adjust : {};
  return {
    v: 1,
    bg: { type: oneOf(bg.type, ['frame', 'solid', 'gradient', 'image'], 'frame'), color: hex(bg.color, '#14213d'), color2: hex(bg.color2, '#e63946'), angle: num(bg.angle, 0, 360, 135), mediaId: str(bg.mediaId, 80), fit: oneOf(bg.fit, ['cover', 'contain'], 'cover') },
    adjust: { preset: str(a.preset, 30, 'none'), filterAmount: num(a.filterAmount, 0, 1, 1), brightness: num(a.brightness, -100, 100, 0), contrast: num(a.contrast, -100, 100, 0), saturation: num(a.saturation, -100, 100, 0), temperature: num(a.temperature, -100, 100, 0), vignette: num(a.vignette, 0, 100, 0), darken: num(a.darken, 0, 0.8, 0.25) },
    layers: (Array.isArray(x.layers) ? x.layers : []).slice(0, MAX_LAYERS).map(normLayer).filter(Boolean),
  };
}
export const cloneDesign = (d) => JSON.parse(JSON.stringify(d));

// ---------------------------------------------------------------- templates (sermon-ready, one layout per format)
export const TEMPLATES = [
  { id: 'title', label: 'Big title' }, { id: 'part', label: 'Part 1 / 2' }, { id: 'verse', label: 'Scripture verse' },
  { id: 'face', label: 'Face left, text right' }, { id: 'split', label: 'Bold split' }, { id: 'minimal', label: 'Minimal' },
];
/** A fresh design for template `id` in format `fk`. `accent` colours the highlights. */
export function templateDesign(id, fk, accent = '#df3f34') {
  const tall = fk === '9:16', sq = fk === '1:1';
  const T = (o) => newText(o), S = (o) => newShape(o);
  const d = { v: 1, bg: defaultBg(), adjust: defaultAdjust(), layers: [] };
  const L = d.layers;
  if (id === 'title') {
    d.adjust.darken = 0.3;
    L.push(S({ name: 'Accent bar', shape: 'rect', fill: accent, x: tall ? 0.5 : sq ? 0.5 : 0.1, y: tall ? 0.34 : sq ? 0.3 : 0.31, w: tall ? 0.7 : 0.16, h: tall ? 0.008 : sq ? 0.012 : 0.02 }));
    L.push(T({ name: 'Title', text: 'WORD OF\nGOD', font: 'anton', size: tall ? 0.2 : sq ? 0.17 : 0.13, w: tall ? 0.84 : sq ? 0.86 : 0.62, align: tall ? 'center' : 'left', x: tall ? 0.5 : sq ? 0.5 : 0.37, y: tall ? 0.46 : sq ? 0.48 : 0.5, h: 0.3 }));
    L.push(T({ name: 'Small line', text: 'SUNDAY MESSAGE', font: 'montserrat', size: tall ? 0.05 : 0.026, w: 0.5, align: tall ? 'center' : 'left', x: tall ? 0.5 : sq ? 0.5 : 0.3, y: tall ? 0.65 : sq ? 0.74 : 0.78, stroke: { on: false, w: 0, color: '#000000' }, shadow: { on: false, color: '#000000', blur: 0.2, dx: 0, dy: 0.05 }, box: { on: true, color: accent, pad: 0.35, radius: 0.1 }, h: 0.06, spacing: 0.06 }));
  } else if (id === 'part') {
    d.adjust.darken = 0.35;
    L.push(T({ name: 'Part', text: 'PART 1', font: 'montserrat', size: tall ? 0.075 : 0.045, w: 0.4, x: tall ? 0.5 : 0.17, y: tall ? 0.2 : 0.14, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: false, color: '#000000', blur: 0.2, dx: 0, dy: 0.05 }, box: { on: true, color: accent, pad: 0.4, radius: 0.12 }, h: 0.08, spacing: 0.05 }));
    L.push(T({ name: 'Title', text: 'FAITH OVER FEAR', font: 'bebas', size: tall ? 0.24 : sq ? 0.2 : 0.17, w: tall ? 0.9 : 0.86, x: 0.5, y: tall ? 0.52 : sq ? 0.58 : 0.62, align: 'center', h: 0.4 }));
    L.push(T({ name: 'Small line', text: 'Pastor John · Psalm 23', font: 'montserrat', size: tall ? 0.045 : 0.03, w: 0.8, x: 0.5, y: tall ? 0.78 : sq ? 0.86 : 0.88, stroke: { on: false, w: 0, color: '#000' }, h: 0.05 }));
  } else if (id === 'verse') {
    d.bg = { ...defaultBg(), type: 'gradient', color: '#101a3a', color2: '#0b0f1f', angle: 160 };
    d.adjust.darken = 0;
    L.push(S({ name: 'Glow', shape: 'ellipse', fill: accent, x: 0.5, y: tall ? 0.18 : 0.5, w: tall ? 0.7 : 0.5, h: tall ? 0.18 : 0.9, opacity: 0.14 }));
    L.push(newSticker({ name: 'Cross', kind: 'cross', color: '#ffd166', w: tall ? 0.16 : 0.07, h: (tall ? 0.16 : 0.07) * (SIZES[fk][0] / SIZES[fk][1]), x: 0.5, y: tall ? 0.15 : 0.16 }));
    L.push(T({ name: 'Verse', text: '“The Lord is my shepherd; I shall not want.”', font: 'playfair', size: tall ? 0.085 : sq ? 0.06 : 0.052, w: tall ? 0.84 : 0.78, x: 0.5, y: tall ? 0.46 : 0.5, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: true, color: '#000000', blur: 0.2, dx: 0, dy: 0.04 }, lineH: 1.2, h: 0.35 }));
    L.push(T({ name: 'Reference', text: 'PSALM 23:1', font: 'montserrat', size: tall ? 0.05 : 0.032, w: 0.6, x: 0.5, y: tall ? 0.68 : sq ? 0.76 : 0.8, color: accent, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: false, color: '#000000', blur: 0.2, dx: 0, dy: 0.05 }, spacing: 0.12, h: 0.06 }));
  } else if (id === 'face') {
    d.adjust.darken = 0.1;
    L.push(S({ name: 'Shade', shape: 'rect', fill: '#000000', x: tall ? 0.5 : 0.74, y: tall ? 0.78 : 0.5, w: tall ? 1 : 0.52, h: tall ? 0.44 : 1, opacity: 0.62 }));
    L.push(T({ name: 'Title', text: 'WHO IS\nJESUS?', font: 'anton', size: tall ? 0.19 : sq ? 0.15 : 0.1, w: tall ? 0.86 : 0.46, x: tall ? 0.5 : 0.74, y: tall ? 0.76 : sq ? 0.5 : 0.46, align: tall ? 'center' : 'left', h: 0.3 }));
    L.push(T({ name: 'Small line', text: 'WATCH NOW', font: 'montserrat', size: tall ? 0.05 : 0.026, w: 0.4, x: tall ? 0.5 : 0.65, y: tall ? 0.9 : sq ? 0.84 : 0.74, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: false, color: '#000000', blur: 0.2, dx: 0, dy: 0.05 }, box: { on: true, color: accent, pad: 0.35, radius: 0.1 }, h: 0.06, spacing: 0.06 }));
  } else if (id === 'split') {
    d.adjust.darken = 0;
    L.push(S({ name: 'Panel', shape: 'rect', fill: accent, x: tall ? 0.5 : 0.27, y: tall ? 0.8 : 0.5, w: tall ? 1 : 0.54, h: tall ? 0.4 : 1 }));
    L.push(T({ name: 'Title', text: 'DON’T\nGIVE UP', font: 'bebas', size: tall ? 0.22 : sq ? 0.18 : 0.15, w: tall ? 0.88 : 0.48, x: tall ? 0.5 : 0.27, y: tall ? 0.8 : 0.5, align: 'center', color: '#ffffff', stroke: { on: false, w: 0, color: '#000' }, shadow: { on: true, color: '#000000', blur: 0.1, dx: 0.03, dy: 0.04 }, h: 0.4 }));
  } else { // minimal
    d.adjust.darken = 0.18;
    L.push(T({ name: 'Title', text: 'Be Still', font: 'playfair', size: tall ? 0.15 : sq ? 0.12 : 0.1, w: 0.8, x: 0.5, y: tall ? 0.46 : 0.46, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: true, color: '#000000', blur: 0.3, dx: 0, dy: 0.04 }, h: 0.2 }));
    L.push(S({ name: 'Line', shape: 'rect', fill: '#ffffff', x: 0.5, y: tall ? 0.55 : 0.6, w: 0.12, h: 0.004 }));
    L.push(T({ name: 'Small line', text: 'PSALM 46:10', font: 'montserrat', size: tall ? 0.04 : 0.026, w: 0.6, x: 0.5, y: tall ? 0.59 : 0.66, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: true, color: '#000000', blur: 0.3, dx: 0, dy: 0.04 }, spacing: 0.18, h: 0.05 }));
  }
  return normDesign(d);
}
/** A design for a project saved before the designer existed (one headline + one small line + a layout), as close as the new layers allow. */
export function legacyDesign(t, fk) {
  const d = templateDesign('title', fk, t.accent || '#df3f34');
  d.layers = [];
  const tall = fk === '9:16', pos = t.position || 'left';
  const x = pos === 'left' ? (tall ? 0.5 : 0.37) : pos === 'right' ? 0.63 : 0.5;
  const align = pos === 'left' && !tall ? 'left' : pos === 'right' ? 'right' : 'center';
  const y = pos === 'top' ? 0.2 : pos === 'bottom' ? 0.78 : 0.5;
  const fontOk = FONTS[t.font] ? t.font : 'sans';
  if (t.text) d.layers.push(newText({ name: 'Title', text: t.text, font: fontOk, size: tall ? 0.15 : 0.1, w: pos === 'left' || pos === 'right' ? 0.6 : 0.86, x, y, align, color: t.color || '#ffffff', h: 0.3 }));
  if (t.sub) d.layers.push(newText({ name: 'Small line', text: t.sub.toUpperCase(), font: 'montserrat', size: tall ? 0.045 : 0.026, w: 0.5, x, y: Math.min(0.92, y + 0.26), align, stroke: { on: false, w: 0, color: '#000' }, shadow: { on: false, color: '#000', blur: 0.2, dx: 0, dy: 0.05 }, box: { on: true, color: t.accent || '#df3f34', pad: 0.35, radius: 0.1 }, h: 0.06 }));
  return normDesign(d);
}

// ---------------------------------------------------------------- text layout (shared by drawing and hit-testing)
const emojiFont = (px) => `${Math.round(px)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) { const test = line ? line + ' ' + w : w; if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test; }
    out.push(line);
  }
  return out.slice(0, 12);
}
/** Lay a text layer out: { lines, px, lh, w, h } in canvas px (w = the box width, h = its measured height incl. the background box padding). */
export function layoutText(ctx, l, W) {
  const px = Math.max(4, l.size * W), boxW = l.w * W, pad = l.box.on ? l.box.pad * px : 0;
  ctx.save(); ctx.font = fontCss(l.font, px); if ('letterSpacing' in ctx) ctx.letterSpacing = (l.spacing * px) + 'px';
  const text = l.upper ? l.text.toUpperCase() : l.text;
  const lines = wrap(ctx, text, Math.max(8, boxW - pad * 2));
  const widest = lines.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);
  ctx.restore();
  const lh = px * l.lineH;
  return { lines, px, lh, pad, textW: widest, w: l.box.on ? Math.min(boxW, widest + pad * 2) : boxW, h: lines.length * lh + pad * 2 };
}
/** The pixel box of a layer: centre, size and rotation (text height is measured, stickers stay square). */
export function layerBox(ctx, l, W, H) {
  if (l.type === 'text') { const m = layoutText(ctx, l, W); return { cx: l.x * W, cy: l.y * H, w: l.box.on ? m.w : l.w * W, h: m.h, rot: l.rot, m }; }
  return { cx: l.x * W, cy: l.y * H, w: l.w * W, h: l.h * H, rot: l.rot };
}
/** Is canvas point (px, py) inside the layer's (rotated) box? */
export function hitLayer(box, px, py, slop = 0) {
  const a = -box.rot * Math.PI / 180, dx = px - box.cx, dy = py - box.cy;
  const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(x) <= box.w / 2 + slop && Math.abs(y) <= box.h / 2 + slop;
}
/** Axis-aligned bounds of a rotated box. */
export function aabb(box) {
  const r = box.rot * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = box.w * c + box.h * s, h = box.w * s + box.h * c;
  return { l: box.cx - w / 2, r: box.cx + w / 2, t: box.cy - h / 2, b: box.cy + h / 2, cx: box.cx, cy: box.cy };
}
/**
 * Snap a moving box to the canvas centre / safe area / other layers. Returns { dx, dy, v: [x...], h: [y...] } in canvas px (the lines to draw).
 * `thr` is the distance in px within which it sticks.
 */
export function snapBox(bounds, others, W, H, safe, thr) {
  const xs = [W / 2, safe.x, safe.x + safe.w, 0, W], ys = [H / 2, safe.y, safe.y + safe.h, 0, H];
  for (const o of others) { xs.push(o.l, o.r, o.cx); ys.push(o.t, o.b, o.cy); }
  const mine = { x: [bounds.l, bounds.cx, bounds.r], y: [bounds.t, bounds.cy, bounds.b] };
  let bx = null, by = null;
  for (const m of mine.x) for (const g of xs) { const d = g - m; if (Math.abs(d) <= thr && (bx === null || Math.abs(d) < Math.abs(bx.d))) bx = { d, g }; }
  for (const m of mine.y) for (const g of ys) { const d = g - m; if (Math.abs(d) <= thr && (by === null || Math.abs(d) < Math.abs(by.d))) by = { d, g }; }
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, v: bx ? [bx.g] : [], h: by ? [by.g] : [] };
}

// ---------------------------------------------------------------- drawing
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function gradFill(ctx, x0, y0, w, h, c1, c2, angle) {
  const a = angle * Math.PI / 180, cx = x0 + w / 2, cy = y0 + h / 2, len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)) || Math.max(w, h);
  const dx = Math.sin(a) * len / 2, dy = -Math.cos(a) * len / 2;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy); g.addColorStop(0, c1); g.addColorStop(1, c2); return g;
}
function drawBackground(ctx, W, H, bg, assets) {
  ctx.save();
  if (bg.type === 'solid') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
  else if (bg.type === 'gradient') { ctx.fillStyle = gradFill(ctx, 0, 0, W, H, bg.color, bg.color2, bg.angle); ctx.fillRect(0, 0, W, H); }
  else if (bg.type === 'image' && assets.bgImage) {
    const im = assets.bgImage, s = (bg.fit === 'contain' ? Math.min : Math.max)(W / im.w, H / im.h), w = im.w * s, h = im.h * s;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (bg.fit === 'contain') { try { ctx.filter = 'blur(24px)'; const c = Math.max(W / im.w, H / im.h); ctx.drawImage(im.img, (W - im.w * c) / 2, (H - im.h * c) / 2, im.w * c, im.h * c); } catch { /* optional */ } ctx.filter = 'none'; }
    ctx.drawImage(im.img, (W - w) / 2, (H - h) / 2, w, h);
  } else if (bg.type === 'frame' && assets.frame) ctx.drawImage(assets.frame, 0, 0, W, H);
  else { ctx.fillStyle = '#1b1b1f'; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}
function drawVectorSticker(ctx, kind, w, h, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color;
  if (kind === 'cross') { const t = w * 0.26; ctx.fillRect(-t / 2, -h / 2, t, h); ctx.fillRect(-w / 2 * 0.72, -h * 0.2, w * 0.72, t); }
  else if (kind === 'burst') { const n = 14; ctx.beginPath(); for (let i = 0; i < n * 2; i++) { const a = i * Math.PI / n, r = i % 2 ? 0.74 : 1; ctx.lineTo(Math.cos(a) * r * w / 2, Math.sin(a) * r * h / 2); } ctx.closePath(); ctx.fill(); }
  else if (kind === 'play') { ctx.beginPath(); ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#ffffff'; const r = Math.min(w, h) * 0.2; ctx.beginPath(); ctx.moveTo(-r * 0.7, -r * 1.1); ctx.lineTo(r * 1.2, 0); ctx.lineTo(-r * 0.7, r * 1.1); ctx.closePath(); ctx.fill(); }
  else { // arrow
    const t = h * 0.28; ctx.beginPath(); ctx.moveTo(-w / 2, -t / 2); ctx.lineTo(w * 0.1, -t / 2); ctx.lineTo(w * 0.1, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(w * 0.1, h / 2); ctx.lineTo(w * 0.1, t / 2); ctx.lineTo(-w / 2, t / 2); ctx.closePath(); ctx.fill();
  }
}
function drawShapePath(ctx, l, w, h) {
  const s = l.shape;
  if (s === 'ellipse') { ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); }
  else if (s === 'round') rr(ctx, -w / 2, -h / 2, w, h, l.radius * Math.min(w, h));
  else if (s === 'triangle') { ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath(); }
  else if (s === 'line') { ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); }
  else if (s === 'arrow') { const t = h * 0.3; ctx.beginPath(); ctx.moveTo(-w / 2, -t / 2); ctx.lineTo(w * 0.15, -t / 2); ctx.lineTo(w * 0.15, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(w * 0.15, h / 2); ctx.lineTo(w * 0.15, t / 2); ctx.lineTo(-w / 2, t / 2); ctx.closePath(); }
  else { ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); }
}
export function drawLayer(ctx, l, W, H, assets) {
  const box = layerBox(ctx, l, W, H);
  ctx.save();
  ctx.translate(box.cx, box.cy); ctx.rotate(l.rot * Math.PI / 180); ctx.globalAlpha = l.opacity;
  if (l.type === 'text') {
    const m = box.m, px = m.px; ctx.font = fontCss(l.font, px); if ('letterSpacing' in ctx) ctx.letterSpacing = (l.spacing * px) + 'px';
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    const left = -box.w / 2 + m.pad, right = box.w / 2 - m.pad;
    if (l.box.on) { ctx.fillStyle = l.box.color; rr(ctx, -box.w / 2, -box.h / 2, box.w, box.h, l.box.radius * px); ctx.fill(); }
    ctx.textAlign = l.align; const ax = l.align === 'left' ? left : l.align === 'right' ? right : 0;
    let y = -box.h / 2 + m.pad + m.lh / 2;
    for (const ln of m.lines) {
      if (l.glow.on) { ctx.shadowColor = l.glow.color; ctx.shadowBlur = l.glow.blur * px; ctx.fillStyle = l.color; ctx.fillText(ln, ax, y); ctx.fillText(ln, ax, y); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
      if (l.shadow.on) { ctx.shadowColor = l.shadow.color; ctx.shadowBlur = l.shadow.blur * px; ctx.shadowOffsetX = l.shadow.dx * px; ctx.shadowOffsetY = l.shadow.dy * px; }
      if (l.stroke.on && l.stroke.w > 0) { ctx.strokeStyle = l.stroke.color; ctx.lineWidth = l.stroke.w * px * 2; ctx.strokeText(ln, ax, y); }
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = l.color; ctx.fillText(ln, ax, y);
      y += m.lh;
    }
  } else if (l.type === 'shape') {
    const w = box.w, h = box.h;
    if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = Math.min(w, h) * 0.12; ctx.shadowOffsetY = Math.min(w, h) * 0.05; }
    drawShapePath(ctx, l, w, h);
    ctx.fillStyle = l.fill2 ? gradFill(ctx, -w / 2, -h / 2, w, h, l.fill, l.fill2, 135) : l.fill; ctx.fill();
    ctx.shadowColor = 'transparent';
    if (l.stroke.on && l.stroke.w > 0) { ctx.strokeStyle = l.stroke.color; ctx.lineWidth = l.stroke.w * W; ctx.lineJoin = 'round'; ctx.stroke(); }
  } else if (l.type === 'sticker') {
    if (l.kind === 'emoji') { ctx.font = emojiFont(box.h * 0.82); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = box.h * 0.06; ctx.shadowOffsetY = box.h * 0.03; ctx.fillText(l.char, 0, box.h * 0.04); }
    else drawVectorSticker(ctx, l.kind, box.w, box.h, l.color);
  } else if (l.type === 'image') {
    const im = assets.images && assets.images.get(l.mediaId), w = box.w, h = box.h;
    if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = Math.min(w, h) * 0.08; ctx.shadowOffsetY = Math.min(w, h) * 0.04; }
    if (im) {
      ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, l.radius * Math.min(w, h)); ctx.clip();
      if (l.flipH) ctx.scale(-1, 1);
      const s = Math.max(w / im.w, h / im.h); ctx.drawImage(im.img, -im.w * s / 2, -im.h * s / 2, im.w * s, im.h * s); ctx.restore();
    } else { ctx.fillStyle = 'rgba(255,255,255,.15)'; rr(ctx, -w / 2, -h / 2, w, h, l.radius * Math.min(w, h)); ctx.fill(); }
    ctx.shadowColor = 'transparent';
    if (l.border.on && l.border.w > 0) { ctx.strokeStyle = l.border.color; ctx.lineWidth = l.border.w * W; rr(ctx, -w / 2, -h / 2, w, h, l.radius * Math.min(w, h)); ctx.stroke(); }
  }
  ctx.restore();
}
/** Draw the whole design: background, darkening, then the layers bottom to top. `assets` = { frame, bgImage, images: Map(mediaId -> {img,w,h}) }; opts.skip = layer ids to leave out. */
export function renderDesign(ctx, W, H, design, assets = {}, opts = {}) {
  if (opts.bgFilter) { // photo adjust / Filters look: only the background is graded, never the text and stickers
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    drawBackground(c.getContext('2d'), W, H, design.bg, assets);
    ctx.drawImage(opts.bgFilter(c) || c, 0, 0, W, H);
  } else drawBackground(ctx, W, H, design.bg, assets);
  const dk = design.adjust.darken;
  if (dk > 0) { ctx.fillStyle = `rgba(0,0,0,${dk})`; ctx.fillRect(0, 0, W, H); }
  for (const l of design.layers) if (!(opts.skip && opts.skip.includes(l.id))) drawLayer(ctx, l, W, H, assets);
}
