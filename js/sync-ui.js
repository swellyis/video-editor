// Sync: the one control (a block under Remove silences) that lines up the selected sound with another one by comparing their audio.
// The comparison is in sync.js (pure) and sync-scan.js (reads the sound in pieces); this file only drives the control and applies the result
// as ONE project change, so it is one undo step.
import { soundTargets } from './model.js';
import { atSpeed, alongClip, prepare, align, applySync } from './sync.js';
import { spanOf } from './silence.js';
import { etaText } from './clean-ui.js';
import { fmt } from './util.js';

const LS = 've.sync';
const WORD = { clip: 'Clip', overlay: 'Overlay', audio: 'Sound' };
const KINDS = ['clip', 'overlay', 'audio'];

export function initSyncUI(ctx) {
  const { $, app, media, toast, commit, current } = ctx;
  const box = $('syncBox'); if (!box) return { render() { } };
  const after = $('silBox');
  let job = null, ref = null, move = null, last = null, lastId = null, envCache = new Map();
  let mute = true; try { mute = JSON.parse(localStorage.getItem(LS) || '{}').mute !== false; } catch { /* default */ }

  const listOf = (type) => (type === 'clip' ? app.project.clips : type === 'overlay' ? app.project.overlays || [] : app.project.audio);
  const hasSnd = (type, it) => !!it.mediaId && !(type === 'audio' && it.loop) && !(type !== 'audio' && (it.kind !== 'video' || it.hasAudio === false || (type === 'overlay' && !it.hasAudio)));
  const sourceOf = (item) => { const id = soundTargets(item).find(t => media.has(t)); return id || item.mediaId; };
  function candidates(cur) {
    const mine = spanOf(app.project, cur.type, cur.item.id), out = [];
    for (const type of KINDS) for (const it of listOf(type)) {
      if (it === cur.item || !hasSnd(type, it)) continue;
      const sp = spanOf(app.project, type, it.id); if (!sp) continue;
      const ov = Math.max(0, Math.min(sp.start + sp.len, mine.start + mine.len) - Math.max(sp.start, mine.start));
      out.push({ key: type + ':' + it.id, type, item: it, sp, ov, label: `${WORD[type]} · ${it.name || 'Untitled'} · ${fmt(sp.start)}` });
    }
    return out.sort((a, b) => b.ov - a.ov || a.sp.start - b.sp.start);
  }
  /** Which one slides by default: an external recording (a sound track) slides to the picture; two pictures: the selected one slides. */
  function defaultMove(cur, other) { return cur.type === 'audio' && other.type !== 'audio' ? 'this' : other.type === 'audio' && cur.type !== 'audio' ? 'other' : 'this'; }
  const isPair = (a, b) => (a.type === 'audio') !== (b.type === 'audio');

  function render() {
    const cur = current();
    if (!cur || !hasSnd(cur.type, cur.item)) { box.hidden = true; return; }
    const cands = candidates(cur);
    if (!cands.length) { box.hidden = true; return; }
    // after an undo (or any other change) the old result no longer describes what is on the timeline
    if (last && last.moved) { const sp = spanOf(app.project, last.moved.type, last.moved.id); if (!sp || Math.abs(sp.start - last.moved.start) > 0.002) last = null; }
    if (after && after.nextElementSibling !== box) after.after(box);
    box.hidden = false;
    if (lastId !== cur.item.id) { lastId = cur.item.id; ref = null; move = null; last = null; }
    if (!ref || !cands.some(c => c.key === ref)) { ref = cands[0].key; move = null; }
    const o = cands.find(c => c.key === ref), sel = $('syncRef');
    const sig = cands.map(c => c.key + c.label).join('|');
    if (sel._sig !== sig) { sel._sig = sig; sel.replaceChildren(...cands.map(c => { const op = document.createElement('option'); op.value = c.key; op.textContent = c.label; return op; })); }
    sel.value = ref; sel.disabled = !!job;
    if (!move) move = defaultMove(cur, o);
    for (const b of box.querySelectorAll('#syncMove button')) { const on = b.dataset.move === move; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    const muteRow = $('syncMuteRow'), pair = isPair(cur, o);
    muteRow.hidden = !pair;
    if (pair) { const vid = cur.type === 'audio' ? o : { item: cur.item }; $('syncMuteText').textContent = 'Mute the video’s own sound (' + (vid.item.name || 'video') + ')'; $('syncMute').checked = mute; }
    $('syncGo').disabled = !!job; $('syncGo').hidden = !!job;
    $('syncProg').classList.toggle('show', !!job);
    const st = $('syncState'); st.className = 'clean-state'; st.textContent = job ? 'Listening' : last && last.id === cur.item.id && last.state || '';
    const h = $('syncHint'); h.className = 'hint' + (last && last.id === cur.item.id && last.ok ? ' ok' : last && last.id === cur.item.id && last.warn ? ' warn' : '');
    h.textContent = job ? '' : last && last.id === cur.item.id ? last.text : (move === 'this' ? 'Slides this' : 'Slides the other') + ' to line up by comparing the sound of both, on this device. Nothing moves if it isn’t sure.';
    if (job) renderProgress();
  }
  function renderProgress() {
    if (!job) return;
    $('syncBar').style.width = Math.round(job.frac * 100) + '%';
    const e = etaText(job.eta);
    $('syncProgText').textContent = (job.frac > 0 ? 'Listening ' + Math.round(job.frac * 100) + '%' : 'Starting…') + (e ? ' · ' + e : '');
  }

  async function envelopeOf(item, sp, onProg, signal) {
    const src = sourceOf(item), key = [item.mediaId, src, item.in, item.out].join('|');
    let env = envCache.get(key);
    if (!env) {
      const rec = await media.get(src) || await media.get(item.mediaId);
      if (!rec) throw new Error('The sound of “' + (item.name || 'an item') + '” isn’t available on this device.');
      const S = await import('./sync-scan.js');
      env = await S.scanEnvelope(rec.blob, rec.name, rec.duration, Math.max(0, item.in), Math.max(item.in + 0.1, item.out), { signal, onProgress: onProg });
      envCache.set(key, env); while (envCache.size > 4) envCache.delete(envCache.keys().next().value);
    } else onProg({ frac: 1 });
    return prepare(sp.type === 'clip' ? alongClip(env, item) : atSpeed(env, sp.sp)); // reversed / speed-curve clips: in playing order
  }
  async function run(cur) {
    if (job) return;
    const o = candidates(cur).find(c => c.key === ref); if (!o) return;
    const ctl = new AbortController(), thisSp = spanOf(app.project, cur.type, cur.item.id);
    const mv = move === 'this' ? { type: cur.type, item: cur.item, sp: thisSp } : { type: o.type, item: o.item, sp: o.sp };
    const st = move === 'this' ? { type: o.type, item: o.item, sp: o.sp } : { type: cur.type, item: cur.item, sp: thisSp };
    const total = st.sp.len + mv.sp.len;
    job = { frac: 0, eta: null, ctl }; last = null; render();
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    const id = cur.item.id; let res = null;
    try {
      const t0 = Date.now(); let base = 0;
      const prog = (w) => (p) => { job.frac = (base + p.frac * w) / total; job.eta = job.frac > 0.02 ? (Date.now() - t0) / 1000 * (1 - job.frac) / job.frac : null; renderProgress(); };
      const a = await envelopeOf(st.item, st.sp, prog(st.sp.len), ctl.signal); base = st.sp.len;
      const b = await envelopeOf(mv.item, mv.sp, prog(mv.sp.len), ctl.signal);
      job.frac = 1; renderProgress(); await new Promise(r => setTimeout(r, 0));
      const r = align(a, b);
      if (!r.ok) {
        const c = Math.round(r.confidence * 100);
        res = { id, warn: true, state: 'Not sure', text: `Couldn’t find the same sound in both (confidence ${c} %), so nothing was moved. Pick recordings of the same moment with a voice or a clap in both, trim away parts that only one of them has (music, other speakers), or line them up roughly by hand and try again.` };
      } else {
        const newStart = st.sp.start + r.lag, shift = newStart - mv.sp.start, c = Math.round(r.confidence * 100);
        const muteIt = isPair(cur, o) && mute ? (cur.type === 'audio' ? { type: o.type, id: o.item.id } : { type: cur.type, id: cur.item.id }) : null;
        let drift = '';
        if (Math.abs(r.driftMs || 0) >= 20) drift = ` Clock drift: the two recorders differ by about ${Math.round(Math.abs(r.driftPpm))} ppm, ${Math.round(Math.abs(r.driftMs))} ms over this recording. It was not corrected; they are lined up in the middle.`;
        if (Math.abs(shift) < 0.005) {
          res = { id, ok: true, state: c + ' % sure', text: `Already in sync (confidence ${c} %).` + drift };
        } else {
          const ap = applySync(app.project, { type: mv.type, id: mv.item.id }, newStart, { mute: muteIt });
          if (ap.fail) res = { id, warn: true, state: 'Not moved', text: ap.reason === 'before-start' ? `They match, but “${mv.item.name || 'the item'}” would have to start ${fmtS(-newStart)} before the start of the project. Choose “${move === 'this' ? 'The other one' : 'This one'}” to slide the other one instead.` : ap.reason };
          else {
            commit('Sync');
            const s = Math.abs(shift), dir = shift < 0 ? 'earlier' : 'later';
            res = { id, ok: true, moved: { type: mv.type, id: mv.item.id, start: ap.start }, state: c + ' % sure', text: `Moved “${mv.item.name || 'item'}” ${fmtS(s)} ${dir}. Confidence ${c} %.` + (muteIt ? ' The video’s own sound is muted.' : '') + (ap.pushed ? ' It went to a new lane because its place was taken.' : '') + (ap.stack ? ' It now sits over the main clips as a layer.' : '') + drift + ' Undo puts it back.' };
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'SyncCancelled') { res = { id, state: '', text: 'Cancelled. Nothing was moved.' }; }
      else { res = { id, warn: true, state: 'Error', text: (e && e.noAudio ? 'One of them has no sound.' : (e && e.message) || 'Could not read the sound.') }; toast(res.text, 6000); }
    } finally {
      try { wake && wake.release(); } catch { /* ignore */ }
      job = null; last = res; box.dataset.runs = String((+box.dataset.runs || 0) + 1); render();
    }
  }
  const fmtS = (s) => (s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60).toFixed(2) + ' s' : s.toFixed(2) + ' s');

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = current(); if (!cur) return;
    if (b.id === 'syncGo') return void run(cur);
    if (b.id === 'syncCancel') { if (job) job.ctl.abort(); return; }
    if (b.dataset.move) { move = b.dataset.move; last = null; render(); }
  });
  $('syncRef').addEventListener('change', (e) => { ref = e.target.value; move = null; last = null; render(); });
  $('syncMute').addEventListener('change', (e) => { mute = e.target.checked; try { localStorage.setItem(LS, JSON.stringify({ mute })); } catch { /* ignore */ } });
  return { render, get job() { return job; } };
}
