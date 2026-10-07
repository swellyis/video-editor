// Cut to beat dialog: choose the music, find its beats if needed, pick Re-time / Cut on beats / Transitions only, how often, photo fitting
// and an optional transition on each beat; see the result in plain words, apply as ONE undo step. The maths is in beatcut.js (pure).
import { $ } from './util.js';
import { EVERY, LENGTHS, cutToBeat, describe, musicBeats, beatPeriod } from './beatcut.js';
import { TYPES } from './transitions.js';
import { detectBeats } from './beat-ui.js';

const MODE_HINT = {
  retime: 'Changes how long each clip or photo plays so every cut lands on a beat (videos use their spare footage; nothing is stretched).',
  cut: 'Splits longer clips exactly on the beats. Clips keep their place; photos are fitted when the box below is ticked.',
  transitions: 'Leaves the cuts alone and only adds the transition where a cut already sits on a beat.',
};

export function initBeatCut({ app, media, toast, openDialog, closeDialog }) {
  if (!$('beatCutDialog') || !$('bcApply')) return { open() { toast('This copy of the page is out of date. Reload it to use Cut to beat.', 5000); } };
  const S = { list: [], music: null, mode: 'retime', job: null };
  const clone = () => JSON.parse(JSON.stringify(app.project));
  const musicList = () => app.project.audio.filter(a => a.mediaId && !a.loop);
  const music = () => app.project.audio.find(a => a.id === S.music) || null;

  // static options
  $('bcEvery').innerHTML = EVERY.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
  $('bcEvery').value = '1';
  $('bcStyle').innerHTML = TYPES.filter(t => t.id !== 'cut').map(t => `<option value="${t.id}">${t.label}</option>`).join('');
  $('bcStyle').value = 'crossfade';
  $('bcLen').innerHTML = LENGTHS.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
  $('bcLen').value = 'q';

  function opts() {
    return { mode: S.mode, every: +$('bcEvery').value, fitPhotos: $('bcFit').checked, transition: $('bcTrans').checked ? { type: $('bcStyle').value, length: $('bcLen').value } : null };
  }
  function summary() {
    const p = app.project, ids = new Set(S.list.filter(s => s.type === 'clip').map(s => s.id));
    const clips = ids.size ? p.clips.filter(c => ids.has(c.id)) : p.clips, ov = S.list.filter(s => s.type === 'overlay').length;
    const ph = clips.filter(c => c.kind === 'image').length, vd = clips.length - ph;
    const parts = []; if (vd) parts.push(vd + ' clip' + (vd === 1 ? '' : 's')); if (ph) parts.push(ph + ' photo' + (ph === 1 ? '' : 's')); if (ov) parts.push(ov + ' overlay' + (ov === 1 ? '' : 's'));
    return (ids.size ? 'Selected: ' : 'Nothing selected on the main track, so all of it is used: ') + (parts.join(', ') || 'nothing') + '.';
  }
  function refresh() {
    const m = music(), beats = m ? musicBeats(m) : [];
    $('bcSel').textContent = summary();
    const list = musicList();
    $('bcMusic').innerHTML = list.length ? list.map(a => `<option value="${a.id}">${(a.name || 'Music').replace(/[<&]/g, '')}${a.beat ? ' · ' + Math.round(a.beat.bpm * (a.speed > 0 ? a.speed : 1)) + ' BPM' : ''}</option>`).join('') : '<option value="">No music on the timeline</option>';
    $('bcMusic').value = S.music || ''; $('bcMusic').disabled = !list.length || !!S.job;
    $('bcFind').hidden = !m || !!S.job; $('bcFind').textContent = m && m.beat ? 'Find beats again' : 'Find beats';
    $('bcProg').hidden = !S.job;
    $('bcBeats').textContent = !list.length ? 'Add a music track first (Audio › Add music).' : !m ? '' : S.job ? '' : beats.length >= 2
      ? beats.length + ' beats on the timeline · one beat every ' + (Math.round(beatPeriod(beats) * 1000) / 1000) + ' s.'
      : m.beat ? 'The beats found don’t reach the part on the timeline. Find beats again.' : (S.refusal || 'This music has no beats yet.');
    for (const b of $('bcMode').querySelectorAll('button')) { const on = b.dataset.mode === S.mode; b.classList.toggle('selected', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
    $('bcModeHint').textContent = MODE_HINT[S.mode];
    $('bcFitRow').hidden = S.mode === 'transitions';
    $('bcTransRow').hidden = !$('bcTrans').checked;
    const o = opts(), box = $('bcPreview');
    if (S.mode === 'transitions' && !o.transition) { box.textContent = 'Tick “Add a transition” to choose one.'; $('bcApply').disabled = true; return; }
    if (!m || beats.length < 2 || S.job) { box.textContent = S.job ? 'Listening to the music…' : 'Find the beats of the music first.'; $('bcApply').disabled = true; return; }
    const rep = cutToBeat(clone(), S.list, m, o);
    box.textContent = describe(rep); $('bcApply').disabled = !rep.ok;
    S.preview = rep;
  }
  async function find() {
    const m = music(); if (!m || S.job) return;
    const rec = await media.get(m.mediaId).catch(() => null);
    if (!rec) { toast('The music isn’t available on this device.', 5000); return; }
    const ctl = new AbortController(); S.job = ctl; S.refusal = null; $('bcBar').style.width = '0%'; refresh();
    try {
      const r = await detectBeats(rec, m, { signal: ctl.signal, onProgress: (p) => { $('bcBar').style.width = Math.round(p.frac * 100) + '%'; $('bcProgText').textContent = 'Listening ' + Math.round(p.frac * 100) + '%'; } });
      const live = app.project.audio.find(a => a.id === m.id);
      if (live && r.beat) { live.beat = r.beat; app.commit('Find beats'); app.timeline && app.timeline.render(); }
      else if (r.refusal) S.refusal = r.refusal;
    } catch (e) {
      if (!(e && e.name === 'BeatCancelled')) S.refusal = (e && e.noAudio) ? 'This has no sound.' : (e && e.message) || 'Could not read the sound.';
    } finally { S.job = null; refresh(); }
  }
  function apply() {
    const m = music(); if (!m) return;
    const rep = cutToBeat(app.project, S.list, m, opts());
    if (!rep.ok) { toast(describe(rep), 4000); return; }
    app.commit('Cut to beat'); app.timeline && app.timeline.render();
    closeDialog('beatCutDialog');
    toast(describe(rep) + ' Undo puts it back.', 6000);
    $('beatCutDialog').dataset.applied = String((+$('beatCutDialog').dataset.applied || 0) + 1);
  }
  function open(o = {}) {
    if (!app.project.clips.length) { toast('Add clips or photos to the timeline first.', 3500); return; }
    const sel = app.selList();
    S.list = sel.filter(s => s.type === 'clip' || s.type === 'overlay');
    const list = musicList(), selAudio = sel.find(s => s.type === 'audio' && list.some(a => a.id === s.id));
    S.music = o.music || (selAudio && selAudio.id) || (list.find(a => a.beat) || list[0] || {}).id || null;
    S.refusal = null;
    openDialog('beatCutDialog'); refresh();
  }
  $('bcMusic').addEventListener('change', (e) => { S.music = e.target.value || null; S.refusal = null; refresh(); });
  $('bcFind').addEventListener('click', find);
  $('bcFindCancel').addEventListener('click', () => S.job && S.job.abort());
  $('bcMode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (!b) return; S.mode = b.dataset.mode; if (S.mode === 'transitions') $('bcTrans').checked = true; refresh(); });
  for (const id of ['bcEvery', 'bcFit', 'bcTrans', 'bcStyle', 'bcLen']) $(id).addEventListener('change', refresh);
  $('bcApply').addEventListener('click', apply);
  $('bcCancel').addEventListener('click', () => closeDialog('beatCutDialog'));
  $('beatCutDialog').addEventListener('close', () => { if (S.job) S.job.abort(); });
  return { open, refresh, state: S };
}
