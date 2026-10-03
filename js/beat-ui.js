// Snap to beat: the one block (under Sync, in the Audio tab) for the selected music / sound item: find its tempo and beats, show them on the
// timeline as small ticks, and let other items snap to them. The maths is in beat.js (pure) and beat-scan.js (reads the sound in pieces).
// The result is stored on the item itself (item.beat) so it is saved with the project and goes through undo like any other change.
import { analyze } from './beat.js';
import { etaText } from './clean-ui.js';

export function initBeatUI(ctx) {
  const { $, app, media, toast, commit, current } = ctx;
  const box = $('beatBox'); if (!box) return { render() { } };
  const after = $('syncBox');
  let job = null, refused = new Map(); // item id -> plain-language refusal for this session (nothing is stored for a refusal)

  const fits = (item) => !!item.beat && item.in >= item.beat.from - 0.03 && item.out <= item.beat.to + 0.03;
  const played = (item) => (item.beat.bpm * (item.speed > 0 ? item.speed : 1));
  const countIn = (item) => { let n = 0; for (const t of item.beat.t) if (t >= item.in - 1e-6 && t <= item.out + 1e-6) n++; return n; };

  function render() {
    const cur = current();
    if (!cur || cur.type !== 'audio' || cur.item.loop || !cur.item.mediaId) { box.hidden = true; return; }
    const item = cur.item;
    if (after && after.nextElementSibling !== box) after.after(box);
    box.hidden = false;
    const st = $('beatState'), hint = $('beatHint'), has = !!item.beat, refusal = refused.get(item.id);
    $('beatFind').hidden = !!job; $('beatFind').textContent = has || refusal ? 'Find beats again' : 'Find beats';
    $('beatProg').classList.toggle('show', !!job);
    $('beatSnapRow').hidden = !has || !!job; $('beatSnap').checked = has && item.beat.on !== false;
    $('beatClear').hidden = !has || !!job;
    st.className = 'clean-state';
    if (job) { st.textContent = 'Listening'; hint.className = 'hint'; hint.textContent = ''; renderProgress(); return; }
    if (has) {
      const sp = item.speed > 0 ? item.speed : 1, n = countIn(item), c = Math.round(item.beat.conf * 100);
      st.textContent = Math.round(played(item) * 10) / 10 + ' BPM';
      hint.className = 'hint ok';
      hint.textContent = `${Math.round(played(item) * 10) / 10} BPM${sp !== 1 ? ' as it plays (' + Math.round(item.beat.bpm * 10) / 10 + ' in the file)' : ''} · ${c} % sure · ${n} beats on the timeline (the small ticks on the music). `
        + (item.beat.on !== false ? 'Items you drag snap to them while Snap is on; hold Alt to skip.' : 'Snapping to them is off.')
        + (fits(item) ? '' : ' You trimmed beyond the part that was analysed: press Find beats again to cover it.');
    } else if (refusal) { st.textContent = 'No clear beat'; hint.className = 'hint warn'; hint.textContent = refusal; }
    else { st.textContent = ''; hint.className = 'hint'; hint.textContent = 'Finds the tempo and the beats of this music, so other items can snap to them. Works best with drums or a steady pulse. On this device; nothing is uploaded.'; }
  }
  function renderProgress() {
    if (!job) return;
    $('beatBar').style.width = Math.round(job.frac * 100) + '%';
    const e = etaText(job.eta);
    $('beatProgText').textContent = (job.frac > 0 ? 'Listening ' + Math.round(job.frac * 100) + '%' : 'Starting…') + (e ? ' · ' + e : '');
  }
  async function find(cur) {
    if (job) return;
    const item = cur.item, rec = await media.get(item.mediaId);
    if (!rec) { toast('The sound isn’t available on this device.', 5000); return; }
    const ctl = new AbortController(); job = { frac: 0, eta: null, ctl }; refused.delete(item.id); render();
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    try {
      const S = await import('./beat-scan.js'), t0 = Date.now(), from = Math.max(0, item.in), to = Math.max(from + 0.1, item.out);
      const env = await S.scanOnsets(rec.blob, rec.name, rec.duration, from, to, { signal: ctl.signal, onProgress: (p) => { job.frac = p.frac; job.eta = p.frac > 0.02 ? (Date.now() - t0) / 1000 * (1 - p.frac) / p.frac : null; renderProgress(); } });
      await new Promise(r => setTimeout(r, 0));
      const r = analyze(env, from), live = app.project.audio.find(a => a.id === item.id);
      if (!live) return;
      if (!r.ok) {
        const c = Math.round(r.confidence * 100);
        refused.set(item.id, `No clear beat found (confidence ${c} %), so nothing was added. This works best with drums or a steady pulse; speech, ambient pads and free-time playing don’t have a beat to find. ${r.reason === 'short' ? 'The part you use is also very short.' : 'If this does have a beat, try a longer part or one with louder drums.'}`);
      } else {
        live.beat = { on: true, bpm: Math.round(r.bpm * 100) / 100, conf: Math.round(r.confidence * 100) / 100, from, to, t: r.beats.map(t => Math.round(t * 1000) / 1000) };
        commit('Find beats');
      }
    } catch (e) {
      if (!(e && e.name === 'BeatCancelled')) { refused.set(item.id, (e && e.noAudio ? 'This has no sound.' : (e && e.message) || 'Could not read the sound.')); toast(refused.get(item.id), 6000); }
    } finally { try { wake && wake.release(); } catch { /* ignore */ } job = null; box.dataset.runs = String((+box.dataset.runs || 0) + 1); app.timeline && app.timeline.render(); render(); }
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = current(); if (!cur) return;
    if (b.id === 'beatFind') return void find(cur);
    if (b.id === 'beatCancel') { if (job) job.ctl.abort(); return; }
    if (b.id === 'beatClear') { delete cur.item.beat; refused.delete(cur.item.id); commit('Clear beats'); app.timeline && app.timeline.render(); render(); }
  });
  $('beatSnap').addEventListener('change', (e) => {
    const cur = current(); if (!cur || !cur.item.beat) return;
    cur.item.beat.on = e.target.checked; commit(e.target.checked ? 'Snap to beats on' : 'Snap to beats off'); app.timeline && app.timeline.render(); render();
  });
  return { render, get job() { return job; } };
}
