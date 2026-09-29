// Video Editor Pro — main controller
import { initInstall } from './install.js';
import { BUILD } from './build.js';
import { $, qs, qsa, clamp, fmt, fmtPrecise, fmtDuration, fmtBytes, toast, download, debounce, el, icon, safeName, isIOS, deepClone, dataURLToBlob, uid, tarBlob, readTar, isTar } from './util.js';
import { db, mediaIdsOf, setKeepProvider } from './db.js';
import { media, kindOf, isHeic, isMediaDataURL, seekVideo } from './media.js';
import {
  newProject, migrate, layout, clipAt, clipLen, audioLen, newClipFromMedia, newText, newAudio, removeClip, duplicateClip,
  moveClip, rippleShift, History, PRESETS, FONTS, outputDims, defaultColor, defaultTransform, MIN_CLIP,
  newOverlay, overlayLen, animated, hasKeyframes, setKeyframe, kfTimes, removeKeyframesAt, setEaseAt, ANIM_PROPS, normalizeClip,
  splitItem, audioSpan, rebaseKeyframes, overlaysAt, overlaySourceTime, thumbFormat,
} from './model.js';
import { Compositor, drawLogo, ensureFonts, fontCss, wrapLines, TEXT_ANIMS_IN, TEXT_ANIMS_OUT } from './render.js';
import { TEMPLATES, paintBackground } from './templates.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { runExport, capabilities, planFormat, ExportCancelled, createSink, canStreamToOPFS, cleanupExports, bitrateFor } from './exporter.js';

// Page/script version check first, before anything else can fail on a mismatched page (see the service worker section).
// If an old copy of index.html (browser HTTP cache / old offline copy) is paired with these newer scripts, elements the scripts
// expect are missing and the app would die half-started ("not responding"). Reset the offline copy, refetch the page past the
// HTTP cache and reload once. Projects live in IndexedDB and are untouched.
async function healBuildMismatch() {
  const meta = document.querySelector('meta[name="ve-build"]');
  if (meta && meta.content === BUILD) return false; // (an old page without the tag next to new scripts counts as a mismatch too)
  let tried = false; try { tried = sessionStorage.getItem('ve.healed') === BUILD; sessionStorage.setItem('ve.healed', BUILD); } catch { /* storage blocked */ }
  if (tried) return false; // already tried once in this tab: run as well as we can rather than loop
  try {
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    await Promise.race([fetch(location.pathname, { cache: 'reload' }), new Promise(r => setTimeout(r, 6000))]); // refresh the HTTP-cached page
  } catch { /* best effort */ }
  location.reload();
  return true;
}
if (await healBuildMismatch()) await new Promise(() => { }); // the page is reloading: don't start this mismatched copy


const app = {
  project: newProject(),
  selection: null,
  snapEnabled: true,
  rippleEnabled: true,
  media,
  history: new History(),
};
// Debug/test handle: only on local development hosts or with ?debug in the URL (not exposed on the public site).
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || new URLSearchParams(location.search).has('debug')) window.__app = app;
let voice = { busy: false, state: 'idle', toggle() { }, keyR() { }, cancelCountdown() { }, tick() { } }; // replaced by the voiceover recorder below

// media this tab still needs, reported to other tabs before they garbage-collect stored media
setKeepProvider(() => [...mediaIdsOf(app.project), ...app.history.mediaIds(), ...media.recs.keys(), ...media.pending]);

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
// Autosave: revision-counted so the indicator only says "Saved" when the stored copy matches the editor.
app.rev = 0; app.savedRev = 0;
let saveInFlight = null, saveQueued = false, saveFailures = 0, retryTimer = null;
const saveNow = async () => {
  if (saveInFlight) { saveQueued = true; return saveInFlight; }
  clearTimeout(retryTimer);
  const rev = app.rev;
  setSaveState('saving');
  saveInFlight = (async () => {
    try {
      app.project.updated = Date.now();
      await db.saveProject(JSON.parse(JSON.stringify(app.project)));
      await db.kvSet('lastProject', app.project.id);
      if (saveFailures) toast('Saved again ✓');
      saveFailures = 0; app.savedRev = Math.max(app.savedRev, rev);
      setSaveState(app.rev === app.savedRev ? 'saved' : 'dirty');
    } catch (e) {
      console.warn('Save failed', e); saveFailures++;
      setSaveState('failed');
      if (saveFailures === 1) toast('Could not save (' + (e.message || e) + '). Retrying…', 4000);
      retryTimer = setTimeout(() => saveNow(), Math.min(30000, 2000 * 2 ** (saveFailures - 1)));
    } finally { saveInFlight = null; }
  })();
  await saveInFlight;
  if (saveQueued) { saveQueued = false; if (app.rev !== app.savedRev) await saveNow(); }
};
const debouncedSave = debounce(saveNow, 500);
const scheduleSave = Object.assign(() => { app.rev++; setSaveState('dirty'); debouncedSave(); }, { flush: () => debouncedSave.flush() });
app.saveNow = saveNow;
function setSaveState(s) {
  const e = $('saveState');
  const map = {
    dirty: 'Unsaved changes', saving: 'Saving…', failed: 'Save failed – retrying',
    saved: 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  e.textContent = map[s] || s;
  e.dataset.state = map[s] ? s : 'info';
  e.classList.toggle('saving', s === 'saving' || s === 'dirty');
  e.classList.toggle('failed', s === 'failed');
}

app.commit = (label) => {
  if (app.history.commit(app.project)) scheduleSave();
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
    const tab = { clip: 'clip', text: 'text', audio: 'audio', overlay: 'pip' }[sel.type];
    if (tab) showTab(tab);
    if (opts.seekInto) {
      const t = player.t;
      if (sel.type === 'clip') { const it = layout(app.project).items.find(i => i.clip.id === sel.id); if (it && (t < it.start || t >= it.end)) player.setTime(it.start + 0.001); }
      if (sel.type === 'text') { const x = app.project.texts.find(i => i.id === sel.id); if (x && (t < x.start || t >= x.end)) player.setTime(x.start + 0.01); }
      if (sel.type === 'marker') { const m = app.project.markers.find(i => i.id === sel.id); if (m) player.setTime(m.time); }
      if (sel.type === 'overlay') { const o = app.project.overlays.find(i => i.id === sel.id); if (o && (t < o.start || t >= o.start + overlayLen(o))) player.setTime(o.start + 0.01); }
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
  if (s.type === 'overlay') return (p.overlays || []).find(c => c.id === s.id) || null;
  return null;
}
/** Selected animatable item with its timeline start/length and the playhead's local time. */
function kfTarget(type) {
  const s = app.selection; if (!s || !['clip', 'text', 'overlay'].includes(s.type) || (type && s.type !== type)) return null;
  const item = selected(s.type); if (!item) return null;
  let start, len;
  if (s.type === 'clip') { const it = layout(app.project).items.find(i => i.clip.id === item.id); if (!it) return null; start = it.start; len = it.len; }
  else if (s.type === 'text') { start = item.start; len = item.end - item.start; }
  else { start = item.start; len = overlayLen(item); }
  const raw = player.t - start;
  return { type: s.type, item, start, len, raw, local: clamp(raw, 0, len), inside: raw >= -1e-4 && raw <= len + 1e-4 };
}
const KF_PATHS = {
  'clip.transform.x': 'x', 'clip.transform.y': 'y', 'clip.transform.zoom': 'scale', 'clip.transform.angle': 'rotation', 'clip.opacity': 'opacity',
  'text.x': 'x', 'text.y': 'y', 'text.scale': 'scale', 'text.rotation': 'rotation', 'text.opacity': 'opacity',
  'ovl.x': 'x', 'ovl.y': 'y', 'ovl.scale': 'scale', 'ovl.rotation': 'rotation', 'ovl.opacity': 'opacity',
};
const typeOfRoot = (path) => ({ clip: 'clip', text: 'text', ovl: 'overlay' })[path.split('.')[0]];

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
  qs('.overlay-head').style.height = timeline.oTrack.offsetHeight + 'px';
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
  if (!player.playing && app.selection) refreshAnimated();
  if (voice && voice.state === 'rec') voice.tick();
}

// ---------------------------------------------------------------- data binding
function resolve(path) {
  const [root, ...rest] = path.split('.');
  let obj = root === 'proj' ? app.project : root === 'clip' ? selected('clip') : root === 'text' ? selected('text') : root === 'audio' ? selected('audio') : root === 'ovl' ? selected('overlay') : null;
  if (!obj) return null;
  for (let i = 0; i < rest.length - 1; i++) { obj = obj[rest[i]]; if (obj == null) return null; }
  return { obj, key: rest[rest.length - 1] };
}
function getVal(path) {
  const prop = KF_PATHS[path];
  if (prop) { const k = kfTarget(typeOfRoot(path)); if (k && hasKeyframes(k.item, prop)) return animated(k.type, k.item, k.local)[prop]; }
  const r = resolve(path); return r ? r.obj[r.key] : undefined;
}
function setVal(path, v) {
  const prop = KF_PATHS[path];
  if (prop) {
    // Auto-key: once a property has keyframes, edits create/update a keyframe at the playhead.
    const k = kfTarget(typeOfRoot(path));
    if (k && hasKeyframes(k.item, prop)) {
      if (!k.inside) { toast('Move the playhead over this item to change its keyframes.'); return false; }
      setKeyframe(k.item, prop, k.local, v); return true;
    }
  }
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
  if (path === 'proj.settings.ratio' && obj.ratio === '9:16' && p.settings.bg === 'black') {
    p.settings.bg = 'blur'; toast('Shorts: background set to a blurred copy of your clip (Look tab to change).', 3500);
  }
  if (path === 'ovl.in' || path === 'ovl.out') { const mx = obj.kind === 'image' ? 3600 : (obj.srcDuration || 1e9); obj.in = clamp(obj.in, 0, mx - MIN_CLIP); obj.out = clamp(obj.out, obj.in + MIN_CLIP, mx); }
  if (path === 'ovl.start') obj.start = Math.max(0, obj.start);
  if (path === 'ovl.speed') obj.speed = clamp(Number(obj.speed) || 1, 0.25, 4);
  if (path === 'text.anim.in' || path === 'text.anim.out') { const t = selected('text'); const d = t.end - t.start; if (t.anim.inDur + t.anim.outDur > d) { t.anim.inDur = Math.min(t.anim.inDur, d * 0.6); t.anim.outDur = Math.min(t.anim.outDur, d * 0.35); } }
  if (path === 'proj.settings.ratio' || path === 'proj.settings.res') sizeStage();
  if (path.startsWith('proj.settings.') && ['res', 'fps', 'quality', 'format'].includes(path.split('.')[2])) refreshCaps();
}
const FMT = {
  x: v => (+v).toFixed(2).replace(/\.?0+$/, '') + '×', pct: v => Math.round(v * 100) + '%', s: v => (+v).toFixed(1) + 's',
  n2: v => (+v).toFixed(2), size: v => Math.round(v * 1000) / 10, int: v => String(Math.round(v)),
  deg: v => Math.round(v) + '°', permil: v => (v * 1000).toFixed(0),
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
    const lay = layout(p), it = lay.items.find(i => i.clip.id === c.id) || { index: p.clips.indexOf(c), len: clipLen(c) };
    $('clipTitle').textContent = (c.kind === 'image' ? 'Image ' : 'Clip ') + (it.index + 1) + ' of ' + lay.items.length;
    $('clipLenLabel').textContent = fmt(it.len) + ' on timeline';
    const isImg = c.kind === 'image';
    $('trimBlock').hidden = isImg; $('imageDurBlock').hidden = !isImg; $('speedSection').hidden = isImg;
    if (isImg) { $('imageDur').value = c.out - c.in; $('imageDurOut').textContent = (c.out - c.in).toFixed(1) + 's'; }
    else {
      const d = c.srcDuration > 0 ? c.srcDuration : Math.max(c.out, 0.01); // media with an unknown duration
      for (const r of [$('startRange'), $('endRange')]) { r.max = d; r.step = Math.max(0.01, d / 1000); }
      $('startRange').value = c.in; $('endRange').value = c.out;
      if (document.activeElement !== $('clipIn')) $('clipIn').value = c.in.toFixed(2);
      if (document.activeElement !== $('clipOut')) $('clipOut').value = c.out.toFixed(2);
      $('rangeFill').style.marginLeft = clamp(c.in / d * 100, 0, 100) + '%'; $('rangeFill').style.width = clamp((c.out - c.in) / d * 100, 0, 100) + '%';
    }
    $('offlineBanner').hidden = media.has(c.mediaId);
    const idx = it.index;
    qsa('[data-action=moveLeft]').forEach(b => b.disabled = idx === 0);
    qsa('[data-action=moveRight]').forEach(b => b.disabled = idx === lay.items.length - 1);
  }
  const t = selected('text');
  const o = selected('overlay');
  stage.classList.toggle('text-edit', !!t || !!o);
  $('overlayPanel').hidden = !o; $('overlayEmptyHint').hidden = (p.overlays || []).length > 0;
  if (o) {
    if (document.activeElement !== $('ovlLenInput')) $('ovlLenInput').value = overlayLen(o).toFixed(2);
    $('ovlTrimRow').hidden = o.kind === 'image';
    $('ovlSpeedSection').hidden = o.kind === 'image';
    $('ovlSoundSection').hidden = o.kind === 'image' || !o.hasAudio;
    $('ovlOfflineBanner').hidden = media.has(o.mediaId);
  }
  renderKfPanels();
  $('textPanel').hidden = !t; $('textEmptyHint').hidden = p.texts.length > 0;
  const a = selected('audio');
  $('audioPanel').hidden = !a; $('audioEmptyHint').hidden = p.audio.length > 0;
  if (a && document.activeElement !== $('audioLenInput')) $('audioLenInput').value = audioSpan(a, layout(p).total).toFixed(2);
  if (a) {
    $('audioLenLabel').textContent = a.loop ? 'Length on timeline (s)' : 'Length (s)';
    $('loopHint').textContent = a.loop ? (a.loopLen > 0 ? `Repeats the ${fmt(audioLen(a))} trimmed section for ${fmt(a.loopLen)}.` : `Repeats the ${fmt(audioLen(a))} trimmed section until the video ends. Set a length to stop earlier.`) : 'Turn on to repeat a short track under the whole video.';
  }
  $('logoPanel').hidden = !p.logo; $('logoHint').hidden = !!p.logo;
  const sel = !!app.selection;
  qsa('.tl-toolbar [data-action=duplicate], .tl-toolbar [data-action=delete]').forEach(b => b.disabled = !sel);
  // Keyframes only exist for things that animate visually (clip, text, overlay) - not music, voice or markers.
  const kfOk = !!app.selection && ['clip', 'text', 'overlay'].includes(app.selection.type);
  qsa('.tl-toolbar [data-action=addKeyframe]').forEach(b => {
    b.disabled = !kfOk;
    b.title = kfOk ? 'Keyframe the selected clip, text or overlay at the playhead (Shift+K)' : 'Select a clip, text or overlay to keyframe (music uses fades, volume and ducking instead)';
  });
}
// Side-panel lists: rebuilt only when what they show changed (they're refreshed on every slider input event).
const listKeys = {};
const listItem = (selectedNow, label, onPick, ...kids) => el('div', {
  class: 'item' + (selectedNow ? ' selected' : ''), role: 'button', tabindex: '0', 'aria-pressed': selectedNow ? 'true' : 'false', 'aria-label': label,
  onclick: onPick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } },
}, ...kids);
function renderList(id, rows, build) {
  const key = JSON.stringify(rows.map(r => r.key));
  if (listKeys[id] === key) return;
  listKeys[id] = key;
  const box = $(id), focusedIdx = [...box.children].indexOf(document.activeElement);
  box.replaceChildren(...rows.map(build));
  if (focusedIdx >= 0 && box.children[focusedIdx]) box.children[focusedIdx].focus();
}
function renderLists(light) {
  const p = app.project, sel = app.selection || {}, total = layout(p).total;
  const isSel = (type, id) => sel.type === type && sel.id === id;
  const texts = [...p.texts].sort((a, b) => a.start - b.start).map(t => ({ t, key: [t.id, fmt(t.start), t.text, isSel('text', t.id)] }));
  renderList('textList', texts, ({ t }) => { const txt = (t.text || '(empty)').replace(/\n/g, ' '); return listItem(isSel('text', t.id), `Text at ${fmt(t.start)}: ${txt}`, () => app.select({ type: 'text', id: t.id }, { seekInto: true }),
    el('span', { class: 't', text: fmt(t.start) }), el('span', { class: 'grow', text: txt })); });
  const auds = p.audio.map(a => ({ a, span: audioSpan(a, total), key: [a.id, a.name, a.voice, a.loop, fmt(a.start), fmt(audioSpan(a, total)), isSel('audio', a.id)] }));
  renderList('audioList', auds, ({ a, span }) => listItem(isSel('audio', a.id), `${a.voice ? 'Voice' : 'Music'} track ${a.name}${a.loop ? ', looped' : ''}, ${fmt(a.start)}`, () => app.select({ type: 'audio', id: a.id }),
    el('span', { text: a.voice ? '🎙' : '♪' }), el('span', { class: 'grow', text: a.name + (a.loop ? ' (loop)' : '') }), el('span', { class: 't', text: fmt(a.start) + ' · ' + fmt(span) })));
  const ovs = (p.overlays || []).map(o => ({ o, key: [o.id, o.name, !!(o.chroma && o.chroma.enabled), fmt(o.start), fmt(overlayLen(o)), isSel('overlay', o.id)] }));
  renderList('overlayList', ovs, ({ o }) => { const keyed = o.chroma && o.chroma.enabled; return listItem(isSel('overlay', o.id), `Overlay ${o.name}, ${fmt(o.start)}`, () => app.select({ type: 'overlay', id: o.id }, { seekInto: true }),
    el('span', { class: 'item-ico', title: keyed ? 'Green screen' : 'Picture-in-picture' }, icon(keyed ? 'key' : 'pip')), el('span', { class: 'grow', text: o.name }), el('span', { class: 't', text: fmt(o.start) + ' · ' + fmt(overlayLen(o)) })); });
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
  app._pendingTrimRipple = app._pendingTrimRipple || { end: it0.end, total: before.total, kf: deepClone(c.keyframes || {}), in0: c.in };
  c.in = s; c.out = e;
  // keyframes stay on the same frames of the source when the start is trimmed
  const P = app._pendingTrimRipple;
  if (hasKeyframes({ keyframes: P.kf })) c.keyframes = rebaseKeyframes(P.kf, (s - P.in0) / (c.speed || 1));
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
$('audioLenInput').addEventListener('change', () => {
  const a = selected('audio'); if (!a) return; const l = parseFloat($('audioLenInput').value); if (!(l > 0)) return;
  if (a.loop) a.loopLen = Math.max(0.2, l); // looped: how long it repeats on the timeline
  else a.out = clamp(a.in + l, a.in + 0.2, a.srcDuration || 1e9);
  app.commit('Audio length');
});
$('textPosPresets').addEventListener('click', (e) => { const b = e.target.closest('button'); const t = selected('text'); if (!b || !t) return; t.y = parseFloat(b.dataset.y); t.x = 0.5; app.commit('Text position'); });

// ---------------------------------------------------------------- actions
const actions = {
  split() {
    // Splits the selected item on any track (clip, text, overlay, music/voice); with nothing (or a marker) selected,
    // splits the main video track at the playhead.
    const s = app.selection && app.selection.type !== 'marker' ? app.selection : null;
    const r = splitItem(app.project, s, player.t);
    if (!r || r.fail) return toast(r ? r.reason : 'Nothing to split here.');
    app.selection = { type: r.type, id: r.item.id };
    const what = { clip: 'Clip', text: 'Text', audio: 'Audio', overlay: 'Overlay' }[r.type];
    app.commit('Split'); toast(what + ' split at ' + fmtPrecise(player.t, app.project.settings.fps));
  },
  duplicate() {
    const s = app.selection; if (!s) return toast('Select something to duplicate.');
    if (s.type === 'clip') { const b = duplicateClip(app.project, s.id, app.rippleEnabled); if (b) app.selection = { type: 'clip', id: b.id }; }
    else if (s.type === 'text') return actions.duplicateText();
    else if (s.type === 'audio') { const a = selected('audio'); const b = deepClone(a); b.id = uid('aud'); b.start = a.start + audioSpan(a, layout(app.project).total); app.project.audio.push(b); app.selection = { type: 'audio', id: b.id }; }
    else if (s.type === 'overlay') { const o = selected('overlay'); const b = deepClone(o); b.id = uid('ovl'); b.start = o.start + overlayLen(o); app.project.overlays.push(b); app.selection = { type: 'overlay', id: b.id }; }
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
    if (s.type === 'overlay') p.overlays = p.overlays.filter(t => t.id !== s.id);
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
    const m = { id: uid('mk'), time: t, name: 'Marker ' + (app.project.markers.length + 1) };
    app.project.markers.push(m); app.selection = { type: 'marker', id: m.id };
    app.commit('Add marker'); toast('Marker added at ' + fmt(t) + '. Drag it to move it, or select it and press Delete to remove it.');
  },
  removeLogo() { app.project.logo = null; app.commit('Remove logo'); },
  deleteOverlay() { const o = selected('overlay'); if (!o) return; app.project.overlays = app.project.overlays.filter(x => x !== o); app.selection = null; app.commit('Delete overlay'); },
  ovlStartHere() { const o = selected('overlay'); if (!o) return; o.start = Math.max(0, player.t); app.commit('Move overlay'); },
  addKeyframe() {
    const k = kfTarget();
    if (!k) return toast('Select a clip, text or overlay first, then add a keyframe.');
    if (!k.inside) return toast('Move the playhead over the selected item first.');
    const vals = animated(k.type, k.item, k.local);
    for (const pr of ANIM_PROPS) setKeyframe(k.item, pr, k.local, vals[pr]);
    app.commit('Add keyframe');
    toast('◆ Keyframe at ' + fmtPrecise(player.t, app.project.settings.fps) + ' — move to another time and change position, scale, rotation or opacity.', 3500);
  },
  kfPrev() { const k = kfTarget(); if (!k) return; const ts = kfTimes(k.item).filter(x => x < k.raw - 1e-3); if (ts.length) { player.pause(); player.setTime(k.start + ts[ts.length - 1] + 1e-4); } },
  kfNext() { const k = kfTarget(); if (!k) return; const ts = kfTimes(k.item).filter(x => x > k.raw + 1e-3); if (ts.length) { player.pause(); player.setTime(k.start + ts[0] + 1e-4); } },
  kfClear() { const k = kfTarget(); if (!k) return; k.item.keyframes = {}; app.commit('Clear keyframes'); toast('Keyframes cleared'); },
};
app.actions = actions;

// ---------------------------------------------------------------- keyframe panels
function renderKfPanels() {
  for (const panel of qsa('.kf-panel')) {
    const type = panel.dataset.kf;
    const k = kfTarget(type);
    if (!k) { if (panel._key) { panel._key = ''; panel.replaceChildren(); } continue; }
    const times = kfTimes(k.item);
    const eases = times.map(lt => { for (const pr of ANIM_PROPS) { const f = (k.item.keyframes[pr] || []).find(x => Math.abs(x.t - lt) < 1 / 120); if (f) return f.ease; } return 'linear'; });
    const key = [type, k.item.id, k.start.toFixed(3), times.join(','), eases.join(',')].join('|');
    if (panel._key !== key) {
      panel._key = key;
      const head = el('div', { class: 'section-head' }, el('h2', { text: 'Keyframes' }), el('span', { class: 'hint mono', text: times.length ? times.length + ' ◆' : 'none' }));
      const btns = el('div', { class: 'button-row' },
        el('button', { class: 'btn primary small', type: 'button', 'data-action': 'addKeyframe', text: '◆ Keyframe at playhead' }),
        el('button', { class: 'btn secondary small', type: 'button', 'data-action': 'kfPrev', 'aria-label': 'Previous keyframe', text: '◀ ◆' }),
        el('button', { class: 'btn secondary small', type: 'button', 'data-action': 'kfNext', 'aria-label': 'Next keyframe', text: '◆ ▶' }),
        times.length ? el('button', { class: 'btn ghost danger small', type: 'button', 'data-action': 'kfClear', text: 'Clear all' }) : null);
      const list = el('div', { class: 'item-list kf-list' });
      times.forEach((lt, i) => {
        const sel = el('select', { class: 'mini-select', 'aria-label': 'Easing' });
        for (const [v, l] of [['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['easeInOut', 'Ease in/out'], ['hold', 'Hold']]) sel.append(el('option', { value: v, text: l }));
        sel.value = eases[i];
        sel.addEventListener('change', () => { const kk = kfTarget(type); if (!kk) return; setEaseAt(kk.item, lt, sel.value); app.commit('Keyframe easing'); });
        list.append(el('div', { class: 'item kf-row', 'data-lt': String(lt) },
          el('button', { type: 'button', class: 't', text: '◆ ' + fmtPrecise(k.start + lt, app.project.settings.fps), title: 'Jump to keyframe', onclick: () => { player.pause(); player.setTime(k.start + lt + 1e-4); } }),
          el('span', { class: 'grow' }), sel,
          el('button', { type: 'button', text: '✕', 'aria-label': 'Delete keyframe', onclick: () => { const kk = kfTarget(type); if (!kk) return; removeKeyframesAt(kk.item, lt); app.commit('Delete keyframe'); } })));
      });
      const hint = el('p', { class: 'hint', text: times.length ? 'Position, scale, rotation and opacity are animated. Move the playhead and drag a slider (or the item on the preview) to set another keyframe. Easing applies from a keyframe to the next.' : 'Animate position, scale, rotation and opacity: add a keyframe, move the playhead, then change a value.' });
      panel.replaceChildren(head, btns, list, hint);
    }
    for (const row of panel.querySelectorAll('.kf-row')) row.classList.toggle('selected', Math.abs(parseFloat(row.dataset.lt) - k.raw) < 1 / 60);
  }
}
let animRefreshQueued = false;
function refreshAnimated() {
  if (animRefreshQueued) return; animRefreshQueued = true;
  requestAnimationFrame(() => {
    animRefreshQueued = false;
    const k = kfTarget(); if (!k || !hasKeyframes(k.item)) return;
    const root = k.type === 'overlay' ? 'ovl' : k.type;
    for (const inp of qsa('input[type=range][data-bind]')) {
      const path = inp.dataset.bind; if (!KF_PATHS[path] || !path.startsWith(root + '.')) continue;
      const v = getVal(path); if (v != null && document.activeElement !== inp) inp.value = v;
    }
    fillOutputs(); renderKfPanels();
  });
}
// text animation selects & presets
for (const [k, v] of Object.entries(TEXT_ANIMS_IN)) $('animInSelect').append(el('option', { value: k, text: v }));
for (const [k, v] of Object.entries(TEXT_ANIMS_OUT)) $('animOutSelect').append(el('option', { value: k, text: v }));
$('animPresets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); const t = selected('text'); if (!b || !t) return;
  t.anim = Object.assign({}, t.anim, { in: b.dataset.in, out: b.dataset.out });
  if (b.dataset.in === 'typewriter' || b.dataset.in === 'wordByWord') t.anim.inDur = Math.min(Math.max(t.anim.inDur, 1.2), (t.end - t.start) * 0.6);
  if (b.dataset.in !== 'none') t.fadeIn = 0;
  app.commit('Text animation'); player.setTime(t.start + 0.001); player.play();
});

// ---------------------------------------------------------------- picture-in-picture
async function importOverlay(f) {
  if (!f) return;
  const kind = kindOf(f);
  if (!['video', 'image'].includes(kind)) return toast('Choose a video or image for the overlay.');
  const p = app.project, total = layout(p).total;
  setSaveState((isHeic(f) ? 'Converting HEIC photo ' : 'Importing ') + f.name + '…');
  try {
    const m = await media.importFile(f);
    mediaNotes(m);
    const start = total > 0.5 ? clamp(player.t, 0, total - 0.5) : 0;
    const o = newOverlay(m, start, p.settings);
    if (o.kind === 'image' && total > 0) o.out = o.in + Math.min(o.out - o.in, Math.max(1, total - start));
    p.overlays.push(o); app.selection = { type: 'overlay', id: o.id };
    app.commit('Add overlay'); showTab('pip');
    toast('Overlay added — drag it on the preview, or use the corner buttons.');
  } catch (e) { console.warn(e); toast('Could not read ' + f.name + ': ' + (e.message || e)); setSaveState('saved'); }
}
app.importOverlay = importOverlay;
$('overlayInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; importOverlay(f); };
$('ovlRelinkInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; const o = selected('overlay'); if (!f || !o) return;
  try { await media.replaceMedia(o.mediaId, f); }
  catch (err) { console.warn(err); return toast('Could not read ' + f.name + ': ' + (err.message || err), 5000); }
  renderAll(); toast('Media relinked.');
};
$('ovlLenInput').addEventListener('change', () => {
  const o = selected('overlay'); if (!o) return; const l = parseFloat($('ovlLenInput').value); if (!(l > 0)) return;
  const sp = o.kind === 'image' ? 1 : (o.speed || 1);
  o.out = clamp(o.in + l * sp, o.in + MIN_CLIP, o.kind === 'image' ? 3600 : (o.srcDuration || 1e9)); app.commit('Overlay length');
});
$('ovlPosPresets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); const o = selected('overlay'); if (!b || !o) return;
  const { width: W, height: H } = outputDims(app.project);
  const pr = b.dataset.p;
  if (pr === 'full') { setVal('ovl.w', 1); setVal('ovl.x', 0.5); setVal('ovl.y', 0.5); o.radius = 0; o.shadow = false; o.border = 0; }
  else {
    const w = o.w >= 0.95 ? 0.36 : o.w; setVal('ovl.w', w);
    const hFrac = w * W * ((o.height || 9) / (o.width || 16)) / H, m = 0.04;
    const x = pr === 'tl' || pr === 'bl' ? m + w / 2 : pr === 'c' ? 0.5 : 1 - m - w / 2;
    const y = pr === 'tl' || pr === 'tr' ? m * W / H + hFrac / 2 : pr === 'c' ? 0.5 : 1 - m * W / H - hFrac / 2;
    setVal('ovl.x', x); setVal('ovl.y', y);
  }
  app.commit('Overlay position');
});
$('chromaPick').onclick = () => {
  const o = selected('overlay'); if (!o) return;
  const t = player.t; if (t < o.start || t >= o.start + overlayLen(o)) player.setTime(o.start + Math.min(0.5, overlayLen(o) / 2));
  player.pause();
  app.picking = true; stage.classList.add('picking');
  toast('Tap the background color to remove in the preview.', 3000);
};
function pickColorAt(x, y) {
  const o = selected('overlay'); app.picking = false; stage.classList.remove('picking');
  if (!o) return;
  const was = o.chroma.enabled; o.chroma.enabled = false;
  player.render();
  let px;
  try { px = player.ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; } catch (e) { o.chroma.enabled = was; return toast('Could not read the preview color.'); }
  const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  o.chroma.color = hex; o.chroma.enabled = true;
  app.commit('Pick key color'); toast('Key color ' + hex + ' — adjust Similarity if edges remain.');
}

// ---------------------------------------------------------------- voiceover recorder
voice = (() => {
  const V = { state: 'idle', busy: false, stream: null, rec: null, chunks: [], blob: null, url: null, t0: 0, startedAt: 0, dur: 0, ac: null, an: null, raf: 0, peak: 0, takes: 0 };
  const ui = () => {
    const recd = V.state === 'rec' || V.state === 'arming' || V.state === 'countdown';
    $('voStop').textContent = V.state === 'rec' ? '■ Stop' : '✕ Cancel';
    $('voRecord').hidden = recd; $('voStop').hidden = !recd;
    $('voRecord').disabled = V.state === 'review';
    $('voReview').hidden = V.state !== 'review';
    $('voSection').classList.toggle('recording', V.state === 'rec');
    V.busy = V.state !== 'idle';
  };
  const fmtT = (sec) => { const m = Math.floor(sec / 60), ss = sec - m * 60; return String(m).padStart(2, '0') + ':' + ss.toFixed(1).padStart(4, '0'); };
  const meter = () => {
    if (!V.an) return;
    const buf = new Float32Array(V.an.fftSize); V.an.getFloatTimeDomainData(buf);
    let sum = 0, pk = 0; for (const v of buf) { sum += v * v; pk = Math.max(pk, Math.abs(v)); }
    const rms = Math.sqrt(sum / buf.length), db = 20 * Math.log10(Math.max(1e-5, rms));
    const pct = clamp((db + 60) / 60, 0, 1);
    V.peak = Math.max(pct, V.peak - 0.01);
    $('voLevel').style.transform = `scaleX(${pct.toFixed(3)})`;
    $('voPeak').style.left = (V.peak * 100).toFixed(1) + '%';
    $('voSection').classList.toggle('clipping', pk > 0.98);
    V.level = pct;
    if (V.state === 'rec') $('voTimer').textContent = fmtT((performance.now() - V.startedAt) / 1000);
    V.raf = requestAnimationFrame(meter);
  };
  const release = () => {
    cancelAnimationFrame(V.raf); V.raf = 0;
    if (V.stream) V.stream.getTracks().forEach(t => t.stop());
    V.stream = null; V.an = null;
    if (V.ac) { V.ac.close().catch(() => { }); V.ac = null; }
    $('voLevel').style.transform = 'scaleX(0)'; $('voPeak').style.left = '0%';
    player.muteAll = false;
  };
  const mimeFor = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  const IDLE_HINT = 'Records from your microphone into a new voice track starting at the playhead. Music automatically ducks under your voice.';
  const mkRecorder = (mime) => { try { return new MediaRecorder(V.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined); } catch (e) { if (!mime) throw e; return new MediaRecorder(V.stream); } };
  async function start() {
    if (V.state !== 'idle') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return toast('This browser cannot record audio.');
    showTab('audio');
    V.state = 'arming'; V.cancelArm = false; ui();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (V.state === 'arming') { V.state = 'idle'; ui(); }
      if (V.cancelArm) return;
      return toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser’s site settings.' : 'No microphone available: ' + (e.message || e.name), 5000);
    }
    if (V.cancelArm || V.state !== 'arming') { stream.getTracks().forEach(t => t.stop()); return; } // cancelled while the permission prompt was open
    V.stream = stream;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      V.ac = new AC(); const src = V.ac.createMediaStreamSource(V.stream);
      V.an = V.ac.createAnalyser(); V.an.fftSize = 1024; src.connect(V.an);
    } catch { }
    try {
      // recorder creation/start can throw (unsupported mime/bitrate, device lost): never leave the mic on
      V.rec = mkRecorder(mimeFor());
      V.chunks = [];
      V.rec.ondataavailable = (e) => { if (e.data && e.data.size) V.chunks.push(e.data); };
      V.stopped = new Promise(r => V.rec.addEventListener('stop', r, { once: true }));
      player.pause();
      V.t0 = player.t >= player.total - 0.05 && player.total > 0 ? 0 : player.t;
      player.setTime(V.t0);
      player.muteAll = $('voMute').checked;
      V.rec.start(250);
    } catch (e) {
      console.warn('Voiceover recorder failed', e);
      release(); V.rec = null; V.state = 'idle'; ui();
      $('voHint').textContent = IDLE_HINT;
      return toast('Recording could not start: ' + (e.message || e.name), 5000);
    }
    V.startedAt = performance.now();
    V.state = 'rec'; ui();
    if ($('voPlayVideo').checked && app.project.clips.length) player.play(1);
    meter();
    $('voHint').textContent = 'Recording… press Stop (or R) when you’re done.';
  }
  async function stop() {
    if (V.state === 'countdown') return cancelCountdown();
    if (V.state === 'arming') { V.cancelArm = true; release(); V.state = 'idle'; ui(); $('voHint').textContent = IDLE_HINT; return; }
    if (V.state !== 'rec') return;
    V.dur = (performance.now() - V.startedAt) / 1000;
    V.rec.stop(); await V.stopped;
    player.pause();
    release();
    const type = (V.rec.mimeType || 'audio/webm').split(';')[0];
    V.blob = new Blob(V.chunks, { type });
    if (V.url) URL.revokeObjectURL(V.url);
    V.url = URL.createObjectURL(V.blob);
    $('voAudio').src = V.url;
    $('voTimer').textContent = fmtT(V.dur);
    V.state = 'review'; ui();
    $('voHint').textContent = `Take ready (${V.dur.toFixed(1)}s from ${fmt(V.t0)}). Listen, then keep it or retake.`;
    player.setTime(V.t0);
  }
  async function keep() {
    if (V.state !== 'review' || !V.blob) return;
    const n = app.project.audio.filter(a => a.voice).length + 1;
    const ext = V.blob.type.includes('mp4') ? 'm4a' : V.blob.type.includes('ogg') ? 'ogg' : 'webm';
    try {
      const m = await media.importFile(new File([V.blob], `Voiceover ${n}.${ext}`, { type: V.blob.type }), 'audio');
      if (!(m.duration > 0)) { m.duration = V.dur; await db.updateMediaMeta(m.id, { duration: V.dur }).catch(() => { }); }
      const a = newAudio(m, V.t0);
      Object.assign(a, { name: 'Voiceover ' + n, voice: true, duck: false, volume: 1, fadeIn: 0.05, fadeOut: 0.15 });
      if (!(a.out > 0)) { a.out = V.dur; a.srcDuration = V.dur; }
      app.project.audio.push(a);
      app.selection = { type: 'audio', id: a.id };
      discard(true);
      app.commit('Record voiceover');
      toast('Voiceover added at ' + fmt(a.start) + '. Music ducks under it automatically.');
    } catch (e) { console.warn(e); toast('Could not save the recording: ' + (e.message || e)); }
  }
  function discard(silent) {
    if (V.url) { $('voAudio').removeAttribute('src'); $('voAudio').load(); URL.revokeObjectURL(V.url); V.url = null; }
    V.blob = null; V.chunks = [];
    V.state = 'idle'; ui();
    $('voTimer').textContent = '00:00.0';
    $('voHint').textContent = IDLE_HINT;
    if (!silent) toast('Take discarded');
  }
  async function retake() { const t0 = V.t0; discard(true); player.setTime(t0); await start(); }
  $('voRecord').onclick = start; $('voStop').onclick = stop;
  $('voKeep').onclick = keep; $('voRetake').onclick = retake; $('voDiscard').onclick = () => discard();
  V.start = start; V.stop = stop; V.keep = keep; V.retake = retake; V.discard = discard;
  V.toggle = () => { if (V.state === 'idle') start(); else if (V.state === 'rec' || V.state === 'arming') stop(); };
  // Keyboard R: a visible 3-2-1 countdown first (so a stray key press never opens the mic), R/Esc/Cancel aborts it.
  const COUNT = 3;
  function countdown() {
    if (V.state !== 'idle') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return toast('This browser cannot record audio.');
    showTab('audio');
    V.state = 'countdown'; ui();
    let n = COUNT;
    const tick = () => {
      if (V.state !== 'countdown') return;
      if (n <= 0) { V.state = 'idle'; ui(); start(); return; }
      $('voTimer').textContent = String(n);
      $('voHint').textContent = `Recording starts in ${n}… press R or Esc to cancel.`;
      toast(`Recording in ${n}… (R or Esc cancels)`, 1100);
      n--; V.cdTimer = setTimeout(tick, 1000);
    };
    tick();
  }
  function cancelCountdown() {
    if (V.state !== 'countdown') return;
    clearTimeout(V.cdTimer); V.state = 'idle'; ui();
    $('voTimer').textContent = '00:00.0'; $('voHint').textContent = IDLE_HINT;
    toast('Recording cancelled');
  }
  V.keyR = () => { if (V.state === 'idle') countdown(); else if (V.state === 'countdown') cancelCountdown(); else if (V.state === 'rec' || V.state === 'arming') stop(); };
  V.cancelCountdown = cancelCountdown; V.countdownSec = COUNT;
  V.tick = () => { };
  ui();
  return V;
})();
app.voice = voice;

// ---------------------------------------------------------------- import
function mediaNotes(m) {
  if (m && m.gifStill) toast('This browser can’t play GIF animation here, so “' + m.name + '” is used as a still image.', 4500);
}
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
    setSaveState((isHeic(f) ? 'Converting HEIC photo ' : 'Importing ') + f.name + '…');
    try {
      const m = await media.importFile(f);
      mediaNotes(m);
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
    if (!$('onboard').hidden) dismissOnboarding();
    app.commit('Import');
    if (timeline.autoFit) timeline.fit();
    toast(added + ' item' + (added > 1 ? 's' : '') + ' added');
  } else setSaveState(app.rev === app.savedRev ? 'saved' : 'dirty');
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
  try { await media.replaceMedia(c.mediaId, f); }
  catch (err) { console.warn(err); return toast('Could not read ' + f.name + ': ' + (err.message || err), 5000); }
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
  (p.overlays || []).forEach(o => { s.add(o.start); s.add(o.start + overlayLen(o)); });
  const k = kfTarget(); if (k) kfTimes(k.item).forEach(lt => s.add(k.start + lt));
  return [...s].sort((a, b) => a - b);
}
// Keys a focused control uses itself (slider steps, checkbox/button activation, select navigation).
const CONTROL_KEYS = new Set([' ', 'Spacebar', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** 'text' = typing (no shortcuts), 'control' = a focused control (its own keys win), 'global' = shortcuts apply. */
function keyContext(t) {
  if (!t || !t.closest) return 'global';
  if (t.isContentEditable) return 'text';
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  if (tag === 'INPUT') return ['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file'].includes(t.type) ? 'control' : 'text';
  if (t.closest('button, a[href], summary, [role=button], [role=tab], [role=slider], [role=switch], [role=checkbox], [role=option], [role=menuitem]')) return 'control';
  return 'global';
}
document.addEventListener('keydown', (e) => {
  const ctx = keyContext(e.target);
  const typing = ctx === 'text';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (qs('dialog[open]')) return;
  if (ctx === 'control' && CONTROL_KEYS.has(e.key)) return; // e.g. arrows move the focused slider, Space presses the focused button
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); actions.duplicate(); return; }
  if (mod || e.altKey) return;
  const k = e.key;
  const handled = () => e.preventDefault();
  if (e.shiftKey && (k === 'K' || k === 'k')) { handled(); actions.addKeyframe(); return; }
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
    case 's': case 'S': if (!e.repeat) actions.split(); break;
    case 'Delete': case 'Backspace': handled(); actions.delete(); break;
    case 't': case 'T': if (!e.repeat) actions.addText(); break;
    case 'm': case 'M': if (!e.repeat) actions.addMarker(); break;
    // R never starts recording instantly: it arms a 3-second countdown (R or Esc cancels); R again stops a recording
    case 'r': case 'R': handled(); if (!e.repeat) voice.keyR(); break;
    case '+': case '=': timeline.zoomBy(1.4); break;
    case '-': case '_': timeline.zoomBy(1 / 1.4); break;
    case '0': timeline.autoFit = true; timeline.fit(); app.onZoom(timeline.pps); break;
    case '?': openDialog('helpDialog'); break;
    case 'Escape': if (voice.state === 'countdown') voice.cancelCountdown(); else app.select(null); break;
  }
});
function undo() { if (voice.busy) return; const s = app.history.undo(); if (!s) return; app.project = migrate(s); renderAll(); scheduleSave(); toast('Undo'); }
function redo() { if (voice.busy) return; const s = app.history.redo(); if (!s) return; app.project = migrate(s); renderAll(); scheduleSave(); toast('Redo'); }
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
  qsa('.tabs button').forEach(x => { const on = x.dataset.tab === name; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; });
  qsa('.tab-panel').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
}
// ARIA tabs: tab <-> panel wiring, roving focus with arrow keys / Home / End
(() => {
  const tabs = qsa('.tabs button');
  const list = tabs[0] && tabs[0].parentElement; if (list) { list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Inspector'); }
  for (const b of tabs) {
    const panel = $('tab-' + b.dataset.tab);
    if (!b.id) b.id = 'tabbtn-' + b.dataset.tab;
    b.setAttribute('role', 'tab');
    if (panel) { b.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', b.id); }
    b.onclick = () => showTab(b.dataset.tab);
    b.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(b); let j = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
      if (j == null) return;
      e.preventDefault(); e.stopPropagation(); showTab(tabs[j].dataset.tab); tabs[j].focus();
    });
  }
  const cur = tabs.find(b => b.classList.contains('active')) || tabs[0]; if (cur) showTab(cur.dataset.tab);
})();
// Sliders: every range input gets an accessible name (its row label) and announces the formatted value shown next to it.
(() => {
  let n = 0;
  for (const inp of qsa('input[type=range]')) {
    const row = inp.closest('.slider-row, label');
    const lab = row && row.matches('.slider-row') ? row.querySelector('label') : null, out = row && row.querySelector('output');
    if (!inp.id) inp.id = 'rng-' + (inp.dataset.bind || 'slider').replace(/[^\w-]+/g, '-') + '-' + (++n);
    if (lab && !lab.htmlFor) lab.htmlFor = inp.id;
    if (!inp.labels?.length && !inp.getAttribute('aria-label') && !inp.getAttribute('aria-labelledby')) inp.setAttribute('aria-label', (row && row.textContent.trim()) || inp.title || 'Slider');
    if (out) {
      out.setAttribute('for', inp.id);
      const sync = () => { const t = out.textContent.trim(); if (t) inp.setAttribute('aria-valuetext', t); else inp.removeAttribute('aria-valuetext'); };
      new MutationObserver(sync).observe(out, { childList: true, characterData: true, subtree: true }); sync();
    }
  }
})();

// preset chips + fonts
for (const box of qsa('[data-presets]')) for (const [k, v] of Object.entries(PRESETS)) box.append(el('button', { type: 'button', 'data-value': k, text: v.label }));
for (const [k, v] of Object.entries(FONTS)) { $('fontSelect').append(el('option', { value: k, text: v.label })); $('thumbFont').append(el('option', { value: k, text: v.label })); }

// ---------------------------------------------------------------- preview interactions (drag text/overlays on canvas, pick key color, tap to play)
(() => {
  let drag = null;
  const itemOf = (kind, id) => kind === 'overlay' ? app.project.overlays.find(q => q.id === id) : app.project.texts.find(q => q.id === id);
  stage.addEventListener('pointerdown', (e) => {
    const r = stage.getBoundingClientRect();
    const sx = stage.width / r.width, sy = stage.height / r.height;
    const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy;
    if (app.picking) { e.preventDefault(); pickColorAt(x, y); return; }
    const hit = [...player.lastBoxes].reverse().find(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    if (hit) {
      const kind = hit.type === 'overlay' ? 'overlay' : 'text';
      const it = itemOf(kind, hit.id); if (!it) return;
      e.preventDefault();
      if (player.playing) player.pause();
      app.select({ type: kind, id: it.id });
      const local = player.t - it.start;
      const A = animated(kind, it, local);
      drag = { kind, id: it.id, x0: e.clientX, y0: e.clientY, tx: A.x, ty: A.y, local, moved: false, w: r.width, h: r.height };
      stage.setPointerCapture(e.pointerId); stage.classList.add('grab');
    } else drag = { tap: true, x0: e.clientX, y0: e.clientY };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.tap) return;
    const it = itemOf(drag.kind, drag.id); if (!it) return;
    const dx = (e.clientX - drag.x0) / drag.w, dy = (e.clientY - drag.y0) / drag.h;
    if (Math.abs(dx) + Math.abs(dy) > 0.004) drag.moved = true;
    let nx = clamp(drag.tx + dx, 0, 1), ny = clamp(drag.ty + dy, 0, 1);
    // snap to center lines
    if (Math.abs(nx - 0.5) < 0.015) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.015) ny = 0.5;
    if (hasKeyframes(it, 'x')) setKeyframe(it, 'x', drag.local, nx); else it.x = nx;
    if (hasKeyframes(it, 'y')) setKeyframe(it, 'y', drag.local, ny); else it.y = ny;
    player.requestRender(); fillOutputs();
  });
  const end = (e) => {
    if (!drag) return;
    if (drag.tap) { if (Math.abs(e.clientX - drag.x0) < 6 && Math.abs(e.clientY - drag.y0) < 6 && e.type === 'pointerup') player.toggle(); }
    else if (drag.moved) app.commit(drag.kind === 'overlay' ? 'Move overlay on canvas' : 'Move text on canvas');
    drag = null; stage.classList.remove('grab');
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- projects
/** Free memory held for media the open project no longer uses (object URLs, decoded images, GIF frames). */
function releaseUnusedMedia() {
  const keep = new Set([...mediaIdsOf(app.project), ...app.history.mediaIds()]);
  media.retain(keep);
  if (thumb.v) { thumb.v.removeAttribute('src'); thumb.v.load(); delete thumb.v.dataset.url; }
  for (const v of thumb.ov.values()) { v.removeAttribute('src'); v.load(); }
  thumb.ov.clear(); thumb.logo = null; thumb.key = '';
  thumbBg = null;
}
async function flushPendingSave() {
  clearTimeout(retryTimer);
  if (app.rev !== app.savedRev || saveInFlight) { debouncedSave.cancel && debouncedSave.cancel(); await saveNow(); }
}
async function openProject(id) {
  if (app.ready) await flushPendingSave(); // don't lose the current project's unsaved edits
  const p = await db.getProject(id);
  if (!p) return false;
  player.pause();
  app.project = migrate(p);
  app.history.reset(app.project);
  releaseUnusedMedia();
  await media.preload(mediaIdsOf(app.project));
  // waveforms for media imported before peaks existed (or whose peak pass was interrupted)
  for (const x of [...app.project.clips, ...app.project.audio, ...app.project.overlays]) {
    const rec = media.peek(x.mediaId);
    if (rec && rec.kind !== 'image' && rec.hasAudio !== false && !rec.peaks) media.fillPeaks(x.mediaId).catch(() => { });
  }
  app.selection = null;
  player.t = 0;
  timeline.autoFit = true;
  await db.kvSet('lastProject', id);
  renderAll(); timeline.fit(); player.setTime(0);
  app.savedRev = app.rev;
  setSaveState('saved');
  refreshCaps();
  return true;
}
async function createProject(name) {
  if (app.ready) await flushPendingSave();
  player.pause();
  app.project = newProject(name || 'Untitled project');
  app.selection = null; app.history.reset(app.project);
  releaseUnusedMedia();
  await saveNow();
  renderAll(); player.setTime(0);
  refreshCaps();
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
            releaseUnusedMedia();
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
$('newProject').onclick = async () => { const n = prompt('Name your new project', 'Untitled project'); if (n === null) return; await createProject(n || 'Untitled project'); closeDialog('projectsDialog'); toast('New project created'); };
/**
 * Project file. With media: a .vedit file (tar) holding project.json plus every media file as raw bytes. It's assembled
 * from Blob parts that reference the stored media, so nothing is base64-encoded or copied into one giant string.
 * Without media: a small .vedit.json. Old .vedit.json files with base64 media still import.
 */
async function exportProjectFile(id) {
  if (id === app.project.id) await flushPendingSave();
  const p = id === app.project.id ? JSON.parse(JSON.stringify(app.project)) : await db.getProject(id);
  const embed = $('embedMedia').checked;
  const mediaOut = [], files = [];
  for (const mid of mediaIdsOf(p)) {
    const m = await media.get(mid); if (!m) continue;
    const { blob, peaks, ...meta } = m; // waveform peaks are rebuilt on import
    if (embed && blob) { meta.file = 'media/' + mid; files.push({ name: meta.file, data: blob }); }
    mediaOut.push(meta);
  }
  const data = { app: 'video-editor-pro', format: embed ? 2 : 1, exported: new Date().toISOString(), project: p, media: mediaOut };
  const base = safeName(p.name, 'project');
  if (embed) download(tarBlob([{ name: 'project.json', data: JSON.stringify(data) }, ...files]), base + '-with-media.vedit');
  else download(new Blob([JSON.stringify(data)], { type: 'application/json' }), base + '.vedit.json');
  toast(embed ? 'Project exported with media' : 'Project exported (media stays on this device)');
}
app.exportProjectFile = exportProjectFile;
async function importProjectFile(file) {
  try {
    let data, entries = null;
    if (await isTar(file)) {
      entries = await readTar(file);
      const pj = entries.get('project.json'); if (!pj) throw new Error('Not a project file');
      data = JSON.parse(await pj.text());
    } else data = JSON.parse(await file.text()); // .vedit.json (format 1, media optionally base64)
    const src = data.project || data;
    if (!src || !Array.isArray(src.clips)) throw new Error('Not a project file');
    let missing = 0, skipped = 0;
    for (const m of Array.isArray(data.media) ? data.media : []) {
      if (!m || typeof m.id !== 'string') continue;
      if (await media.get(m.id)) continue;
      let blob = null;
      if (entries && typeof m.file === 'string') blob = entries.get(m.file) || null;
      else if (m.data) { if (isMediaDataURL(m.data)) blob = dataURLToBlob(m.data); else skipped++; } // never fetch() arbitrary URLs
      if (blob) { try { await media.importEmbedded(m, blob); } catch (e) { console.warn(e); missing++; } }
      else missing++;
    }
    const p = migrate(src);
    p.id = uid('prj'); p.name = String(src.name || 'Imported').slice(0, 200); p.updated = Date.now();
    await db.saveProject(p);
    await openProject(p.id);
    closeDialog('projectsDialog');
    if (skipped) console.warn(skipped + ' embedded media entries were not valid media data and were ignored');
    toast(missing ? `Imported. ${missing} media file(s) need relinking (select the red clips).` : 'Project imported');
  } catch (e) { console.warn(e); toast('Import failed: ' + e.message); }
}
app.importProjectFile = importProjectFile;
$('importProject').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importProjectFile(f); };

// dialogs
function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
// close on a real backdrop click only (a click in the dialog's own padding also targets the <dialog> element)
qsa('dialog').forEach(d => { d.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return d.close();
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside || (e.clientX === 0 && e.clientY === 0 && e.detail === 0)) d.close();
}); });
$('helpBtn').onclick = () => openDialog('helpDialog');

// theme
async function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
$('themeBtn').onclick = async () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next); db.kvSet('theme', next);
};

// ---------------------------------------------------------------- thumbnail maker
// Formats: YouTube 16:9 (1280x720), Shorts 9:16 (1080x1920) and square 1:1 (1080x1080). "Auto" follows the project's aspect.
// Text and the logo are laid out inside a per-format safe area (Shorts keeps clear of the app's bottom UI and the top bar).
const THUMB_SAFE = {
  '16:9': { x: 70, y: 60, w: 1140, h: 600, side: 0.63, lines: 4 },
  '1:1': { x: 70, y: 70, w: 940, h: 940, side: 0.78, lines: 5 },
  '9:16': { x: 80, y: 150, w: 920, h: 1410, side: 1, lines: 6 },
};
const thumb = { canvas: $('thumbCanvas'), comp: new Compositor(), v: null, ov: new Map(), logo: null, key: '', seq: 0 };
const thumbFmt = () => thumbFormat(app.project, app.project.thumb.format);
async function thumbVideoAt(v, url, t) {
  if (v.dataset.url !== url) {
    v.src = url; v.dataset.url = url;
    await Promise.race([new Promise(r => { v.onloadeddata = r; v.onerror = r; }), new Promise(r => setTimeout(r, 8000))]);
  }
  if (v.error || v.readyState < 1) return null; // can't decode this video here
  await seekVideo(v, Math.max(0.01, t)); // has a timeout, never hangs
  return { img: v, w: v.videoWidth, h: v.videoHeight };
}
const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
async function thumbFrame(t, F) {
  // Render the sequence frame at time t at the chosen thumbnail size (independent of the project aspect ratio).
  const P = app.project.thumb;
  const p = deepClone(app.project);
  p.settings.ratio = F.key; p.texts = []; p.settings.fit = P.fit; p.settings.bg = P.fit === 'contain' ? 'blur' : 'black';
  for (const c of p.clips) { c.fit = 'inherit'; c.bg = 'inherit'; }
  if (!P.pip) p.overlays = [];
  for (const o of p.overlays) { o.fadeIn = 0; o.fadeOut = 0; } // a thumbnail shows overlays fully visible, not mid-fade
  const lay = layout(p);
  const it = clipAt(lay, t);
  const c = document.createElement('canvas'); c.width = F.width; c.height = F.height;
  if (!it) return c;
  let src = null;
  if (it.clip.kind === 'image') {
    const im = await withTimeout(media.image(it.clip.mediaId), 8000, 'image').catch(() => null);
    if (!im) return c; // missing, undecodable or stuck image: plain background
    src = { img: im.img, w: im.w, h: im.h };
  } else {
    const url = media.url(it.clip.mediaId);
    if (!url) return c;
    if (!thumb.v) { thumb.v = document.createElement('video'); thumb.v.muted = true; thumb.v.playsInline = true; thumb.v.preload = 'auto'; }
    src = await thumbVideoAt(thumb.v, url, it.clip.in + (t - it.start) * it.clip.speed);
    if (!src) return c;
  }
  // picture-in-picture overlays at this moment (each video overlay gets its own hidden <video>)
  const tt = it.start + 0.0001 + Math.max(0, t - it.start);
  const ovSrc = new Map();
  for (const o of overlaysAt(p, tt)) {
    try {
      if (o.kind === 'image') { await withTimeout(media.image(o.mediaId), 8000, 'overlay image'); const s = media.imageSourceAt(o.mediaId, 0, () => { }); if (s) ovSrc.set(o.id, s); continue; }
      const url = media.url(o.mediaId); if (!url) continue;
      let v = thumb.ov.get(o.id);
      if (!v) { v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; thumb.ov.set(o.id, v); }
      const s = await thumbVideoAt(v, url, overlaySourceTime(o, tt));
      if (s && s.w) ovSrc.set(o.id, s);
    } catch { /* an overlay that can't be decoded is left out */ }
  }
  const single = { ...lay, items: [{ ...it, xIn: 0, fadeInBlack: 0, fadeOutBlack: 0 }] };
  thumb.comp.render(c.getContext('2d'), F.width, F.height, p, single, tt, () => src, { getOverlaySource: (o) => ovSrc.get(o.id) || null });
  return c;
}
let thumbBg = null;
async function thumbRefresh(refetch) {
  const P = app.project.thumb, F = thumbFmt(), W = F.width, H = F.height, S = THUMB_SAFE[F.key], sc = W / 1280;
  const seq = ++thumb.seq;
  const key = [P.time, F.key, P.fit, P.pip, P.logo && app.project.logo ? app.project.logo.mediaId : ''].join('|');
  if (refetch || !thumbBg || key !== thumb.key || thumbBg.width !== W) {
    const bg = await thumbFrame(P.time, F);
    let lg = null;
    if (P.logo && app.project.logo) lg = await withTimeout(media.image(app.project.logo.mediaId), 8000, 'logo').catch(() => null);
    if (seq !== thumb.seq) return; // a newer refresh took over
    thumbBg = bg; thumb.logo = lg; thumb.key = key;
  }
  if (thumb.canvas.width !== W || thumb.canvas.height !== H) { thumb.canvas.width = W; thumb.canvas.height = H; }
  const x = thumb.canvas.getContext('2d');
  x.drawImage(thumbBg, 0, 0);
  const dark = parseFloat($('thumbDarken').value);
  if (dark > 0) {
    const g = x.createLinearGradient(P.position === 'right' ? W : 0, 0, P.position === 'right' ? 0 : W, 0);
    if (['center', 'bottom', 'top'].includes(P.position)) { x.fillStyle = `rgba(0,0,0,${dark})`; x.fillRect(0, 0, W, H); }
    else { g.addColorStop(0, `rgba(0,0,0,${Math.min(1, dark * 2.2)})`); g.addColorStop(0.65, `rgba(0,0,0,${dark * 0.4})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
  }
  const text = $('thumbText').value.trim(), sub = $('thumbSub').value.trim();
  const band = P.position === 'center' || P.position === 'bottom' || P.position === 'top';
  const maxW = band ? S.w : S.w * S.side;
  x.save();
  // start at the chosen size, then shrink until the words fit the width and the block fits the safe area
  let size = parseFloat($('thumbSize').value) * sc, lines = [], subSize = 0, blockH = 0, lh = 0;
  for (let i = 0; i < 40; i++) {
    x.font = fontCss(P.font, size);
    lines = text ? wrapLines(x, text, maxW) : [];
    lh = size * 1.02; subSize = Math.round(size * 0.34);
    blockH = lines.length * lh + (sub ? subSize * 1.8 : 0);
    const widest = lines.reduce((m, l) => Math.max(m, x.measureText(l).width), 0);
    if ((lines.length <= S.lines && widest <= maxW + 1 && blockH <= S.h) || size <= 24 * sc) break;
    size *= 0.94;
  }
  lines = lines.slice(0, S.lines);
  let ax, align;
  if (P.position === 'left') { ax = S.x; align = 'left'; } else if (P.position === 'right') { ax = S.x + S.w; align = 'right'; } else { ax = S.x + S.w / 2; align = 'center'; }
  let y;
  if (P.position === 'bottom') y = S.y + S.h - blockH;
  else if (P.position === 'top') y = S.y;
  else y = S.y + (S.h - blockH) * (F.key === '9:16' ? 0.55 : 0.5);
  if ((P.position === 'bottom' || P.position === 'top') && (lines.length || sub)) { x.fillStyle = 'rgba(0,0,0,.62)'; x.fillRect(0, y - 30 * sc, W, blockH + 60 * sc); }
  x.textAlign = align; x.textBaseline = 'top';
  if (sub) {
    x.font = `700 ${subSize}px "IBM Plex Sans", sans-serif`;
    const w = Math.min(S.w, x.measureText(sub.toUpperCase()).width);
    const bx = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
    x.fillStyle = P.accent; x.fillRect(bx - 12 * sc, y - 6 * sc, w + 24 * sc, subSize + 14 * sc);
    x.fillStyle = '#fff'; x.fillText(sub.toUpperCase(), ax, y + 1, S.w);
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
  // logo / watermark, placed by the project's logo settings but kept inside the safe area
  if (thumb.logo && app.project.logo) {
    x.save(); x.translate(S.x, S.y);
    drawLogo(x, S.w, S.h, app.project.logo, thumb.logo);
    x.restore();
  }
}
function thumbSyncInputs() {
  const P = app.project.thumb, F = thumbFmt(), p = app.project;
  $('thumbText').value = P.text || ''; $('thumbSub').value = P.sub || '';
  $('thumbFont').value = P.font; $('thumbPos').value = P.position; $('thumbColor').value = P.color; $('thumbAccent').value = P.accent;
  $('thumbTime').max = Math.max(0.01, layout(p).total - 0.01); $('thumbTime').value = P.time; $('thumbTimeOut').textContent = fmt(P.time);
  const auto = thumbFormat(p, 'auto');
  $('thumbFormat').options[0].textContent = `Auto · ${auto.label.split(' ')[0]}`;
  $('thumbFormat').value = P.format; $('thumbFit').value = P.fit; $('thumbType').value = P.type;
  $('thumbPip').checked = P.pip; $('thumbLogo').checked = P.logo;
  $('thumbPipRow').hidden = !(p.overlays || []).length; $('thumbLogoRow').hidden = !p.logo;
  $('thumbTitle').textContent = `Thumbnail maker · ${F.width}×${F.height}`;
  $('thumbSave').textContent = 'Download ' + (P.type === 'png' ? 'PNG' : 'JPG');
  const S = THUMB_SAFE[F.key], g = $('thumbSafe');
  g.style.cssText = `left:${S.x / F.width * 100}%;top:${S.y / F.height * 100}%;width:${S.w / F.width * 100}%;height:${S.h / F.height * 100}%`;
  g.hidden = !$('thumbGuides').checked;
  $('thumbCanvas').dataset.format = F.key;
}
let thumbOpening = false;
async function openThumb() {
  if (!app.project.clips.length) return toast('Add a clip first.');
  if (thumbOpening) return; // ignore double taps while the first frame is being prepared
  thumbOpening = true;
  try {
    player.pause();
    await Promise.race([ensureFonts(), new Promise(r => setTimeout(r, 3000))]); // never wait forever for fonts
    if (app.project.thumb.time == null) app.project.thumb.time = player.t; // a chosen frame at 0:00 is valid
    thumbSyncInputs(); openDialog('thumbDialog');
    await Promise.race([thumbRefresh(true), new Promise((_, rej) => setTimeout(() => rej(new Error('The frame took too long to load')), 25000))]);
  } catch (e) {
    console.warn('Thumbnail maker', e);
    toast('Could not prepare the thumbnail frame: ' + (e && e.message ? e.message : 'unknown error') + '. Try another frame.');
    if (!$('thumbDialog').open) { try { openDialog('thumbDialog'); } catch { /* dialog unsupported */ } }
  } finally { thumbOpening = false; }
}
$('thumbBtn').onclick = openThumb;
const thumbRefreshSafe = (refetch) => thumbRefresh(refetch).catch((e) => { console.warn('Thumbnail refresh', e); toast('Could not update the thumbnail preview.'); });
const thumbInput = debounce(() => thumbRefreshSafe(false), 30);
for (const id of ['thumbText', 'thumbSub', 'thumbFont', 'thumbPos', 'thumbColor', 'thumbAccent', 'thumbDarken', 'thumbSize']) {
  $(id).addEventListener('input', () => {
    const P = app.project.thumb;
    P.text = $('thumbText').value; P.sub = $('thumbSub').value; P.font = $('thumbFont').value; P.position = $('thumbPos').value; P.color = $('thumbColor').value; P.accent = $('thumbAccent').value;
    $('thumbDarkenOut').textContent = Math.round($('thumbDarken').value * 100) + '%'; $('thumbSizeOut').textContent = $('thumbSize').value;
    thumbInput(); scheduleSave();
  });
}
// options that change the picture itself (or the output size) re-render the frame
for (const id of ['thumbFormat', 'thumbFit', 'thumbPip', 'thumbLogo', 'thumbType']) {
  $(id).addEventListener('change', () => {
    const P = app.project.thumb;
    P.format = $('thumbFormat').value; P.fit = $('thumbFit').value; P.pip = $('thumbPip').checked; P.logo = $('thumbLogo').checked; P.type = $('thumbType').value;
    thumbSyncInputs(); thumbRefreshSafe(true); scheduleSave();
  });
}
$('thumbGuides').addEventListener('change', () => { $('thumbSafe').hidden = !$('thumbGuides').checked; });
$('thumbTime').addEventListener('input', debounce(() => { app.project.thumb.time = parseFloat($('thumbTime').value); $('thumbTimeOut').textContent = fmt(app.project.thumb.time); thumbRefreshSafe(true); scheduleSave(); }, 60));
$('thumbUsePlayhead').onclick = () => { app.project.thumb.time = player.t; thumbSyncInputs(); thumbRefreshSafe(true); };
const YT_THUMB_LIMIT = 2 * 1024 * 1024;
$('thumbSave').onclick = async () => {
  try { await thumbRefresh(false); } catch (e) { return toast('Could not create thumbnail: ' + (e && e.message || 'error')); }
  const P = app.project.thumb, F = thumbFmt();
  const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));
  let blob, note = '';
  if (P.type === 'png') {
    blob = await toBlob(thumb.canvas, 'image/png');
    if (blob && blob.size > YT_THUMB_LIMIT) note = ' PNG is over YouTube\'s 2 MB limit; use JPG for upload.';
  } else {
    // JPG: lower the quality (then the size a little) until it is under YouTube's 2 MB limit
    let cv = thumb.canvas, q = 0.92;
    for (let i = 0; i < 12; i++) {
      blob = await toBlob(cv, 'image/jpeg', q);
      if (!blob || blob.size <= YT_THUMB_LIMIT) break;
      if (q > 0.45) q -= 0.08;
      else { const s = document.createElement('canvas'); s.width = Math.round(cv.width * 0.85); s.height = Math.round(cv.height * 0.85); s.getContext('2d').drawImage(cv, 0, 0, s.width, s.height); cv = s; }
    }
    if (blob && (cv.width !== F.width)) note = ` Reduced to ${cv.width}×${cv.height} to stay under 2 MB.`;
  }
  if (!blob) return toast('Could not create thumbnail.');
  download(blob, `${exportBaseName(app.project)}-thumbnail-${F.short}-${F.width}x${F.height}.${P.type === 'png' ? 'png' : 'jpg'}`);
  toast(`${F.label} thumbnail saved (${fmtBytes(blob.size)}, ${F.width}×${F.height}).${note}`);
};
app.thumbRefresh = thumbRefresh;

// ---------------------------------------------------------------- export
let exporting = false, abort = null, lastExport = null;
/** Export file name (without extension) from the project name; safe on every OS. */
function exportBaseName(p) { return safeName(p.name, 'video'); }
async function refreshCaps() {
  const c = await capabilities(app.project);
  app.caps = c;
  const fmtPref = app.project.settings.format;
  const plan = planFormat(c, fmtPref);
  app.exportPlan = plan;
  let note;
  if (plan.engine === 'fast' && plan.ext === 'mp4') note = `Fast export: MP4 (H.264 + ${c.aac ? 'AAC' : 'Opus'} audio), faster than real time.`;
  else if (plan.engine === 'fast') note = 'Fast export: WebM (VP9 + Opus), faster than real time.' + (fmtPref === 'auto' ? ' This browser can’t encode MP4 quickly, so Auto makes WebM.' : '');
  else if (plan.engine === 'realtime') note = `This browser records in real time: ${plan.ext.toUpperCase()}. Keep this tab open during export.`;
  else note = plan.reason || 'This browser cannot export video. Use Chrome, Edge or Safari 17+.';
  $('capsNote').textContent = note;
}
$('exportBtn').onclick = async () => {
  if (exporting) return;
  const p = app.project;
  if (!p.clips.length) return;
  const missing = [...p.clips, ...(p.overlays || [])].filter(c => !media.has(c.mediaId));
  if (missing.length) return toast('Relink missing media before exporting (red clips).');
  if (voice.busy) return toast('Finish the voiceover recording first.');
  const fmtWanted = ['mp4', 'webm'].includes(p.settings.format) ? p.settings.format : 'auto';
  // expected container (Auto = MP4 when this browser can encode it, otherwise WebM); the engine has the final say
  const plan = app.caps ? planFormat(app.caps, fmtWanted) : { ext: fmtWanted === 'webm' ? 'webm' : 'mp4', engine: 'fast' };
  if (!plan.engine && plan.reason) return toast(plan.reason, 5000);
  const baseName = exportBaseName(p);
  // "Save straight to a file": the picker must open before any other await (it needs the click's user activation)
  let handle = null;
  if ($('saveToDisk').checked && window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: baseName + '.' + plan.ext, types: [plan.ext === 'webm' ? { description: 'WebM video', accept: { 'video/webm': ['.webm'] } } : { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch (e) { if (e.name === 'AbortError') return; console.warn('Save picker unavailable', e); handle = null; }
  }
  let handleUnused = false; // the engine produced another container than the picked file's extension
  const lay = layout(p), estBytes = bitrateFor(...Object.values(outputDims(p)), p.settings.fps, p.settings.quality) * lay.total / 8;
  const streams = !!handle || canStreamToOPFS();
  const lowMem = (navigator.deviceMemory || 8) <= 4;
  if (!streams && (lay.total > 20 * 60 || estBytes > 1.5e9 || (lowMem && (lay.total > 8 * 60 || estBytes > 4e8)))) {
    toast(`Heads-up: this browser builds the ${fmtBytes(estBytes)} file in memory. On a phone a ${fmt(lay.total)} export may run out of memory — try 720p, split it into parts, or use Chrome.`, 8000);
  }
  player.pause();
  exporting = true; updateSummary();
  abort = new AbortController();
  $('progress').classList.add('show'); $('exportResult').hidden = true;
  $('progressBar').style.width = '0%'; $('progressPercent').textContent = '0%'; $('progressStatus').textContent = 'Preparing…'; $('progressEta').textContent = 'ETA —';
  const t0 = performance.now();
  try { await navigator.wakeLock?.request('screen').then(l => (app._wake = l)); } catch { }
  try {
    if (lastExport) { URL.revokeObjectURL(lastExport.url); lastExport = null; app.lastExport = null; }
    const res = await runExport(JSON.parse(JSON.stringify(p)), media, {
      format: fmtWanted,
      signal: abort.signal,
      // disk-backed output (picked file or private temp file) when possible; called once the container is known
      makeSink: (ext) => {
        const pickedExt = handle && (handle.name.match(/\.([^.]+)$/) || [])[1];
        if (handle && pickedExt && pickedExt.toLowerCase() !== ext) { handleUnused = true; return createSink({ ext }); }
        return createSink({ handle, ext });
      },
      onWarn: (msg) => toast(msg, 6000),
      onFallback: (why) => toast('Using real-time recording (' + why + ')', 4000),
      onProgress: ({ frac, stage, eta, speed }) => {
        $('progressBar').style.width = (frac * 100).toFixed(1) + '%';
        $('progressPercent').textContent = Math.floor(frac * 100) + '%';
        $('progressStatus').textContent = stage;
        $('progressEta').textContent = (eta != null ? 'ETA ' + fmtDuration(eta) : 'ETA —') + (speed ? ` · ${speed.toFixed(1)}× real time` : '');
      },
    });
    const name = handle && res.streamed === 'file' ? handle.name : baseName + '.' + res.ext;
    if (res.streamed !== 'file') download(res.blob, name); // a picked file is already saved on disk
    if (handleUnused) {
      // the picked .mp4/.webm name would lie about the content: download under the right name, drop the empty picked file
      try { await handle.remove?.(); } catch { }
      toast(`This browser made a ${res.ext.toUpperCase()} file, so it was downloaded as “${name}” instead of the file you picked.`, 7000);
    }
    lastExport = { ...res, name, url: URL.createObjectURL(res.blob) };
    app.lastExport = lastExport;
    const took = (performance.now() - t0) / 1000;
    $('progressBar').style.width = '100%'; $('progressPercent').textContent = '100%';
    $('progressStatus').textContent = 'Done'; $('progressEta').textContent = 'Took ' + fmtDuration(took);
    const where = res.streamed === 'file' ? ' · saved directly to your disk' : res.streamed === 'opfs' ? ' · streamed to disk while rendering' : '';
    // built from text nodes: a picked file name can contain < > & quotes
    $('exportResultText').replaceChildren(el('b', { text: name }), ` · ${res.width}×${res.height} · ${res.fps} fps · ${fmt(res.duration)} · ${fmtBytes(res.blob.size)}`, el('br'),
      el('span', { class: 'hint', text: `${res.method}${where} · rendered in ${fmtDuration(took)}. Ready to upload.` }));
    $('downloadAgain').href = lastExport.url; $('downloadAgain').download = name;
    const file = new File([res.blob], name, { type: res.mime });
    $('shareExport').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('shareExport').onclick = () => navigator.share({ files: [file], title: p.name }).catch(() => { });
    $('exportResult').hidden = false;
    $('outputNote').textContent = 'Export complete.'; $('outputNote').classList.add('status-good');
    if (!handleUnused) toast((res.streamed === 'file' ? 'Video saved: ' : 'Video exported: ') + name);
  } catch (e) {
    if (e instanceof ExportCancelled || e.name === 'ExportCancelled') { $('progressStatus').textContent = 'Export cancelled.'; toast('Export cancelled'); }
    else { console.error(e); $('progressStatus').textContent = 'Export failed: ' + (e.message || e); toast('The export could not finish: ' + (e.message || e), 5000); }
  } finally {
    exporting = false; abort = null; updateSummary();
    try { app._wake && app._wake.release(); } catch { }
  }
};
$('cancelExport').onclick = () => { if (abort) abort.abort(); };

// ---------------------------------------------------------------- install (PWA): see js/install.js
initInstall({ $, toast, isIOS });

// service worker
// The worker serves the page and its scripts from one versioned cache, so they always match. As a safety net, if the page
// and the scripts still disagree (e.g. an old copy of the page came from the browser's HTTP cache), reset the offline copy
// once and reload rather than run half-wired. Projects live in IndexedDB and are untouched.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      app.swReg = reg;
      const hadController = !!navigator.serviceWorker.controller;
      const showUpdate = () => { $('updateBar').hidden = false; };
      $('reloadBtn').addEventListener('click', () => {
        app._updateRequested = true; saveNow();
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); else location.reload();
      });
      if (reg.waiting && hadController) showUpdate();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        if (app._updateRequested) { reloading = true; location.reload(); } else if (hadController) showUpdate(); // new version took over: offer a reload (this tab keeps running its own loaded code)
      });
    } catch (e) { console.warn('Service worker registration failed', e); }
  });
}
// ---------------------------------------------------------------- templates
function renderTemplates() {
  const g = $('templateGrid'); g.replaceChildren();
  const hasClips = app.project.clips.length > 0;
  for (const t of TEMPLATES) {
    const card = el('div', { class: 'tpl-card', 'data-tpl': t.id },
      el('div', { class: 'tpl-icon', text: t.icon }),
      el('div', { class: 'tpl-body' },
        el('h3', { text: t.name }),
        el('p', { class: 'hint', text: t.desc + (t.ratio ? ' · ' + (t.ratio === '9:16' ? 'Vertical 9:16' : '16:9') : '') }),
        el('div', { class: 'button-row' },
          t.insertOnly ? null : el('button', { class: 'btn primary small', type: 'button', text: 'New project', 'data-mode': 'new', onclick: () => applyTemplate(t, 'new') }),
          el('button', { class: 'btn ' + (t.insertOnly ? 'primary' : 'secondary') + ' small', type: 'button', text: t.insertOnly ? 'Add at playhead' : 'Insert at playhead', 'data-mode': 'insert', disabled: t.insertOnly && !hasClips ? true : null, onclick: () => applyTemplate(t, 'insert') }))));
    g.append(card);
  }
}
async function applyTemplate(t, mode) {
  const spec = t.build();
  closeDialog('templatesDialog');
  player.pause();
  if (mode === 'new') {
    await saveNow();
    await createProject(t.name);
    Object.assign(app.project.settings, { ratio: t.ratio || '16:9' }, spec.settings || {});
    if (app.project.settings.ratio === '9:16' && app.project.settings.bg === 'black') app.project.settings.bg = 'blur';
    player.setTime(0);
  }
  const p = app.project;
  await ensureFonts();
  const lay0 = layout(p);
  // insertion point: clip boundary nearest the playhead
  let idx = p.clips.length, at = lay0.total;
  if (mode === 'insert') {
    const t0 = player.t;
    for (const it of lay0.items) { if (t0 < (it.start + it.end) / 2) { idx = it.index; at = it.start; break; } }
    if (!spec.sections.length) at = t0;
  } else { idx = 0; at = 0; }
  setSaveState('Building template…');
  let dims = outputDims(p);
  if (p.settings.ratio === 'original') dims = { width: 1920, height: 1080 };
  const sc = Math.min(1, 1920 / Math.max(dims.width, dims.height));
  const W = Math.round(dims.width * sc), H = Math.round(dims.height * sc);
  const newClips = [];
  for (const sec of spec.sections) {
    const blob = await paintBackground(W, H, sec.bg);
    const m = await media.importFile(new File([blob], `${t.name} – ${sec.name}.jpg`, { type: 'image/jpeg' }), 'image');
    const c = newClipFromMedia(m, p.settings);
    c.name = sec.name; c.out = c.in + sec.dur; c.fit = 'cover';
    if (sec.zoom) c.keyframes = { scale: [{ t: 0, v: sec.zoom[0], ease: 'easeInOut' }, { t: sec.dur, v: sec.zoom[1], ease: 'easeInOut' }] };
    newClips.push(c);
  }
  const added = newClips.reduce((a, c) => a + clipLen(c), 0);
  if (newClips.length) {
    if (mode === 'insert' && app.rippleEnabled && idx < p.clips.length) rippleShift(p, at - 1e-3, added);
    p.clips.splice(idx, 0, ...newClips.map(c => normalizeClip(c)));
  }
  for (const tx of spec.texts) { tx.start += at; tx.end += at; p.texts.push(tx); }
  for (const mk of spec.markers || []) p.markers.push({ id: uid('mk'), time: at + mk.t, name: mk.name });
  app.selection = spec.texts.length ? { type: 'text', id: spec.texts[0].id } : null;
  app.commit('Template: ' + t.name);
  timeline.autoFit = true; timeline.fit();
  player.setTime(at + 0.001);
  if (spec.texts.length) showTab('text');
  toast(`“${t.name}” added — tap any text to edit it${newClips.length ? ', or replace the backgrounds with your own clips' : ''}.`, 4500);
}
app.applyTemplate = (id, mode) => applyTemplate(TEMPLATES.find(t => t.id === id), mode);
const openTemplates = () => { renderTemplates(); openDialog('templatesDialog'); };
$('templatesBtn').onclick = openTemplates;
$('dropTemplates').onclick = openTemplates;
$('onboardTemplates').onclick = () => { dismissOnboarding(); openTemplates(); };
function dismissOnboarding() { $('onboard').hidden = true; db.kvSet('onboarded', true).catch(() => { }); }
$('onboardClose').onclick = dismissOnboarding;

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
  const onboarded = await db.kvGet('onboarded').catch(() => true);
  if (!onboarded) { if (app.project.clips.length) db.kvSet('onboarded', true).catch(() => { }); else $('onboard').hidden = false; }
  // files shared to the installed app (Android share sheet → share_target)
  if (new URLSearchParams(location.search).get('shared') === 'error') {
    toast('The shared files could not be received. Open them with “Add clips” instead.', 6000);
    history.replaceState(null, '', location.pathname);
  } else if (new URLSearchParams(location.search).has('shared')) {
    const inbox = await db.inboxAll().catch(() => []);
    if (inbox.length) { await importFiles(inbox.map(x => new File([x.blob], x.name, { type: x.type }))); await db.inboxClear(); }
    history.replaceState(null, '', location.pathname);
  }
  db.gc(app.history.mediaIds()).catch(() => { });
  cleanupExports().catch(() => { }); // temporary export files from earlier sessions
  $('saveToDiskRow').hidden = !window.showSaveFilePicker;
  app.ready = true;
  document.documentElement.dataset.ready = '1';
}
boot().catch(e => { console.error(e); toast('Startup problem: ' + e.message); });
