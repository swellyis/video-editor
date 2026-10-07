// Auto Shorts dialog: analyse the captions (and the voice's loudness), suggest ranked 20-60 s moments, let the person nudge / tick them,
// then make one NEW 9:16 project per ticked moment. The open project is never modified. Logic is in shorts.js; this only wires the DOM.
import { $, el, fmt, download } from './util.js';
import { layout } from './model.js';
import { captionAt, CAPTION_PRESETS, PACK_KEYS } from './captions.js';
import { findCandidates, nudge, wordsOf, makeShortProject, cropOffset, shortFileName, NAME_PATTERN } from './shorts.js';
import { runQueue, summarize, Skip } from './queue.js';
import { autoReframeClip } from './reframe-run.js';

const STEP = 0.5;       // seconds per nudge tap
const PRESELECT = 3;    // the best few start ticked
const t1 = (v) => { const m = fmt(Math.floor(v)); return m + '.' + String(Math.floor((v % 1) * 10)); };

export function initShorts({ app, media, db, actions, openDialog, closeDialog, toast, cleanProjectName, openProject, showProjects, exportProject }) {
  if (!$('shortsDialog') || !$('shList')) return { open() { toast('This copy of the page is out of date. Reload it to use Shorts.', 5000); }, state: {} }; // stale cached page
  const S = { cands: [], on: new Set(), words: [], total: 0, env: null, envKey: '', job: null, playing: null, made: [], busy: false, epoch: 0, batch: null, rows: [], urls: [] };
  const show = (ids) => { for (const id of ['shNeed', 'shScan', 'shResults', 'shDone', 'shQueue']) $(id).hidden = !ids.includes(id); };
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
    if ($('shExport')) { $('shExport').textContent = n ? 'Export ' + n + ' ticked as ' + (n === 1 ? 'a video' : 'videos') : 'Export ticked as videos'; $('shExport').disabled = !n || S.busy; }
    nameExample();
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
    if (!p.clips.length) { toast('Add your video to the timeline first, then find Shorts.', 4500); return false; }
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
      ? (env ? '' : 'The voice analysis was skipped or unavailable, so these are ranked by the words and pauses only. ') + 'Heuristics: strong opening, finished sentences, references, questions, voice emphasis, pauses at the ends, 20–60 s. Nudge the start / end with − and ＋.'
      : 'No 20–60 second moment with finished sentences was found. The captions may be too short or have no punctuation. You can still cut by hand with Split.';
    renderList(); applyOffset();
    return true;
  }

  // ------------------------------------------------------------ make
  const capPreset = () => { const v = $('shCapStyle') && $('shCapStyle').value; return CAPTION_PRESETS[v] ? v : 'shorts'; };
  const has = (id) => { const r = media.peek(id); return !!(r && r.blob); };
  /** Build the 9:16 project for one moment (reframed when that box is ticked). Returns { r, warn } or null when its media is missing. */
  async function buildShort(c, name, onReframe) {
    const p = app.project, off = cropOffset($('shOffset').value);
    const r = makeShortProject(p, c.start, c.end, { name, offset: off, has, captionPreset: capPreset() });
    if (!r.clips || r.project.clips.every(x => x.kind === 'video' && !has(x.mediaId))) return null;
    const warn = r.missing.length ? [name] : [];
    if ($('shReframe') && $('shReframe').checked) {
      try {
        for (const clip of r.project.clips.filter(x => x.kind !== 'image' && x.mediaId && has(x.mediaId))) {
          await autoReframeClip(r.project, clip, async () => { const m = media.peek(clip.mediaId) || await media.get(clip.mediaId); return m && m.blob; }, {
            target: '9:16', setProjectRatio: false, setFit: true, onProgress: (pr) => onReframe && onReframe(pr.frac || 0),
          });
        }
      } catch (e) { console.warn('Shorts reframe', e); warn.push(name + ' (reframe skipped)'); }
    }
    return { r, warn };
  }
  async function uniqueProjectNames() { return new Set((await db.listProjects()).map(x => x.name)); }
  const baseName = () => (app.project.name || 'Video').replace(/\s*·\s*Short \d+$/, '').slice(0, 60);
  async function make() {
    if (S.busy || !S.on.size) return;
    S.busy = true; refreshMake(); stopPreview();
    const chosen = S.cands.filter(c => S.on.has(c.id));
    try {
      const names = await uniqueProjectNames(), base = baseName();
      let k = 0; const made = [], skipped = [], warn = [];
      const now = Date.now();
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i]; let name; do { k++; name = cleanProjectName(base + ' · Short ' + k); } while (names.has(name));
        names.add(name);
        const rp = $('shReframeProg'), rb = $('shReframeBar'), rs = $('shReframeStatus');
        const reframing = $('shReframe') && $('shReframe').checked;
        if (reframing && rp) rp.hidden = false;
        const b = await buildShort(c, name, (f) => { if (rb) rb.style.width = (((i + f) / chosen.length) * 100).toFixed(1) + '%'; if (rs) rs.textContent = 'Reframing Short ' + (i + 1) + '/' + chosen.length + '…'; });
        if (rp) rp.hidden = true;
        if (!b) { skipped.push(name); continue; }
        warn.push(...b.warn);
        b.r.project.updated = now + (chosen.length - i); b.r.project.created = now;
        await db.saveProject(b.r.project);
        made.push({ id: b.r.project.id, name, start: c.start, end: c.end });
      }
      S.made = made;
      show(['shDone']); $('shIntro').hidden = true;
      $('shDoneText').textContent = made.length
        ? '✓ ' + made.length + (made.length === 1 ? ' Short' : ' Shorts') + ' created in Projects (9:16, ' + CAPTION_PRESETS[capPreset()].label + ' captions): ' + made.map(m => m.name).join(', ') + '. This project was not changed.' + (warn.length ? ' Some media is missing for: ' + warn.join(', ') + '.' : '') + (skipped.length ? ' Skipped (no media): ' + skipped.join(', ') + '.' : '')
        : 'Nothing was created: the video for the chosen moments is missing on this device.';
      $('shOpen').hidden = !made.length;
      if (made.length) toast(made.length + (made.length === 1 ? ' Short' : ' Shorts') + ' created. Find them in Projects.', 4500);
    } catch (e) {
      console.warn('Shorts: make failed', e);
      toast('Could not create the Shorts: ' + (e && e.message || e), 6000);
      show(['shResults']);
    } finally { S.busy = false; refreshMake(); }
  }

  // ------------------------------------------------------------ batch export (a queue: build each Short in memory, export it, download it)
  function nameExample() {
    const ex = $('shNameEx'); if (!ex) return;
    const chosen = S.cands.filter(c => S.on.has(c.id)), c = chosen[0] || S.cands[0];
    const f = shortFileName($('shNamePat').value, { name: baseName(), n: 1, count: Math.max(1, chosen.length), start: c ? c.start : 0, score: c ? c.score : 0 });
    ex.textContent = 'First file: ' + f + '.mp4 · tokens {name} {n} {start} {score} {date}';
  }
  const STATE_TEXT = { waiting: 'Waiting', running: '', done: 'Done', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
  function renderQueue(rows, frac) {
    const list = $('shQList');
    if (list.children.length !== rows.length) {
      list.replaceChildren(...rows.map((row, i) => el('li', { class: 'sh-q', 'data-i': i },
        el('div', { class: 'sh-q-top' }, el('b', { class: 'sh-q-name', text: row.item.file }), el('span', { class: 'sh-q-state' })),
        el('div', { class: 'progress-track sh-q-track' }, el('div', { class: 'progress-bar sh-q-bar' })),
        el('div', { class: 'sh-q-res' }))));
    }
    rows.forEach((row, i) => {
      const li = list.children[i]; li.dataset.state = row.state;
      li.querySelector('.sh-q-state').textContent = row.state === 'running' ? (row.stage || 'Working…') + ' ' + Math.floor(row.frac * 100) + '%' : STATE_TEXT[row.state];
      li.querySelector('.sh-q-bar').style.width = (row.state === 'done' ? 100 : row.frac * 100).toFixed(1) + '%';
      const res = li.querySelector('.sh-q-res');
      if (row.state === 'done' && row.result && !res.dataset.filled) {
        res.dataset.filled = '1';
        const r = row.result, a = el('a', { href: r.url, download: r.name, class: 'sh-q-again', text: 'Save again' });
        res.replaceChildren(el('span', { text: r.name + ' · ' + r.width + '×' + r.height + ' · ' + fmt(r.duration) + ' · ' + (r.size / 1048576).toFixed(1) + ' MB' + (r.project ? ' · kept in Projects' : '') + (r.warn ? ' · ' + r.warn : '') + ' ' }), a);
      } else if ((row.state === 'failed' || row.state === 'skipped') && !res.dataset.filled) { res.dataset.filled = '1'; res.textContent = row.error; }
    });
    const running = rows.findIndex(r => r.state === 'running');
    $('shQBar').style.width = (frac * 100).toFixed(1) + '%'; $('shQPercent').textContent = Math.floor(frac * 100) + '%';
    $('shQText').textContent = running >= 0 ? 'Short ' + (running + 1) + ' of ' + rows.length + ': ' + (rows[running].stage || 'working…') : summarize(rows);
  }
  function freeUrls() { for (const u of S.urls) URL.revokeObjectURL(u); S.urls = []; }
  async function exportBatch() {
    if (S.busy || !S.on.size) return;
    if (!exportProject) return toast('This copy of the page is out of date. Reload it to export Shorts.', 5000);
    S.busy = true; refreshMake(); stopPreview(); freeUrls();
    const chosen = S.cands.filter(c => S.on.has(c.id)), keep = $('shKeepProj') && $('shKeepProj').checked;
    const used = new Set(), base = baseName(), pat = $('shNamePat').value, date = new Date();
    const names = keep ? await uniqueProjectNames() : new Set();
    let k = 0;
    const items = chosen.map((c, i) => ({ c, file: shortFileName(pat, { name: base, n: i + 1, count: chosen.length, start: c.start, score: c.score, date }, used) }));
    const ac = new AbortController(); S.batch = ac;
    show(['shQueue']); $('shIntro').hidden = true; $('shQCancel').hidden = false; $('shQBack').hidden = true; $('shQList').replaceChildren();
    const src = app.project.settings;
    try {
      const rows = await runQueue(items, async (it, { signal, progress }) => {
        let pname; do { k++; pname = cleanProjectName(base + ' · Short ' + k); } while (names.has(pname));
        names.add(pname);
        progress(0, 'Building');
        const b = await buildShort(it.c, pname, (f) => progress(f * 0.2, 'Reframing'));
        if (signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        if (!b) throw new Skip('The video for this moment is missing on this device.');
        const proj = b.r.project;
        proj.settings = { ...proj.settings, fps: src.fps, quality: src.quality, format: src.format };
        const reframed = $('shReframe') && $('shReframe').checked, off = reframed ? 0.2 : 0;
        const res = await exportProject(proj, { signal, onProgress: (f, stage) => progress(off + f * (1 - off), stage || 'Exporting') });
        const name = it.file + '.' + res.ext;
        download(res.blob, name);
        const url = URL.createObjectURL(res.blob); S.urls.push(url);
        if (keep) { proj.updated = Date.now(); proj.created = proj.created || Date.now(); await db.saveProject(proj); }
        return { name, url, width: res.width, height: res.height, duration: res.duration, size: res.blob.size, ext: res.ext, project: keep ? proj.id : null, warn: b.warn.length ? 'some media missing' : '' };
      }, { signal: ac.signal, onUpdate: renderQueue });
      S.rows = rows;
      const done = rows.filter(r => r.state === 'done').length;
      $('shQueue').dataset.done = String(done);
      toast(summarize(rows) + (done ? '. The files are in your downloads.' : '.'), 5000);
    } catch (e) {
      console.warn('Shorts: batch export failed', e);
      toast('Could not export the Shorts: ' + (e && e.message || e), 6000);
    } finally {
      S.batch = null; S.busy = false; refreshMake();
      $('shQCancel').hidden = true; $('shQBack').hidden = false;
    }
  }

  // ------------------------------------------------------------ wiring
  $('shOffset').addEventListener('input', applyOffset);
  $('shMake').onclick = make;
  if ($('shExport')) {
    $('shCapStyle').replaceChildren(...PACK_KEYS.map(k => el('option', { value: k, text: CAPTION_PRESETS[k].label })));
    $('shCapStyle').value = 'shorts';
    $('shNamePat').value = localStorage.getItem('ve.shorts.pattern') || NAME_PATTERN;
    $('shNamePat').addEventListener('input', () => { nameExample(); try { localStorage.setItem('ve.shorts.pattern', $('shNamePat').value); } catch { /* private mode */ } });
    $('shExport').onclick = exportBatch;
    $('shQCancel').onclick = () => { if (S.batch) { S.batch.abort(); $('shQText').textContent = 'Cancelling…'; } };
    $('shQBack').onclick = () => { show(['shResults']); $('shIntro').hidden = false; };
  }
  $('shCancel').onclick = () => closeDialog('shortsDialog');
  $('shSkip').onclick = () => { if (S.job) S.job.abort(); };
  $('shGenerate').onclick = () => { closeDialog('shortsDialog'); app.shortsAfterCaptions = true; actions.transcribe(); };
  $('shOpen').onclick = async () => { if (S.made[0]) { await openProject(S.made[0].id); closeDialog('shortsDialog'); } };
  $('shProjects').onclick = () => { closeDialog('shortsDialog'); showProjects(); };
  $('shortsDialog').addEventListener('close', () => { S.epoch++; stopPreview(); if (S.job) S.job.abort(); if (S.batch) { S.batch.abort(); toast('Batch export cancelled: the dialog was closed.', 4000); } v.removeAttribute('src'); delete v.dataset.url; v.load(); });
  return {
    state: S,
    async open() { if (!(await precheck())) return; openDialog('shortsDialog'); applyOffset(); await analyse(); },
  };
}
