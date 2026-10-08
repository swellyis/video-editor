// Proxy editing UI: one "Proxy" block in the selected video's panel (Clip tab for a clip, PiP tab for an overlay), a "P" badge on
// timeline clips that play a proxy, and a background queue (one proxy at a time). Logic and storage are in proxy.js.
import { $, el } from './util.js';
import { needsProxy, makeProxy, proxyMeta, proxyFile, deleteProxy, cleanupProxies, proxyEstimate, ProxyCancelled } from './proxy.js';
import { db } from './db.js';

/** Media ids of the project's video clips and overlays (the files a preview plays as pictures). */
const videoIdsOf = (p) => new Set([...(p.clips || []), ...(p.overlays || [])].filter(it => it.kind === 'video' && it.mediaId).map(it => it.mediaId));

const MB = (b) => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
const secs = (ms) => (ms >= 60000 ? Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s' : (ms / 1000).toFixed(1) + ' s');
const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const setLS = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };

export function initProxies({ app, media, player, toast, selected }) {
  const box = $('proxyBox');
  const canMake = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'; // WebCodecs (stored proxies still play without it)
  const S = { st: new Map(), queue: [], job: null, known: new Set(), use: LS('ve.proxy.use', true), auto: LS('ve.proxy.auto', true) };
  media.useProxies = S.use;
  const stOf = (id) => S.st.get(id) || { state: 'none' };
  const set = (id, patch) => { S.st.set(id, { ...stOf(id), ...patch }); render(); };
  const refreshPreview = () => { if (app.timeline && app.timeline.render) app.timeline.render(); else if (app.renderTimeline) app.renderTimeline(); player.requestRender && player.requestRender(); };

  /** Look up stored proxies for the project's videos (once per media id) and queue missing ones when automatic proxies are on. */
  async function sync() {
    const ids = [...videoIdsOf(app.project)].filter(id => !S.known.has(id) || (stOf(id).state === 'ready' && !media.proxies.has(id)));
    for (const id of ids) {
      S.known.add(id);
      const rec = await media.get(id); if (!rec || rec.kind !== 'video') continue;
      const m = await proxyMeta(id), f = m && await proxyFile(id);
      if (f) { media.setProxy(id, f); S.st.set(id, { state: 'ready', meta: m }); refreshPreview(); }
      else { if (m) await deleteProxy(id); if (S.auto && canMake && needsProxy(rec)) enqueue(id); }
    }
    render();
  }
  function enqueue(id) {
    const s = stOf(id).state; if (s === 'queued' || s === 'making' || s === 'ready') return;
    S.queue.push(id); set(id, { state: 'queued', frac: 0, err: '' }); pump();
  }
  async function pump() {
    if (S.job || !S.queue.length) return;
    const id = S.queue.shift(); const rec = await media.get(id);
    if (!rec || !rec.blob) { set(id, { state: 'failed', err: 'The original file is not on this device.' }); return pump(); }
    const ac = new AbortController(); S.job = { id, ac };
    set(id, { state: 'making', frac: 0, t0: performance.now() });
    try {
      const meta = await makeProxy(rec, { signal: ac.signal, onProgress: (f) => { const s = stOf(id); s.frac = f; S.st.set(id, s); renderProgress(id); } });
      const f = await proxyFile(id);
      if (!f) throw new Error('The proxy could not be stored.');
      media.setProxy(id, f); set(id, { state: 'ready', meta });
      refreshPreview();
      toast('Proxy ready for “' + (rec.name || 'video') + '” (' + meta.width + '×' + meta.height + ', ' + MB(meta.size) + ', made in ' + secs(meta.ms) + '). Export still uses the original.', 4500);
    } catch (e) {
      if (e instanceof ProxyCancelled || ac.signal.aborted) set(id, { state: 'none', frac: 0 });
      else { console.warn('Proxy', e); set(id, { state: 'failed', err: String(e && e.message || e) }); }
    } finally { S.job = null; pump(); }
  }
  function cancel(id) {
    const qi = S.queue.indexOf(id); if (qi >= 0) { S.queue.splice(qi, 1); set(id, { state: 'none' }); }
    if (S.job && S.job.id === id) S.job.ac.abort();
  }
  async function remove(id) { cancel(id); media.setProxy(id, null); await deleteProxy(id); set(id, { state: 'none', meta: null }); refreshPreview(); }

  // ------------------------------------------------------------ the block (moved into the selected video's panel)
  function current() {
    const c = selected('clip'); if (c && c.kind === 'video') return { item: c, panel: $('clipPanel'), anchor: $('mcBox') };
    const o = selected('overlay'); if (o && o.kind === 'video') return { item: o, panel: $('overlayPanel'), anchor: null };
    return null;
  }
  function stateText(id, rec) {
    const s = stOf(id);
    if (s.state === 'ready') return 'Proxy ready · ' + s.meta.width + '×' + s.meta.height + ' · ' + MB(s.meta.size) + (S.use ? ' · in use' : ' · not in use');
    if (s.state === 'making') return 'Making proxy… ' + Math.floor((s.frac || 0) * 100) + '%';
    if (s.state === 'queued') return 'Waiting to make a proxy';
    if (s.state === 'failed') return 'No proxy: ' + s.err;
    if (!rec) return '';
    if (!canMake) return 'This browser can’t make proxies (it needs WebCodecs: Chrome, Edge, Android Chrome or Safari 16.4+).';
    return needsProxy(rec) ? 'No proxy yet (suggested: ' + (rec.width || '?') + '×' + (rec.height || '?') + ', ' + Math.round(rec.duration || 0) + ' s)' : 'No proxy (not needed for a file this size)';
  }
  function renderProgress(id) {
    const cur = current(); if (!cur || cur.item.mediaId !== id) return;
    const s = stOf(id), f = Math.floor((s.frac || 0) * 100);
    $('pxBar').style.width = f + '%'; $('pxText').textContent = 'Making proxy… ' + f + '%';
    $('pxState').textContent = stateText(id, media.peek(id));
    renderList();
  }
  function renderList() {
    const vids = [...videoIdsOf(app.project)].map(id => media.peek(id)).filter(r => r && r.kind === 'video');
    $('pxCount').textContent = vids.length;
    $('pxList').replaceChildren(...vids.map(r => el('li', { 'data-id': r.id, 'data-state': stOf(r.id).state }, el('span', { class: 'px-name', text: r.name || r.id }), el('span', { class: 'px-st', text: stateText(r.id, r) }))));
  }
  function render() {
    if (!box) return;
    const cur = current();
    if (!cur) { box.hidden = true; return; }
    if (cur.anchor) { if (box.previousElementSibling !== cur.anchor) cur.anchor.after(box); }
    else if (box.parentElement !== cur.panel.querySelector('.section') && cur.panel.querySelector('.section')) cur.panel.querySelector('.section').append(box);
    box.hidden = false;
    const id = cur.item.mediaId, rec = media.peek(id), s = stOf(id);
    box.dataset.state = s.state;
    $('pxState').textContent = stateText(id, rec);
    $('pxProg').hidden = s.state !== 'making';
    $('pxMake').hidden = !canMake || !(s.state === 'none' || s.state === 'failed');
    $('pxMake').textContent = s.state === 'failed' ? 'Try again' : 'Make proxy' + (rec && rec.duration ? ' (about ' + MB(proxyEstimate(rec)) + ')' : '');
    $('pxCancel').hidden = !(s.state === 'making' || s.state === 'queued');
    $('pxDelete').hidden = s.state !== 'ready';
    $('pxUse').checked = S.use; $('pxAuto').checked = S.auto;
    if (s.state === 'making') renderProgress(id);
    renderList();
  }
  if (box) {
    $('pxMake').onclick = () => { const c = current(); if (c) enqueue(c.item.mediaId); };
    $('pxCancel').onclick = () => { const c = current(); if (c) cancel(c.item.mediaId); };
    $('pxDelete').onclick = () => { const c = current(); if (c) remove(c.item.mediaId); };
    $('pxUse').onchange = () => { S.use = $('pxUse').checked; setLS('ve.proxy.use', S.use); media.useProxies = S.use; refreshPreview(); render(); toast(S.use ? 'Editing with proxies where they are ready. Export always uses the originals.' : 'Editing with the original files.', 3000); };
    $('pxAuto').onchange = () => { S.auto = $('pxAuto').checked; setLS('ve.proxy.auto', S.auto); if (S.auto) { S.known.clear(); sync(); } };
  }
  // tidy proxy files whose media is gone (once, after start-up)
  setTimeout(async () => { try { await cleanupProxies(await db.mediaKeys()); } catch { /* */ } }, 4000);
  setTimeout(() => sync(), 0);
  return { sync, render, enqueue, cancel, remove, state: S, stOf };
}
