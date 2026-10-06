// On-device face detection (MediaPipe BlazeFace via @mediapipe/tasks-vision).
// WASM + models are vendored under vendor/mediapipe/. First fetch is cached by the service worker
// in `video-editor-ai` (same pattern as Whisper), then it works offline.
import { FilesetResolver, FaceDetector } from '../vendor/mediapipe/vision_bundle.mjs';
import { aiKey } from './ai-manifest.js';

export const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
export const MODEL_SHORT = new URL('../vendor/mediapipe/models/blaze_face_short_range.tflite', import.meta.url).href;
/** @deprecated full-range TFLite mismatches this tasks-vision graph; alias to short. */
export const MODEL_FULL = MODEL_SHORT;
export const CACHE_NAME = 'video-editor-ai';

/** Approximate download sizes shown in the UI (vendored on this site). */
export const FACE_MB = { wasm: 9.5, short: 0.23, total: 9.8 }; // short-range model (full-range TFLite is incompatible with this WASM build)

/** Test seam: set hooks.createDetector to return { detect(image) → {detections} }. */
export const hooks = { createDetector: null };

let _det = null, _mode = null, _loading = null;

/** Is the face model (and WASM) already in the AI cache? */
export async function isFaceCached() {
  try {
    if (!('caches' in self) || !(await caches.has(CACHE_NAME))) return false;
    const c = await caches.open(CACHE_NAME);
    return !!(await c.match(aiKey(WASM_BASE + '/vision_wasm_internal.wasm'))) && !!(await c.match(aiKey(MODEL_SHORT))); // this version's files
  } catch { return false; }
}

async function warm(url) {
  try {
    if (!('caches' in self)) { await fetch(url); return; }
    const c = await caches.open(CACHE_NAME);
    const hit = await c.match(aiKey(url)); // versioned key (js/ai-manifest.js): a stale copy from an older release doesn't count
    if (hit) return;
    const res = await fetch(url, { cache: 'no-cache' }); // through the service worker, which stores it under the same key
    if (res.ok && !(await c.match(aiKey(url)))) await c.put(aiKey(url), res.clone());
  } catch { /* network / private mode — FaceDetector will fetch itself */ }
}

/**
 * Load (or reuse) a FaceDetector. mode: 'full' (sermons / distance) or 'short' (close-up).
 * onProgress({ phase, frac }) optional.
 */
export async function loadFaceDetector({ mode = 'short', onProgress } = {}) {
  if (hooks.createDetector) return hooks.createDetector({ mode });
  // BlazeFace full-range float16 currently mismatches this tasks-vision graph (2304 vs 896 boxes) — use short-range.
  if (mode === 'full') mode = 'short';
  if (_det && _mode === mode) return _det;
  if (_loading) return _loading;
  _loading = (async () => {
    onProgress && onProgress({ phase: 'download', frac: 0 });
    const model = MODEL_SHORT;
    await warm(WASM_BASE + '/vision_wasm_internal.wasm');
    onProgress && onProgress({ phase: 'download', frac: 0.55 });
    await warm(model);
    onProgress && onProgress({ phase: 'load', frac: 0.75 });
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    let det;
    try {
      det = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'GPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45,
      });
    } catch (e) {
      // CPU fallback when GPU delegate fails
      det = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45,
      });
    }
    if (_det && _det.close) try { _det.close(); } catch { /* */ }
    _det = det; _mode = mode;
    onProgress && onProgress({ phase: 'load', frac: 1 });
    return det;
  })();
  try { return await _loading; } finally { _loading = null; }
}

/** Normalise MediaPipe detections to [{x,y,w,h,score}] in 0..1 of the image. */
export function normDetections(result, iw, ih) {
  const W = Math.max(1, iw), H = Math.max(1, ih);
  const out = [];
  for (const d of (result && result.detections) || []) {
    const b = d.boundingBox; if (!b) continue;
    const score = (d.categories && d.categories[0] && d.categories[0].score) || 0;
    out.push({
      x: b.originX / W, y: b.originY / H,
      w: b.width / W, h: b.height / H,
      score,
    });
  }
  return out;
}

/** Detect faces on a canvas/video/image. Returns normalised boxes. */
export async function detectFaces(det, image) {
  if (!det) return [];
  try {
    if (hooks.createDetector && det.detect) {
      const r = det.detect(image);
      if (Array.isArray(r)) return r;
      return normDetections(r, image.videoWidth || image.naturalWidth || image.width, image.videoHeight || image.naturalHeight || image.height);
    }
    const r = det.detect(image);
    const iw = image.videoWidth || image.naturalWidth || image.width;
    const ih = image.videoHeight || image.naturalHeight || image.height;
    return normDetections(r, iw, ih);
  } catch (e) {
    console.warn('face detect failed', e);
    return [];
  }
}

export function closeFaceDetector() {
  if (_det && _det.close) try { _det.close(); } catch { /* */ }
  _det = null; _mode = null;
}
