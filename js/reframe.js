// Auto reframe: turn face detections into smooth pan/zoom keyframes for a target aspect ratio.
// Pure functions (no DOM / MediaPipe) so unit tests stay fast. The runner in reframe-run.js samples frames.
import { RATIOS } from './model.js';

export const TARGETS = {
  '9:16': { key: '9:16', label: 'Vertical 9:16', ratio: 9 / 16 },
  '1:1': { key: '1:1', label: 'Square 1:1', ratio: 1 },
  '4:5': { key: '4:5', label: 'Portrait 4:5', ratio: 4 / 5 },
  '16:9': { key: '16:9', label: 'Widescreen 16:9', ratio: 16 / 9 },
};

export const DEFAULTS = {
  sampleSec: 0.4,       // how often to sample (clip-local seconds)
  deadZone: 0.06,       // ignore pan moves smaller than this (−1..1)
  zoomDead: 0.03,       // ignore tiny zoom changes
  maxStep: 0.35,        // clamp pan jump per sample (stops teleport after a miss)
  facePad: 1.85,        // how much larger than the face the crop window aims to be
  minZoom: 1,
  maxZoom: 2.8,
  ease: 'ease-in-out',
  confMin: 0.45,        // drop weak detections
  holdMiss: 3,          // keep last good face for N misses before falling back to centre
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Resolve a target key or numeric ratio to { key, ratio }. Unknown → project / 9:16. */
export function resolveTarget(target, projectRatio) {
  if (target && TARGETS[target]) return TARGETS[target];
  if (target === 'project' || target === 'auto') {
    const k = projectRatio && TARGETS[projectRatio] ? projectRatio : '9:16';
    return TARGETS[k];
  }
  const n = +target;
  if (Number.isFinite(n) && n > 0) return { key: 'custom', label: 'Custom', ratio: n };
  return TARGETS['9:16'];
}

/**
 * Cover-fit placement size for a source (sw×sh) into a frame whose aspect is `ratio`
 * at a given zoom. Returns the scaled size and the horizontal/vertical overflow half-spans.
 */
export function coverSize(sw, sh, ratio, zoom = 1) {
  const W = ratio >= 1 ? ratio : 1, H = ratio >= 1 ? 1 : 1 / ratio; // unit frame
  const z = Math.max(0.05, zoom);
  const base = Math.max(W / sw, H / sh);
  const s = base * z;
  const dw = sw * s, dh = sh * s;
  return { W, H, s, dw, dh, ox: Math.max(0, (dw - W) / 2), oy: Math.max(0, (dh - H) / 2) };
}

/**
 * Pan (−1..1) that puts source point (fx, fy) in [0..1] at the centre of the cover crop.
 * When there is no overflow on an axis, that pan is 0.
 */
export function panForPoint(fx, fy, sw, sh, ratio, zoom = 1) {
  const { dw, dh, ox, oy } = coverSize(sw, sh, ratio, zoom);
  const px = ox > 1e-6 ? clamp(((fx - 0.5) * dw) / ox, -1, 1) : 0;
  const py = oy > 1e-6 ? clamp(((fy - 0.5) * dh) / oy, -1, 1) : 0;
  return { x: r3(px), y: r3(py) };
}

/**
 * Zoom so a face box (nx,ny,nw,nh in 0..1 of source) fits comfortably in the crop,
 * with facePad. Never below minZoom / above maxZoom.
 */
export function zoomForFace(face, sw, sh, ratio, { facePad = DEFAULTS.facePad, minZoom = DEFAULTS.minZoom, maxZoom = DEFAULTS.maxZoom } = {}) {
  const { W, H } = coverSize(sw, sh, ratio, 1);
  const fw = Math.max(1e-3, face.w) * sw, fh = Math.max(1e-3, face.h) * sh;
  // At zoom z, the visible source window is roughly (W/(base*z)) × (H/(base*z)).
  const base = Math.max(W / sw, H / sh);
  const visW = W / base, visH = H / base; // source pixels visible at z=1
  const need = Math.max(visW / (fw * facePad), visH / (fh * facePad));
  return r3(clamp(need, minZoom, maxZoom));
}

/** Pick the best face from a MediaPipe-like list: highest score among large boxes, prefer centre. */
export function pickFace(dets, { confMin = DEFAULTS.confMin } = {}) {
  const list = (dets || []).map(d => {
    const b = d.box || d.boundingBox || d;
    // MediaPipe: originX/Y, width, height in pixels — caller may already normalise.
    const x = b.x ?? b.originX ?? b.xmin ?? 0;
    const y = b.y ?? b.originY ?? b.ymin ?? 0;
    const w = b.w ?? b.width ?? ((b.xmax ?? 0) - x);
    const h = b.h ?? b.height ?? ((b.ymax ?? 0) - y);
    const score = d.score ?? d.categories?.[0]?.score ?? d.confidence ?? 1;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, score: +score || 0, area: Math.max(0, w) * Math.max(0, h) };
  }).filter(f => f.w > 0 && f.h > 0 && f.score >= confMin);
  if (!list.length) return null;
  list.sort((a, b) => {
    const ca = 1 - Math.hypot(a.cx - 0.5, a.cy - 0.5);
    const cb = 1 - Math.hypot(b.cx - 0.5, b.cy - 0.5);
    return (b.area * (0.5 + b.score) * (0.6 + ca)) - (a.area * (0.5 + a.score) * (0.6 + cb));
  });
  return list[0];
}

/**
 * One sample → desired { x, y, zoom }. No face → centre at zoom 1 (or keep last if holdMiss).
 */
export function sampleToPose(face, sw, sh, ratio, opts = {}, last = null, missStreak = 0) {
  const o = { ...DEFAULTS, ...opts };
  if (!face) {
    if (last && missStreak < o.holdMiss) return { ...last, held: true, miss: missStreak + 1 };
    return { x: 0, y: 0, zoom: 1, held: false, miss: missStreak + 1, fallback: true };
  }
  const zoom = zoomForFace(face, sw, sh, ratio, o);
  const pan = panForPoint(face.cx, face.cy, sw, sh, ratio, zoom);
  return { x: pan.x, y: pan.y, zoom, held: false, miss: 0, fallback: false };
}

/** Apply dead-zone + max-step smoothing between consecutive poses. */
export function smoothPose(prev, next, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!prev) return { x: next.x, y: next.y, zoom: next.zoom };
  const step = (a, b, dead, maxS) => {
    const d = b - a;
    if (Math.abs(d) < dead) return a;
    return a + clamp(d, -maxS, maxS);
  };
  return {
    x: r3(step(prev.x, next.x, o.deadZone, o.maxStep)),
    y: r3(step(prev.y, next.y, o.deadZone, o.maxStep)),
    zoom: r3(step(prev.zoom, next.zoom, o.zoomDead, 0.25)),
  };
}

/**
 * Build sparse keyframe tracks from timed poses [{ t, x, y, zoom }].
 * Drops near-duplicates; always keeps first and last. ease defaults to ease-in-out.
 */
export function posesToKeyframes(poses, { ease = DEFAULTS.ease, minDelta = 0.04, minZoomDelta = 0.02 } = {}) {
  const sorted = [...(poses || [])].sort((a, b) => a.t - b.t);
  if (!sorted.length) return { x: [], y: [], scale: [] };
  const keep = [sorted[0]];
  for (let i = 1; i < sorted.length - 1; i++) {
    const p = sorted[i], prev = keep[keep.length - 1];
    if (Math.abs(p.x - prev.x) >= minDelta || Math.abs(p.y - prev.y) >= minDelta || Math.abs(p.zoom - prev.zoom) >= minZoomDelta) keep.push(p);
  }
  if (sorted.length > 1) keep.push(sorted[sorted.length - 1]);
  const track = (prop, key) => keep.map(p => ({ t: r3(p.t), v: r3(p[key]), ease }));
  return { x: track('x', 'x'), y: track('y', 'y'), scale: track('zoom', 'zoom') };
}

/**
 * Write reframe keyframes onto a clip (mutates). Clears prior x/y/scale keys then sets new ones.
 * Also sets transform base to the first key (or centre) and fit to cover so the crop fills the frame.
 * Returns { keys, faces, fallbacks }.
 */
export function applyReframeToClip(clip, keyframes, { setFit = true } = {}) {
  clip.keyframes = clip.keyframes || {};
  for (const p of ['x', 'y', 'scale']) {
    if (keyframes[p] && keyframes[p].length) clip.keyframes[p] = keyframes[p].map(k => ({ ...k }));
    else delete clip.keyframes[p];
  }
  const firstX = keyframes.x && keyframes.x[0], firstY = keyframes.y && keyframes.y[0], firstZ = keyframes.scale && keyframes.scale[0];
  clip.transform = {
    ...(clip.transform || {}),
    x: firstX ? firstX.v : 0,
    y: firstY ? firstY.v : 0,
    zoom: firstZ ? firstZ.v : 1,
    kenBurns: 'none',
  };
  if (setFit) clip.fit = 'cover';
  return {
    keys: (keyframes.x || []).length,
    hasMotion: !!(keyframes.x && keyframes.x.length > 1),
  };
}

/**
 * Turn a list of per-sample detections into smoothed poses then keyframes.
 * samples: [{ t, faces: [{x,y,w,h,score}] }] with boxes normalised 0..1.
 */
export function buildReframe(samples, sw, sh, target, opts = {}) {
  const tg = resolveTarget(target);
  const ratio = tg.ratio || RATIOS[tg.key] || (9 / 16);
  const o = { ...DEFAULTS, ...opts };
  let last = null, miss = 0;
  const poses = [];
  let faces = 0, fallbacks = 0;
  for (const s of samples || []) {
    const face = pickFace(s.faces, o);
    if (face) faces++;
    const raw = sampleToPose(face, sw, sh, ratio, o, last, miss);
    miss = raw.miss || 0;
    if (raw.fallback) fallbacks++;
    const sm = smoothPose(last, raw, o);
    last = { x: sm.x, y: sm.y, zoom: sm.zoom };
    poses.push({ t: s.t, ...last });
  }
  const keyframes = posesToKeyframes(poses, o);
  return { keyframes, poses, faces, fallbacks, target: tg, ratio };
}

export class ReframeCancelled extends Error {
  constructor() { super('Auto reframe cancelled'); this.name = 'ReframeCancelled'; }
}
