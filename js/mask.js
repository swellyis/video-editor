// Masks on a clip's or overlay's own picture: rectangle, ellipse or a pen (freehand) shape, with feather, invert and opacity.
// The mask is applied to the picture before it is placed, so it follows the item's position, zoom, rotation and keyframes,
// and preview and export (same compositor) match. Outside the mask: the clip's background, or see-through for an overlay.
import { kfValue, maskActive } from './model.js';

/** The item's mask at local time `local` with keyframed position / size applied (null when there is no active mask). */
export function maskAt(item, local) {
  if (!maskActive(item)) return null;
  const m = item.mask, kf = item.keyframes || {};
  return { ...m, x: kfValue(kf.mx, local, m.x), y: kfValue(kf.my, local, m.y), w: Math.max(0.01, kfValue(kf.mw, local, m.w)), h: Math.max(0.01, kfValue(kf.mh, local, m.h)) };
}
/** Trace the shape into a 2D path on a W x H picture. */
export function traceMask(ctx, m, W, H) {
  const cx = m.x * W, cy = m.y * H, w = m.w * W, h = m.h * H;
  ctx.beginPath();
  if (m.shape === 'rect') ctx.rect(cx - w / 2, cy - h / 2, w, h);
  else if (m.shape === 'ellipse') ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (m.shape === 'path') {
    const P = m.points.map(([u, v]) => [cx + (u - 0.5) * w, cy + (v - 0.5) * h]), n = P.length;
    // a smooth closed curve through the midpoints of the drawn points
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let s = mid(P[n - 1], P[0]); ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const q = P[i], e = mid(q, P[(i + 1) % n]); ctx.quadraticCurveTo(q[0], q[1], e[0], e[1]); }
    ctx.closePath();
  }
}
const mk = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
/**
 * The picture `img` (iw x ih) with the mask applied, as a canvas at most `maxW` wide. `S` is a per-caller scratch object.
 * filterOK: ctx.filter works (feather); without it the edge is hard.
 */
export function applyMask(img, iw, ih, m, S, filterOK = true, maxW = 1920) {
  const cw = Math.max(2, Math.round(Math.min(iw, maxW))), ch = Math.max(2, Math.round(cw * ih / iw));
  if (!S.pic || S.pic.width !== cw || S.pic.height !== ch) { S.pic = mk(cw, ch); S.px = S.pic.getContext('2d'); S.msk = mk(cw, ch); S.mx = S.msk.getContext('2d'); }
  const x = S.mx; x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.filter = 'none'; x.globalAlpha = 1; x.clearRect(0, 0, cw, ch);
  const op = Math.max(0, Math.min(1, m.opacity ?? 1)), fe = Math.max(0, m.feather || 0) * Math.min(cw, ch);
  if (filterOK && fe > 0.5) x.filter = `blur(${(fe / 2).toFixed(1)}px)`;
  // opacity = how see-through the part you keep is (outside the mask stays hidden)
  if (!m.invert) { x.fillStyle = `rgba(0,0,0,${op})`; traceMask(x, m, cw, ch); x.fill(); }
  else { const f = x.filter; x.filter = 'none'; x.fillStyle = `rgba(0,0,0,${op})`; x.fillRect(0, 0, cw, ch); x.filter = f; x.globalCompositeOperation = 'destination-out'; x.fillStyle = '#000'; traceMask(x, m, cw, ch); x.fill(); }
  x.restore();
  const p = S.px; p.save(); p.globalCompositeOperation = 'source-over'; p.clearRect(0, 0, cw, ch); p.drawImage(img, 0, 0, cw, ch);
  p.globalCompositeOperation = 'destination-in'; p.drawImage(S.msk, 0, 0); p.restore();
  return S.pic;
}
/** Points drawn on the picture (fractions 0..1) -> { x, y, w, h, points } with the points as fractions of their own box. */
export function pathFromPoints(pts) {
  if (pts.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of pts) { x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v); }
  const w = Math.max(0.01, x1 - x0), h = Math.max(0.01, y1 - y0);
  // thin the stroke: keep points at least 0.5 % apart
  const out = []; let last = null;
  for (const [u, v] of pts) { if (last && Math.hypot(u - last[0], v - last[1]) < 0.005) continue; out.push([(u - x0) / w, (v - y0) / h]); last = [u, v]; }
  return out.length >= 3 ? { x: x0 + w / 2, y: y0 + h / 2, w, h, points: out.slice(0, 2000).map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]) } : null;
}
