// Stabilize (Clip tab › Frame, crop & motion › Stabilize): Off / Smooth / Strong per clip (one undo step), analysis in the background
// with progress and Cancel, cached per media file. The compositor applies it (stab-store.js), so preview and export match.
import { $ } from './util.js';
import { analyse, loadAnalysis, saveAnalysis, StabCancelled } from './stab-run.js';
import { setAnalysis, getAnalysis, hasAnalysis, stabZoom } from './stab-store.js';

export function initStab({ app, media, player, toast, selected }) {
  const S = { st: new Map(), queue: [], job: null, loaded: new Set(), waiters: [] };
  const stOf = (id) => S.st.get(id) || { state: 'none' };
  const set = (id, patch) => { S.st.set(id, { ...stOf(id), ...patch }); render(); };
  /** source range each media needs, over every clip that has stabilize on */
  function needs() {
    const m = new Map();
    for (const c of app.project.clips) if (c.kind === 'video' && c.stab && c.stab !== 'off' && c.mediaId) {
      const r = m.get(c.mediaId); m.set(c.mediaId, r ? [Math.min(r[0], c.in), Math.max(r[1], c.out)] : [c.in, c.out]);
    }
    return m;
  }
  async function sync() {
    for (const [id, [t0, t1]] of needs()) {
      if (!S.loaded.has(id)) { S.loaded.add(id); const a = await loadAnalysis(id); if (a) { setAnalysis(id, a); player.invalidate && player.invalidate(); player.requestRender && player.requestRender(); } }
      if (hasAnalysis(id, t0, t1)) { if (stOf(id).state !== 'ready') set(id, { state: 'ready' }); continue; }
      const s = stOf(id).state; if (s === 'queued' || s === 'running' || s === 'failed') continue;
      const a = getAnalysis(id); const r0 = a ? Math.min(a.t0, t0) : t0, r1 = a ? Math.max(a.t1, t1) : t1;
      S.queue.push({ id, t0: r0, t1: r1 }); set(id, { state: 'queued', frac: 0 }); pump();
    }
    render(); if (!S.job && !S.queue.length) flushWaiters();
  }
  function flushWaiters() { const w = S.waiters; S.waiters = []; w.forEach(f => f()); }
  async function pump() {
    if (S.job || !S.queue.length) return;
    const q = S.queue.shift(), rec = await media.get(q.id);
    const blob = (media.proxies && media.proxies.get(q.id)) || (rec && rec.blob);
    if (!blob) { set(q.id, { state: 'failed', err: 'The original file is not on this device.' }); return pump(); }
    const ac = new AbortController(); S.job = { id: q.id, ac };
    set(q.id, { state: 'running', frac: 0 });
    try {
      const a = await analyse(blob, q.t0, q.t1, { signal: ac.signal, onProgress: (f) => { const s = stOf(q.id); s.frac = f; S.st.set(q.id, s); renderProgress(); } });
      a.fromProxy = blob !== (rec && rec.blob);
      await saveAnalysis(q.id, a); setAnalysis(q.id, a);
      set(q.id, { state: 'ready', ms: a.ms, frames: a.frames });
      S.last = { id: q.id, ms: a.ms, frames: a.frames, seconds: a.t1 - a.t0, fromProxy: a.fromProxy };
      player.invalidate && player.invalidate(); player.requestRender && player.requestRender();
    } catch (e) {
      if (e instanceof StabCancelled || ac.signal.aborted) set(q.id, { state: 'none' });
      else { console.warn('Stabilize', e); set(q.id, { state: 'failed', err: String(e && e.message || e) }); }
    } finally { S.job = null; if (S.queue.length) pump(); else flushWaiters(); }
  }
  function cancel(id) {
    S.queue = S.queue.filter(q => q.id !== id);
    if (S.job && S.job.id === id) S.job.ac.abort();
    let n = 0; for (const c of app.project.clips) if (c.mediaId === id && c.stab !== 'off') { c.stab = 'off'; n++; }
    S.st.delete(id);
    if (n) app.commit('Stabilize off');
  }
  /** Wait until every clip that needs it has its analysis (before an export). Resolves false if one failed. */
  async function ready() {
    await sync();
    if (S.job || S.queue.length) { toast('Finishing the stabilize analysis before the export…', 3000); await new Promise(r => S.waiters.push(r)); }
    for (const [id] of needs()) if (stOf(id).state === 'failed') return false;
    return true;
  }

  function current() { const c = selected('clip'); return c && c.kind === 'video' ? c : null; }
  function renderProgress() {
    const c = current(); if (!c) return; const s = stOf(c.mediaId);
    if (s.state !== 'running') return;
    const f = Math.floor((s.frac || 0) * 100);
    $('stabBar').style.width = f + '%'; $('stabText').textContent = 'Measuring the camera shake… ' + f + '%';
    $('stabState').textContent = f + '%';
  }
  function render() {
    const box = $('stabBlock'); if (!box) return;
    const c = current(); box.hidden = !c; if (!c) return;
    const s = stOf(c.mediaId), on = c.stab && c.stab !== 'off';
    box.dataset.state = on ? s.state : 'off';
    $('stabProg').hidden = !(on && (s.state === 'running' || s.state === 'queued'));
    if (on && s.state === 'queued') $('stabText').textContent = 'Waiting…';
    const z = on && s.state === 'ready' ? stabZoom(c.mediaId, c.stab) : null;
    $('stabState').textContent = !on ? '' : s.state === 'ready' ? 'Steady · zoom ' + (z || 1).toFixed(2) + '×' : s.state === 'failed' ? 'Failed' : s.state === 'running' ? Math.floor((s.frac || 0) * 100) + '%' : '…';
    $('stabErr').hidden = !(on && s.state === 'failed'); $('stabErr').textContent = s.err ? 'Could not stabilize: ' + s.err : '';
    if (on && s.state === 'running') renderProgress();
  }
  if ($('stabCancel')) $('stabCancel').onclick = () => { const c = current(); if (c) cancel(c.mediaId); };
  setTimeout(() => sync(), 0);
  return { sync, render, ready, cancel, state: S, stOf };
}
