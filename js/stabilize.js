// Stabilization (pure math, no DOM): global motion between frames, a smoothed camera path, and the per-frame correction + zoom.
// Frames are small grey images (Uint8Array, w*h). Motion is a similarity transform (shift, rotation, scale) fitted to block matches.
// Shifts are stored as fractions of the analysis width, so they apply to the proxy, the original or any export size alike.

export const STAB_V = 2;
export const ANALYSIS_W = 192;
export const MODES = { smooth: { sigma: 0.5, maxZoom: 1.12 }, strong: { sigma: 2.2, maxZoom: 1.25 } };

/** Box-downsample a grey image by 2. */
function half(g, w, h) {
  const w2 = w >> 1, h2 = h >> 1, o = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = 2 * y * w + 2 * x; o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) >> 2; }
  return { g: o, w: w2, h: h2 };
}
/** Sum of absolute differences of a B x B block at (x,y) in a vs (x+dx,y+dy) in b (Infinity if outside). */
function sad(a, b, w, h, x, y, dx, dy, B, best) {
  const x2 = x + dx, y2 = y + dy;
  if (x2 < 0 || y2 < 0 || x2 + B > w || y2 + B > h) return Infinity;
  let s = 0;
  for (let j = 0; j < B; j++) {
    const ra = (y + j) * w + x, rb = (y2 + j) * w + x2;
    for (let i = 0; i < B; i++) { const d = a[ra + i] - b[rb + i]; s += d < 0 ? -d : d; }
    if (s >= best) return s;
  }
  return s;
}
function blockVar(a, w, x, y, B) {
  let s = 0, s2 = 0; for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const v = a[(y + j) * w + x + i]; s += v; s2 += v * v; }
  const n = B * B; return s2 / n - (s / n) * (s / n);
}
/** Best shift of one block, searching +-R around (gx,gy). Returns [dx,dy,cost]. */
function search(a, b, w, h, x, y, B, gx, gy, R) {
  let bd = [gx, gy], bc = Infinity;
  for (let dy = gy - R; dy <= gy + R; dy++) for (let dx = gx - R; dx <= gx + R; dx++) { const c = sad(a, b, w, h, x, y, dx, dy, B, bc); if (c < bc) { bc = c; bd = [dx, dy]; } }
  if (!Number.isFinite(bc)) return [bd[0], bd[1], bc];
  // sub-pixel: a parabola through the costs either side of the best match
  const sub = (cm, cp) => { const den = cm - 2 * bc + cp; return Number.isFinite(den) && den > 0 ? Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * den))) : 0; };
  const ox = sub(sad(a, b, w, h, x, y, bd[0] - 1, bd[1], B, Infinity), sad(a, b, w, h, x, y, bd[0] + 1, bd[1], B, Infinity));
  const oy = sub(sad(a, b, w, h, x, y, bd[0], bd[1] - 1, B, Infinity), sad(a, b, w, h, x, y, bd[0], bd[1] + 1, B, Infinity));
  return [bd[0] + ox, bd[1] + oy, bc];
}

/** Whole-frame shift of b against a (inner area, every 'step' pixel), searching +-R around (gx, gy). */
function globalShift(a, b, w, h, gx, gy, R, step) {
  const m = Math.ceil(Math.max(R + Math.abs(gx), R + Math.abs(gy))) + 1;
  let best = [gx, gy], bc;
  const cost = (dx, dy, lim) => { let s = 0; for (let y = m; y < h - m && s < lim; y += step) { const ra = y * w, rb = (y + dy) * w + dx; for (let x = m; x < w - m; x += step) { const d = a[ra + x] - b[rb + x]; s += d < 0 ? -d : d; } } return s; };
  bc = cost(gx, gy, Infinity); // ties keep the guess (a flat frame doesn't "move")
  for (let dy = gy - R; dy <= gy + R; dy++) for (let dx = gx - R; dx <= gx + R; dx++) {
    if (dx === gx && dy === gy) continue;
    let s = 0;
    for (let y = m; y < h - m && s < bc; y += step) { const ra = y * w, rb = (y + dy) * w + dx; for (let x = m; x < w - m; x += step) { const d = a[ra + x] - b[rb + x]; s += d < 0 ? -d : d; } }
    if (s < bc) { bc = s; best = [dx, dy]; }
  }
  return best;
}

/** Mean absolute difference of b shifted by (dx,dy) against a over the shared inner area. */
function frameCost(a, b, w, h, dx, dy) {
  const m = 26; let s = 0, n = 0;
  for (let y = m; y < h - m; y += 2) { const ra = y * w, rb = (y + dy) * w + dx; for (let x = m; x < w - m; x += 2) { const d = a[ra + x] - b[rb + x]; s += d < 0 ? -d : d; n++; } }
  return s / Math.max(1, n);
}
/**
 * Repair single-frame glitches in a motion series (a false match shows as one frame jumping far from its neighbours):
 * a value further than max(minJump, 4 x local spread) from the median of its 7 neighbours is replaced by that median. In place.
 */
export function repairOutliers(arr, minJump) {
  const n = arr.length, src = Array.from(arr); let fixed = 0;
  for (let i = 0; i < n; i++) {
    const win = []; for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (j !== i) win.push(src[j]);
    if (win.length < 3) continue;
    win.sort((x, y) => x - y); const med = win[win.length >> 1];
    const mad = win.map(v => Math.abs(v - med)).sort((x, y) => x - y)[win.length >> 1];
    if (Math.abs(src[i] - med) > Math.max(minJump, 4 * mad)) { arr[i] = med; fixed++; }
  }
  return fixed;
}
/**
 * Global motion from frame a to frame b (grey, w*h). Returns { dx, dy, da, ds, n } with dx,dy in pixels of this size,
 * da in radians, ds = log scale; n = blocks used. A whole-frame shift found coarse-to-fine (robust to repeating patterns), then
 * block matches around it and a robust similarity fit for rotation and zoom.
 */
export function estimateMotion(a, b, w, h) {
  const A1 = half(a, w, h), B1 = half(b, w, h), A2 = half(A1.g, A1.w, A1.h), B2 = half(B1.g, B1.w, B1.h);
  let [gx, gy] = globalShift(A2.g, B2.g, A2.w, A2.h, 0, 0, 6, 1);         // +-24 px at full size
  [gx, gy] = globalShift(A1.g, B1.g, A1.w, A1.h, gx * 2, gy * 2, 2, 1);
  [gx, gy] = globalShift(a, b, w, h, gx * 2, gy * 2, 2, 2);
  if (gx || gy) { // a repeating pattern can fool the coarse level: also try "small motion" and keep whichever matches better at full size
    let [zx, zy] = globalShift(A1.g, B1.g, A1.w, A1.h, 0, 0, 2, 1);
    [zx, zy] = globalShift(a, b, w, h, zx * 2, zy * 2, 2, 2);
    if ((zx !== gx || zy !== gy) && frameCost(a, b, w, h, zx, zy) <= frameCost(a, b, w, h, gx, gy)) { gx = zx; gy = zy; }
  }
  const B = 16, cols = 7, rows = 5, vecs = [];
  const mx = Math.max(B, Math.round(w * 0.1)), my = Math.max(B, Math.round(h * 0.1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = Math.round(mx + (w - 2 * mx - B) * c / (cols - 1)), y = Math.round(my + (h - 2 * my - B) * r / (rows - 1));
    if (blockVar(a, w, x, y, B) < 25) continue; // flat: no information
    const [fx, fy, cost] = search(a, b, w, h, x, y, B, gx, gy, 3);
    if (!Number.isFinite(cost)) continue;
    vecs.push({ x: x + B / 2 - w / 2, y: y + B / 2 - h / 2, u: fx, v: fy, cost });
  }
  if (vecs.length < 4) return { dx: gx, dy: gy, da: 0, ds: 0, n: vecs.length };
  let use = vecs, fit = null;
  for (let it = 0; it < 3; it++) {
    fit = fitSimilarity(use);
    const res = vecs.map(p => { const [px, py] = apply(fit, p.x, p.y); return Math.hypot(px - (p.x + p.u), py - (p.y + p.v)); });
    const sorted = [...res].sort((x, y) => x - y), med = sorted[sorted.length >> 1];
    const keep = vecs.filter((_, i) => res[i] <= Math.max(1.0, med * 2.5));
    if (keep.length < 4 || keep.length === use.length) break;
    use = keep;
  }
  return { dx: fit.tx, dy: fit.ty, da: Math.atan2(fit.b, fit.a), ds: Math.log(Math.hypot(fit.a, fit.b)), n: use.length };
}
const apply = (f, x, y) => [f.a * x - f.b * y + f.tx, f.b * x + f.a * y + f.ty];
/** Least-squares similarity x' = a x - b y + tx, y' = b x + a y + ty from points {x,y,u,v}. */
export function fitSimilarity(pts) {
  const n = pts.length; let mx = 0, my = 0, mX = 0, mY = 0;
  for (const p of pts) { mx += p.x; my += p.y; mX += p.x + p.u; mY += p.y + p.v; }
  mx /= n; my /= n; mX /= n; mY /= n;
  let sxx = 0, sab = 0, sba = 0;
  for (const p of pts) { const x = p.x - mx, y = p.y - my, X = p.x + p.u - mX, Y = p.y + p.v - mY; sxx += x * x + y * y; sab += x * X + y * Y; sba += x * Y - y * X; }
  const a = sxx > 1e-9 ? sab / sxx : 1, b = sxx > 1e-9 ? sba / sxx : 0;
  return { a, b, tx: mX - (a * mx - b * my), ty: mY - (b * mx + a * my) };
}

/** Gaussian smoothing with mirrored ends. */
export function gaussSmooth(arr, sigma) {
  const n = arr.length; if (n < 3 || sigma <= 0) return arr.slice();
  const R = Math.ceil(sigma * 3), k = []; let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const at = (i) => { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; return arr[Math.max(0, Math.min(n - 1, i))]; };
  const out = new Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -R; j <= R; j++) s += k[j + R] * at(i + j); out[i] = s / ks; }
  return out;
}

/**
 * Corrections for a run of motions (frame i-1 -> i, normalised: dx,dy as fractions of the width; da radians), mode 'smooth'|'strong'.
 * aspect = h/w. Returns { zoom, frames: [{ x, y, a }] } where x,y are fractions of the width to MOVE the picture and a radians to
 * rotate it, so that the camera follows the smoothed path; zoom hides the moving edges (capped; corrections are clamped to fit).
 */
export function corrections(motions, fps, mode, aspect = 9 / 16) {
  const M = MODES[mode] || MODES.smooth, n = motions.length;
  if (!n) return { zoom: 1, frames: [] };
  const X = [], Y = [], Aa = []; let x = 0, y = 0, a = 0;
  for (const m of motions) { x += m.dx; y += m.dy; a += m.da; X.push(x); Y.push(y); Aa.push(a); }
  const sg = M.sigma * fps;
  const SX = gaussSmooth(X, sg), SY = gaussSmooth(Y, sg), SA = gaussSmooth(Aa, sg);
  let cx = X.map((v, i) => SX[i] - v), cy = Y.map((v, i) => SY[i] - v), ca = Aa.map((v, i) => SA[i] - v);
  // zoom needed so the moved/rotated picture still covers the frame: 1 + 2|shift| (+ rotation term), capped
  const need = (i) => Math.max(1 + 2 * Math.abs(cx[i]), 1 + 2 * Math.abs(cy[i]) / aspect) + Math.abs(Math.sin(ca[i])) * (1 / aspect + aspect) * 0.5;
  let zoom = 1; for (let i = 0; i < n; i++) zoom = Math.max(zoom, need(i));
  zoom = Math.min(zoom, M.maxZoom);
  // clamp each correction to the margin the zoom gives
  const mX = (zoom - 1) / 2, mY = (zoom - 1) / 2 * aspect;
  cx = cx.map(v => Math.max(-mX, Math.min(mX, v))); cy = cy.map(v => Math.max(-mY, Math.min(mY, v)));
  const aMax = Math.max(0.0001, (zoom - 1) * 0.6); ca = ca.map(v => Math.max(-aMax, Math.min(aMax, v)));
  return { zoom, frames: cx.map((v, i) => ({ x: v, y: cy[i], a: ca[i] })) };
}

/**
 * Correction at source time t from an analysis { t0, fps, frames }: the frame a decoder shows at t (the last one that started at or
 * before t). No blending: shake is different on every frame, so a blend of two frames' corrections would correct neither.
 */
export function correctionAt(corr, t0, fps, t) {
  const f = corr.frames; if (!f.length) return { x: 0, y: 0, a: 0 };
  const i = Math.max(0, Math.min(f.length - 1, Math.floor((t - t0) * fps + 0.02)));
  return { x: f[i].x, y: f[i].y, a: f[i].a };
}

/** Jitter measure: RMS of the frame-to-frame shift minus its smoothed version (fractions of the width). */
export function jitter(motions, fps) {
  if (motions.length < 3) return 0;
  const dx = motions.map(m => m.dx), dy = motions.map(m => m.dy);
  const sx = gaussSmooth(dx, fps * 0.5), sy = gaussSmooth(dy, fps * 0.5);
  let s = 0; for (let i = 0; i < dx.length; i++) s += (dx[i] - sx[i]) ** 2 + (dy[i] - sy[i]) ** 2;
  return Math.sqrt(s / dx.length);
}
