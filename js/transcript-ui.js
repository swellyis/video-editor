// Transcript view (Captions tab): words from captions with timings. Click → seek; Shift/Ctrl-click or drag to select;
// Delete / the Delete selected button cuts those ranges from the timeline (same engine as filler removal) in ONE undo step.
// Playback highlight follows the playhead. Filler-word review lives in the same section (one entry point).
import { allWords, findFillers, countsOf, indexesToCut, hitKey } from './fillers.js';
import { wordRanges, cutRanges } from './cut.js';
import { fmt } from './util.js';

const LS_FILL = 've.fillers';

export function initTranscriptUI(ctx) {
  const { $, app, player, toast, showTab } = ctx;
  const list = $('txList'), empty = $('txEmpty'), tools = $('txTools'), countEl = $('txSelCount');
  const fillBox = $('txFillers'), fillList = $('txFillList'), fillSum = $('txFillSum');
  if (!list) return { render() { }, onTime() { } };

  let words = [], sel = new Set(), lastClick = -1, active = -1, dismissed = new Set(), fillHits = [];
  let opts = { phrases: true, optional: false, stutters: true };
  try { opts = { ...opts, ...JSON.parse(localStorage.getItem(LS_FILL) || '{}') }; } catch { /* private */ }
  const saveOpts = () => { try { localStorage.setItem(LS_FILL, JSON.stringify(opts)); } catch { /* private */ } };

  const paintSel = () => {
    for (const n of list.children) n.classList.toggle('sel', sel.has(+n.dataset.i));
    const n = sel.size;
    if (tools) tools.hidden = !words.length;
    if (countEl) countEl.textContent = n ? n + (n === 1 ? ' word selected' : ' words selected') : 'Tap a word to seek · Shift-click or drag to select · Delete to cut';
    const del = $('txDelete'); if (del) { del.disabled = !n; del.setAttribute('aria-disabled', n ? 'false' : 'true'); }
  };
  const paintActive = (i) => {
    if (i === active) return;
    if (active >= 0 && list.children[active]) list.children[active].classList.remove('on');
    active = i;
    if (i >= 0 && list.children[i]) { list.children[i].classList.add('on'); if (!player.playing) list.children[i].scrollIntoView({ block: 'nearest' }); }
  };
  function renderList() {
    words = allWords(app.project.captions);
    sel = new Set([...sel].filter(i => i < words.length));
    list.replaceChildren();
    if (!words.length) {
      if (empty) { empty.hidden = false; empty.textContent = (app.project.captions || []).length ? 'These captions have no word timings (imported .srt without words). Generate captions from speech to edit by deleting words.' : 'Generate captions from speech (✨ Generate…) to get a transcript you can edit. Deleting words cuts them from the timeline.'; }
      if (tools) tools.hidden = true; list.hidden = true; if (fillBox) fillBox.hidden = true; return;
    }
    if (empty) empty.hidden = true; list.hidden = false;
    const frag = document.createDocumentFragment();
    words.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tx-word'; b.dataset.i = i; b.textContent = w.w;
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', 'false');
      b.title = fmt(w.start) + ' – ' + fmt(w.end);
      frag.appendChild(b);
      if (i + 1 < words.length && words[i + 1].start - w.end > 0.55) {
        const gap = document.createElement('span'); gap.className = 'tx-gap'; gap.setAttribute('aria-hidden', 'true'); gap.textContent = '·';
        frag.appendChild(gap);
      }
    });
    list.appendChild(frag);
    paintSel();
    onTime(player.t);
    renderFillers();
  }
  function renderFillers() {
    if (!fillBox) return;
    if (!words.length) { fillBox.hidden = true; return; }
    fillHits = findFillers(words, opts);
    fillBox.hidden = false;
    const counts = countsOf(fillHits.filter(h => !dismissed.has(hitKey(h))));
    const kept = fillHits.filter(h => !dismissed.has(hitKey(h)));
    if (fillSum) {
      fillSum.textContent = kept.length
        ? kept.length + ' filler' + (kept.length === 1 ? '' : 's') + (counts.length ? ' · ' + counts.slice(0, 6).map(([l, n]) => l + ' ×' + n).join(', ') : '')
        : 'No fillers found in this transcript. Whisper often drops um/uh/er — if you said them and they are missing here, they were never timed.';
    }
    if (!fillList) return;
    fillList.replaceChildren();
    for (const h of fillHits) {
      const row = document.createElement('div'); row.className = 'tx-fill' + (dismissed.has(hitKey(h)) ? ' is-off' : '');
      row.innerHTML = '';
      const play = document.createElement('button'); play.type = 'button'; play.className = 'btn ghost small'; play.textContent = '▶'; play.title = 'Play this moment';
      play.onclick = () => { player.setTime(Math.max(0, h.a - 0.15)); player.play(); setTimeout(() => player.pause(), Math.max(400, (h.b - h.a + 0.4) * 1000)); };
      const lab = document.createElement('span'); lab.className = 'tx-fill-lab'; lab.textContent = h.label; lab.title = h.text + ' @ ' + fmt(h.a);
      const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'btn ghost small'; keep.textContent = dismissed.has(hitKey(h)) ? 'Undo keep' : 'Keep';
      keep.onclick = () => { const k = hitKey(h); if (dismissed.has(k)) dismissed.delete(k); else dismissed.add(k); renderFillers(); };
      row.append(play, lab, keep);
      fillList.appendChild(row);
    }
  }

  function cutIndexes(idx, label) {
    if (!idx.length) return toast('Select words in the transcript first, then press Delete.', 3000);
    const ranges = wordRanges(words, idx);
    const r = cutRanges(app.project, ranges);
    if (!r || r.removed < 0.001) return toast('Nothing to cut there.', 2500);
    dismissed = new Set();
    app.commit(label || ('Delete ' + idx.length + (idx.length === 1 ? ' word' : ' words')));
    toast('Removed ' + r.removed.toFixed(1) + ' s. Undo (Ctrl+Z) brings it back.', 4000);
    sel = new Set();
    renderList();
  }

  // ---- pointer selection on the word list
  let drag = null;
  list.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.tx-word'); if (!b) return;
    const i = +b.dataset.i; e.preventDefault();
    try { list.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (e.shiftKey && lastClick >= 0) {
      const a = Math.min(lastClick, i), z = Math.max(lastClick, i);
      if (!e.ctrlKey && !e.metaKey) sel = new Set();
      for (let k = a; k <= z; k++) sel.add(k);
    } else if (e.ctrlKey || e.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); lastClick = i; }
    else { sel = new Set([i]); lastClick = i; player.setTime(words[i].start + 0.01); }
    drag = { id: e.pointerId, from: i }; paintSel();
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const b = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tx-word'); if (!b) return;
    const i = +b.dataset.i, a = Math.min(drag.from, i), z = Math.max(drag.from, i);
    sel = new Set(); for (let k = a; k <= z; k++) sel.add(k); paintSel();
  });
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  list.addEventListener('pointerup', endDrag); list.addEventListener('pointercancel', endDrag);

  $('txDelete')?.addEventListener('click', () => cutIndexes([...sel].sort((a, b) => a - b)));
  $('txSelectAll')?.addEventListener('click', () => { sel = new Set(words.map((_, i) => i)); paintSel(); });
  $('txClearSel')?.addEventListener('click', () => { sel = new Set(); paintSel(); });

  // fillers options + remove
  const syncOpts = () => {
    const p = $('txOptPhrases'), o = $('txOptLike'), s = $('txOptStutter');
    if (p) p.checked = !!opts.phrases; if (o) o.checked = !!opts.optional; if (s) s.checked = !!opts.stutters;
  };
  for (const [id, key] of [['txOptPhrases', 'phrases'], ['txOptLike', 'optional'], ['txOptStutter', 'stutters']]) {
    $(id)?.addEventListener('change', (e) => { opts[key] = e.target.checked; saveOpts(); dismissed = new Set(); renderFillers(); });
  }
  $('txRemoveFillers')?.addEventListener('click', () => {
    const idx = indexesToCut(fillHits, dismissed);
    if (!idx.length) return toast(fillHits.length ? 'Every filler is marked Keep. Un-keep one, or select words above.' : 'No fillers to remove. Whisper often omits um/uh — generate captions again after speaking them clearly if you need them timed.', 5000);
    cutIndexes(idx, 'Remove fillers');
  });
  $('txShowFillers')?.addEventListener('click', () => {
    const body = $('txFillBody'); if (!body) return;
    body.hidden = !body.hidden; $('txShowFillers').setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    if (!body.hidden) { syncOpts(); renderFillers(); body.scrollIntoView({ block: 'nearest' }); }
  });

  // Delete key when the transcript (or a word) is focused — do not steal it from text fields
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (!list.offsetParent) return; // section not visible
    if (!sel.size) return;
    if (!(e.target === list || list.contains(e.target) || e.target.id === 'txDelete' || e.target.closest?.('#txSection'))) return;
    e.preventDefault(); e.stopPropagation();
    cutIndexes([...sel].sort((a, b) => a - b));
  }, true);

  function onTime(t) {
    if (!words.length) return;
    let i = -1;
    for (let k = 0; k < words.length; k++) if (t >= words[k].start - 0.02 && t < words[k].end + 0.05) i = k;
    if (i < 0) { // between words: the last one that started
      for (let k = words.length - 1; k >= 0; k--) if (words[k].start <= t) { i = k; break; }
    }
    paintActive(i);
  }

  syncOpts();
  return {
    render: renderList,
    onTime,
    open() { showTab && showTab('captions'); renderList(); },
  };
}
