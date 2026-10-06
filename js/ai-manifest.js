// Written by bump-version.py: content hashes of the AI files kept in the 'video-editor-ai' cache (sw.js has the same map).
/** Path (from the app root) -> first 16 hex digits of the file's SHA-256. */
export const AI_FILES = {"vendor/clean-strong/dpdfnet2_48khz_hr.init.json":"74471efe3513b255","vendor/clean-strong/dpdfnet2_48khz_hr.onnx":"0b399f8a58dc4d70","vendor/clean-strong/ort-wasm-simd-threaded.mjs":"30dd851d9c006229","vendor/clean-strong/ort-wasm-simd-threaded.wasm":"71aef04959c5c1b6","vendor/clean-strong/ort.wasm.min.mjs":"6ef726f355b79112","vendor/mediapipe/models/blaze_face_short_range.tflite":"b4578f35940bf5a1","vendor/mediapipe/models/selfie_segmenter.tflite":"191ac9529ae506ee","vendor/mediapipe/models/selfie_segmenter_landscape.tflite":"490e9ea734313e0d","vendor/mediapipe/vision_bundle.mjs":"40f4123dfcd75cfa","vendor/mediapipe/wasm/vision_wasm_internal.js":"4a97e2520ba506c6","vendor/mediapipe/wasm/vision_wasm_internal.wasm":"f00ec4731faa23b3","vendor/whisper/ort-wasm-simd-threaded.jsep.mjs":"08fb86ec433c78bf","vendor/whisper/ort-wasm-simd-threaded.jsep.wasm":"c46655e8a94afc45","vendor/whisper/transformers.min.js":"92d9448b16b928cd"};
/** The app root URL (this file is js/ai-manifest.js). */
export const AI_ROOT = new URL('../', import.meta.url).href;
/** Cache key of an AI file: its URL + '?h=<content hash>' (any query/hash dropped). Other URLs are returned unchanged. */
export function aiKey(url) {
  const u = new URL(url, AI_ROOT), clean = u.href.split(/[?#]/)[0];
  const rel = clean.startsWith(AI_ROOT) ? clean.slice(AI_ROOT.length) : null, h = rel && AI_FILES[rel];
  return h ? clean + '?h=' + h : u.href;
}
