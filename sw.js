/* Video Editor service worker: offline app shell (versioned cache) + share target inbox. */
const VERSION = 'v5722806c59';
const CACHE = 'video-editor-shell-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/fonts.css',
  './js/app.js', './js/util.js', './js/db.js', './js/model.js', './js/designer.js', './js/designer-ui.js', './js/render.js', './js/blur.js', './js/media-link.js', './js/add-media-ui.js', './js/shorts.js', './js/shorts-ui.js', './js/shorts-scan.js', './js/queue.js', './js/match.js', './js/textanim.js', './js/textanim-ui.js', './js/layout.js', './js/layout-ui.js', './js/freeze.js', './js/group.js', './js/ramp.js', './js/speed-ui.js', './js/match-ui.js', './js/player.js', './js/timeline.js', './js/media.js', './js/audio.js', './js/extract.js', './js/exporter.js', './js/templates.js', './js/install.js', './js/install-early.js', './js/build.js',
  './js/heic-worker.js', './js/captions.js', './js/transcribe.js', './js/whisper-worker.js', './js/vad.js', './js/asr-plan.js', './js/transcript-ui.js', './js/fillers.js', './js/cut.js', './js/duck.js', './js/reframe.js', './js/reframe-run.js', './js/face.js', './js/segment.js', './js/bgremove.js',
  './js/ai-manifest.js', './js/clean.js', './js/clean-ui.js', './js/voice-ui.js', './js/silence.js', './js/silence-scan.js', './js/silence-ui.js', './js/sync.js', './js/sync-scan.js', './js/sync-ui.js', './js/beat.js', './js/beat-scan.js', './js/beat-ui.js', './js/beatcut.js', './js/beatcut-ui.js', './js/multicam.js', './js/multicam-ui.js', './js/transitions.js', './js/transition-ui.js', './js/transition-thumbs.js', './js/effects.js', './js/effects-ui.js', './js/filters.js', './js/filters-ui.js', './js/fx-gl.js', './js/voice-dsp.js', './js/clean-dsp.js', './js/clean-worker.js', './vendor/clean/rnnoise.js', './vendor/clean/rnnoise.wasm', // Clean voice "Light" (RNNoise, ~125 KB); the big "Strong" model is never precached
 
  './vendor/mediabunny.min.mjs', './vendor/gifuct.min.mjs', './vendor/libheif/libheif.js', './vendor/libheif/libheif.wasm',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './fonts/anton-latin-400-normal.woff2', './fonts/bebas-neue-latin-400-normal.woff2', './fonts/oswald-latin-700-normal.woff2', './fonts/montserrat-latin-800-normal.woff2', './fonts/playfair-display-latin-800-normal.woff2', './fonts/lobster-latin-400-normal.woff2',
  './fonts/ibm-plex-sans-latin-400-normal.woff2', './fonts/ibm-plex-sans-latin-500-normal.woff2', './fonts/ibm-plex-sans-latin-600-normal.woff2', './fonts/ibm-plex-sans-latin-700-normal.woff2',
  './fonts/ibm-plex-sans-latin-700-italic.woff2', './fonts/ibm-plex-sans-condensed-latin-700-normal.woff2',
  './fonts/ibm-plex-serif-latin-400-normal.woff2', './fonts/ibm-plex-serif-latin-400-italic.woff2', './fonts/ibm-plex-serif-latin-700-normal.woff2', './fonts/ibm-plex-serif-latin-700-italic.woff2',
  './fonts/ibm-plex-mono-latin-500-normal.woff2', './fonts/ibm-plex-mono-latin-600-normal.woff2',
];

// ---- AI files (MediaPipe face + segmenter, Whisper runtime, Clean voice Strong): kept in 'video-editor-ai', which survives app updates.
// AI_FILES (written by bump-version.py, same as js/ai-manifest.js) maps each file to a content hash. Entries are stored under the
// versioned key URL?h=<hash>, so a changed vendor file is fetched again instead of a stale copy being served forever.
const AI_CACHE = 'video-editor-ai';
const AI_FILES = {"vendor/clean-strong/dpdfnet2_48khz_hr.init.json":"74471efe3513b255","vendor/clean-strong/dpdfnet2_48khz_hr.onnx":"0b399f8a58dc4d70","vendor/clean-strong/ort-wasm-simd-threaded.mjs":"30dd851d9c006229","vendor/clean-strong/ort-wasm-simd-threaded.wasm":"71aef04959c5c1b6","vendor/clean-strong/ort.wasm.min.mjs":"6ef726f355b79112","vendor/mediapipe/models/blaze_face_short_range.tflite":"b4578f35940bf5a1","vendor/mediapipe/models/selfie_segmenter.tflite":"191ac9529ae506ee","vendor/mediapipe/models/selfie_segmenter_landscape.tflite":"490e9ea734313e0d","vendor/mediapipe/vision_bundle.mjs":"40f4123dfcd75cfa","vendor/mediapipe/wasm/vision_wasm_internal.js":"4a97e2520ba506c6","vendor/mediapipe/wasm/vision_wasm_internal.wasm":"f00ec4731faa23b3","vendor/whisper/ort-wasm-simd-threaded.jsep.mjs":"08fb86ec433c78bf","vendor/whisper/ort-wasm-simd-threaded.jsep.wasm":"c46655e8a94afc45","vendor/whisper/transformers.min.js":"92d9448b16b928cd"};
const ROOT = new URL('./', self.location.href).href;
const AI_DIR = /^vendor\/(mediapipe|whisper|clean-strong)\//;
const relOf = (u) => { const clean = u.href.split(/[?#]/)[0]; return clean.startsWith(ROOT) ? clean.slice(ROOT.length) : null; };
const aiKeyOf = (rel) => (AI_FILES[rel] ? ROOT + rel + '?h=' + AI_FILES[rel] : null);
async function sha16(buf) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join(''); }
/** Drop every other copy (older versions, unversioned) of one AI file. */
async function pruneAi(c, rel, keep) {
  for (const k of await c.keys(ROOT + rel, { ignoreSearch: true })) if (k.url !== keep) await c.delete(k);
}
/**
 * Clean-up of the AI cache, run on activate (and on demand: message AI_SWEEP). Current versioned entries stay; an unversioned entry
 * from an earlier release is kept (re-stored under its versioned key) when its bytes ARE the current file, so offline use survives the
 * update without a new download; stale copies and files this version no longer has are deleted. Old app shells go too.
 */
async function sweep({ shells = true } = {}) {
  const out = { kept: 0, migrated: 0, deleted: 0, shell: CACHE };
  if (shells) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('video-editor-shell-') && k !== CACHE).map((k) => caches.delete(k)));
  }
  if (!(await caches.has(AI_CACHE))) return out;
  const c = await caches.open(AI_CACHE);
  for (const req of await c.keys()) {
    const u = new URL(req.url), rel = relOf(u);
    if (!rel || !AI_DIR.test(rel)) continue; // not ours to judge
    const key = aiKeyOf(rel);
    if (key && req.url === key) { out.kept++; continue; }
    if (key && !(await c.match(key))) {
      try {
        const res = await c.match(req);
        if (res && (await sha16(await res.clone().arrayBuffer())) === AI_FILES[rel]) { await c.put(key, res); await c.delete(req); out.migrated++; continue; }
      } catch { /* unreadable: delete below */ }
    }
    await c.delete(req); out.deleted++;
  }
  return out;
}
/** Cache-first for AI files under their versioned key; on a miss the network (revalidated), stored by the service worker when `store`. */
async function aiFetch(req, url, store) {
  const rel = relOf(url), key = rel && aiKeyOf(rel);
  if (!key) return fetch(req); // not a file this version knows: plain network
  const c = await caches.open(AI_CACHE);
  const hit = await c.match(key);
  if (hit) return hit;
  const res = await fetch(ROOT + rel, { cache: 'no-cache' });
  if (store && res.ok && res.type === 'basic') {
    const copy = res.clone();
    (async () => { // only bytes that match this version's hash are kept (a half-deployed CDN can't poison the cache)
      try { const buf = await copy.arrayBuffer(); if ((await sha16(buf)) !== AI_FILES[rel]) return; await c.put(key, new Response(buf, { headers: copy.headers })); await pruneAi(c, rel, key); } catch { /* quota: next time */ }
    })();
  }
  return res;
}

self.addEventListener('install', (event) => {
  // Precache everything for THIS version. It then waits (the app offers "Reload") so open tabs keep their own version.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await sweep(); } catch { /* never block activation */ }
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  else if (d.type === 'AI_SWEEP') { // a newer worker waiting to activate still needs its own shell cache
    const reg = self.registration, shells = !(reg && (reg.waiting || reg.installing));
    e.waitUntil(sweep({ shells }).then((r) => e.ports[0] && e.ports[0].postMessage(r), (err) => e.ports[0] && e.ports[0].postMessage({ error: String(err) })));
  }
});

// Opens the app's database at whatever version it has (no hard-coded version, so a DB_VERSION bump in js/db.js
// can't break sharing). On a brand-new install the app hasn't created it yet: create the stores it expects.
function idbPutInbox(items) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('video-editor-pro');
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['projects', 'media', 'inbox']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('inbox')) { db.close(); return reject(new Error('inbox store missing')); }
      const t = db.transaction('inbox', 'readwrite');
      items.forEach((it) => t.objectStore('inbox').put(it));
      t.oncomplete = () => { db.close(); resolve(); }; t.onerror = () => { db.close(); reject(t.error); };
    };
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size > 0);
        const items = files.map((f, i) => ({ id: 'in_' + Date.now() + '_' + i, name: f.name, type: f.type, blob: f }));
        // a shared link (a "Share" from a browser or another app): text fields only, never fetched here
        const text = ['url', 'text', 'title'].map((k) => String(form.get(k) || '')).join(' ');
        const m = /https:\/\/[^\s<>"']+/i.exec(text);
        if (m) items.push({ id: 'in_' + Date.now() + '_link', link: m[0].replace(/[).,;!?]+$/, '') });
        if (!items.length) return Response.redirect('./?shared=error', 303);
        await idbPutInbox(items);
        // an editor window that stays open (launch_handler focus-existing) is told directly; a fresh one reads the inbox on start
        for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'SHARED', count: items.length });
      } catch (e) {
        return Response.redirect('./?shared=error', 303); // the app explains instead of silently showing nothing
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // The speech-to-text runtime (~22 MB of WebAssembly) and face tracking / segmentation (MediaPipe, ~11 MB) are NOT part of the app
  // shell: fetched the first time they are needed and kept in 'video-editor-ai' (versioned keys, see AI_FILES) across app updates.
  if (url.pathname.includes('/vendor/mediapipe/') || url.pathname.includes('/vendor/whisper/')) {
    event.respondWith(aiFetch(req, url, true));
    return;
  }
  // Clean voice "Strong" (neural network, ~21 MB): downloaded by the page only after the user agrees, and stored by the page in the
  // same cache under the same versioned keys. Here it is only READ (cache first, else the network).
  if (url.pathname.includes('/vendor/clean-strong/')) {
    event.respondWith(aiFetch(req, url, false));
    return;
  }
  const own = () => caches.open(CACHE); // ONLY this version's cache: never a file left over from another version
  if (req.mode === 'navigate') {
    // The app page comes from this version's cache, the same version as its scripts (fetching it from the network could
    // return a newer or HTTP-cached older index.html that doesn't match the cached JS, which broke the page). A new
    // version arrives through the service worker update (sw.js is always revalidated), not through the page fetch.
    const isShell = /\/(index\.html)?$/.test(url.pathname);
    event.respondWith((async () => {
      if (isShell) { const hit = await (await own()).match('./index.html'); if (hit) return hit; }
      try { return await fetch(req, { cache: 'no-cache' }); } catch { return (await (await own()).match('./index.html')) || Response.error(); }
    })());
    return;
  }
  // Cache first for versioned static assets; fill cache at runtime for anything else same-origin.
  event.respondWith((async () => {
    const c = await own();
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic' && !url.pathname.includes('/screenshots/')) c.put(req, res.clone());
      return res;
    } catch { return Response.error(); }
  })());
});
