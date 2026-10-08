// Stabilization analysis on this device: decode the clip's frames small (192 px wide, from the proxy when there is one), estimate the
// global motion between neighbours (stabilize.js) and cache the result per media file (IndexedDB kv 'st:<id>', versioned).
import { loadMediabunny } from './media.js';
import { db } from './db.js';
import { ANALYSIS_W, STAB_V, estimateMotion } from './stabilize.js';

export class StabCancelled extends Error { constructor() { super('Cancelled'); this.name = 'StabCancelled'; } }
const KEY = 'st:';

export async function loadAnalysis(id) {
  const a = await db.kvGet(KEY + id).catch(() => null);
  return a && a.v === STAB_V ? a : null;
}
export const deleteAnalysis = (id) => db.kvDel(KEY + id).catch(() => { });

/**
 * Analyse [t0, t1] of a video Blob. onProgress(frac). Returns { v, t0, t1, fps, w, h, dx, dy, da, ms, frames }.
 * dx, dy are fractions of the width; da radians (motion of the picture from one frame to the next).
 */
export async function analyse(blob, t0, t1, { signal, onProgress } = {}) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const T0 = performance.now();
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser can’t decode this video for stabilizing.');
    const first = await track.getFirstTimestamp().catch(() => 0), off = first > 0 ? first : 0;
    const w = ANALYSIS_W, h = Math.max(16, Math.round(w * track.displayHeight / track.displayWidth / 2) * 2);
    const sink = new mb.CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 2 });
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const dx = [], dy = [], da = [], times = [];
    let prev = null, lastYield = performance.now();
    for await (const r of sink.canvases(t0 + off, t1 + off)) {
      if (signal && signal.aborted) throw new StabCancelled();
      cx.drawImage(r.canvas, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      times.push(r.timestamp - off);
      if (prev) { const m = estimateMotion(prev, g, w, h); dx.push(m.dx / w); dy.push(m.dy / w); da.push(m.da); }
      else { dx.push(0); dy.push(0); da.push(0); }
      prev = g;
      if (onProgress) onProgress(Math.min(1, (r.timestamp - off - t0) / Math.max(0.01, t1 - t0)));
      if (performance.now() - lastYield > 40) { await new Promise(res => setTimeout(res, 0)); lastYield = performance.now(); }
    }
    if (times.length < 2) throw new Error('Too few frames to stabilize.');
    const fps = (times.length - 1) / Math.max(0.001, times[times.length - 1] - times[0]);
    return { v: STAB_V, t0: times[0], t1: times[times.length - 1], fps, w, h, dx: Float32Array.from(dx), dy: Float32Array.from(dy), da: Float32Array.from(da), ms: Math.round(performance.now() - T0), frames: times.length };
  } finally { input.dispose && input.dispose(); }
}
export async function saveAnalysis(id, a) { await db.kvSet(KEY + id, a); }
