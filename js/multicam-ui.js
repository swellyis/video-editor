// Multi-angle: the group dialog (pick 2-4 videos, line them up by sound with the Sync engine, choose the sound), the Angle block in the
// Clip tab of a multi-angle piece, and the 1-4 keys. The edits are in multicam.js (pure); each one is ONE undo step. Live switching
// during playback changes the timeline as you go and is committed as one step when playback stops.
import { $ } from './util.js';
import { prepare, align } from './sync.js';
import { anglesOf, planGroup, createGroup, setAngle, switchAt, groupOf, audioInSync, rebuildAudio, setAudioSource, angleTimes, prune } from './multicam.js';

const fmtS = (s) => (s >= 60 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : (Math.round(s * 10) / 10) + ' s');
const esc = (s) => String(s || '').replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));

export function initMulticam({ app, media, player, toast, openDialog, closeDialog, selected }) {
  if (!$('mcDialog') || !$('mcBox')) return { open() { toast('This copy of the page is out of date. Reload it to use Multi-angle.', 5000); }, render() { }, key() { return false; } };
  const S = { sel: [], starts: null, job: null, scope: 'here', live: null, envs: new Map() };

  // ------------------------------------------------------------ the group dialog
  function open() {
    const sel = app.selList().filter(s => s.type === 'clip' || s.type === 'overlay');
    const r = anglesOf(app.project, sel);
    if (r.fail) { toast(r.reason, 5000); return; }
    S.sel = r.angles.map(a => ({ type: a.type, id: a.id })); S.starts = null; S.result = null;
    $('mcList').innerHTML = r.angles.map((a, k) => `<li><b>Angle ${k + 1}</b> · ${esc(a.item.name || 'Video')} <small>(${a.type === 'clip' ? 'main track' : 'layer'}, ${fmtS(a.item.out - a.item.in)}${a.item.hasAudio === false ? ', no sound' : ''})</small></li>`).join('');
    $('mcAudioPick').innerHTML = r.angles.map((a, k) => `<option value="${k}" ${a.item.hasAudio === false ? 'disabled' : ''}>Angle ${k + 1} · ${esc(a.item.name || 'Video')}</option>`).join('');
    const firstSound = r.angles.findIndex(a => a.item.hasAudio !== false); $('mcAudioPick').value = String(Math.max(0, firstSound));
    $('mcName').value = 'Multi-angle ' + ((app.project.multicams || []).length + 1);
    $('mcSyncChk').checked = true; $('mcProg').hidden = true;
    openDialog('mcDialog'); refresh();
  }
  function refresh() {
    const r = anglesOf(app.project, S.sel), box = $('mcPreview');
    if (r.fail) { box.textContent = r.reason; $('mcCreate').disabled = true; return; }
    const sync = $('mcSyncChk').checked;
    $('mcCreate').disabled = !!S.job; $('mcCreate').textContent = sync && !S.starts ? 'Line up and create' : 'Create multi-angle clip';
    if (S.job) { box.textContent = 'Listening to the angles…'; return; }
    const starts = sync ? S.starts : r.angles.map(a => a.start);
    if (!starts) { box.textContent = `${r.angles.length} angles. They will be lined up by their sound, then grouped into one clip on the main track.`; return; }
    const pl = planGroup(r.angles, starts);
    if (pl.fail) { box.innerHTML = '<p class="bad"></p>'; box.firstChild.textContent = pl.reason; $('mcCreate').disabled = true; return; }
    const lines = [`All ${r.angles.length} angles overlap for ${fmtS(pl.len)}: that becomes the multi-angle clip.`];
    if (S.result) lines.push(S.result);
    box.innerHTML = lines.map(l => '<p></p>').join(''); [...box.children].forEach((p, i) => { p.textContent = lines[i]; });
  }
  async function envelope(item, onProg, signal) {
    const key = [item.mediaId, item.in, item.out].join('|');
    if (S.envs.has(key)) { onProg(1); return S.envs.get(key); }
    const rec = await media.get(item.mediaId); if (!rec) throw new Error('The sound of “' + (item.name || 'a video') + '” isn’t available on this device.');
    const sc = await import('./sync-scan.js');
    const env = prepare(await sc.scanEnvelope(rec.blob, rec.name, rec.duration, Math.max(0, item.in), Math.max(item.in + 0.1, item.out), { signal, onProgress: (p) => onProg(p.frac) }));
    S.envs.set(key, env); while (S.envs.size > 6) S.envs.delete(S.envs.keys().next().value);
    return env;
  }
  async function lineUp() {
    const r = anglesOf(app.project, S.sel); if (r.fail) return false;
    const ctl = new AbortController(); S.job = ctl; $('mcProg').hidden = false; $('mcBar').style.width = '0%'; refresh();
    try {
      const n = r.angles.length, prog = (k) => (f) => { const v = (k + f) / n; $('mcBar').style.width = Math.round(v * 100) + '%'; $('mcProgText').textContent = 'Listening to angle ' + (k + 1) + ' of ' + n + '…'; };
      const envs = [];
      for (let k = 0; k < n; k++) { if (r.angles[k].item.hasAudio === false) { envs.push(null); continue; } envs.push(await envelope(r.angles[k].item, prog(k), ctl.signal)); }
      const ref = envs.findIndex(Boolean); if (ref < 0) throw new Error('None of the angles has sound, so they can’t be lined up by sound. Untick “Line them up by sound” and line them up on the timeline.');
      const starts = r.angles.map(a => a.start), notes = [];
      for (let k = 0; k < n; k++) {
        if (k === ref) continue;
        if (!envs[k]) { notes.push(`Angle ${k + 1} has no sound and keeps its place on the timeline.`); continue; }
        const al = align(envs[ref], envs[k]);
        if (!al.ok) throw new Error(`Couldn’t find the same sound in angle ${ref + 1} and angle ${k + 1} (confidence ${Math.round(al.confidence * 100)} %). Use recordings of the same moment with clear sound, or untick “Line them up by sound”.`);
        starts[k] = starts[ref] + al.lag; notes.push(`Angle ${k + 1}: ${Math.round(al.confidence * 100)} % sure`);
      }
      S.starts = starts; S.result = 'Lined up by sound. ' + notes.join(' · ') + '.';
      return true;
    } catch (e) {
      S.starts = null; S.result = null;
      if (!(e && e.name === 'SyncCancelled')) toast((e && e.noAudio) ? 'One of the angles has no sound.' : (e && e.message) || 'Could not read the sound.', 7000);
      return false;
    } finally { S.job = null; $('mcProg').hidden = true; refresh(); }
  }
  async function create() {
    const sync = $('mcSyncChk').checked;
    if (sync && !S.starts && !(await lineUp())) return;
    const r = anglesOf(app.project, S.sel); if (r.fail) { toast(r.reason, 4000); return; }
    const starts = sync ? S.starts : r.angles.map(a => a.start);
    const res = createGroup(app.project, S.sel, starts, { audio: +$('mcAudioPick').value, name: $('mcName').value.trim() || undefined });
    if (res.fail) { toast(res.reason, 5000); return; }
    app.setMulti([]); app.commit('Multi-angle clip');
    app.select({ type: 'clip', id: res.clip.id });
    closeDialog('mcDialog');
    toast(`Made “${res.group.name}” (${res.group.angles.length} angles). Tap an angle or press 1–${res.group.angles.length} while it plays to switch. Undo puts the videos back.`, 7000);
    $('mcDialog').dataset.made = String((+$('mcDialog').dataset.made || 0) + 1);
  }
  $('mcSyncChk').addEventListener('change', () => { refresh(); });
  $('mcCreate').addEventListener('click', create);
  $('mcCancel').addEventListener('click', () => closeDialog('mcDialog'));
  $('mcCancelScan').addEventListener('click', () => S.job && S.job.abort());
  $('mcDialog').addEventListener('close', () => { if (S.job) S.job.abort(); });

  // ------------------------------------------------------------ the Angle block (Clip tab)
  const curPiece = () => { const c = selected && selected('clip'); return c && c.mc ? c : null; };
  function render() {
    const c = curPiece(), box = $('mcBox');
    if (!c) { box.hidden = true; return; }
    const G = groupOf(app.project, c.mc.g); if (!G) { box.hidden = true; return; }
    box.hidden = false;
    $('mcLabel').textContent = 'Multi-angle · ' + G.name;
    const times = angleTimes(app.project, G.id);
    $('mcState').textContent = 'Angle ' + (c.mc.a + 1);
    const ab = $('mcAngles'); ab.style.setProperty('--n', String(G.angles.length));
    const sig = G.angles.map(a => a.name).join('|') + '#' + c.mc.a + '#' + times.join(',');
    if (ab.dataset.sig !== sig) {
      ab.dataset.sig = sig;
      ab.innerHTML = G.angles.map((a, k) => `<button type="button" data-angle="${k}" class="${k === c.mc.a ? 'selected' : ''}" aria-pressed="${k === c.mc.a}" title="Angle ${k + 1} (key ${k + 1}): ${esc(a.name)}"><b>${k + 1}</b><small>${esc(a.name)}</small></button>`).join('');
    }
    for (const b of $('mcScope').querySelectorAll('button')) { const on = b.dataset.scope === S.scope; b.classList.toggle('selected', on); b.setAttribute('aria-checked', String(on)); }
    const sel = $('mcAudio'), osig = G.angles.map((a, k) => k + a.name + a.hasAudio).join('|');
    if (sel.dataset.sig !== osig) { sel.dataset.sig = osig; sel.innerHTML = G.angles.map((a, k) => `<option value="${k}" ${a.hasAudio ? '' : 'disabled'}>Angle ${k + 1} · ${esc(a.name)}</option>`).join(''); }
    sel.value = String(G.audio);
    $('mcSyncWarn').hidden = !!S.live || audioInSync(app.project, G.id);
  }
  /** Switch: from the playhead (split there) or the whole selected piece. */
  function choose(a) {
    const c = curPiece(); if (!c) return;
    const t = player.t;
    if (player.playing) return void liveSwitch(a);
    let r;
    if (S.scope === 'all') r = setAngle(app.project, c.id, a);
    else { r = switchAt(app.project, t, a); if (r.fail && /not on a multi-angle/.test(r.reason)) r = setAngle(app.project, c.id, a); }
    if (r.fail) { toast(r.reason, 4000); return; }
    if (r.same) return;
    if (!audioInSync(app.project, c.mc.g)) rebuildAudio(app.project, c.mc.g);
    app.commit('Switch angle');
    if (r.clip) app.select({ type: 'clip', id: r.clip });
  }
  /** During playback: cut to angle `a` at the playhead now; committed as one step when playback stops. */
  function liveSwitch(a) {
    const t = player.t, r = switchAt(app.project, t, a);
    if (r.fail) { toast(r.reason, 2500); return false; }
    if (r.same) return true;
    if (!S.live) {
      S.live = { n: 0, g: null };
      S.live.timer = setInterval(() => { if (!player.playing) endLive(); }, 150);
    }
    S.live.n++;
    const piece = app.project.clips.find(x => x.id === r.clip); if (piece) S.live.g = piece.mc.g;
    app.liveUpdate();
    $('mcBox').dataset.live = String(S.live.n);
    return true;
  }
  function endLive() {
    if (!S.live) return;
    clearInterval(S.live.timer);
    const { n, g } = S.live; S.live = null;
    if (g && !audioInSync(app.project, g)) rebuildAudio(app.project, g);
    app.commit('Live angle switching');
    toast(`${n} angle ${n === 1 ? 'switch' : 'switches'} recorded. One Undo takes them all back.`, 4000);
  }
  /** 1-4 keys: switch when the playhead is on a multi-angle piece (true = handled). */
  function key(a) {
    const t = player.t;
    if (!app.project.clips.some(c => c.mc)) return false;
    if (player.playing) return liveSwitch(a);
    const r = switchAt(app.project, t, a);
    if (r.fail) { if (/not on a multi-angle/.test(r.reason)) return false; toast(r.reason, 3000); return true; }
    if (r.same) return true;
    const c = app.project.clips.find(x => x.id === r.clip);
    if (c && !audioInSync(app.project, c.mc.g)) rebuildAudio(app.project, c.mc.g);
    app.commit('Switch angle'); if (r.clip) app.select({ type: 'clip', id: r.clip });
    return true;
  }
  $('mcAngles').addEventListener('click', (e) => { const b = e.target.closest('button[data-angle]'); if (b) choose(+b.dataset.angle); });
  $('mcScope').addEventListener('click', (e) => { const b = e.target.closest('button[data-scope]'); if (!b) return; S.scope = b.dataset.scope; render(); });
  $('mcAudio').addEventListener('change', (e) => {
    const c = curPiece(); if (!c) return;
    const r = setAudioSource(app.project, c.mc.g, +e.target.value);
    if (r.fail) { toast(r.reason, 4000); render(); return; }
    app.commit('Multi-angle sound'); toast('The sound now comes from angle ' + (+e.target.value + 1) + '.', 2500);
  });
  $('mcResync').addEventListener('click', () => { const c = curPiece(); if (!c) return; prune(app.project); rebuildAudio(app.project, c.mc.g); app.commit('Re-sync multi-angle sound'); toast('The sound follows the pieces again.', 2500); });
  return { open, render, key, refresh, state: S };
}
