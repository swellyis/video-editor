// Filters section of the Looks tab: a library of one-tap colour looks (like the Filters tab of CapCut / Filmora). Each preview is drawn from the user's OWN
// picture (the selected clip's current frame; a sample picture when there is none) with the same colour shader as the editor (render.js ColorGL).
// Tap a look to put it on the selected clip or PiP overlay (one undo step); Intensity fades it in; Remove; Apply to all copies it to the lane.
// The data is item.color.preset (+ color.filterAmount); the manual sliders in the Clip tab stay on top of it. See filters.js.
import { FILTERS, GROUPS, filterInfo, filterLabel, amountOf } from './filters.js';
import { ColorGL } from './render.js';
import { effectiveColor, layout, laneOf } from './model.js';
import { samplePicture } from './effects-ui.js';

const TW = 160, TH = 90;
const pct = (v) => Math.round(v * 100) + '%';

export function initFiltersUI(ctx) {
  const { $, app, commit } = ctx;
  const panel = $('tab-look'), typesEl = $('flTypes');
  if (!panel || !typesEl) return { render() { }, selectedItem() { return null; } };
  let msg = '', lastId = null, gl = null, base = null, baseKey = '', drawn = false;
  const setMsg = (m) => { msg = m; $('flNote').textContent = m; };

  // ---- the Filters | Effects switch at the top of the tab
  function showPart(which) {
    for (const b of document.querySelectorAll('#lookSeg button')) { const on = b.dataset.look === which; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    $('flSection').hidden = which !== 'filters'; $('fxSection').hidden = which !== 'effects';
    render();
  }
  for (const b of document.querySelectorAll('#lookSeg button')) b.addEventListener('click', () => { showPart(b.dataset.look); try { localStorage.setItem('ve.lookPart', b.dataset.look); } catch { /* optional */ } });

  function item() {
    const s = app.selection; if (!s) return null;
    const arr = s.type === 'clip' ? app.project.clips : s.type === 'overlay' ? app.project.overlays : null;
    const obj = arr && arr.find(x => x.id === s.id);
    if (!obj) return null;
    if (!obj.color || typeof obj.color !== 'object') obj.color = { preset: 'none', filterAmount: 1 };
    return { kind: s.type, obj, list: arr };
  }

  // ---- the picture the previews are drawn on
  function basePicture(it) {
    const c = document.createElement('canvas'); c.width = TW; c.height = TH; const x = c.getContext('2d');
    let src = null, key = 'sample';
    try {
      if (it && it.kind === 'clip') { const li = layout(app.project).items.find(i => i.clip.id === it.obj.id); src = li && app.player.getSource ? app.player.getSource(li) : null; key = it.obj.id + ':' + Math.round(app.player.t * 4); }
      else if (it && it.kind === 'overlay' && app.player.getOverlaySource) { src = app.player.getOverlaySource(it.obj); key = it.obj.id + ':' + Math.round(app.player.t * 4); }
    } catch { src = null; }
    if (src && src.img && src.w > 0 && src.h > 0) {
      try {
        const s = Math.max(TW / src.w, TH / src.h), w = src.w * s, h = src.h * s;
        x.fillStyle = '#000'; x.fillRect(0, 0, TW, TH); x.drawImage(src.img, (TW - w) / 2, (TH - h) / 2, w, h);
        return { c, key };
      } catch { /* fall back to the sample */ }
    }
    return { c: samplePicture(), key: 'sample' };
  }
  function paint(cv, id) {
    const x = cv.getContext('2d'); x.clearRect(0, 0, TW, TH);
    if (!gl) gl = new ColorGL();
    const col = effectiveColor({}, { color: { preset: id, filterAmount: 1 } });
    if (id === 'none' || !gl.ok) { x.drawImage(base.c, 0, 0); return; }
    x.drawImage(gl.process(base.c, TW, TH, col), 0, 0);
  }

  // ---- the library
  const cards = new Map();
  function addCard(grid, id, label) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-type fx-card fl-card'; b.dataset.filter = id; b.setAttribute('aria-pressed', 'false');
    const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.setAttribute('aria-hidden', 'true');
    const lb = document.createElement('span'); lb.className = 'tr-lbl'; lb.textContent = label;
    b.append(cv, lb); b.addEventListener('click', () => choose(id));
    grid.append(b); cards.set(id, { b, cv });
  }
  { // "None" first, then each group
    const row = document.createElement('div'); row.className = 'tr-group'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Original');
    const grid = document.createElement('div'); grid.className = 'tr-grid'; addCard(grid, 'none', 'Original'); row.append(grid); typesEl.append(row);
    for (const g of GROUPS) {
      const r = document.createElement('div'); r.className = 'tr-group'; r.setAttribute('role', 'group'); r.setAttribute('aria-label', g);
      const h = document.createElement('span'); h.className = 'tr-gl'; h.textContent = g; h.setAttribute('aria-hidden', 'true'); r.append(h);
      const gr = document.createElement('div'); gr.className = 'tr-grid';
      for (const f of FILTERS.filter(x => x.group === g)) addCard(gr, f.id, f.label);
      r.append(gr); typesEl.append(r);
    }
  }
  function drawAll(it) {
    const b = basePicture(it); if (drawn && b.key === baseKey) return;
    base = b; baseKey = b.key; drawn = true;
    for (const [id, { cv }] of cards) paint(cv, id);
  }

  // ---- changing the project (one undo step each)
  function choose(id) {
    const it = item();
    if (!it) { // nothing selected: take the clip at the playhead, say so, change nothing
      const t = app.player ? app.player.t : 0, x = layout(app.project).items.find(i => t >= i.start && t < i.end) || layout(app.project).items[0];
      if (!x) { setMsg('Add a clip first, then tap a filter.'); return; }
      app.select({ type: 'clip', id: x.clip.id }); render();
      setMsg(`Clip ${x.index + 1} selected. Tap a filter to put it on this clip.`); return;
    }
    const c = it.obj.color;
    if (c.preset === id) { setMsg(id === 'none' ? 'No filter on this ' + (it.kind === 'clip' ? 'clip' : 'overlay') + '.' : filterLabel(id) + ' is already on. Drag Intensity to change it, or tap Remove.'); return; }
    c.preset = id; if (!(amountOf(c) > 0)) c.filterAmount = 1; else c.filterAmount = amountOf(c);
    msg = ''; commit(id === 'none' ? 'Remove filter' : 'Filter: ' + filterLabel(id));
  }
  $('flAmt').addEventListener('input', () => {
    const it = item(); if (!it || it.obj.color.preset === 'none') return;
    it.obj.color.filterAmount = +$('flAmt').value / 100; $('flAmtOut').textContent = pct(it.obj.color.filterAmount); app.liveUpdate();
  });
  $('flAmt').addEventListener('change', () => { const it = item(); if (it && it.obj.color.preset !== 'none') commit('Filter intensity'); });
  $('flRemove').addEventListener('click', () => { const it = item(); if (it && it.obj.color.preset !== 'none') { it.obj.color.preset = 'none'; it.obj.color.filterAmount = 1; msg = ''; commit('Remove filter'); } });
  $('flAll').addEventListener('click', () => {
    const it = item(); if (!it || it.obj.color.preset === 'none') return;
    const lane = laneOf(it.obj), same = it.list.filter(x => x !== it.obj && laneOf(x) === lane);
    if (!same.length) { setMsg('There is no other ' + (it.kind === 'clip' ? 'clip' : 'overlay') + ' on this lane.'); return; }
    for (const x of same) { if (!x.color || typeof x.color !== 'object') x.color = { preset: 'none', filterAmount: 1 }; x.color.preset = it.obj.color.preset; x.color.filterAmount = amountOf(it.obj.color); }
    const n = same.length; commit('Filter on all clips in the lane');
    setMsg(`${filterLabel(it.obj.color.preset)} is now on ${n} other ${it.kind === 'clip' ? (n === 1 ? 'clip' : 'clips') : (n === 1 ? 'overlay' : 'overlays')} in this lane.`);
  });

  function render() {
    const it = item(), id = it ? it.obj.id : null;
    if (id !== lastId) { lastId = id; msg = ''; }
    if (panel.classList.contains('active') && !$('flSection').hidden) drawAll(it);
    const cur = it ? it.obj.color.preset : null, amt = it ? amountOf(it.obj.color) : 1;
    let sp = null; if (it && it.kind === 'clip') sp = layout(app.project).items.find(i => i.clip.id === it.obj.id);
    $('flFor').textContent = !it ? 'No clip selected' : it.kind === 'clip' ? `Clip ${sp ? sp.index + 1 : ''}: ${it.obj.name}` : `Overlay: ${it.obj.name}`;
    for (const [fid, { b }] of cards) { const on = !!it && cur === fid; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    const has = !!it && cur !== 'none' && !!filterInfo(cur);
    $('flAmt').disabled = !has; if (document.activeElement !== $('flAmt')) $('flAmt').value = String(Math.round(amt * 100));
    $('flAmtOut').textContent = has ? pct(amt) : '—';
    $('flRemove').disabled = !has; $('flAll').disabled = !has;
    if (!msg) $('flNote').textContent = !it ? (app.project.clips.length ? 'Select a clip or overlay on the timeline, then tap a look. Tapping one now picks the clip at the playhead.' : 'Add a clip first, then tap a filter.') : has ? filterLabel(cur) + ' is on this ' + (it.kind === 'clip' ? 'clip' : 'overlay') + '.' : 'No filter yet. Tap a look below.';
  }
  { let v = 'filters'; try { v = localStorage.getItem('ve.lookPart') === 'effects' ? 'effects' : 'filters'; } catch { /* optional */ } showPart(v); }
  return { render, selectedItem: item, showPart };
}
