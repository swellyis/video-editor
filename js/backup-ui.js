// Project backup and restore with progress. "Back up project" (Projects list) opens one dialog: what's in it, the size, Save.
// Save streams to a file you pick where the browser can (Chrome/Edge on a computer: showSaveFilePicker), with progress and Cancel;
// elsewhere (phones, Safari, Firefox) the browser downloads the assembled file itself. Restore (Import project…) checks free space,
// stores each file with progress, verifies sizes, and Cancel removes what was stored so far.
import { $, tarBlob, readTar, isTar, download, safeName, fmtBytes, dataURLToBlob, uid } from './util.js';
import { isMediaDataURL } from './media.js';
import { backupPlan, restorePlan, roomFor } from './backup.js';

export class BackupCancelled extends Error { constructor() { super('Cancelled'); this.name = 'BackupCancelled'; } }
const rate = (bytes, ms) => (ms > 50 ? fmtBytes(bytes / (ms / 1000)) + '/s' : '');

export function initBackup({ app, media, db, toast, openDialog, closeDialog, flushPendingSave, migrate, openProject, mediaIdsOf }) {
  const S = { id: null, job: null, last: null };
  const embedBox = $('embedMedia');
  try { const v = localStorage.getItem('ve.backup.media'); if (v != null) embedBox.checked = v === '1'; } catch { /* */ }

  async function plan(id, embed) {
    if (id === app.project.id) await flushPendingSave();
    const p = id === app.project.id ? JSON.parse(JSON.stringify(app.project)) : await db.getProject(id);
    if (!p) throw new Error('Project not found');
    const ids = [...mediaIdsOf(p)], recs = new Map();
    for (const mid of ids) { const m = await media.get(mid); if (m) recs.set(mid, m); }
    return { p, ...backupPlan(p, ids, (x) => recs.get(x), embed) };
  }
  const build = (pl, embed) => embed ? tarBlob([{ name: 'project.json', data: pl.json }, ...pl.files.map(f => ({ name: f.name, data: f.blob }))]) : new Blob([pl.json], { type: 'application/json' });
  const nameOf = (pl, embed) => safeName(pl.p.name, 'project') + (embed ? '-with-media.vedit' : '.vedit.json');

  /** Immediate download (kept for scripts and the old one-click behaviour). */
  async function exportNow(id) {
    const embed = embedBox.checked, pl = await plan(id, embed);
    download(build(pl, embed), nameOf(pl, embed));
    toast(embed ? 'Project file saved with media (.vedit)' : 'Project file saved (media stays on this device)');
  }

  // ------------------------------------------------------------ backup dialog
  function prog(prefix, show, frac, text) {
    $(prefix + 'Prog').hidden = !show; if (!show) return;
    $(prefix + 'Bar').style.width = Math.round(frac * 100) + '%'; $(prefix + 'Text').textContent = text;
  }
  async function summarize() {
    const embed = embedBox.checked, pl = await plan(S.id, embed);
    const n = pl.meta.length;
    $('bkName').textContent = pl.p.name;
    $('bkSummary').textContent = (n ? n + ' media file' + (n > 1 ? 's' : '') : 'No media') + (embed ? ' · ' + fmtBytes(pl.mediaBytes) + ' of media' : '') + ' · backup file ' + fmtBytes(pl.fileBytes);
    $('bkMissing').hidden = !pl.missing; $('bkMissing').textContent = pl.missing ? pl.missing + ' file(s) are not on this device and will need relinking after a restore.' : '';
    $('bkHow').textContent = window.showSaveFilePicker ? 'You pick where to save; the file is written piece by piece, so even very large projects need little memory.' : 'Your browser saves the file to Downloads by itself (no progress is shown). For backups of several GB, Chrome or Edge on a computer is the most reliable.';
    S.last = pl; return pl;
  }
  async function open(id) {
    S.id = id; prog('bk', false); $('bkSave').disabled = false; $('bkCancel').hidden = true; $('bkResult').hidden = true;
    openDialog('backupDialog');
    try { await summarize(); } catch (e) { $('bkSummary').textContent = 'Could not read the project: ' + e.message; }
  }
  embedBox.addEventListener('change', () => { try { localStorage.setItem('ve.backup.media', embedBox.checked ? '1' : '0'); } catch { /* */ } if ($('backupDialog').open) summarize(); });

  /** Write a Blob to a writable file stream with progress. */
  async function streamTo(writable, blob, job, onProgress) {
    const reader = blob.stream().getReader(); let done = 0;
    try {
      for (;;) {
        if (job.cancel) throw new BackupCancelled();
        const r = await reader.read(); if (r.done) break;
        await writable.write(r.value); done += r.value.byteLength; onProgress(done);
      }
      await writable.close();
    } catch (e) { try { reader.cancel(); } catch { /* */ } try { await writable.abort(); } catch { /* */ } throw e; }
  }
  async function save() {
    const embed = embedBox.checked, pl = await summarize(), blob = build(pl, embed), name = nameOf(pl, embed);
    if (!window.showSaveFilePicker) { download(blob, name); $('bkResult').hidden = false; $('bkResult').textContent = 'Saved as ' + name + ' (' + fmtBytes(blob.size) + ').'; return; }
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Project backup', accept: embed ? { 'application/x-tar': ['.vedit'] } : { 'application/json': ['.json'] } }] }); }
    catch (e) { if (e && e.name === 'AbortError') return; throw e; }
    const job = { cancel: false, t0: performance.now() }; S.job = job;
    $('bkSave').disabled = true; $('bkCancel').hidden = false; $('bkResult').hidden = true;
    try {
      const w = await handle.createWritable();
      await streamTo(w, blob, job, (d) => prog('bk', true, d / blob.size, 'Saved ' + fmtBytes(d) + ' of ' + fmtBytes(blob.size) + ' · ' + rate(d, performance.now() - job.t0)));
      const ms = performance.now() - job.t0;
      S.lastSave = { bytes: blob.size, ms };
      $('bkResult').hidden = false; $('bkResult').textContent = 'Backup saved: ' + (handle.name || name) + ' · ' + fmtBytes(blob.size) + ' in ' + (ms / 1000).toFixed(1) + ' s (' + rate(blob.size, ms) + ').';
      toast('Backup saved (' + fmtBytes(blob.size) + ')');
    } catch (e) {
      if (e instanceof BackupCancelled) { $('bkResult').hidden = false; $('bkResult').textContent = 'Backup cancelled. The partial file was discarded.'; }
      else { $('bkResult').hidden = false; $('bkResult').textContent = 'Backup failed: ' + (e.message || e); }
    } finally { S.job = null; prog('bk', false); $('bkSave').disabled = false; $('bkCancel').hidden = true; }
  }
  $('bkSave').onclick = () => save().catch(e => toast('Backup failed: ' + e.message));
  $('bkCancel').onclick = () => { if (S.job) S.job.cancel = true; };

  // ------------------------------------------------------------ restore
  async function importFile(file) {
    const job = { cancel: false, stored: [] }; S.rjob = job;
    const show = (frac, text) => { if (!$('restoreDialog').open) openDialog('restoreDialog'); prog('rs', true, frac, text); };
    try {
      let data, entries = null;
      if (await isTar(file)) {
        entries = await readTar(file);
        const pj = entries.get('project.json'); if (!pj) throw new Error('Not a project file');
        data = JSON.parse(await pj.text());
      } else data = JSON.parse(await file.text()); // .vedit.json (format 1, media optionally base64)
      const src = data.project || data;
      if (!src || !Array.isArray(src.clips)) throw new Error('Not a project file');
      // decide what to store (skip media this device already has)
      const have = new Set(); for (const m of Array.isArray(data.media) ? data.media : []) if (m && typeof m.id === 'string' && await media.get(m.id)) have.add(m.id);
      const rp = restorePlan(data, entries, (id) => have.has(id));
      let missing = 0, skipped = 0;
      for (const m of rp.missing) { // format 1: base64 media inside the JSON
        if (!entries && m.data) { if (isMediaDataURL(m.data)) rp.store.push({ meta: m, blob: dataURLToBlob(m.data) }); else { skipped++; missing++; } }
        else missing++;
      }
      const total = rp.store.reduce((a, x) => a + x.blob.size, 0);
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
      const room = roomFor(est, total);
      if (!room.ok) throw new Error('Not enough space on this device: the media needs about ' + fmtBytes(room.need) + ', about ' + fmtBytes(room.free) + ' is free. Delete old projects or exports and try again.');
      $('rsName').textContent = src.name || 'Project';
      let done = 0; const t0 = performance.now();
      if (total > 0) show(0, 'Restoring ' + fmtBytes(total) + ' of media…');
      for (let i = 0; i < rp.store.length; i++) {
        if (job.cancel) throw new BackupCancelled();
        const { meta, blob } = rp.store[i];
        show(done / Math.max(1, total), 'File ' + (i + 1) + ' of ' + rp.store.length + ' · ' + fmtBytes(done) + ' of ' + fmtBytes(total) + (done ? ' · ' + rate(done, performance.now() - t0) : ''));
        const rec = await media.importEmbedded(meta, blob);
        job.stored.push(rec.id);
        const back = await db.getMedia(rec.id);
        if (!back || !back.blob || back.blob.size !== blob.size) throw new Error('“' + (meta.name || 'A media file') + '” was not stored completely (the device may be out of space).');
        done += blob.size;
      }
      if (job.cancel) throw new BackupCancelled();
      const p = migrate(src);
      p.id = uid('prj'); p.updated = Date.now();
      await db.saveProject(p);
      await openProject(p.id);
      closeDialog('projectsDialog'); closeDialog('restoreDialog');
      S.lastRestore = { bytes: done, ms: performance.now() - t0, files: rp.store.length };
      if (skipped) console.warn(skipped + ' embedded media entries were not valid media data and were ignored');
      toast(missing ? `Imported. ${missing} media file(s) need relinking (select the red clips).` : (done ? 'Project restored with ' + rp.store.length + ' media file(s), ' + fmtBytes(done) : 'Project imported'));
      return p.id;
    } catch (e) {
      for (const id of job.stored) { try { await db.deleteMedia(id); media.forget(id); } catch { /* */ } }
      closeDialog('restoreDialog');
      if (e instanceof BackupCancelled) toast('Restore cancelled. Nothing was kept.');
      else { console.warn(e); toast('Import failed: ' + e.message, 6000); }
      return null;
    } finally { S.rjob = null; }
  }
  $('rsCancel').onclick = () => { if (S.rjob) S.rjob.cancel = true; };
  $('restoreDialog').addEventListener('cancel', (e) => e.preventDefault()); // Esc doesn't hide a restore that is still running; use Cancel
  $('backupDialog').addEventListener('close', () => { if (S.job) S.job.cancel = true; });
  return { open, exportNow, importFile, state: S };
}
