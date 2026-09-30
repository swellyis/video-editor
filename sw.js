/* Video Editor service worker: offline app shell (versioned cache) + share target inbox. */
const VERSION = 'v67fe784aeb';
const CACHE = 'video-editor-shell-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/fonts.css',
  './js/app.js', './js/util.js', './js/db.js', './js/model.js', './js/render.js', './js/blur.js', './js/connect.js', './js/connect-ui.js', './js/player.js', './js/timeline.js', './js/media.js', './js/audio.js', './js/exporter.js', './js/templates.js', './js/install.js', './js/install-early.js', './js/build.js',
  './js/heic-worker.js',
  './vendor/mediabunny.min.mjs', './vendor/gifuct.min.mjs', './vendor/libheif/libheif.js', './vendor/libheif/libheif.wasm',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './fonts/ibm-plex-sans-latin-400-normal.woff2', './fonts/ibm-plex-sans-latin-500-normal.woff2', './fonts/ibm-plex-sans-latin-600-normal.woff2', './fonts/ibm-plex-sans-latin-700-normal.woff2',
  './fonts/ibm-plex-sans-latin-700-italic.woff2', './fonts/ibm-plex-sans-condensed-latin-700-normal.woff2',
  './fonts/ibm-plex-serif-latin-400-normal.woff2', './fonts/ibm-plex-serif-latin-400-italic.woff2', './fonts/ibm-plex-serif-latin-700-normal.woff2', './fonts/ibm-plex-serif-latin-700-italic.woff2',
  './fonts/ibm-plex-mono-latin-500-normal.woff2', './fonts/ibm-plex-mono-latin-600-normal.woff2',
];

self.addEventListener('install', (event) => {
  // Precache everything for THIS version. It then waits (the app offers "Reload") so open tabs keep their own version.
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
