// Stabilization data the compositor reads synchronously (preview and export alike): media id -> analysis, and memoised corrections.
import { corrections, correctionAt } from './stabilize.js';

const analyses = new Map(); // mediaId -> { v, t0, t1, fps, w, h, dx: Float32Array, dy, da }
const memo = new Map();     // mediaId|mode -> { zoom, frames }

export function setAnalysis(id, a) { if (a) analyses.set(id, a); else analyses.delete(id); for (const k of [...memo.keys()]) if (k.startsWith(id + '|')) memo.delete(k); }
export function getAnalysis(id) { return analyses.get(id) || null; }
export function hasAnalysis(id, t0, t1) { const a = analyses.get(id); return !!a && a.t0 <= t0 + 0.05 && a.t1 >= t1 - 0.1; }

function corrFor(id, mode) {
  const k = id + '|' + mode; let c = memo.get(k); if (c) return c;
  const a = analyses.get(id); if (!a) return null;
  const mot = []; for (let i = 0; i < a.dx.length; i++) mot.push({ dx: a.dx[i], dy: a.dy[i], da: a.da[i] });
  c = corrections(mot, a.fps, mode, a.h / a.w); memo.set(k, c); return c;
}
/** { x, y, a, zoom } for a clip (mode smooth|strong) at source time st, or null when there is nothing to apply. */
export function stabAt(clip, st) {
  if (!clip || !clip.stab || clip.stab === 'off' || clip.kind !== 'video') return null;
  const a = analyses.get(clip.mediaId); if (!a) return null;
  const c = corrFor(clip.mediaId, clip.stab); if (!c) return null;
  const r = correctionAt(c, a.t0, a.fps, st);
  return { x: r.x, y: r.y, a: r.a, zoom: c.zoom };
}
/** Crop/zoom a mode needs for a media (for the UI). */
export function stabZoom(id, mode) { const c = corrFor(id, mode); return c ? c.zoom : null; }
