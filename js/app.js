// Video Editor Pro — main controller
import { $, qs, qsa, clamp, fmt, fmtPrecise, fmtDuration, fmtBytes, toast, download, debounce, el, safeName, isIOS, isMac, deepClone, blobToDataURL, dataURLToBlob, uid } from './util.js';
import { db, mediaIdsOf } from './db.js';
import { media, kindOf } from './media.js';
import {
  newProject, migrate, layout, clipAt, clipLen, audioLen, newClipFromMedia, newText, newAudio, splitAt, removeClip, duplicateClip,
  moveClip, rippleShift, chapters, History, PRESETS, FONTS, outputDims, defaultColor, defaultTransform, MIN_CLIP,
} from './model.js';
import { Compositor, ensureFonts, drawText, fontCss, wrapLines } from './render.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { runExport, capabilities, ExportCancelled } from './exporter.js';

const app = {
  project: newProject(),
  selection: null,
  snapEnabled: true,
  rippleEnabled: true,
  media,
  history: new History(),
};
window.__app = app; // handy for debugging & automated tests

const compositor = new Compositor();
const stage = $('stage');
const player = new Player({
  canvas: stage, getProject: () => app.project, media, compositor,
  onTime: (t) => onTime(t), onState: (p) => { $('playBtn').textContent = p ? '❚❚' : '▶'; },
});
app.player = player;
const timeline = new Timeline($('timeline'), app);
app.timeline = timeline;

// ---------------------------------------------------------------- persistence
const saveNow = async () => {
  try {
    app.project.updated = Date.now();
    await db.saveProject(JSON.parse(JSON.stringify(app.project)));
    await db.kvSet('lastProject', app.project.id);
    setSaveState('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  } catch (e) { console.error(e); setSaveState('Save failed'); toast('Could not save: ' + e.message); }
};
const scheduleSave = debounce(saveNow, 500);
function setSaveState(s) { const e = $('saveState'); e.textContent = s; e.classList.toggle('saving', /saving/i.test(s)); }

app.commit = (label) => {
  if (app.history.commit(app.project)) { setSaveState('Saving…'); scheduleSave(); }
  renderAll();
};
app.liveUpdate = (opts = {}) => {
  player.invalidate();
  timeline.render();
  syncHeads();
  if (opts.previewAt != null) player.setTime(opts.previewAt);
  fillInspector();
  updateSummary();
};
app.restore = (snap) => { app.project = migrate(snap); renderAll(); };
app.seek = (t) => { player.setTime(t); };
app.select = (sel, opts = {}) => {
  app.selection = sel;
  if (sel) {
    const tab = { clip: 'clip', text: 'text', audio: 'audio', marker: 'youtube' }[sel.type];
    if (tab) showTab(tab);
    if (opts.seekInto) {
      const t = player.t;
      if (sel.type === 'clip') { const it = layout(app.project).items.find(i => i.clip.id === sel.id); if (it && (t < it.start || t >= it.end)) player.setTime(it.start + 0.001); }
      if (sel.type === 'text') { const x = app.project.texts.find(i => i.id === sel.id); if (x && (t < x.start || t >= x.end)) player.setTime(x.start + 0.01); }
      if (sel.type === 'marker') { const m = app.project.markers.find(i => i.id === sel.id); if (m) player.setTime(m.time); }
    }
  }
  timeline.render(); fillInspector(); renderLists();
};
app.onZoom = (pps) => { $('zoomRange').value = String(ppsToRange(pps)); };

function selected(type) {
  const s = app.selection; if (!s || (type && s.type !== type)) return null;
  const p = app.project;
  if (s.type === 'clip') return p.clips.find(c => c.id === s.id) || null;
  if (s.type === 'text') return p.texts.find(c => c.id === s.id) || null;
  if (s.type === 'audio') return p.audio.find(c => c.id === s.id) || null;
  if (s.type === 'marker') return p.markers.find(c => c.id === s.id) || null;
  return null;
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  if (app.selection && !selected()) app.selection = null;
  player.invalidate();
  sizeStage();
  timeline.render();
  syncHeads();
  fillInspector();
  renderLists();
  updateSummary();
  $('undoBtn').disabled = !app.history.canUndo;
  $('redoBtn').disabled = !app.history.canRedo;
  $('projectName').textContent = app.project.name;
  document.title = app.project.name + ' · Video Editor';
}
function syncHeads() {
  qs('.text-head').style.height = timeline.tTrack.offsetHeight + 'px';
  qs('.audio-head').style.height = timeline.aTrack.offsetHeight + 'px';
}
function sizeStage() {
  const has = app.project.clips.length > 0;
  $('dropzone').hidden = has; $('stageWrap').hidden = !has;
  if (!has) return;
  const { width: W, height: H } = outputDims(app.project);
  const shell = $('dropTarget');
  const cs = getComputedStyle(shell);
  const availW = shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const maxH = Math.min(window.innerHeight * (window.innerWidth <= 620 ? 0.42 : window.innerWidth <= 940 ? 0.5 : 0.44), 820);
  let cw = availW, ch = cw * H / W;
  if (ch > maxH) { ch = maxH; cw = ch * W / H; }
  stage.style.width = Math.floor(cw) + 'px'; stage.style.height = Math.floor(ch) + 'px';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.min(W, Math.round(cw * dpr)), ph = Math.round(pw * H / W);
  if (stage.width !== pw || stage.height !== ph) { stage.width = pw; stage.height = ph; }
  player.requestRender();
}
function updateSummary() {
  const p = app.project, lay = layout(p), n = p.clips.length;
  $('clipCount').textContent = n + ' clip' + (n === 1 ? '' : 's');
  $('projectDuration').textContent = fmt(lay.total);
  const r = p.settings.ratio === 'original' ? 'Orig' : p.settings.ratio;
  $('outputFormat').textContent = r + ' ' + ({ 720: 'HD', 1080: 'FHD', 2160: '4K' }[p.settings.res] || '') + ' ' + p.settings.fps;
  $('exportBtn').disabled = !n || exporting;
  $('thumbBtn').disabled = !n;
  onTime(player.t, true);
}
let lastStageName = '';
function onTime(t, force) {
  const lay = player.lay, fps = app.project.settings.fps;
  $('timecode').textContent = fmtPrecise(t, fps) + ' / ' + fmt(lay.total);
  $('stageMeta').textContent = (player.playing ? 'PLAYING · ' : 'PREVIEW · ') + fmt(t) + ' / ' + fmt(lay.total);
  const it = clipAt(lay, t);
  const name = it ? (it.index + 1) + ' / ' + lay.items.length + ' · ' + it.clip.name : (app.project.clips.length ? '' : 'No clips yet');
  if (name !== lastStageName) { $('stageName').textContent = name; lastStageName = name; }
  timeline.updatePlayhead(t, player.playing);
}

// ---------------------------------------------------------------- data binding
function resolve(path) {
  const [root, ...rest] = path.split('.');
  let obj = root === 'proj' ? app.project : root === 'clip' ? selected('clip') : root === 'text' ? selected('text') : root === 'audio' ? selected('audio') : null;
  if (!obj) return null;
  for (let i = 0; i < rest.length - 1; i++) { obj = obj[rest[i]]; if (obj == null) return null; }
  return { obj, key: rest[rest.length - 1] };
}
function getVal(path) { const r = resolve(path); return r ? r.obj[r.key] : undefined; }
function setVal(path, v) {
  const r = resolve(path); if (!r) return false;
  const old = r.obj[r.key];
  if (old === v) return false;
  const before = layout(app.project);
  r.obj[r.key] = v;
  afterSet(path, r.obj, old, before);
  return true;
}
function afterSet(path, obj, old, before) {
  const p = app.project;
  if (path === 'clip.speed') {
    obj.speed = clamp(Number(obj.speed) || 1, 0.25, 4);
    if (app.rippleEnabled) { const it = before.items.find(i => i.clip.id === obj.id); if (it) rippleShift(p, it.end - 1e-3, layout(p).total - before.total); }
  }
  if (path === 'text.start' || path === 'text.end') { obj.start = Math.max(0, obj.start); if (obj.end < obj.start + 0.1) obj.end = obj.start + 0.1; }
  if (path === 'audio.in' || path === 'audio.out') { obj.in = clamp(obj.in, 0, (obj.srcDuration || 1e9) - 0.2); obj.out = clamp(obj.out, obj.in + 0.2, obj.srcDuration || 1e9); }
  if (path === 'audio.start') obj.start = Math.max(0, obj.start);
  if (path.startsWith('clip.fade')) obj[path.split('.')[1]] = clamp(obj[path.split('.')[1]], 0, 10);
  if (path === 'proj.settings.ratio' || path === 'proj.settings.res') sizeStage();
  if (path === 'proj.youtube.title' || path === 'proj.youtube.tags') updateCounts();
  if (path.startsWith('proj.settings.') && ['res', 'fps', 'quality', 'format'].includes(path.split('.')[2])) refreshCaps();
}
const FMT = {
  x: v => (+v).toFixed(2).replace(/\.?0+$/, '') + '×', pct: v => Math.round(v * 100) + '%', s: v => (+v).toFixed(1) + 's',
  n2: v => (+v).toFixed(2), size: v => Math.round(v * 1000) / 10, int: v => String(Math.round(v)),
};
function parseInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'range' || input.type === 'number' || input.dataset.num) { const n = parseFloat(input.value); return Number.isFinite(n) ? n : 0; }
  return input.value;
}
document.addEventListener('input', (e) => {
  const input = e.target.closest('[data-bind]');
  if (!input || input.tagName === 'DIV' || input.dataset.commit === 'change' || input.tagName === 'SELECT' || input.type === 'checkbox') return;
  if (input.tagName === 'TEXTAREA' || input.type === 'text' || !input.type || input.type === 'color') {
    if (setVal(input.dataset.bind, parseInput(input))) { liveLight(); scheduleTextCommit(); }
    return;
  }
  if (setVal(input.dataset.bind, parseInput(input))) liveLight();
});
document.addEventListener('change', (e) => {
  const input = e.target.closest('[data-bind]');
  if (!input || input.tagName === 'DIV') return;
  setVal(input.dataset.bind, parseInput(input));
  app.commit('Change ' + input.dataset.bind);
});
const scheduleTextCommit = debounce(() => app.commit('Edit text'), 700);
function liveLight() {
  player.invalidate(); timeline.render(); syncHeads(); fillOutputs(); updateSummary(); renderLists(true);
}
document.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-bind] > button');
  if (seg) {
    const box = seg.parentElement, path = box.dataset.bind;
    let v = seg.dataset.value; if (box.dataset.num) v = parseFloat(v);
    if (setVal(path, v)) app.commit('Set ' + path); else fillInspector();
    return;
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) { setVal(tg.dataset.toggle, !getVal(tg.dataset.toggle)); app.commit('Toggle'); return; }
  const act = e.target.closest('[data-action]');
  if (act && !act.disabled) { actions[act.dataset.action] && actions[act.dataset.action](); }
});
function fillOutputs() {
  for (const o of qsa('output[data-out]')) {
    const v = getVal(o.dataset.out);
    o.textContent = v == null ? '' : (FMT[o.dataset.fmt] || FMT.int)(v);
  }
}
function fillInspector() {
  const p = app.project;
  for (const inp of qsa('[data-bind]')) {
    const v = getVal(inp.dataset.bind);
    if (inp.tagName === 'DIV') {
      for (const b of inp.querySelectorAll('button')) b.classList.toggle('selected', v != null && String(b.dataset.value) === String(v));
      continue;
    }
    if (v === undefined || document.activeElement === inp && inp.type !== 'range') continue;
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if (inp.type === 'number') inp.value = Math.round(v * 100) / 100;
    else inp.value = v;
  }
  for (const t of qsa('[data-toggle]')) t.classList.toggle('on', !!getVal(t.dataset.toggle));
  fillOutputs();
  // clip panel
  const c = selected('clip');
  $('clipPanel').hidden = !c; $('clipEmptyHint').hidden = !!c;
  if (c) {
    const lay = layout(p), it = lay.items.find(i => i.clip.id === c.id);
    $('clipTitle').textContent = (c.kind === 'image' ? 'Image ' : 'Clip ') + (it.index + 1) + ' of ' + lay.items.length;
    $('clipLenLabel').textContent = fmt(it.len) + ' on timeline';
    const isImg = c.kind === 'image';
    $('trimBlock').hidden = isImg; $('imageDurBlock').hidden = !isImg; $('speedSection').hidden = isImg;
    if (isImg) { $('imageDur').value = c.out - c.in; $('imageDurOut').textContent = (c.out - c.in).toFixed(1) + 's'; }
    else {
      const d = c.srcDuration;
      for (const r of [$('startRange'), $('endRange')]) { r.max = d; r.step = Math.max(0.01, d / 1000); }
      $('startRange').value = c.in; $('endRange').value = c.out;
      if (document.activeElement !== $('clipIn')) $('clipIn').value = c.in.toFixed(2);
      if (document.activeElement !== $('clipOut')) $('clipOut').value = c.out.toFixed(2);
      $('rangeFill').style.marginLeft = (c.in / d * 100) + '%'; $('rangeFill').style.width = ((c.out - c.in) / d * 100) + '%';
    }
    $('offlineBanner').hidden = media.has(c.mediaId);
    const idx = it.index;
    qsa('[data-action=moveLeft]').forEach(b => b.disabled = idx === 0);
    qsa('[data-action=moveRight]').forEach(b => b.disabled = idx === lay.items.length - 1);
  }
  const t = selected('text');
  stage.classList.toggle('text-edit', !!t);
  $('textPanel').hidden = !t; $('textEmptyHint').hidden = p.texts.length > 0;
  const a = selected('audio');
  $('audioPanel').hidden = !a; $('audioEmptyHint').hidden = p.audio.length > 0;
  if (a && document.activeElement !== $('audioLenInput')) $('audioLenInput').value = audioLen(a).toFixed(2);
  $('logoPanel').hidden = !p.logo; $('logoHint').hidden = !!p.logo;
  const sel = !!app.selection;
  qsa('.tl-toolbar [data-action=duplicate], .tl-toolbar [data-action=delete]').forEach(b => b.disabled = !sel);
  updateCounts();
  renderChapters();
}
function updateCounts() {
  $('titleCount').textContent = (app.project.youtube.title || '').length + '/100';
  $('tagCount').textContent = (app.project.youtube.tags || '').length + '/500';
}
function renderChapters() {
  const ch = chapters(app.project);
  $('chaptersOut').textContent = ch.text || '—';
  $('chapterWarn').textContent = ch.warnings.join(' ');
}
function renderLists(light) {
  const p = app.project, sel = app.selection || {};
  // text list
  const tl = $('textList'); tl.replaceChildren();
  [...p.texts].sort((a, b) => a.start - b.start).forEach(t => {
    tl.append(el('div', { class: 'item' + (sel.type === 'text' && sel.id === t.id ? ' selected' : ''), onclick: () => app.select({ type: 'text', id: t.id }, { seekInto: true }) },
      el('span', { class: 't', text: fmt(t.start) }), el('span', { class: 'grow', text: (t.text || '(empty)').replace(/\n/g, ' ') })));
  });
  const al = $('audioList'); al.replaceChildren();
  p.audio.forEach(a => {
    al.append(el('div', { class: 'item' + (sel.type === 'audio' && sel.id === a.id ? ' selected' : ''), onclick: () => app.select({ type: 'audio', id: a.id }) },
      el('span', { text: '♪' }), el('span', { class: 'grow', text: a.name }), el('span', { class: 't', text: fmt(a.start) + ' · ' + fmt(audioLen(a)) })));
  });
  if (light) return;
  const ml = $('markerList'); ml.replaceChildren();
  [...p.markers].sort((a, b) => a.time - b.time).forEach(m => {
    const name = el('input', { value: m.name || '', 'aria-label': 'Marker name', placeholder: 'Chapter name' });
    name.addEventListener('change', () => { m.name = name.value; app.commit('Rename marker'); });
    ml.append(el('div', { class: 'item' + (sel.type === 'marker' && sel.id === m.id ? ' selected' : '') },
      el('button', { type: 'button', class: 't', text: fmt(m.time), title: 'Jump', onclick: () => { app.select({ type: 'marker', id: m.id }); player.setTime(m.time); } }),
      name,
      el('button', { type: 'button', text: '✕', 'aria-label': 'Delete marker', onclick: () => { p.markers = p.markers.filter(x => x !== m); app.commit('Delete marker'); } })));
  });
}

// trim controls
function trimFrom(source) {
  const c = selected('clip'); if (!c) return;
  let s, e;
  if (source === 'inputs') { s = parseFloat($('clipIn').value); e = parseFloat($('clipOut').value); }
  else { s = parseFloat($('startRange').value); e = parseFloat($('endRange').value); }
  const min = MIN_CLIP * c.speed;
  s = clamp(Number.isFinite(s) ? s : 0, 0, c.srcDuration - min);
  e = clamp(Number.isFinite(e) ? e : c.srcDuration, min, c.srcDuration);
  if (e - s < min) { if (source === 'end') s = Math.max(0, e - min); else e = Math.min(c.srcDuration, s + min); }
  const before = layout(app.project), it0 = before.items.find(i => i.clip.id === c.id);
  c.in = s; c.out = e;
  app._pendingTrimRipple = app._pendingTrimRipple || { end: it0.end, total: before.total };
  const it = layout(app.project).items.find(i => i.clip.id === c.id);
  return { it, source };
}
function trimCommit() {
  const r = app._pendingTrimRipple; app._pendingTrimRipple = null;
  if (r && app.rippleEnabled) rippleShift(app.project, r.end - 1e-3, layout(app.project).total - r.total);
  app.commit('Trim');
}
$('startRange').addEventListener('input', () => { const r = trimFrom('start'); if (r) app.liveUpdate({ previewAt: r.it.start }); });
$('endRange').addEventListener('input', () => { const r = trimFrom('end'); if (r) app.liveUpdate({ previewAt: Math.max(r.it.start, r.it.end - 0.04) }); });
$('startRange').addEventListener('change', trimCommit); $('endRange').addEventListener('change', trimCommit);
$('clipIn').addEventListener('change', () => { if (trimFrom('inputs')) trimCommit(); });
$('clipOut').addEventListener('change', () => { if (trimFrom('inputs')) trimCommit(); });
$('imageDur').addEventListener('input', () => { const c = selected('clip'); if (!c) return; const b = layout(app.project); app._pendingTrimRipple = app._pendingTrimRipple || { end: b.items.find(i => i.clip.id === c.id).end, total: b.total }; c.out = c.in + parseFloat($('imageDur').value); app.liveUpdate(); });
$('imageDur').addEventListener('change', trimCommit);
$('audioLenInput').addEventListener('change', () => { const a = selected('audio'); if (!a) return; const l = parseFloat($('audioLenInput').value); if (l > 0) { a.out = clamp(a.in + l, a.in + 0.2, a.srcDuration || 1e9); app.commit('Audio length'); } });
$('textPosPresets').addEventListener('click', (e) => { const b = e.target.closest('button'); const t = selected('text'); if (!b || !t) return; t.y = parseFloat(b.dataset.y); t.x = 0.5; app.commit('Text position'); });

// ---------------------------------------------------------------- actions
const actions = {
  split() {
    const nb = splitAt(app.project, player.t);
    if (!nb) return toast('Move the playhead inside a clip (not at its edge) to split.');
    app.selection = { type: 'clip', id: nb.id };
    app.commit('Split'); toast('Split at ' + fmtPrecise(player.t, app.project.settings.fps));
  },
  duplicate() {
    const s = app.selection; if (!s) return toast('Select something to duplicate.');
    if (s.type === 'clip') { const b = duplicateClip(app.project, s.id, app.rippleEnabled); if (b) app.selection = { type: 'clip', id: b.id }; }
    else if (s.type === 'text') return actions.duplicateText();
    else if (s.type === 'audio') { const a = selected('audio'); const b = deepClone(a); b.id = uid('aud'); b.start = a.start + audioLen(a); app.project.audio.push(b); app.selection = { type: 'audio', id: b.id }; }
    else return;
    app.commit('Duplicate');
  },
  delete() {
    const s = app.selection; if (!s) return;
    const p = app.project;
    if (s.type === 'clip') removeClip(p, s.id, app.rippleEnabled);
    if (s.type === 'text') p.texts = p.texts.filter(t => t.id !== s.id);
    if (s.type === 'audio') p.audio = p.audio.filter(t => t.id !== s.id);
    if (s.type === 'marker') p.markers = p.markers.filter(t => t.id !== s.id);
    app.selection = null; app.commit('Delete');
  },
  moveLeft() { const c = selected('clip'); if (!c) return; const i = app.project.clips.indexOf(c); if (i > 0) { moveClip(app.project, i, i - 1); app.commit('Move clip'); } },
  moveRight() { const c = selected('clip'); if (!c) return; const i = app.project.clips.indexOf(c); if (i < app.project.clips.length - 1) { moveClip(app.project, i, i + 1); app.commit('Move clip'); } },
  resetTransform() { const c = selected('clip'); if (!c) return; c.transform = defaultTransform(); c.fit = 'inherit'; app.commit('Reset frame'); },
  rotL() { const c = selected('clip'); if (!c) return; c.transform.rotate = ((c.transform.rotate || 0) + 270) % 360; app.commit('Rotate'); },
  rotR() { const c = selected('clip'); if (!c) return; c.transform.rotate = ((c.transform.rotate || 0) + 90) % 360; app.commit('Rotate'); },
  resetClipColor() { const c = selected('clip'); if (!c) return; c.color = defaultColor(); app.commit('Reset color'); },
  resetGlobalColor() { app.project.color = defaultColor(); app.commit('Reset color'); },
  addText() {
    const p = app.project, total = layout(p).total;
    const start = clamp(player.t, 0, Math.max(0, total - 0.5));
    const t = newText(start, Math.min(4, Math.max(1, (total || 4) - start)), p.texts.length ? 'New text' : 'Your title here');
    p.texts.push(t); app.selection = { type: 'text', id: t.id };
    app.commit('Add text'); showTab('text');
    setTimeout(() => { const ta = qs('#textPanel textarea'); ta && ta.focus(); ta && ta.select(); }, 50);
  },
  duplicateText() { const t = selected('text'); if (!t) return; const b = deepClone(t); b.id = uid('txt'); b.start = t.end; b.end = t.end + (t.end - t.start); app.project.texts.push(b); app.selection = { type: 'text', id: b.id }; app.commit('Duplicate text'); },
  deleteText() { const t = selected('text'); if (!t) return; app.project.texts = app.project.texts.filter(x => x !== t); app.selection = null; app.commit('Delete text'); },
  textStartHere() { const t = selected('text'); if (!t) return; const len = t.end - t.start; t.start = player.t; if (t.end <= t.start + 0.1) t.end = t.start + len; app.commit('Text start'); },
  textEndHere() { const t = selected('text'); if (!t) return; if (player.t > t.start + 0.1) { t.end = player.t; app.commit('Text end'); } else toast('Playhead must be after the text start.'); },
  audioStartHere() { const a = selected('audio'); if (!a) return; a.start = player.t; app.commit('Move music'); },
  deleteAudio() { const a = selected('audio'); if (!a) return; app.project.audio = app.project.audio.filter(x => x !== a); app.selection = null; app.commit('Remove music'); },
  addMarker() {
    const t = player.t;
    const n = app.project.markers.length + 1;
    const it = clipAt(layout(app.project), t);
    const m = { id: uid('mk'), time: t, name: it && app.project.markers.length ? 'Chapter ' + (n) : (t < 0.5 ? 'Intro' : 'Chapter ' + n) };
    app.project.markers.push(m); app.selection = { type: 'marker', id: m.id };
    app.commit('Add marker'); toast('Marker added at ' + fmt(t) + ' — rename it in the YouTube tab.');
  },
  removeLogo() { app.project.logo = null; app.commit('Remove logo'); },
};
app.actions = actions;

// ---------------------------------------------------------------- import
async function importFiles(files, where = 'auto') {
  files = [...files];
  if (!files.length) return;
  const vis = files.filter(f => ['video', 'image'].includes(kindOf(f)));
  const aud = files.filter(f => kindOf(f) === 'audio');
  const bad = files.length - vis.length - aud.length;
  if (bad) toast(bad + ' file(s) skipped — use video, image or audio files.');
  navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => { });
  let added = 0;
  const p = app.project;
  const lay0 = layout(p);
  const sel = selected('clip');
  let insertAt = sel ? p.clips.indexOf(sel) + 1 : p.clips.length;
  for (const f of vis) {
    setSaveState('Importing ' + f.name + '…');
    try {
      const m = await media.importFile(f);
      const c = newClipFromMedia(m, p.settings);
      p.clips.splice(insertAt++, 0, c); added++;
      app.selection = { type: 'clip', id: c.id };
      if (added === 1 && !lay0.items.length) { renderAll(); }
    } catch (e) { console.warn(e); toast('Could not read ' + f.name + ': ' + (e.message || e)); }
  }
  if (added && sel && app.rippleEnabled) rippleShift(p, layout({ ...p, clips: p.clips.slice(0, p.clips.indexOf(sel) + 1) }).total - 1e-3, layout(p).total - lay0.total);
  for (const f of aud) {
    try {
      const m = await media.importFile(f, 'audio');
      const a = newAudio(m, where === 'start' ? 0 : (player.t < layout(p).total - 0.5 ? player.t : 0));
      p.audio.push(a); app.selection = { type: 'audio', id: a.id }; added++;
    } catch (e) { toast('Could not read ' + f.name); }
  }
  if (added) {
    app.commit('Import');
    if (timeline.autoFit) timeline.fit();
    toast(added + ' item' + (added > 1 ? 's' : '') + ' added');
  } else setSaveState('Saved');
}
$('videoInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
$('addInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
$('musicInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
$('logoInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const m = await media.importFile(f, 'image'); app.project.logo = Object.assign({ position: 'tr', size: 0.14, opacity: 0.85, margin: 0.035 }, app.project.logo || {}, { mediaId: m.id }); app.commit('Logo'); showTab('look'); }
  catch (err) { toast('Could not read that image.'); }
};
$('relinkInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  const c = selected('clip'); if (!f || !c) return;
  await media.replaceMedia(c.mediaId, f);
  renderAll(); toast('Media relinked.');
};
const dropT = document.body;
['dragenter', 'dragover'].forEach(t => dropT.addEventListener(t, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('dropzone').classList.add('drag'); $('dropTarget').classList.add('drag'); } }));
['dragleave', 'drop'].forEach(t => dropT.addEventListener(t, e => { if (t === 'dragleave' && e.relatedTarget) return; $('dropzone').classList.remove('drag'); $('dropTarget').classList.remove('drag'); }));
dropT.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); } });
media.onChange(() => { timeline.render(); player.invalidate(); fillInspector(); });

// ---------------------------------------------------------------- transport & keyboard
const frame = () => 1 / (app.project.settings.fps || 30);
$('playBtn').onclick = () => player.toggle();
$('toStartBtn').onclick = () => { player.pause(); player.setTime(0); };
$('toEndBtn').onclick = () => { player.pause(); player.setTime(player.total); };
$('frameBackBtn').onclick = () => { player.pause(); player.setTime(player.t - frame()); };
$('frameFwdBtn').onclick = () => { player.pause(); player.setTime(player.t + frame()); };
function editPoints() {
  const p = app.project, lay = layout(p), s = new Set([0, lay.total]);
  lay.items.forEach(i => { s.add(i.start); s.add(i.end); });
  p.texts.forEach(t => { s.add(t.start); s.add(t.end); }); p.markers.forEach(m => s.add(m.time));
  return [...s].sort((a, b) => a - b);
}
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = ['input', 'textarea', 'select'].includes(tag) && !(e.target.type === 'range' || e.target.type === 'checkbox') || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (qs('dialog[open]')) return;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); actions.duplicate(); return; }
  if (mod || e.altKey) return;
  const k = e.key;
  const handled = () => e.preventDefault();
  switch (k) {
    case ' ': handled(); player.toggle(); break;
    case 'k': case 'K': player.pause(); break;
    case 'l': case 'L': { const r = player.playing && player.rate > 0 ? Math.min(4, player.rate * 2) : 1; player.pause(); player.play(r); break; }
    case 'j': case 'J': { const r = player.playing && player.rate < 0 ? Math.max(-4, player.rate * 2) : -1; player.pause(); player.play(r); break; }
    case 'ArrowLeft': handled(); player.pause(); player.setTime(player.t - (e.shiftKey ? 1 : frame())); break;
    case 'ArrowRight': handled(); player.pause(); player.setTime(player.t + (e.shiftKey ? 1 : frame())); break;
    case 'ArrowUp': { handled(); const pts = editPoints().filter(x => x < player.t - 1e-3); player.pause(); player.setTime(pts.length ? pts[pts.length - 1] : 0); break; }
    case 'ArrowDown': { handled(); const pts = editPoints().filter(x => x > player.t + 1e-3); player.pause(); player.setTime(pts.length ? pts[0] : player.total); break; }
    case 'Home': handled(); player.setTime(0); break;
    case 'End': handled(); player.setTime(player.total); break;
    case 's': case 'S': actions.split(); break;
    case 'Delete': case 'Backspace': handled(); actions.delete(); break;
    case 't': case 'T': actions.addText(); break;
    case 'm': case 'M': actions.addMarker(); break;
    case '+': case '=': timeline.zoomBy(1.4); break;
    case '-': case '_': timeline.zoomBy(1 / 1.4); break;
    case '0': timeline.autoFit = true; timeline.fit(); app.onZoom(timeline.pps); break;
    case '?': openDialog('helpDialog'); break;
    case 'Escape': app.select(null); break;
  }
});
function undo() { const s = app.history.undo(); if (!s) return; app.project = migrate(s); renderAll(); scheduleSave(); toast('Undo'); }
function redo() { const s = app.history.redo(); if (!s) return; app.project = migrate(s); renderAll(); scheduleSave(); toast('Redo'); }
app.undo = undo; app.redo = redo;
$('undoBtn').onclick = undo; $('redoBtn').onclick = redo;

// timeline toolbar
const ppsToRange = (pps) => Math.round(Math.log(pps / 2) / Math.log(300) * 100);
const rangeToPps = (v) => 2 * Math.pow(300, v / 100);
$('zoomRange').addEventListener('input', () => timeline.setZoom(rangeToPps(+$('zoomRange').value)));
$('zoomIn').onclick = () => timeline.zoomBy(1.4);
$('zoomOut').onclick = () => timeline.zoomBy(1 / 1.4);
$('zoomFit').onclick = () => { timeline.autoFit = true; timeline.fit(); app.onZoom(timeline.pps); };
$('rippleBtn').onclick = () => { app.rippleEnabled = !app.rippleEnabled; $('rippleBtn').setAttribute('aria-pressed', app.rippleEnabled); db.kvSet('ripple', app.rippleEnabled); toast('Ripple ' + (app.rippleEnabled ? 'on' : 'off')); };
$('snapBtn').onclick = () => { app.snapEnabled = !app.snapEnabled; $('snapBtn').setAttribute('aria-pressed', app.snapEnabled); db.kvSet('snap', app.snapEnabled); toast('Snapping ' + (app.snapEnabled ? 'on' : 'off')); };

// tabs
function showTab(name) {
  qsa('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  qsa('.tab-panel').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
}
qsa('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// preset chips + fonts
for (const box of qsa('[data-presets]')) for (const [k, v] of Object.entries(PRESETS)) box.append(el('button', { type: 'button', 'data-value': k, text: v.label }));
for (const [k, v] of Object.entries(FONTS)) { $('fontSelect').append(el('option', { value: k, text: v.label })); $('thumbFont').append(el('option', { value: k, text: v.label })); }

// ---------------------------------------------------------------- preview interactions (drag text on canvas, tap to play)
(() => {
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const r = stage.getBoundingClientRect();
    const sx = stage.width / r.width, sy = stage.height / r.height;
    const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy;
    const hit = [...player.lastBoxes].reverse().find(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    if (hit) {
      e.preventDefault();
      const t = app.project.texts.find(q => q.id === hit.id); if (!t) return;
      if (player.playing) player.pause();
      app.select({ type: 'text', id: t.id });
      drag = { id: t.id, x0: e.clientX, y0: e.clientY, tx: t.x, ty: t.y, moved: false, w: r.width, h: r.height };
      stage.setPointerCapture(e.pointerId); stage.classList.add('grab');
    } else drag = { tap: true, x0: e.clientX, y0: e.clientY };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.tap) return;
    const t = app.project.texts.find(q => q.id === drag.id); if (!t) return;
    const dx = (e.clientX - drag.x0) / drag.w, dy = (e.clientY - drag.y0) / drag.h;
    if (Math.abs(dx) + Math.abs(dy) > 0.004) drag.moved = true;
    t.x = clamp(drag.tx + dx, 0, 1); t.y = clamp(drag.ty + dy, 0, 1);
    // snap to center lines
    if (Math.abs(t.x - 0.5) < 0.015) t.x = 0.5;
    if (Math.abs(t.y - 0.5) < 0.015) t.y = 0.5;
    player.requestRender(); fillOutputs();
  });
  const end = (e) => {
    if (!drag) return;
    if (drag.tap) { if (Math.abs(e.clientX - drag.x0) < 6 && Math.abs(e.clientY - drag.y0) < 6 && e.type === 'pointerup') player.toggle(); }
    else if (drag.moved) app.commit('Move text on canvas');
    drag = null; stage.classList.remove('grab');
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- projects
async function openProject(id) {
  const p = await db.getProject(id);
  if (!p) return false;
  player.pause();
  app.project = migrate(p);
  await media.preload(mediaIdsOf(app.project));
  app.selection = null;
  app.history.reset(app.project);
  player.t = 0;
  timeline.autoFit = true;
  await db.kvSet('lastProject', id);
  renderAll(); timeline.fit(); player.setTime(0);
  setSaveState('Saved');
  refreshCaps();
  return true;
}
async function createProject(name) {
  player.pause();
  app.project = newProject(name || 'Untitled project');
  app.selection = null; app.history.reset(app.project);
  await saveNow();
  renderAll(); player.setTime(0);
}
app.openProject = openProject;
async function renderProjectList() {
  const list = $('projectList'); list.replaceChildren();
  const projects = await db.listProjects();
  for (const p of projects) {
    const first = p.clips && p.clips[0];
    let thumb = '';
    if (first) { const m = await media.get(first.mediaId); thumb = m && m.strip ? m.strip[0] : ''; }
    const dur = layout(migrate(p)).total;
    const card = el('div', { class: 'project-card' + (p.id === app.project.id ? ' current' : '') },
      el('div', { class: 'pthumb', style: thumb ? { backgroundImage: `url(${thumb})` } : {} }),
      el('div', {},
        el('h3', { text: p.name }),
        el('div', { class: 'pmeta', text: `${(p.clips || []).length} clips · ${fmt(dur)} · edited ${new Date(p.updated).toLocaleString()}` }),
        el('div', { class: 'button-row' },
          el('button', { class: 'btn primary small', type: 'button', text: p.id === app.project.id ? 'Open (current)' : 'Open', onclick: async () => { await openProject(p.id); closeDialog('projectsDialog'); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Rename', onclick: async () => { const n = prompt('Project name', p.name); if (!n) return; if (p.id === app.project.id) { app.project.name = n; app.commit('Rename'); await saveNow(); } else { p.name = n; p.updated = Date.now(); await db.saveProject(p); } renderProjectList(); renderAll(); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Duplicate', onclick: async () => { if (p.id === app.project.id) await saveNow(); const src = p.id === app.project.id ? JSON.parse(JSON.stringify(app.project)) : p; const c = { ...deepClone(src), id: uid('prj'), name: src.name + ' copy', created: Date.now(), updated: Date.now() }; await db.saveProject(c); renderProjectList(); toast('Project duplicated'); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Export', onclick: () => exportProjectFile(p.id) }),
          el('button', { class: 'btn ghost danger small', type: 'button', text: 'Delete', onclick: async () => {
            if (!confirm(`Delete “${p.name}”? Its media is removed from this device unless another project uses it.`)) return;
            await db.deleteProject(p.id);
            if (p.id === app.project.id) { const rest = await db.listProjects(); if (rest.length) await openProject(rest[0].id); else await createProject(); }
            await db.gc(app.history.mediaIds());
            renderProjectList(); toast('Project deleted');
          } }))));
    list.append(card);
  }
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('storageNote').textContent = `Storage used on this device: ${fmtBytes(est.usage)} of ~${fmtBytes(est.quota)}${persisted ? ' · protected from automatic cleanup' : ''}.`;
  }
}
$('projectBtn').onclick = () => { renderProjectList(); openDialog('projectsDialog'); };
$('newProject').onclick = async () => { const n = prompt('Name your new project', 'Untitled project'); if (n === null) return; await saveNow(); await createProject(n || 'Untitled project'); closeDialog('projectsDialog'); toast('New project created'); };
async function exportProjectFile(id) {
  const p = id === app.project.id ? JSON.parse(JSON.stringify(app.project)) : await db.getProject(id);
  const embed = $('embedMedia').checked;
  const mediaOut = [];
  for (const mid of mediaIdsOf(p)) {
    const m = await media.get(mid); if (!m) continue;
    const { blob, peaks, ...meta } = m;
    if (embed) meta.data = await blobToDataURL(blob);
    mediaOut.push(meta);
  }
  const data = { app: 'video-editor-pro', format: 1, exported: new Date().toISOString(), project: p, media: mediaOut };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(p.name) + (embed ? '-with-media' : '') + '.vedit.json');
  toast(embed ? 'Project exported with media' : 'Project exported (media stays on this device)');
}
app.exportProjectFile = exportProjectFile;
async function importProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const src = data.project || data;
    if (!src || !Array.isArray(src.clips)) throw new Error('Not a project file');
    let missing = 0;
    for (const m of data.media || []) {
      if (m.data) { if (!(await media.get(m.id))) await media.importEmbedded(m, await dataURLToBlob(m.data)); }
      else if (!(await media.get(m.id))) missing++;
    }
    const p = migrate(src);
    p.id = uid('prj'); p.name = (src.name || 'Imported') + (data.project ? '' : ''); p.updated = Date.now();
    await db.saveProject(p);
    await openProject(p.id);
    closeDialog('projectsDialog');
    toast(missing ? `Imported. ${missing} media file(s) need relinking (select the red clips).` : 'Project imported');
  } catch (e) { console.warn(e); toast('Import failed: ' + e.message); }
}
app.importProjectFile = importProjectFile;
$('importProject').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importProjectFile(f); };

// dialogs
function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
qsa('dialog').forEach(d => { d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); }); });
$('helpBtn').onclick = () => openDialog('helpDialog');

// theme
async function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
$('themeBtn').onclick = async () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next); db.kvSet('theme', next);
};

// ---------------------------------------------------------------- YouTube details
function detailsText() {
  const y = app.project.youtube, ch = chapters(app.project);
  let s = '';
  if (y.title.trim()) s += y.title.trim() + '\n\n';
  if (y.description.trim()) s += y.description.trim() + '\n\n';
  if (ch.list.length >= 3) s += 'Chapters\n' + ch.text + '\n';
  return s.trim();
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast(msg);
}
$('copyDetails').onclick = () => { const t = detailsText(); if (!t) return toast('Add a title or description first.'); copy(t, 'Title, description and chapters copied.'); };
$('copyTags').onclick = () => { const t = app.project.youtube.tags.split(',').map(s => s.trim()).filter(Boolean).join(', '); if (!t) return toast('Add some tags first.'); copy(t, 'Tags copied.'); };

// ---------------------------------------------------------------- thumbnail maker
const thumb = { canvas: $('thumbCanvas'), comp: new Compositor(), v: null };
async function thumbFrame(t) {
  // Render the sequence frame at time t at 1280x720 (fill), independent of the project aspect ratio.
  const p = deepClone(app.project);
  p.settings.ratio = '16:9'; p.texts = []; p.settings.fit = 'cover';
  const lay = layout(p);
  const it = clipAt(lay, t);
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  if (!it) return c;
  let src = null;
  if (it.clip.kind === 'image') { const im = await media.image(it.clip.mediaId); src = { img: im.img, w: im.w, h: im.h }; }
  else {
    if (!thumb.v) { thumb.v = document.createElement('video'); thumb.v.muted = true; thumb.v.playsInline = true; thumb.v.preload = 'auto'; }
    const v = thumb.v, url = media.url(it.clip.mediaId);
    if (v.dataset.url !== url) { v.src = url; v.dataset.url = url; await new Promise(r => { v.onloadeddata = r; v.onerror = r; }); }
    await new Promise(r => { const d = () => { v.removeEventListener('seeked', d); r(); }; v.addEventListener('seeked', d); v.currentTime = Math.max(0.01, it.clip.in + (t - it.start) * it.clip.speed); });
    src = { img: v, w: v.videoWidth, h: v.videoHeight };
  }
  const single = { ...lay, items: [{ ...it, xIn: 0, fadeInBlack: 0, fadeOutBlack: 0 }] };
  thumb.comp.render(c.getContext('2d'), 1280, 720, p, single, it.start + 0.0001 + Math.max(0, t - it.start), () => src, {});
  return c;
}
let thumbBg = null;
async function thumbRefresh(refetch) {
  const P = app.project.thumb;
  if (refetch || !thumbBg) thumbBg = await thumbFrame(P.time);
  const x = thumb.canvas.getContext('2d');
  x.drawImage(thumbBg, 0, 0);
  const dark = parseFloat($('thumbDarken').value);
  if (dark > 0) {
    const g = x.createLinearGradient(P.position === 'right' ? 1280 : 0, 0, P.position === 'right' ? 0 : 1280, 0);
    if (P.position === 'center' || P.position === 'bottom') { x.fillStyle = `rgba(0,0,0,${dark})`; x.fillRect(0, 0, 1280, 720); }
    else { g.addColorStop(0, `rgba(0,0,0,${Math.min(1, dark * 2.2)})`); g.addColorStop(0.65, `rgba(0,0,0,${dark * 0.4})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 1280, 720); }
  }
  const size = parseFloat($('thumbSize').value);
  const text = $('thumbText').value.trim(), sub = $('thumbSub').value.trim();
  x.save();
  x.font = fontCss(P.font, size);
  const maxW = P.position === 'center' || P.position === 'bottom' ? 1140 : 720;
  const lines = text ? wrapLines(x, text, maxW).slice(0, 4) : [];
  const lh = size * 1.02;
  const subSize = Math.round(size * 0.34);
  const blockH = lines.length * lh + (sub ? subSize * 1.8 : 0);
  let ax, align;
  if (P.position === 'left') { ax = 70; align = 'left'; } else if (P.position === 'right') { ax = 1210; align = 'right'; } else { ax = 640; align = 'center'; }
  let y = P.position === 'bottom' ? 720 - 60 - blockH : (720 - blockH) / 2;
  if (P.position === 'bottom' && (lines.length || sub)) { x.fillStyle = 'rgba(0,0,0,.62)'; x.fillRect(0, y - 30, 1280, blockH + 60); }
  x.textAlign = align; x.textBaseline = 'top';
  if (sub) {
    x.font = `700 ${subSize}px "IBM Plex Sans", sans-serif`;
    const w = x.measureText(sub.toUpperCase()).width;
    const bx = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
    x.fillStyle = P.accent; x.fillRect(bx - 12, y - 6, w + 24, subSize + 14);
    x.fillStyle = '#fff'; x.fillText(sub.toUpperCase(), ax, y + 1);
    y += subSize * 1.8;
  }
  x.font = fontCss(P.font, size);
  x.lineJoin = 'round';
  for (const l of lines) {
    x.shadowColor = 'rgba(0,0,0,.7)'; x.shadowBlur = size * 0.25; x.shadowOffsetY = size * 0.05;
    x.strokeStyle = 'rgba(0,0,0,.85)'; x.lineWidth = size * 0.14; x.strokeText(l, ax, y);
    x.shadowColor = 'transparent';
    x.fillStyle = P.color; x.fillText(l, ax, y);
    y += lh;
  }
  x.restore();
}
function thumbSyncInputs() {
  const P = app.project.thumb;
  $('thumbText').value = P.text || app.project.youtube.title || ''; $('thumbSub').value = P.sub || '';
  $('thumbFont').value = P.font; $('thumbPos').value = P.position; $('thumbColor').value = P.color; $('thumbAccent').value = P.accent;
  $('thumbTime').max = Math.max(0.01, layout(app.project).total - 0.01); $('thumbTime').value = P.time; $('thumbTimeOut').textContent = fmt(P.time);
}
async function openThumb() {
  if (!app.project.clips.length) return toast('Add a clip first.');
  player.pause();
  await ensureFonts();
  if (!app.project.thumb.time) app.project.thumb.time = player.t;
  thumbSyncInputs(); openDialog('thumbDialog'); await thumbRefresh(true);
}
$('thumbBtn').onclick = openThumb; $('thumbBtn2').onclick = openThumb;
const thumbInput = debounce(() => thumbRefresh(false), 30);
for (const id of ['thumbText', 'thumbSub', 'thumbFont', 'thumbPos', 'thumbColor', 'thumbAccent', 'thumbDarken', 'thumbSize']) {
  $(id).addEventListener('input', () => {
    const P = app.project.thumb;
    P.text = $('thumbText').value; P.sub = $('thumbSub').value; P.font = $('thumbFont').value; P.position = $('thumbPos').value; P.color = $('thumbColor').value; P.accent = $('thumbAccent').value;
    $('thumbDarkenOut').textContent = Math.round($('thumbDarken').value * 100) + '%'; $('thumbSizeOut').textContent = $('thumbSize').value;
    thumbInput(); scheduleSave();
  });
}
$('thumbTime').addEventListener('input', debounce(() => { app.project.thumb.time = parseFloat($('thumbTime').value); $('thumbTimeOut').textContent = fmt(app.project.thumb.time); thumbRefresh(true); scheduleSave(); }, 60));
$('thumbUsePlayhead').onclick = () => { app.project.thumb.time = player.t; thumbSyncInputs(); thumbRefresh(true); };
$('thumbSave').onclick = async () => {
  await thumbRefresh(false);
  let q = 0.92, blob;
  do { blob = await new Promise(r => thumb.canvas.toBlob(r, 'image/jpeg', q)); q -= 0.08; } while (blob && blob.size > 2 * 1024 * 1024 && q > 0.4);
  if (!blob) return toast('Could not create thumbnail.');
  download(blob, safeName(app.project.youtube.title || app.project.name) + '-thumbnail.jpg');
  toast('Thumbnail saved (' + fmtBytes(blob.size) + ', 1280×720).');
};
app.thumbRefresh = thumbRefresh;

// ---------------------------------------------------------------- export
let exporting = false, abort = null, lastExport = null;
async function refreshCaps() {
  const c = await capabilities(app.project);
  app.caps = c;
  const fmtPref = app.project.settings.format;
  let note;
  const mr = c.recorder.find(t => t.includes('mp4')) ? 'MP4' : c.recorder.length ? 'WebM' : null;
  if (c.fastMp4 && fmtPref !== 'webm') note = `Fast export: MP4 (H.264 + ${c.aac ? 'AAC' : 'Opus'} audio), faster than real time.`;
  else if (c.fastWebm) note = 'Fast export: WebM (VP9 + Opus), faster than real time.';
  else if (mr) note = `This browser records in real time: ${mr}. Keep this tab open during export.`;
  else note = 'This browser cannot export video. Use Chrome, Edge or Safari 17+.';
  $('capsNote').textContent = note;
}
$('exportBtn').onclick = async () => {
  if (exporting) return;
  const p = app.project;
  if (!p.clips.length) return;
  const missing = p.clips.filter(c => !media.has(c.mediaId));
  if (missing.length) return toast('Relink missing media before exporting (red clips).');
  player.pause();
  exporting = true; updateSummary();
  abort = new AbortController();
  $('progress').classList.add('show'); $('exportResult').hidden = true;
  $('progressBar').style.width = '0%'; $('progressPercent').textContent = '0%'; $('progressStatus').textContent = 'Preparing…'; $('progressEta').textContent = 'ETA —';
  const t0 = performance.now();
  try { await navigator.wakeLock?.request('screen').then(l => (app._wake = l)); } catch { }
  try {
    const res = await runExport(JSON.parse(JSON.stringify(p)), media, {
      format: p.settings.format === 'auto' ? 'mp4' : p.settings.format,
      signal: abort.signal,
      onFallback: (why) => toast('Using real-time recording (' + why + ')', 4000),
      onProgress: ({ frac, stage, eta, speed }) => {
        $('progressBar').style.width = (frac * 100).toFixed(1) + '%';
        $('progressPercent').textContent = Math.floor(frac * 100) + '%';
        $('progressStatus').textContent = stage;
        $('progressEta').textContent = (eta != null ? 'ETA ' + fmtDuration(eta) : 'ETA —') + (speed ? ` · ${speed.toFixed(1)}× real time` : '');
      },
    });
    const name = safeName(p.youtube.title || p.name) + '.' + res.ext;
    download(res.blob, name);
    if (lastExport) URL.revokeObjectURL(lastExport.url);
    lastExport = { ...res, name, url: URL.createObjectURL(res.blob) };
    app.lastExport = lastExport;
    const took = (performance.now() - t0) / 1000;
    $('progressBar').style.width = '100%'; $('progressPercent').textContent = '100%';
    $('progressStatus').textContent = 'Done'; $('progressEta').textContent = 'Took ' + fmtDuration(took);
    $('exportResultText').innerHTML = `<b>${name}</b> · ${res.width}×${res.height} · ${res.fps} fps · ${fmt(res.duration)} · ${fmtBytes(res.blob.size)}<br><span class="hint">${res.method} · rendered in ${fmtDuration(took)}. Upload it in YouTube Studio.</span>`;
    $('downloadAgain').href = lastExport.url; $('downloadAgain').download = name;
    const file = new File([res.blob], name, { type: res.mime });
    $('shareExport').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('shareExport').onclick = () => navigator.share({ files: [file], title: p.youtube.title || p.name }).catch(() => { });
    $('exportResult').hidden = false;
    $('outputNote').textContent = 'Export complete.'; $('outputNote').classList.add('status-good');
    toast('Video exported: ' + name);
  } catch (e) {
    if (e instanceof ExportCancelled || e.name === 'ExportCancelled') { $('progressStatus').textContent = 'Export cancelled.'; toast('Export cancelled'); }
    else { console.error(e); $('progressStatus').textContent = 'Export failed: ' + (e.message || e); toast('The export could not finish: ' + (e.message || e), 5000); }
  } finally {
    exporting = false; abort = null; updateSummary();
    try { app._wake && app._wake.release(); } catch { }
  }
};
$('cancelExport').onclick = () => { if (abort) abort.abort(); };

// ---------------------------------------------------------------- install (PWA)
let deferredPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function updateInstallBtn() {
  const b = $('installBtn');
  if (standalone()) { b.textContent = 'Installed ✓'; b.disabled = false; }
  else b.textContent = deferredPrompt ? 'Install app' : 'How to install';
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; updateInstallBtn(); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; updateInstallBtn(); $('installHelp').classList.remove('show'); toast('Installed! Open it from your home screen.'); });
$('installBtn').onclick = async () => {
  if (standalone()) return toast('Video Editor is installed and running as an app.');
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    deferredPrompt = null; updateInstallBtn();
    if (outcome === 'accepted') toast('Installing…');
    return;
  }
  let msg;
  if (isIOS()) msg = '<b>Install on iPhone / iPad:</b> open this page in <b>Safari</b>, tap the <b>Share</b> button (square with arrow), then choose <b>Add to Home Screen</b>. The editor then opens full-screen and works offline.';
  else if (/android/i.test(navigator.userAgent)) msg = '<b>Install on Android:</b> open the browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>. If you don’t see it, reload the page once.';
  else msg = '<b>Install on desktop:</b> in Chrome or Edge, click the install icon at the right of the address bar (or menu ⋮ → <b>Install Video Editor</b>). In Safari on Mac: File → <b>Add to Dock</b>.';
  $('installCopy').innerHTML = msg;
  $('installHelp').classList.toggle('show');
};
$('closeInstall').onclick = () => $('installHelp').classList.remove('show');

// service worker
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      app.swReg = reg;
      const showUpdate = (w) => { $('updateBar').hidden = false; $('reloadBtn').onclick = () => w.postMessage({ type: 'SKIP_WAITING' }); };
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading || !app._updateRequested) return; reloading = true; location.reload(); });
      $('reloadBtn').addEventListener('click', () => { app._updateRequested = true; saveNow(); });
    } catch (e) { console.warn('Service worker registration failed', e); }
  });
}

// ---------------------------------------------------------------- boot
window.addEventListener('resize', debounce(() => { sizeStage(); if (timeline.autoFit) timeline.fit(); }, 120));
window.addEventListener('pagehide', () => { scheduleSave.flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { player.pause(); scheduleSave.flush(); } });

async function boot() {
  const theme = await db.kvGet('theme').catch(() => null); if (theme) applyTheme(theme);
  const ripple = await db.kvGet('ripple').catch(() => null); if (ripple === false) { app.rippleEnabled = false; $('rippleBtn').setAttribute('aria-pressed', 'false'); }
  const snap = await db.kvGet('snap').catch(() => null); if (snap === false) { app.snapEnabled = false; $('snapBtn').setAttribute('aria-pressed', 'false'); }
  ensureFonts().then(() => player.requestRender());
  const last = await db.kvGet('lastProject').catch(() => null);
  let ok = last ? await openProject(last) : false;
  if (!ok) { const all = await db.listProjects(); if (all.length) ok = await openProject(all[0].id); }
  if (!ok) await createProject('My first video');
  updateInstallBtn();
  // files shared to the installed app (Android share sheet → share_target)
  if (new URLSearchParams(location.search).has('shared')) {
    const inbox = await db.inboxAll().catch(() => []);
    if (inbox.length) { await importFiles(inbox.map(x => new File([x.blob], x.name, { type: x.type }))); await db.inboxClear(); }
    history.replaceState(null, '', location.pathname);
  }
  db.gc(app.history.mediaIds()).catch(() => { });
  app.ready = true;
  document.documentElement.dataset.ready = '1';
}
boot().catch(e => { console.error(e); toast('Startup problem: ' + e.message); });
