// Clean voice: the one control (Off / Light / Strong + compare) that lives under the Volume slider of the selected sound.
// This file only drives that control; the audio work is in clean.js (worker) and the playback / export hooks are in player.js / audio.js.
import { cleanId, cleanLevelOf, changeTarget, mediaSourceEnd } from './model.js';

const esc = (n) => (n < 0 ? 0 : n);
/** "about 40 s left" / "about 3 min left" */
export function etaText(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = esc(sec);
  if (sec < 5) return 'a few seconds left';
  if (sec < 90) return 'about ' + Math.round(sec / 5) * 5 + ' s left';
  if (sec < 5400) return 'about ' + Math.round(sec / 60) + ' min left';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return 'about ' + h + ' h ' + m + ' min left';
}

export function initCleanUI(ctx) {
  const { $, qs, app, media, player, selected, toast, fmtBytes, commit } = ctx;
  const box = $('cleanBox'); if (!box) return { render() { } };
  let api = null;
  const load = async () => api || (api = await import('./clean.js'));
  app.cleanApi = load;
  let job = null, ask = null, err = null, lastId = null;
  const PATHS = { clip: 'clip.volume', overlay: 'ovl.volume', audio: 'audio.volume' };

  /** The selected item that has sound to clean, or null (photos, silent videos, text...). */
  function current() {
    const s = app.selection; if (!s) return null;
    const item = selected(s.type); if (!item || !PATHS[s.type] || !item.mediaId) return null;
    if (s.type === 'clip' && (item.kind !== 'video' || item.hasAudio === false)) return null;
    if (s.type === 'overlay' && (item.kind !== 'video' || !item.hasAudio)) return null;
    return { type: s.type, item };
  }
  function findItem(type, id) {
    const p = app.project;
    return (type === 'clip' ? p.clips : type === 'overlay' ? p.overlays || [] : p.audio).find(x => x.id === id) || null;
  }
  function place(type) {
    const inp = qs('[data-bind="' + PATHS[type] + '"]'); const row = inp && inp.closest('.slider-row');
    if (row && box.previousElementSibling !== row) row.after(box);
  }
  const readyFor = (item, level) => level !== 'off' && media.has(cleanId(item.mediaId, level));

  function render() {
    const cur = current();
    if (!cur) { box.hidden = true; if (player.cleanBypass) { player.cleanBypass = false; } lastId = null; return; }
    const { item, type } = cur;
    place(type); box.hidden = false;
    if (lastId !== item.id) { lastId = item.id; ask = null; err = null; if (player.cleanBypass) { player.cleanBypass = false; player.invalidate(); } $('cleanCompare').checked = false; }
    const lvl = cleanLevelOf(item), here = job && job.itemId === item.id;
    const shown = here ? job.level : (ask === item.id ? 'strong' : lvl);
    for (const b of box.querySelectorAll('#cleanSeg button')) { const on = b.dataset.clean === shown; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    const ready = lvl !== 'off' && readyFor(item, lvl), stale = lvl !== 'off' && !ready && !here;
    const st = $('cleanState'); st.className = 'clean-state';
    let hint, warn = false;
    if (here) st.textContent = job.phase === 'download' ? 'Downloading' : 'Cleaning';
    else if (ready) { st.textContent = 'Cleaned'; st.classList.add('ok'); }
    else if (stale) st.textContent = 'Not on this device yet';
    else st.textContent = '';
    if (err && err.itemId === item.id && !here) { hint = err.msg; warn = true; }
    else if (here) hint = '';
    else if (ask === item.id) hint = '';
    else if (stale) hint = 'Clean voice is on for this sound, but the cleaned copy isn’t stored on this device (it was not included in the file you opened).';
    else if (ready && lvl === 'strong') hint = 'Strong: heavy noise removal for hum, fans, crowd and room noise. It cannot fully remove echo or music under a voice. The original is kept; Off brings it back.';
    else if (ready) hint = 'Light: gentle cleanup of hum, fans and background noise. The original is kept; Off brings it back.';
    else hint = 'Removes hum, fans and background noise from speech, on this device. The original is kept.';
    const h = $('cleanHint'); h.textContent = hint; h.hidden = !hint; h.classList.toggle('warn', warn);
    $('cleanProg').classList.toggle('show', !!here);
    $('cleanAsk').hidden = !(ask === item.id && !here);
    $('cleanNow').hidden = !(stale && !(err && err.itemId === item.id)) ;
    const ct = changeTarget(item);
    $('cleanCompareRow').hidden = !(ready || (ct && media.has(ct))); // one compare switch for Clean voice and Change voice
    if (here) renderProgress();
    if (ask === item.id && !here) {
      const mb = api ? api.STRONG_MB : 22;
      $('cleanAskText').textContent = 'Strong needs a one-time download of about ' + mb + ' MB (a neural network). After that it works offline. It is slower than Light: roughly 25 seconds per minute of sound on a computer, longer on a phone.';
    }
  }
  function renderProgress() {
    if (!job) return;
    const bar = $('cleanBar'), txt = $('cleanProgText');
    if (job.phase === 'download') {
      const f = job.total ? job.loaded / job.total : 0;
      bar.style.width = Math.round(f * 100) + '%';
      txt.textContent = 'Downloading ' + fmtBytes(job.loaded || 0) + ' of ' + fmtBytes(job.total || 0) + ' · ' + Math.round(f * 100) + '%';
    } else {
      bar.style.width = Math.round(job.frac * 100) + '%';
      const e = etaText(job.eta);
      txt.textContent = (job.frac > 0 ? 'Cleaning ' + Math.round(job.frac * 100) + '%' : 'Starting…') + (e ? ' · ' + e : '');
    }
  }

  function apply(type, id, level) {
    const it = findItem(type, id); if (!it) return;
    it.clean = { level };
    commit('Clean voice: ' + level);
    player.invalidate();
    if (ctx.afterClean) setTimeout(() => ctx.afterClean(type, id), 0); // Change voice goes on top of the new cleaned sound (after this job has ended)
  }
  async function startJob(cur, level) {
    const { item, type } = cur;
    const ctl = new AbortController();
    job = { kind: 'clean', itemId: item.id, type, mediaId: item.mediaId, level, phase: 'process', frac: 0, eta: null, loaded: 0, total: 0, ctl };
    app.cleanJob = job; err = null; ask = null; render();
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    try {
      const A = await load();
      if (level === 'strong' && !(await A.strongReady())) {
        job.phase = 'download'; job.total = A.STRONG_BYTES; render();
        await A.downloadStrong({ signal: ctl.signal, onProgress: (p) => { job.loaded = p.loaded; job.total = p.total; renderProgress(); } });
        job.phase = 'process'; job.frac = 0; render();
      }
      const t0 = performance.now();
      await A.cleanMedia(media, item.mediaId, { level, fallbackDur: () => mediaSourceEnd(app.project, item.mediaId), signal: ctl.signal, onProgress: (p) => { job.frac = p.frac; job.eta = p.etaSec; renderProgress(); } });
      job.secs = (performance.now() - t0) / 1000;
      if (findItem(type, item.id)) apply(type, item.id, level);
      else player.invalidate();
      toast('Clean voice is on.');
    } catch (e) {
      const A = api;
      if (e && (e.name === 'CleanCancelled' || (A && e instanceof A.CleanCancelled))) toast('Cancelled. The sound is unchanged.');
      else { err = { itemId: item.id, msg: (e && e.message) || 'Cleaning did not work.' }; toast(err.msg, 6000); }
    } finally {
      try { wake && wake.release(); } catch { /* ignore */ }
      job = null; app.cleanJob = null; render();
    }
  }
  async function setLevel(level) {
    const cur = current(); if (!cur) return;
    const { item, type } = cur;
    err = null;
    if (app.cleanJob && !job) return toast('Another sound is being processed. Wait for it or cancel it first.', 4000);
    if (job) {
      if (job.itemId !== item.id) return toast('Another sound is being cleaned. Wait for it or cancel it first.', 4000);
      if (job.level === level) return;
      job.ctl.abort(); // switching level cancels the running one
      const wait = Date.now(); while (job && Date.now() - wait < 3000) await new Promise(r => setTimeout(r, 30));
    }
    const lvl = cleanLevelOf(item);
    if (level === 'off') { ask = null; if (lvl !== 'off') apply(type, item.id, 'off'); else render(); return; }
    if (level === lvl && readyFor(item, level)) { ask = null; render(); return; }
    if (readyFor(item, level)) { ask = null; apply(type, item.id, level); return; }
    if (level === 'strong') {
      const A = await load();
      if (!(await A.strongReady())) { ask = item.id; render(); return; }
    }
    startJob(cur, level);
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.clean) return void setLevel(b.dataset.clean);
    const cur = current(); if (!cur) return;
    if (b.id === 'cleanCancel') { if (job) job.ctl.abort(); }
    else if (b.id === 'cleanAskGo') startJob(cur, 'strong');
    else if (b.id === 'cleanAskNo') { ask = null; render(); }
    else if (b.id === 'cleanNow') startJob(cur, cleanLevelOf(cur.item));
  });
  $('cleanCompare').addEventListener('change', (e) => { player.cleanBypass = e.target.checked; player.invalidate(); });
  return { render, current, findItem, get job() { return job; } };
}
