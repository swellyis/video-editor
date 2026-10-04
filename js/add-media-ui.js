// Add media dialog: choose files, import from a link (with progress), and files / links shared in from other apps.
// Logic lives in media-link.js (unit-testable); this file only wires the DOM. Nothing here sends project data anywhere.
import { $, fmtBytes } from './util.js';
import { parseHttpsUrl, extractUrl, fetchMedia, LinkError, LIMITS } from './media-link.js';

export function initAddMedia({ importFiles, openDialog, closeDialog }) {
  // A stale cached page (old index.html + new scripts) may lack the dialog: do nothing instead of throwing; the page heals itself on reload.
  if (!document.getElementById('addMediaDialog') || !document.getElementById('linkInput') || !document.getElementById('addMediaBtn')) return { receiveLink: () => false };
  // ------------------------------------------------------------ import from link
  const msg = (id, text, kind) => { const m = $(id); m.textContent = text; m.classList.toggle('err', kind === 'err'); m.classList.toggle('okm', kind === 'ok'); };
  let job = null;
  const lowMemory = () => (navigator.deviceMemory && navigator.deviceMemory <= 4) || matchMedia('(pointer:coarse)').matches;
  const setBusy = (busy) => { $('linkGo').disabled = busy; $('linkInput').readOnly = busy; $('linkProgress').hidden = !busy; };
  async function importLink(raw) {
    if (job) return;
    const p = parseHttpsUrl(raw);
    if (!p.ok) { msg('linkMsg', p.error, 'err'); $('linkInput').focus(); return; }
    $('linkInput').value = p.url;
    const ac = new AbortController(); job = ac;
    setBusy(true); msg('linkMsg', 'Connecting to ' + new URL(p.url).hostname + '…'); $('linkStat').textContent = 'Connecting…';
    const bar = $('linkBar'); bar.classList.add('indet'); bar.style.width = '';
    try {
      const file = await fetchMedia(p.url, {
        signal: ac.signal, maxBytes: lowMemory() ? 300 * 1024 * 1024 : LIMITS.urlBytes,
        onProgress: (l, t) => {
          if (t) { bar.classList.remove('indet'); bar.style.width = Math.min(100, l / t * 100).toFixed(1) + '%'; $('linkStat').textContent = `${fmtBytes(l)} of ${fmtBytes(t)} · ${Math.round(l / t * 100)}%`; }
          else $('linkStat').textContent = fmtBytes(l) + ' downloaded';
        },
      });
      bar.classList.remove('indet'); bar.style.width = '100%';
      msg('linkMsg', `Downloaded ${file.name} (${fmtBytes(file.size)}). Adding it to the project…`);
      await importFiles([file]);
      msg('linkMsg', `Added ${file.name} (${fmtBytes(file.size)}) to the project.`, 'ok'); $('linkInput').value = '';
    } catch (e) {
      if (e instanceof LinkError) msg('linkMsg', e.code === 'cancelled' ? 'Download cancelled.' : e.message, e.code === 'cancelled' ? '' : 'err');
      else { console.warn(e); msg('linkMsg', 'Something went wrong: ' + (e && e.message || e), 'err'); }
    } finally { job = null; setBusy(false); }
  }
  $('linkGo').onclick = () => importLink($('linkInput').value);
  $('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); importLink($('linkInput').value); } });
  $('linkCancel').onclick = () => { if (job) job.abort(); };
  $('addInput').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; closeDialog('addMediaDialog'); importFiles(fs); };
  $('addMediaBtn').onclick = () => openDialog('addMediaDialog');

  // Earlier builds kept a list of website shortcuts here; that feature is gone, so drop its leftover data.
  try { localStorage.removeItem('ve.sites'); } catch { /* storage blocked */ }

  return {
    /** A link arrived from another app (share sheet): show it in the import box, ready to import. */
    receiveLink(text) {
      const u = extractUrl(text); if (!u) return false;
      openDialog('addMediaDialog'); $('linkInput').value = u; msg('linkMsg', 'A link was shared with the editor. Tap Import to download it if it is a direct media file.');
      return true;
    },
  };
}
