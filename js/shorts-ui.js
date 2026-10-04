// Auto Shorts dialog: analyse the captions (and the voice's loudness), suggest ranked 20-60 s moments, let the person nudge / tick them,
// then make one NEW 9:16 project per ticked moment. The open project is never modified. Logic is in shorts.js; this only wires the DOM.
import { $, el, fmt } from './util.js';
import { layout } from './model.js';
import { captionAt } from './captions.js';
import { findCandidates, nudge, wordsOf, makeShortProject, cropOffset } from './shorts.js';

const STEP = 0.5;       // seconds per nudge tap
const PRESELECT = 3;    // the best few start ticked
const t1 = (v) => { const m = fmt(Math.floor(v)); return m + '.' + String(Math.floor((v % 1) * 10)); };

export function initShorts({ app, media, db, actions, openDialog, closeDialog, toast, cleanProjectName, openProject, showProjects }) {
  if (!$('shortsDialog') || !$('shList')) return { open() { toast('This copy of the page is out of date. Reload it to use Shorts.', 5000); }, state: {} }; // stale cached page
  const S = { cands: [], on: new Set(), words: [], total: 0, env: null, envKey: '', job: null, playing: null, made: [], busy: false, epoch: 0 };
  const show = (ids) => { for (const id of ['shNeed', 'shScan', 'shResults', 'shDone']) $(id).hidden = !ids.includes(id); };
  const v = $('shVideo'); $('shScan').classList.add('show'); // (the hidden attribute decides when it is visible)

  // ------------------------------------------------------------ preview (the source file itself, in a 9:16 window; nothing is loaded into memory)
  function stopPreview() { try { v.pause(); } catch { /* gone */ } S.playing = null; $('shPrevCap').textContent = ''; for (const c of document.querySelectorAll('.sh-card.playing')) c.classList.remove('playing'); }
  function applyOffset() {
    const o = cropOffset($('shOffset').value);
    v.style.objectPosition = (50 + o * 50) + '% 50%';
    $('shOffsetOut').textContent = Math.abs(o) < 0.03 ? 'Centre' : (o < 0 ? 'Left ' : 'Right ') + Math.round(Math.abs(o) * 100) + '%';
  }
  async function preview(c, card) {
    if (S.playing === c.id) return stopPreview();
    stopPreview();
    const lay = layout(app.project);
    const it = lay.items.find(i => c.start >= i.start - 1e-3 && c.start < i.end) || lay.items.find(i => i.end > c.start);
    const rec = it && it.clip.kind === 'video' ? await media.get(it.clip.mediaId) : null;
    if (!rec || !rec.blob) return toast('The video for this moment is missing on this device, so it can’t be previewed. Relink it first.', 5000);
    const sp = it.clip.speed || 1, from = it.clip.in + (Math.max(c.start, it.start) - it.start) * sp, to = it.clip.in + (Math.min(c.end, it.end) - it.start) * sp;
    S.playing = c.id; card.classList.add('playing'); applyOffset();
    const url = media.url(it.clip.mediaId);
    if (v.dataset.url !== url) { v.src = url; v.dataset.url = url; await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 6000); }); }
    v.muted = it.clip.muted === true; v.playbackRate = sp; v.currentTime = from;
    v.ontimeupdate = () => {
      const cap = captionAt(app.project.captions || [], it.start + (v.currentTime - it.clip.in) / sp);
      $('shPrevCap').textContent = cap ? cap.text.split(/\s+/).slice(0, 3).join(' ') : '';
      if (v.currentTime >= to - 0.03) stopPreview();
    };
    try { await v.play(); } catch (e) { stopPreview(); toast('Could not play the preview: ' + (e && e.message || e), 4000); }
  }

  // ------------------------------------------------------------ list
  function refreshMake() {
    const n = S.on.size;
    $('shMake').textContent = n ? 'Make ' + n + (n === 1 ? ' Short' : ' Shorts') : 'Tick a moment to make';
    $('shMake').disabled = !n || S.busy;
    for (const card of $('shList').children) card.classList.toggle('on', S.on.has(card.dataset.id));
  }
  function renderList() {
    const list = $('shList'); list.replaceChildren();
    S.cands.forEach((c, i) => {
      const cb = el('input', { type: 'checkbox', id: 'shc_' + c.id, 'aria-label': 'Make a Short from moment ' + (i + 1) });
      cb.checked = S.on.has(c.id); cb.onchange = () => { cb.checked ? S.on.add(c.id) : S.on.delete(c.id); refreshMake(); };
      const when = el('small', { class: 'when' }), why = el('p', { class: 'sh-why' });
      const refresh = () => { when.textContent = t1(c.start) + ' – ' + t1(c.end) + ' · ' + Math.round(c.end - c.start) + ' s'; };
      refresh();
      why.textContent = c.reasons.filter(r => r.pts !== 0).sort((a, b) => b.pts - a.pts).slice(0, 5).map(r => (r.pts > 0 ? '+' : '−') + ' ' + r.label).join('  ·  ');
      const vals = {};
      const mk = (which, label) => {
        const val = el('span', { class: 'val', text: t1(which === 'start' ? c.start : c.end) });
        vals[which] = val;
        const step = (d) => async () => {
          const r = nudge({ start: c.start, end: c.end }, which, d, S.words, S.total);
          c.start = r.start; c.end = r.end; vals.start.textContent = t1(c.start); vals.end.textContent = t1(c.end); refresh();
          if (S.playing === c.id) stopPreview();
        };
        return el('span', { class: 'grp sh-' + which }, label,
          el('button', { class: 'btn secondary small sh-dec', type: 'button', text: '−', 'aria-label': label + ' earlier by half a second', onclick: step(-STEP) }), val,
          el('button', { class: 'btn secondary small sh-inc', type: 'button', text: '＋', 'aria-label': label + ' later by half a second', onclick: step(STEP) }));
      };
      const card = el('div', { class: 'sh-card', 'data-id': c.id },
        el('div', { class: 'sh-top' }, cb, el('label', { class: 'sh-title', for: cb.id }, '#' + (i + 1) + ' · ' + Math.round(c.end - c.start) + ' s', when), el('span', { class: 'sh-score', title: 'Heuristic score out of 100', text: c.score })),
        el('p', { class: 'sh-text', text: '“' + c.text + '”' }), why,
        el('div', { class: 'sh-nudge' }, el('button', { class: 'btn secondary small sh-prev', type: 'button', text: '▶ Preview', onclick: () => preview(c, card) }), mk('start', 'Start'), mk('end', 'End')));
      list.append(card);
    });
    refreshMake();
  }

  // ------------------------------------------------------------ analyse
  const projKey = (p) => layout(p).total + '|' + p.clips.map(c => [c.mediaId, c.in, c.out, c.speed].join(',')).join(';') + '|' + (p.audio || []).filter(a => a.voice).length;
  async function getEnv(p) {
    const key = projKey(p);
    if (S.env && S.envKey === key) return S.env;
    const { energyEnvelope, ScanCancelled } = await import('./shorts-scan.js');
    const ac = new AbortController(); S.job = ac;
    $('shScan').hidden = false; $('shSkip').hidden = false;
    const set = (f, txt) => { $('shBar').style.width = Math.round(f * 100) + '%'; $('shPercent').textContent = Math.round(f * 100) + '%'; $('shStatus').textContent = txt; };
    set(0, 'Listening to the voice for emphasis…');
    try {
      const env = await energyEnvelope({ project: p, media, signal: ac.signal, onProgress: (f, d, tot) => set(f, 'Listening to the voice… ' + fmt(d) + ' of ' + fmt(tot)) });
      S.env = env; S.envKey = key; return env;
    } catch (e) {
      if (e instanceof ScanCancelled || ac.signal.aborted) return null;
      console.warn('Shorts: voice analysis failed', e); return null;
    } finally { S.job = null; }
  }
  /** Quick checks before the dialog opens: something on the timeline, and its video is on this device. Returns false (with a toast) if not. */
  async function precheck() {
    const p = app.project;
    if (!p.clips.length) { toast('Add your sermon video to the timeline first, then find Shorts.', 4500); return false; }
    const recs = await Promise.all(p.clips.filter(c => c.kind === 'video').map(c => media.get(c.mediaId)));
    if (!recs.length || recs.every(r => !r || !r.blob)) { toast('The video for this project is missing on this device (red clip). Relink it first, then find Shorts.', 6000); return false; }
    return true;
  }
  async function analyse() {
    const my = ++S.epoch, p = app.project;
    stopPreview(); S.cands = []; S.on = new Set(); S.made = []; S.busy = false;
    $('shNote').textContent = ''; $('shIntro').hidden = false;
    const lay = layout(p); S.total = lay.total;
    if (!(p.captions || []).length) { show(['shNeed']); return true; }
    S.words = wordsOf(p.captions);
    show(['shScan']);
    const env = lay.total <= 60 * 60 * 4 ? await getEnv(p) : null;
    if (my !== S.epoch || !$('shortsDialog').open) return false;
    const cands = findCandidates(p.captions, { env, total: lay.total, count: 8 });
    S.cands = cands; S.on = new Set(cands.slice(0, PRESELECT).map(c => c.id));
    show(['shResults']);
    $('shCount').textContent = cands.length ? cands.length + ' suggested moment' + (cands.length === 1 ? '' : 's') + ', best first. Score is out of 100 and only a guess.' : '';
    $('shNote').textContent = cands.length
      ? (env ? '' : 'The voice analysis was skipped or unavailable, so these are ranked by the words and pauses only. ') + 'Heuristics: strong opening, finished sentences, scripture references, questions, voice emphasis, pauses at the ends, 20–60 s. Nudge the start / end with − and ＋.'
      : 'No 20–60 second moment with finished sentences was found. The captions may be too short or have no punctuation. You can still cut by hand with Split.';
    renderList(); applyOffset();
    return true;
  }

  // ------------------------------------------------------------ make
  async function make() {
    if (S.busy || !S.on.size) return;
    S.busy = true; refreshMake(); stopPreview();
    const p = app.project, off = cropOffset($('shOffset').value), chosen = S.cands.filter(c => S.on.has(c.id));
    const has = (id) => { const r = media.peek(id); return !!(r && r.blob); };
    try {
      const names = new Set((await db.listProjects()).map(x => x.name));
      const base = (p.name || 'Sermon').replace(/\s*·\s*Short \d+$/, '').slice(0, 60);
      let k = 0; const made = [], skipped = [], warn = [];
      const now = Date.now();
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i]; let name; do { k++; name = cleanProjectName(base + ' · Short ' + k); } while (names.has(name));
        names.add(name);
        const r = makeShortProject(p, c.start, c.end, { name, offset: off, has });
        if (!r.clips || r.project.clips.every(x => x.kind === 'video' && !has(x.mediaId))) { skipped.push(name); continue; }
        if (r.missing.length) warn.push(name);
        r.project.updated = now + (chosen.length - i); r.project.created = now;
        await db.saveProject(r.project);
        made.push({ id: r.project.id, name, start: c.start, end: c.end });
      }
      S.made = made;
      show(['shDone']); $('shIntro').hidden = true;
      $('shDoneText').textContent = made.length
        ? '✓ ' + made.length + (made.length === 1 ? ' Short' : ' Shorts') + ' created in Projects (9:16, Bold Shorts captions): ' + made.map(m => m.name).join(', ') + '. This project was not changed.' + (warn.length ? ' Some media is missing for: ' + warn.join(', ') + '.' : '') + (skipped.length ? ' Skipped (no media): ' + skipped.join(', ') + '.' : '')
        : 'Nothing was created: the video for the chosen moments is missing on this device.';
      $('shOpen').hidden = !made.length;
      if (made.length) toast(made.length + (made.length === 1 ? ' Short' : ' Shorts') + ' created. Find them in Projects.', 4500);
    } catch (e) {
      console.warn('Shorts: make failed', e);
      toast('Could not create the Shorts: ' + (e && e.message || e), 6000);
      show(['shResults']);
    } finally { S.busy = false; refreshMake(); }
  }

  // ------------------------------------------------------------ wiring
  $('shOffset').addEventListener('input', applyOffset);
  $('shMake').onclick = make;
  $('shCancel').onclick = () => closeDialog('shortsDialog');
  $('shSkip').onclick = () => { if (S.job) S.job.abort(); };
  $('shGenerate').onclick = () => { closeDialog('shortsDialog'); app.shortsAfterCaptions = true; actions.transcribe(); };
  $('shOpen').onclick = async () => { if (S.made[0]) { await openProject(S.made[0].id); closeDialog('shortsDialog'); } };
  $('shProjects').onclick = () => { closeDialog('shortsDialog'); showProjects(); };
  $('shortsDialog').addEventListener('close', () => { S.epoch++; stopPreview(); if (S.job) S.job.abort(); v.removeAttribute('src'); delete v.dataset.url; v.load(); });
  return {
    state: S,
    async open() { if (!(await precheck())) return; openDialog('shortsDialog'); applyOffset(); await analyse(); },
  };
}
