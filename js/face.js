// On-device face detection (MediaPipe BlazeFace via @mediapipe/tasks-vision).
// WASM + models are vendored under vendor/mediapipe/. First fetch is cached by the service worker
// in `video-editor-ai` (same pattern as Whisper), then it works offline.
import { FilesetResolver, FaceDetector } from '../vendor/mediapipe/vision_bundle.mjs';

export const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
export const MODEL_FULL = new URL('../vendor/mediapipe/models/blaze_face_full_range.tflite', import.meta.url).href;
export const MODEL_SHORT = new URL('../vendor/mediapipe/models/blaze_face_short_range.tflite', import.meta.url).href;
export const CACHE_NAME = 'video-editor-ai';

/** Approximate download sizes shown in the UI (vendored on this site). */
export const FACE_MB = { wasm: 9.5, full: 1.1, short: 0.23 };

/** Test seam: set hooks.createDetector to return { detect(image) → {detections} }. */
export const hooks = { createDetector: null };

let _det = null, _mode = null, _loading = null;

/** Is the face model (and WASM) already in the AI cache? */
export async function isFaceCached() {
  try {
    if (!('caches' in self) || !(await caches.has(CACHE_NAME))) return false;
    const c = await caches.open(CACHE_NAME);
    const keys = await c.keys();
    const hasWasm = keys.some(r => /vision_wasm_internal\.wasm/.test(r.url));
    const hasModel = keys.some(r => /blaze_face_.*\.tflite/.test(r.url));
    return hasWasm && hasModel;
  } catch { return false; }
}

async function warm(url) {
  try {
    if (!('caches' in self)) { await fetch(url); return; }
    const c = await caches.open(CACHE_NAME);
    const hit = await c.match(url, { ignoreSearch: true });
    if (hit) return;
    const res = await fetch(url);
    if (res.ok) await c.put(url, res.clone());
  } catch { /* network / private mode — FaceDetector will fetch itself */ }
}

/**
 * Load (or reuse) a FaceDetector. mode: 'full' (sermons / distance) or 'short' (close-up).
 * onProgress({ phase, frac }) optional.
 */
export async function loadFaceDetector({ mode = 'full', onProgress } = {}) {
  if (hooks.createDetector) return hooks.createDetector({ mode });
  if (_det && _mode === mode) return _det;
  if (_loading) return _loading;
  _loading = (async () => {
    onProgress && onProgress({ phase: 'download', frac: 0 });
    const model = mode === 'short' ? MODEL_SHORT : MODEL_FULL;
    await warm(WASM_BASE + '/vision_wasm_internal.wasm');
    onProgress && onProgress({ phase: 'download', frac: 0.55 });
    await warm(model);
    onProgress && onProgress({ phase: 'load', frac: 0.75 });
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    const det = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: model, delegate: 'GPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.45,
    });
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
  if (hooks.createDetector && det.detect) {
    const r = det.detect(image);
    if (Array.isArray(r)) return r;
    return normDetections(r, image.videoWidth || image.naturalWidth || image.width, image.videoHeight || image.naturalHeight || image.height);
  }
  const r = det.detect(image);
  const iw = image.videoWidth || image.naturalWidth || image.width;
  const ih = image.videoHeight || image.naturalHeight || image.height;
  return normDetections(r, iw, ih);
}

export function closeFaceDetector() {
  if (_det && _det.close) try { _det.close(); } catch { /* */ }
  _det = null; _mode = null;
}
