/* Video Editor service worker: offline app shell (versioned cache) + share target inbox. */
const VERSION = 'v8b3df8cb85';
const CACHE = 'video-editor-shell-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/fonts.css',
  './js/app.js', './js/util.js', './js/db.js', './js/model.js', './js/render.js', './js/player.js', './js/timeline.js', './js/media.js', './js/audio.js', './js/exporter.js', './js/templates.js', './js/install.js', './js/install-early.js',
  './js/heic-worker.js',
  './vendor/mediabunny.min.mjs', './vendor/gifuct.min.mjs', './vendor/libheif/libheif.js', './vendor/libheif/libheif.wasm',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './fonts/ibm-plex-sans-latin-400-normal.woff2', './fonts/ibm-plex-sans-latin-500-normal.woff2', './fonts/ibm-plex-sans-latin-600-normal.woff2', './fonts/ibm-plex-sans-latin-700-normal.woff2',
  './fonts/ibm-plex-sans-latin-700-italic.woff2', './fonts/ibm-plex-sans-condensed-latin-700-normal.woff2',
  './fonts/ibm-plex-serif-latin-400-normal.woff2', './fonts/ibm-plex-serif-latin-400-italic.woff2', './fonts/ibm-plex-serif-latin-700-normal.woff2', './fonts/ibm-plex-serif-latin-700-italic.woff2',
  './fonts/ibm-plex-mono-latin-500-normal.woff2', './fonts/ibm-plex-mono-latin-600-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('video-editor-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

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
        const files = form.getAll('media').filter((f) => f && typeof f === 'object');
        await idbPutInbox(files.map((f, i) => ({ id: 'in_' + Date.now() + '_' + i, name: f.name, type: f.type, blob: f })));
      } catch (e) {
        return Response.redirect('./?shared=error', 303); // the app explains instead of silently showing nothing
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Network first for navigations (fresh HTML when online), cached shell offline.
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // only the app page itself may replace the offline shell (not a README, PNG, etc. opened in a tab)
        const isShell = /\/(index\.html)?$/.test(url.pathname) && (res.headers.get('content-type') || '').includes('text/html');
        if (res.ok && isShell) { const c = await caches.open(CACHE); c.put('./index.html', res.clone()); }
        return res;
      } catch { return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error(); }
    })());
    return;
  }
  // Cache first for versioned static assets; fill cache at runtime for anything else same-origin.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic' && !url.pathname.includes('/screenshots/')) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch { return Response.error(); }
  })());
});
