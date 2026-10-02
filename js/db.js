import { cleanIdsOf } from './model.js';
// IndexedDB persistence: projects (JSON) + media (Blobs) + inbox (shared files from the OS share sheet)
const DB_NAME = 'video-editor-pro';
const DB_VERSION = 1;
let dbp;
const MX = 'mx:';

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async listProjects() {
    const all = await tx('projects', 'readonly', s => reqP(s.getAll()));
    return (all || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },
  getProject: (id) => tx('projects', 'readonly', s => reqP(s.get(id))),
  saveProject: (p) => tx('projects', 'readwrite', s => { s.put(p); }),
  deleteProject: (id) => tx('projects', 'readwrite', s => { s.delete(id); }),
  putMedia: (rec) => tx('media', 'readwrite', s => { s.put(rec); }),
  /** The media record. Small later additions (waveform peaks, corrected duration / hasAudio) live beside it in the kv store as 'mx:<id>'. */
  async getMedia(id) {
    const rec = await tx('media', 'readonly', s => reqP(s.get(id)));
    if (rec) { const mx = await tx('kv', 'readonly', s => reqP(s.get(MX + id))).catch(() => null); if (mx) Object.assign(rec, mx); }
    return rec;
  },
  deleteMedia: async (id) => { await tx('media', 'readwrite', s => { s.delete(id); }); await tx('kv', 'readwrite', s => { s.delete(MX + id); }).catch(() => { }); },
  async mediaKeys() { return tx('media', 'readonly', s => reqP(s.getAllKeys())); },
  /**
   * Add small metadata to a stored media record. It is written to its own tiny kv entry: rewriting the media record itself
   * would re-store the WHOLE video (hundreds of MB to several GB: seconds of disk work, a second copy of the file in the
   * quota, and everything else in the database queued behind it), just to attach a waveform.
   */
  async updateMediaMeta(id, patch) {
    return tx('kv', 'readwrite', async s => {
      const cur = (await reqP(s.get(MX + id))) || {};
      s.put(Object.assign(cur, patch), MX + id);
    });
  },
  inboxAll: () => tx('inbox', 'readonly', s => reqP(s.getAll())),
  inboxClear: () => tx('inbox', 'readwrite', s => { s.clear(); }),
  inboxDelete: (ids) => tx('inbox', 'readwrite', s => { for (const id of ids) s.delete(id); }),
  kvGet: (k) => tx('kv', 'readonly', s => reqP(s.get(k))),
  kvSet: (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); }),
  /**
   * Delete media blobs that no saved project references (keepIds: extra ids to keep, e.g. undo history).
   * Other open tabs of the app are asked which media they still use (unsaved imports, their undo history) and only
   * one tab collects at a time (Web Locks), so a second tab starting up can't delete media the first one needs.
   */
  async gc(keepIds = new Set()) {
    const run = async () => {
      const used = new Set([...keepIds, ...localKeep()]);
      for (const id of await askOtherTabs()) used.add(id);
      const projects = await this.listProjects();
      for (const p of projects) for (const id of mediaIdsOf(p)) used.add(id);
      const keys = await this.mediaKeys();
      let removed = 0;
      for (const k of keys) if (!used.has(k)) { await this.deleteMedia(k); removed++; }
      return removed;
    };
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(DB_NAME + '-gc', run);
    return run();
  },
};

// ---- cross-tab coordination for gc ----
let keepProvider = () => [];
/** The app registers a function returning the media ids this tab still needs (open project, undo history, imports). */
export function setKeepProvider(fn) { keepProvider = fn; }
const localKeep = () => { try { return [...keepProvider()]; } catch { return []; } };
const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DB_NAME + '-gc') : null;
if (chan) chan.onmessage = (e) => { const d = e.data || {}; if (d.type === 'ask') chan.postMessage({ type: 'keep', q: d.q, ids: localKeep() }); };
function askOtherTabs(timeout = 350) {
  if (!chan) return Promise.resolve([]);
  const q = Math.random().toString(36).slice(2), got = new Set();
  return new Promise((resolve) => {
    const rx = new BroadcastChannel(DB_NAME + '-gc'); // a second object receives replies to our own channel's question
    rx.onmessage = (e) => { const d = e.data || {}; if (d.type === 'keep' && d.q === q) for (const id of d.ids || []) got.add(id); };
    chan.postMessage({ type: 'ask', q });
    setTimeout(() => { rx.close(); resolve([...got]); }, timeout);
  });
}

export function mediaIdsOf(p) {
  const ids = new Set();
  for (const it of [...(p.clips || []), ...(p.audio || []), ...(p.overlays || [])]) for (const id of cleanIdsOf(it)) ids.add(id);
  (p.clips || []).forEach(c => c.mediaId && ids.add(c.mediaId));
  (p.audio || []).forEach(a => a.mediaId && ids.add(a.mediaId));
  (p.overlays || []).forEach(o => o.mediaId && ids.add(o.mediaId));
  if (p.logo && p.logo.mediaId) ids.add(p.logo.mediaId);
  return ids;
}
