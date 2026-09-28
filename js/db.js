// IndexedDB persistence: projects (JSON) + media (Blobs) + inbox (shared files from the OS share sheet)
const DB_NAME = 'video-editor-pro';
const DB_VERSION = 1;
let dbp;

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
  getMedia: (id) => tx('media', 'readonly', s => reqP(s.get(id))),
  deleteMedia: (id) => tx('media', 'readwrite', s => { s.delete(id); }),
  async mediaKeys() { return tx('media', 'readonly', s => reqP(s.getAllKeys())); },
  async updateMediaMeta(id, patch) {
    return tx('media', 'readwrite', async s => {
      const rec = await reqP(s.get(id));
      if (rec) s.put(Object.assign(rec, patch));
    });
  },
  inboxAll: () => tx('inbox', 'readonly', s => reqP(s.getAll())),
  inboxClear: () => tx('inbox', 'readwrite', s => { s.clear(); }),
  kvGet: (k) => tx('kv', 'readonly', s => reqP(s.get(k))),
  kvSet: (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); }),
  /** Delete media blobs that no saved project references (keepIds: extra ids to keep, e.g. undo history). */
  async gc(keepIds = new Set()) {
    const projects = await this.listProjects();
    const used = new Set(keepIds);
    for (const p of projects) for (const id of mediaIdsOf(p)) used.add(id);
    const keys = await this.mediaKeys();
    let removed = 0;
    for (const k of keys) if (!used.has(k)) { await this.deleteMedia(k); removed++; }
    return removed;
  },
};

export function mediaIdsOf(p) {
  const ids = new Set();
  (p.clips || []).forEach(c => c.mediaId && ids.add(c.mediaId));
  (p.audio || []).forEach(a => a.mediaId && ids.add(a.mediaId));
  if (p.logo && p.logo.mediaId) ids.add(p.logo.mediaId);
  return ids;
}
