// Change voice: the block under "Clean voice" (Off / Deeper / Higher / Radio, plus Pitch and Tone sliders once something is on).
// The audio work is in clean.js (changeMedia) and voice-dsp.js (run in clean-worker.js); playback and export pick the copy through model.soundTargets().
import { cleanId, cleanLevelOf, changeId, changeTarget, normChange, changeIsOn, changePresetOf, CHANGE_PRESETS, mediaSourceEnd } from './model.js';
import { etaText } from './clean-ui.js';

const sgn = (v, unit) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + unit;

export function initVoiceUI(ctx) {
  const { $, app, media, player, toast, commit, current, findItem } = ctx;
  const box = $('voiceBox'); if (!box) return { render() { }, autoRun() { } };
  let api = null;
  const load = async () => api || (api = await import('./clean.js'));
  let job = null, pending = null, err = null, lastId = null, timer = 0;
  const cleanBox = $('cleanBox');

  const cleanOk = (item) => { const l = cleanLevelOf(item); return l === 'off' || media.has(cleanId(item.mediaId, l)); };
  const readyFor = (item, p) => changeIsOn(p) && media.has(changeId(item.mediaId, cleanLevelOf(item), p));

  function render() {
    const cur = current();
    if (!cur) { box.hidden = true; pending = null; lastId = null; return; }
    const { item, type } = cur;
    if (cleanBox && cleanBox.nextElementSibling !== box) cleanBox.after(box);
    box.hidden = false;
    if (lastId !== item.id) { lastId = item.id; pending = null; err = null; }
    const applied = normChange(item.change), here = !!job && job.itemId === item.id;
    const shown = pending && pending.itemId === item.id ? pending.params : here ? job.params : applied;
    const on = changeIsOn(shown), preset = changePresetOf(shown);
    for (const b of box.querySelectorAll('#voiceSeg button')) { const sel = b.dataset.voice === preset; b.classList.toggle('selected', sel); b.setAttribute('aria-pressed', sel ? 'true' : 'false'); }
    $('voiceTune').hidden = !on;
    const pi = $('voicePitch'), to = $('voiceTone');
    if (document.activeElement !== pi) pi.value = shown.pitch;
    if (document.activeElement !== to) to.value = shown.tone;
    $('voicePitchOut').textContent = sgn(shown.pitch, ' st'); $('voiceToneOut').textContent = sgn(shown.tone, '');
    const appliedOn = changeIsOn(applied), ready = appliedOn && readyFor(item, applied), stale = appliedOn && !ready && !here;
    const st = $('voiceState'); st.className = 'clean-state';
    if (here) st.textContent = 'Applying';
    else if (ready) { st.textContent = 'Applied'; st.classList.add('ok'); }
    else if (stale) st.textContent = 'Not on this device yet';
    else st.textContent = '';
    let hint, warn = false;
    if (err && err.itemId === item.id && !here) { hint = err.msg; warn = true; }
    else if (here) hint = '';
    else if (stale) hint = cleanOk(item) ? 'Change voice is on for this sound, but the changed copy isn’t stored on this device (it was not included in the file you opened).' : 'Change voice is on, but Clean voice has to be made again first (“Clean now” above).';
    else if (on && (Math.abs(shown.pitch) >= 7 || Math.abs(shown.tone) >= 4)) hint = 'Big shifts can sound robotic. A smaller Pitch, or Tone moved the other way, usually sounds more natural.';
    else if (on) hint = shown.radio ? 'Radio: a telephone / radio sound. Clean voice (if on) is applied first.' : 'Pitch changes the voice, not the speed. Clean voice (if on) is applied first; Off brings back the original.';
    else hint = 'Deeper, higher or radio voice, on this device. Speed stays the same and the original is kept.';
    const h = $('voiceHint'); h.textContent = hint; h.hidden = !hint; h.classList.toggle('warn', warn);
    $('voiceProg').classList.toggle('show', here);
    $('voiceNow').hidden = !(stale && cleanOk(item) && !(err && err.itemId === item.id));
    $('voiceReset').hidden = !on;
    if (here) renderProgress();
    void type;
  }
  function renderProgress() {
    if (!job) return;
    $('voiceBar').style.width = Math.round(job.frac * 100) + '%';
    const e = etaText(job.eta);
    $('voiceProgText').textContent = (job.frac > 0 ? 'Applying ' + Math.round(job.frac * 100) + '%' : 'Starting…') + (e ? ' · ' + e : '');
  }
  async function startJob(cur, params) {
    const { item, type } = cur, lvl = cleanLevelOf(item), n = normChange(params);
    const ctl = new AbortController();
    job = { kind: 'voice', itemId: item.id, type, mediaId: item.mediaId, params: n, frac: 0, eta: null, ctl };
    app.cleanJob = job; err = null; render();
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    try {
      const A = await load();
      await A.changeMedia(media, item.mediaId, { clean: lvl, params: n, fallbackDur: () => mediaSourceEnd(app.project, item.mediaId), signal: ctl.signal, onProgress: (p) => { job.frac = p.frac; job.eta = p.etaSec; renderProgress(); } });
      const it = findItem(type, item.id);
      if (it) { it.change = n; commit('Change voice'); }
      player.invalidate();
      toast('Change voice is on.');
    } catch (e) {
      if (e && e.name === 'CleanCancelled') toast('Cancelled. The sound is unchanged.');
      else { err = { itemId: item.id, msg: (e && e.message) || 'Change voice did not work.' }; toast(err.msg, 6000); }
    } finally {
      try { wake && wake.release(); } catch { /* ignore */ }
      job = null; pending = null; app.cleanJob = null; render();
    }
  }
  async function setParams(params) {
    const cur = current(); if (!cur) return;
    const { item, type } = cur, n = normChange(params);
    err = null; clearTimeout(timer);
    if (app.cleanJob && app.cleanJob !== job) { pending = null; render(); return toast('Another sound is being processed. Wait for it or cancel it first.', 4000); }
    if (job) { job.ctl.abort(); const w = Date.now(); while (job && Date.now() - w < 3000) await new Promise(r => setTimeout(r, 30)); }
    if (!changeIsOn(n)) {
      pending = null;
      if (item.change) { const it = findItem(type, item.id); if (it) { delete it.change; commit('Change voice: off'); player.invalidate(); } } else render();
      return;
    }
    if (!cleanOk(item)) { pending = null; err = { itemId: item.id, msg: 'Apply Clean voice first (“Clean now” above), then Change voice.' }; render(); return; }
    if (readyFor(item, n)) { pending = null; const it = findItem(type, item.id); if (it) { it.change = n; commit('Change voice'); player.invalidate(); } return; }
    pending = { itemId: item.id, params: n };
    startJob(cur, n);
  }
  /** After Clean voice changed: the changed copy has to be made again on top of the new cleaned sound. */
  function autoRun(type, id) {
    const it = findItem(type, id); if (!it || !changeIsOn(it.change) || app.cleanJob) return;
    const cur = current(); if (!cur || cur.item.id !== id) return;
    const t = changeTarget(it);
    if (t && !media.has(t) && cleanOk(it)) startJob(cur, it.change);
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = current(); if (!cur) return;
    if (b.dataset.voice) return void setParams(CHANGE_PRESETS[b.dataset.voice]);
    if (b.id === 'voiceReset') return void setParams(CHANGE_PRESETS.off);
    if (b.id === 'voiceCancel') { if (job) job.ctl.abort(); }
    else if (b.id === 'voiceNow') startJob(cur, cur.item.change);
  });
  const slide = (commitNow) => {
    const cur = current(); if (!cur) return;
    const base = pending && pending.itemId === cur.item.id ? pending.params : normChange(cur.item.change);
    const p = normChange({ pitch: Number($('voicePitch').value), tone: Number($('voiceTone').value), radio: base.radio });
    pending = { itemId: cur.item.id, params: p }; render();
    clearTimeout(timer);
    if (commitNow) timer = setTimeout(() => setParams(p), 150);
  };
  for (const id of ['voicePitch', 'voiceTone']) { $(id).addEventListener('input', () => slide(false)); $(id).addEventListener('change', () => slide(true)); }
  return { render, autoRun, get job() { return job; } };
}
