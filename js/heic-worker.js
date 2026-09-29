// Decodes HEIC/HEIF photos with the vendored libheif (WebAssembly, LGPL-3.0). Loaded only when a HEIC file is
// imported in a browser that can't decode HEIC natively (e.g. Chrome, Firefox).
/* global libheif */
importScripts('../vendor/libheif/libheif.js');
let ready = null;
function lib() {
  if (!ready) ready = new Promise((resolve, reject) => {
    const base = new URL('../vendor/libheif/', self.location.href).href;
    // Emscripten fills in the object we pass (it may initialise synchronously inside the call)
    const Module = { locateFile: (f) => base + f, onRuntimeInitialized: () => resolve(Module), onAbort: (e) => reject(new Error('libheif failed to load: ' + e)) };
    try { libheif(Module); } catch (e) { reject(e); }
  });
  return ready;
}
self.onmessage = async (e) => {
  const { id, buffer } = e.data;
  try {
    const L = await lib();
    const dec = new L.HeifDecoder();
    const imgs = dec.decode(new Uint8Array(buffer));
    if (!imgs || !imgs.length) throw new Error('No image found in this HEIC file');
    const img = imgs[0], width = img.get_width(), height = img.get_height();
    const data = await new Promise((res, rej) => img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => d ? res(d.data) : rej(new Error('HEIC decode failed'))));
    for (const i of imgs) try { i.free && i.free(); } catch { }
    try { dec.decoder && L.heif_context_free(dec.decoder); dec.decoder = null; } catch { }
    self.postMessage({ id, width, height, data: data.buffer }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
