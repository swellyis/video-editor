// On-device person segmentation (MediaPipe Selfie Segmenter). WASM shared with face.js under vendor/mediapipe/.
// First fetch cached in video-editor-ai (service worker); then offline.
import { FilesetResolver, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

export const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
export const MODEL_LANDSCAPE = new URL('../vendor/mediapipe/models/selfie_segmenter_landscape.tflite', import.meta.url).href;
export const MODEL_SQUARE = new URL('../vendor/mediapipe/models/selfie_segmenter.tflite', import.meta.url).href;
export const CACHE_NAME = 'video-editor-ai';
export const SEG_MB = { wasm: 9.5, landscape: 0.25, square: 0.25, total: 10 }; // wasm shared with face if already cached

export const hooks = { createSegmenter: null };

let _seg = null, _kind = null, _loading = null;

async function warm(url) {
  try {
    if (!('caches' in self)) { await fetch(url); return; }
    const c = await caches.open(CACHE_NAME);
    if (await c.match(url, { ignoreSearch: true })) return;
    const res = await fetch(url);
    if (res.ok) await c.put(url, res.clone());
  } catch { /* */ }
}

export async function isSegCached() {
  try {
    if (!('caches' in self) || !(await caches.has(CACHE_NAME))) return false;
    const keys = await (await caches.open(CACHE_NAME)).keys();
    return keys.some(r => /selfie_segmenter.*\.tflite/.test(r.url)) && keys.some(r => /vision_wasm_internal\.wasm/.test(r.url));
  } catch { return false; }
}

/** kind: 'landscape' (16:9 sermons, default) | 'square' */
export async function loadSegmenter({ kind = 'landscape', onProgress } = {}) {
  if (hooks.createSegmenter) return hooks.createSegmenter({ kind });
  if (_seg && _kind === kind) return _seg;
  if (_loading) return _loading;
  _loading = (async () => {
    onProgress && onProgress({ phase: 'download', frac: 0 });
    const model = kind === 'square' ? MODEL_SQUARE : MODEL_LANDSCAPE;
    await warm(WASM_BASE + '/vision_wasm_internal.wasm');
    onProgress && onProgress({ phase: 'download', frac: 0.5 });
    await warm(model);
    onProgress && onProgress({ phase: 'load', frac: 0.75 });
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    const opts = {
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    };
    let seg;
    try {
      seg = await ImageSegmenter.createFromOptions(vision, { ...opts, baseOptions: { modelAssetPath: model, delegate: 'GPU' } });
    } catch {
      seg = await ImageSegmenter.createFromOptions(vision, { ...opts, baseOptions: { modelAssetPath: model, delegate: 'CPU' } });
    }
    if (_seg && _seg.close) try { _seg.close(); } catch { /* */ }
    _seg = seg; _kind = kind;
    onProgress && onProgress({ phase: 'load', frac: 1 });
    return seg;
  })();
  try { return await _loading; } finally { _loading = null; }
}

/**
 * Segment a canvas/image → { width, height, data: Float32Array confidence 0..1 (person) }.
 * maxEdge downscales for speed (default 640).
 */
export function segmentPerson(seg, image, { maxEdge = 640 } = {}) {
  if (!seg) return null;
  if (hooks.createSegmenter && seg.segmentPerson) return seg.segmentPerson(image, { maxEdge });
  const iw = image.videoWidth || image.naturalWidth || image.width;
  const ih = image.videoHeight || image.naturalHeight || image.height;
  if (!iw || !ih) return null;
  let src = image;
  const scale = Math.min(1, maxEdge / Math.max(iw, ih));
  if (scale < 1) {
    if (!segmentPerson._c) { segmentPerson._c = document.createElement('canvas'); segmentPerson._x = segmentPerson._c.getContext('2d', { willReadFrequently: true }); }
    const w = Math.max(2, Math.round(iw * scale)), h = Math.max(2, Math.round(ih * scale));
    if (segmentPerson._c.width !== w || segmentPerson._c.height !== h) { segmentPerson._c.width = w; segmentPerson._c.height = h; }
    segmentPerson._x.drawImage(image, 0, 0, w, h);
    src = segmentPerson._c;
  }
  const result = seg.segment(src);
  try {
    const masks = result.confidenceMasks || [];
    const m = masks[0];
    if (!m) return null;
    const mw = m.width, mh = m.height;
    const f32 = m.getAsFloat32Array ? m.getAsFloat32Array() : null;
    const data = f32 ? Float32Array.from(f32) : null;
    masks.forEach(x => x.close && x.close());
    if (!data) return null;
    return { width: mw, height: mh, data };
  } catch (e) {
    console.warn('segment', e);
    return null;
  }
}

export function closeSegmenter() {
  if (_seg && _seg.close) try { _seg.close(); } catch { /* */ }
  _seg = null; _kind = null;
}
