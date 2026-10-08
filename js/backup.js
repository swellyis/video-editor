// Project backup (pure helpers, no DOM): what goes into a .vedit file, what a restore must store, and whether it fits.
// The .vedit file is a tar of project.json plus every media file as raw bytes (util.js tarBlob/readTar; base-256 sizes past 8 GiB).
import { tarBytes } from './util.js';

/**
 * Plan a backup. recs: Map/obj id -> media record (with .blob when the bytes are on this device).
 * Returns { meta: [...media meta without blob/peaks], files: [{ name, id, blob, size }], mediaBytes, fileBytes, missing }.
 * Proxies (proxy.js) are never included: they are rebuilt on the device that needs them.
 */
export function backupPlan(project, ids, getRec, embed) {
  const meta = [], files = []; let mediaBytes = 0, missing = 0;
  for (const id of ids) {
    const m = getRec(id); if (!m) continue;
    const { blob, peaks, ...rest } = m; void peaks; // waveform peaks are rebuilt on import
    if (embed && blob) { rest.file = 'media/' + id; files.push({ name: rest.file, id, blob, size: blob.size }); mediaBytes += blob.size; }
    else if (embed) missing++;
    meta.push(rest);
  }
  const json = JSON.stringify({ app: 'video-editor-pro', format: embed ? 2 : 1, exported: new Date().toISOString(), project, media: meta });
  const jsonBytes = new TextEncoder().encode(json).length;
  return { json, meta, files, mediaBytes, missing, fileBytes: embed ? tarBytes([jsonBytes, ...files.map(f => f.size)]) : jsonBytes };
}

/** What a restore has to store: media listed in the file, not already on this device, whose bytes are in the file. */
export function restorePlan(data, entries, has) {
  const store = [], missing = []; let bytes = 0;
  for (const m of Array.isArray(data.media) ? data.media : []) {
    if (!m || typeof m.id !== 'string' || has(m.id)) continue;
    const blob = entries && typeof m.file === 'string' ? entries.get(m.file) : null;
    if (blob) { store.push({ meta: m, blob }); bytes += blob.size; } else missing.push(m);
  }
  return { store, missing, bytes };
}

/** Is there room? est = navigator.storage.estimate() result (or null when the browser can't tell). Keeps 5 % + 50 MB headroom. */
export function roomFor(est, bytes) {
  if (!est || !est.quota) return { ok: true, free: null, need: bytes };
  const free = Math.max(0, est.quota - (est.usage || 0)), need = Math.ceil(bytes * 1.05) + 50 * 1048576;
  return { ok: bytes === 0 || free >= need, free, need };
}
