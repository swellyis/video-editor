// Video Editor Pro — main controller
import { initInstall } from './install.js';
import { initAddMedia } from './add-media-ui.js';
import { shareOrDownload } from './media-link.js';
import { BUILD } from './build.js';
import { $, qs, qsa, clamp, fmt, fmtPrecise, fmtDuration, fmtBytes, toast, download, debounce, el, icon, safeName, isIOS, deepClone, dataURLToBlob, uid, tarBlob, readTar, isTar, perf, startLongTaskMonitor } from './util.js';
import { db, mediaIdsOf, setKeepProvider } from './db.js';
import { media, kindOf, isHeic, isMediaDataURL, seekVideo } from './media.js';
import {
  newProject, migrate, layout, clipAt, clipLen, sourceTime, audioLen, newClipFromMedia, newText, newAudio, removeClip, duplicateClip,
  moveClip, rippleShift, ensureLanes, holdNextClip, stepVolume, History, FONTS, outputDims, defaultColor, defaultTransform, MIN_CLIP,
  newOverlay, overlayLen, animated, hasKeyframes, setKeyframe, kfTimes, removeKeyframesAt, setEaseAt, normalizeClip,
  splitItem, audioSpan, defaultProjectName, cleanProjectName, fixedProjectName, rebaseKeyframes, ANIM_PROPS, detachAudio, hasSound, volumeEnv, VOL_KEY_MAX, audioSpeed, overlaysAt, overlaySourceTime, thumbFormat, newBlur, animPropsOf, cleanBlur, cleanClipBlur, textLabel, blurLabel,
} from './model.js';
import { Compositor, ensureFonts } from './render.js';
import { TEMPLATES, paintBackground } from './templates.js';
import { Player } from './player.js';
import { initCleanUI } from './clean-ui.js';
import { initVoiceUI } from './voice-ui.js';
import { initSilenceUI } from './silence-ui.js';
import { initTranscriptUI } from './transcript-ui.js';
import { normalizeDuck } from './duck.js';
import { initSyncUI } from './sync-ui.js';
import { initBeatUI } from './beat-ui.js';
import { initTransitionUI } from './transition-ui.js';
import { initTextAnimUI } from './textanim-ui.js';
import { initEffectsUI } from './effects-ui.js';
import { initFiltersUI } from './filters-ui.js';
import { initDesigner } from './designer-ui.js';
import { initShorts } from './shorts-ui.js';
import { initMatch } from './match-ui.js';
import { FILTERS, GROUPS as FILTER_GROUPS } from './filters.js';
import { Timeline } from './timeline.js';
import * as G from './group.js';
import { insertFreeze, freezeTarget, freezeLen, FREEZE_DEFAULT } from './freeze.js';
import { autoReframeClip, ReframeCancelled } from './reframe-run.js';
import { loadSegmenter } from './segment.js';
import { reconcileWords, retimeWords, newCaption, formatSrt, parseSrt, rechunk, applyPreset, FONT_KEYS, MAX_CAPTIONS } from './captions.js';
import * as trans from './transcribe.js';
import { initLayout } from './layout-ui.js';
import { initSpeedUI } from './speed-ui.js';
import { meanSpeed, startShift } from './ramp.js';
import { exportTimelineAudio, ExtractCancelled } from './extract.js';
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
    if (window.caches) for (const k of await caches.keys()) if (k.startsWith('video-editor-shell-')) await caches.delete(k); // (never the downloaded speech and Clean voice models)
    await Promise.race([fetch(location.pathname, { cache: 'reload' }), new Promise(r => setTimeout(r, 6000))]); // refresh the HTTP-cached page
  } catch { /* best effort */ }
  location.reload();
  return true;
}
if (await healBuildMismatch()) await new Promise(() => { }); // the page is reloading: don't start this mismatched copy


let _sel = null;
const app = {
  project: newProject(),
  multi: [],           // several selected items [{type,id}] (then `selection` is null); see setMulti()
  selectMode: false,   // touch / mouse: tapping items adds them to the selection
  clipboard: null,
  snapEnabled: true,
  rippleEnabled: true,
  media,
  history: new History(),
};
// `selection` = the one selected item. A multi-selection keeps `selection` null and lists the items in `multi`; any plain assignment of
// `selection` (every single-item code path does that) therefore also ends a multi-selection.
Object.defineProperty(app, 'selection', { get() { return _sel; }, set(v) { _sel = v; if (!app._holdMulti) app.multi = []; }, enumerable: true, configurable: true });

// Debug/test handle: only on local development hosts or with ?debug in the URL (not exposed on the public site).
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || new URLSearchParams(location.search).has('debug')) window.__app = app;
startLongTaskMonitor(); app.perf = perf; // main-thread health (long tasks), used by the polite background jobs and by tests
let trUI = { render() { }, open() { }, close() { } };
let taUI = { render() { }, kind: () => 'in' };
let fxUI = { render() { } };
let speedUI = { render() { } };
let flUI = { render() { } };
let cleanUI = null, voiceUI = null, silenceUI = null, txUI = null, syncUI = null, beatUI = null; // Clean voice / Change voice / Remove silences controls (set up below)
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
cleanUI = initCleanUI({ $, qs, app, media, player, selected, toast, fmtBytes, commit: (l) => app.commit(l), afterClean: (t, id) => voiceUI && voiceUI.autoRun(t, id) });
voiceUI = initVoiceUI({ $, app, media, player, toast, commit: (l) => app.commit(l), current: cleanUI.current, findItem: cleanUI.findItem });
silenceUI = initSilenceUI({ $, app, media, player, toast, commit: (l) => app.commit(l), current: cleanUI.current, redraw: () => timeline.render(), timeline });
txUI = initTranscriptUI({ $, app, player, toast, showTab });

// Duck controls (same Audio panel — upgrades the old "Duck to" slider in place)
(() => {
  const live = (fn) => (e) => { const a = selected('audio'); if (!a) return; normalizeDuck(a); fn(a, e); app.liveUpdate(); syncDuckControls(); };
  const commit = (label) => () => { const a = selected('audio'); if (!a) return; app.commit(label); };
  $('duckDb')?.addEventListener('input', live((a, e) => { a.duckDb = +e.target.value; a.duckLevel = Math.pow(10, -a.duckDb / 20); }));
  $('duckDb')?.addEventListener('change', commit('Duck amount'));
  $('duckAttack')?.addEventListener('input', live((a, e) => { a.duckAttack = +e.target.value; }));
  $('duckAttack')?.addEventListener('change', commit('Duck attack'));
  $('duckRelease')?.addEventListener('input', live((a, e) => { a.duckRelease = +e.target.value; }));
  $('duckRelease')?.addEventListener('change', commit('Duck release'));
  $('duckTrigger')?.addEventListener('change', (e) => { const a = selected('audio'); if (!a) return; a.duckTrigger = e.target.value; app.commit('Duck trigger'); syncDuckControls(); });
  // when the duck checkbox flips, show/hide the extra controls
  document.addEventListener('change', (e) => { if (e.target && e.target.matches && e.target.matches('[data-bind="audio.duck"]')) syncDuckControls(); });
})();

syncUI = initSyncUI({ $, app, media, toast, commit: (l) => app.commit(l), current: cleanUI.current });
speedUI = initSpeedUI({ $, app, player, toast, selected: (t) => selected(t), sourceTime });
beatUI = initBeatUI({ $, app, media, toast, commit: (l) => app.commit(l), current: cleanUI.current });
trUI = initTransitionUI({ $, app, commit: (l) => app.commit(l), showTab });
fxUI = initEffectsUI({ $, app, commit: (l) => app.commit(l) });
flUI = initFiltersUI({ $, app, commit: (l) => app.commit(l) });
app.openTransition = (id, opts) => trUI.open(id, opts);
taUI = initTextAnimUI({ $, app, commit: (l) => app.commit(l), selected, showTab, player, toast });
app.textAnim = taUI;

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

app.commit = (label, mergeKey) => {
  ensureLanes(app.project); // new / moved items get a lane; overlaps inside one lane become a new lane
  if (app.history.commit(app.project, mergeKey)) scheduleSave();
  renderAll();
};
app.liveUpdate = (opts = {}) => {
  player.invalidate();
  timeline.render();
  if (opts.previewAt != null) player.setTime(opts.previewAt);
  fillInspector();
  updateSummary();
};
app.restore = (snap) => { app.project = migrate(snap); renderAll(); };
app.seek = (t) => { player.setTime(t); };
app.select = (sel, opts = {}) => {
  const prevSel = app.selection; // browsing effects from clip to clip keeps the Effects tab open; coming from a blur region or text opens the clip's own tab
  app.selection = sel;
  if (sel) {
    const tab = { clip: 'clip', text: 'text', audio: 'audio', overlay: 'pip', blur: 'look', caption: 'captions' }[sel.type];
    if (sel.type === 'clip') app.trTarget = null; // the Transitions tab follows the selected clip again
    if (tab && !((sel.type === 'clip' && qs('.tabs button.active')?.dataset.tab === 'trans') || ((sel.type === 'clip' || sel.type === 'overlay') && qs('.tabs button.active')?.dataset.tab === 'look' && (!prevSel || prevSel.type === 'clip' || prevSel.type === 'overlay')))) showTab(tab, 'select'); // selecting a clip while browsing transitions stays on that tab
    if (opts.seekInto) {
      const t = player.t;
      if (sel.type === 'clip') { const it = layout(app.project).items.find(i => i.clip.id === sel.id); if (it && (t < it.start || t >= it.end)) player.setTime(it.start + 0.001); }
      if (sel.type === 'text') { const x = app.project.texts.find(i => i.id === sel.id); if (x && (t < x.start || t >= x.end)) player.setTime(x.start + 0.01); }
      if (sel.type === 'blur') { const x = (app.project.blurs || []).find(i => i.id === sel.id); if (x && (t < x.start || t >= x.end)) player.setTime(x.start + 0.01); }
      if (sel.type === 'caption') { const x = (app.project.captions || []).find(i => i.id === sel.id); if (x && (t < x.start || t >= x.end)) player.setTime(x.start + 0.01); if (x) timeline.reveal(x.start); }
      if (sel.type === 'marker') { const m = app.project.markers.find(i => i.id === sel.id); if (m) player.setTime(m.time); }
      if (sel.type === 'overlay') { const o = app.project.overlays.find(i => i.id === sel.id); if (o && (t < o.start || t >= o.start + overlayLen(o))) player.setTime(o.start + 0.01); }
    }
  }
  timeline.render(); fillInspector(); renderLists();
  if (wsLayout) { wsLayout.syncProps(); wsLayout.refreshBin(); }
};
/** Select several items (one or none falls back to the normal single selection). */
app.setMulti = (list, opts = {}) => {
  list = G.clean(app.project, list);
  if (list.length <= 1) { app.select(list[0] || null, opts); return; }
  app._holdMulti = true; app.selection = null; app._holdMulti = false;
  app.multi = list;
  timeline.render(); fillInspector(); renderLists();
  if (wsLayout) { wsLayout.syncProps(); wsLayout.refreshBin(); }
};
/** Shift / Ctrl-click: add the item to (or take it out of) the selection. */
app.toggleSelect = (sel) => {
  if (!sel || sel.type === 'marker') return;
  app.setMulti(G.toggle(app.selList(), sel));
};
app.isSel = (type, id) => (app.multi.length ? app.multi.some(s => s.type === type && s.id === id) : !!_sel && _sel.type === type && _sel.id === id);
/** The selected items: the multi-selection, else the single selected item (not markers). */
app.selList = () => (app.multi.length ? G.clean(app.project, app.multi) : (_sel && _sel.type !== 'marker' && selected() ? [{ type: _sel.type, id: _sel.id }] : []));
app.selectAll = () => { const l = G.everything(app.project); if (!l.length) return toast('Nothing on the timeline to select yet.'); app.setMulti(l); toast(l.length + ' item' + (l.length === 1 ? '' : 's') + ' selected. Esc clears the selection.', 2200); };
app.onZoom = (pps) => { $('zoomRange').value = String(ppsToRange(pps)); };

function selected(type) {
  const s = app.selection; if (!s || (type && s.type !== type)) return null;
  const p = app.project;
  if (s.type === 'clip') return p.clips.find(c => c.id === s.id) || null;
  if (s.type === 'text') return p.texts.find(c => c.id === s.id) || null;
  if (s.type === 'audio') return p.audio.find(c => c.id === s.id) || null;
  if (s.type === 'marker') return p.markers.find(c => c.id === s.id) || null;
  if (s.type === 'overlay') return (p.overlays || []).find(c => c.id === s.id) || null;
  if (s.type === 'blur') return (p.blurs || []).find(c => c.id === s.id) || null;
  if (s.type === 'caption') return (p.captions || []).find(c => c.id === s.id) || null;
  return null;
}
/** Selected animatable item with its timeline start/length and the playhead's local time. */
function kfTarget(type) {
  const s = app.selection; if (!s || !['clip', 'text', 'overlay', 'blur', 'audio'].includes(s.type) || (type && s.type !== type)) return null;
  const item = selected(s.type); if (!item) return null;
  let start, len;
  if (s.type === 'clip') { const it = layout(app.project).items.find(i => i.clip.id === item.id); if (!it) return null; start = it.start; len = it.len; }
  else if (s.type === 'text' || s.type === 'blur') { start = item.start; len = item.end - item.start; }
  else if (s.type === 'audio') { start = item.start; len = audioSpan(item, layout(app.project).total); }
  else { start = item.start; len = overlayLen(item); }
  const raw = player.t - start;
  return { type: s.type, item, start, len, raw, local: clamp(raw, 0, len), inside: raw >= -1e-4 && raw <= len + 1e-4 };
}
const KF_PATHS = {
  'clip.transform.x': 'x', 'clip.transform.y': 'y', 'clip.transform.zoom': 'scale', 'clip.transform.angle': 'rotation', 'clip.opacity': 'opacity',
  'text.x': 'x', 'text.y': 'y', 'text.scale': 'scale', 'text.rotation': 'rotation', 'text.opacity': 'opacity',
  'ovl.x': 'x', 'ovl.y': 'y', 'ovl.scale': 'scale', 'ovl.rotation': 'rotation', 'ovl.opacity': 'opacity',
  'blur.x': 'x', 'blur.y': 'y', 'blur.w': 'w', 'blur.h': 'h',
};
const typeOfRoot = (path) => ({ clip: 'clip', text: 'text', ovl: 'overlay', blur: 'blur' })[path.split('.')[0]];

// ---------------------------------------------------------------- rendering
function renderAll() {
  if (app.selection && !selected()) app.selection = null;
  if (app.multi.length) { const l = G.clean(app.project, app.multi); if (l.length > 1) app.multi = l; else { app.multi = []; _sel = l[0] || null; } }
  player.invalidate();
  sizeStage();
  timeline.render();
  fillInspector();
  renderLists();
  if (wsLayout) { wsLayout.syncProps(); wsLayout.refreshBin(); }
  updateSummary();
  $('undoBtn').disabled = !app.history.canUndo;
  $('redoBtn').disabled = !app.history.canRedo;
  $('projectName').textContent = app.project.name;
  $('projectNameBtn').title = app.project.name + ' (tap to rename)';
  document.title = app.project.name + ' · Video Editor';
}
function sizeStage() {
  const has = app.project.clips.length > 0;
  $('dropzone').hidden = has; $('stageWrap').hidden = !has;
  if (!has) { $('blurLayer').hidden = true; return; }
  const { width: W, height: H } = outputDims(app.project);
  const shell = $('dropTarget');
  const cs = getComputedStyle(shell);
  const availW = shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // workspace layout: the preview fills whatever room its panel has; otherwise it is capped to a share of the window height
  const maxH = document.body.classList.contains('ws') ? Math.max(120, shell.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) : Math.min(window.innerHeight * (window.innerWidth <= 620 ? 0.42 : window.innerWidth <= 940 ? 0.5 : 0.44), 820);
  let cw = availW, ch = cw * H / W;
  if (ch > maxH) { ch = maxH; cw = ch * W / H; }
  stage.style.width = Math.floor(cw) + 'px'; stage.style.height = Math.floor(ch) + 'px';
  syncBlurBox();
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
  const xb = $('exportAudioBtn'); if (xb) xb.disabled = !n || exporting || !!extractJob;
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
  if (app.selection && (app.selection.type === 'blur' || app.selection.type === 'clip')) syncBlurBox();
  if (!player.playing && app.selection) refreshAnimated();
  if (voice && voice.state === 'rec') voice.tick();
  if (txUI) txUI.onTime(t);
}

// ---------------------------------------------------------------- data binding
function resolve(path) {
  const [root, ...rest] = path.split('.');
  let obj = root === 'proj' ? app.project : root === 'clip' ? selected('clip') : root === 'text' ? selected('text') : root === 'audio' ? selected('audio') : root === 'ovl' ? selected('overlay') : root === 'blur' ? selected('blur') : root === 'cap' ? selected('caption') : null;
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
  if (path === 'cap.text') reconcileWords(obj);
  if (path === 'cap.start' || path === 'cap.end') {
    const o0 = path === 'cap.start' ? old : obj.start, o1 = path === 'cap.end' ? old : obj.end;
    obj.start = Math.max(0, obj.start); if (obj.end < obj.start + 0.1) { if (path === 'cap.start') obj.start = obj.end - 0.1; else obj.end = obj.start + 0.1; }
    if (obj.start < 0) { obj.end -= obj.start; obj.start = 0; }
    retimeWords(obj, o0, o1);
  }
  if (path === 'proj.captionStyle.maxWords') { obj.maxWords = Math.round(clamp(obj.maxWords, 1, 20)); resplitCaptions(); }
  if (path === 'audio.in' || path === 'audio.out') {
    obj.in = clamp(obj.in, 0, (obj.srcDuration || 1e9) - 0.2); obj.out = clamp(obj.out, obj.in + 0.2, obj.srcDuration || 1e9);
    if (path === 'audio.in' && hasKeyframes(obj)) obj.keyframes = rebaseKeyframes(obj.keyframes, (obj.in - old) / audioSpeed(obj)); // the volume envelope stays on the same sound
  }
  if (path === 'audio.start') obj.start = Math.max(0, obj.start);
  if (path.startsWith('clip.fade')) obj[path.split('.')[1]] = clamp(obj[path.split('.')[1]], 0, 10);
  if (path === 'proj.settings.ratio' && obj.ratio === '9:16' && p.settings.bg === 'black') {
    p.settings.bg = 'blur'; toast('Shorts: background set to a blurred copy of your clip (Look tab to change).', 3500);
  }
  if (path === 'ovl.in' || path === 'ovl.out') { const mx = obj.kind === 'image' ? 3600 : (obj.srcDuration || 1e9); obj.in = clamp(obj.in, 0, mx - MIN_CLIP); obj.out = clamp(obj.out, obj.in + MIN_CLIP, mx); if (path === 'ovl.in' && obj.kind !== 'image' && hasKeyframes(obj)) obj.keyframes = rebaseKeyframes(obj.keyframes, (obj.in - old) / (obj.speed || 1)); }
  if (path === 'ovl.start') obj.start = Math.max(0, obj.start);
  if (path.startsWith('blur.') || path.startsWith('clip.blur.')) { if (path === 'blur.start' || path === 'blur.end') { obj.start = Math.max(0, obj.start); if (obj.end < obj.start + 0.1) obj.end = obj.start + 0.1; } if (path.startsWith('blur.')) cleanBlur(obj); else cleanClipBlur(obj); }
  if (path === 'ovl.speed') obj.speed = clamp(Number(obj.speed) || 1, 0.25, 4);
  if (path === 'text.anim.in' || path === 'text.anim.out') { const t = selected('text'); const d = t.end - t.start; if (t.anim.inDur + t.anim.outDur > d) { t.anim.inDur = Math.min(t.anim.inDur, d * 0.6); t.anim.outDur = Math.min(t.anim.outDur, d * 0.35); } }
  if (path === 'proj.settings.ratio' || path === 'proj.settings.res') sizeStage();
  if (path.startsWith('proj.settings.') && ['res', 'fps', 'quality', 'format'].includes(path.split('.')[2])) refreshCaps();
  if (path.includes('bgremove')) {
    const which = path.startsWith('ovl') ? 'ovl' : 'clip';
    syncBgRemoveUI(which === 'ovl' ? selected('overlay') : selected('clip'), which);
    if (player && player.requestRender) player.requestRender();
  }
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
  player.invalidate(); timeline.render(); fillOutputs(); updateSummary(); renderLists(true);
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
  if (tg) { setVal(tg.dataset.toggle, !getVal(tg.dataset.toggle)); app.commit(tg.classList.contains('mute-btn') ? (getVal(tg.dataset.toggle) ? 'Mute' : 'Unmute') : 'Toggle'); return; }
  const act = e.target.closest('[data-action]');
  if (act && !act.disabled) {
    const fn = actions[act.dataset.action]; if (!fn) return;
    // an action that throws (or a promise that rejects) must never fail silently: the user sees why and the button works again
    const fail = (err) => { console.warn(err); toast('Something went wrong: ' + ((err && err.message) || err) + '. Please try again.', 5000); };
    try { const r = fn(act, e); if (r && typeof r.catch === 'function') r.catch(fail); } catch (err) { fail(err); }
  }
});
function fillOutputs() {
  for (const o of qsa('output[data-out]')) {
    const v = getVal(o.dataset.out);
    o.textContent = v == null ? '' : (FMT[o.dataset.fmt] || FMT.int)(v);
  }
}
// What to tell the user when a toolbar action can't apply to the current selection.
const TOOL_HINT = {
  duplicate: { none: 'Nothing selected. Tap a clip, text, overlay, music track or marker on the timeline first, then tap Duplicate.' },
  delete: { none: 'Nothing selected. Tap a clip, overlay, text, audio track, caption, blur region or marker on the timeline first, then tap Delete in the timeline toolbar (or press Del).' },
  addKeyframe: {
    caption: 'A caption can’t be keyframed. Select a clip, text, overlay, music or voice track on the timeline, then use ◆ Add in its Keyframes section (or press Shift+K).',
    none: 'Nothing selected. Tap a clip, text, overlay, music or voice track on the timeline first, then use ◆ Add in its Keyframes section (or press Shift+K).',
    marker: 'A marker can\'t be keyframed. Select a clip, text, overlay, music or voice track on the timeline, then use ◆ Add in its Keyframes section (or press Shift+K).',
  },
};
/** The "N items selected" panel (one place for the group-only controls: copy, cut, paste look, mute, deselect). */
function fillMulti(on) {
  document.body.classList.toggle('has-multi', on);
  const pn = $('multiPanel'); if (!pn) return;
  pn.hidden = !on;
  if (!on) return;
  const l = app.multi;
  $('multiTitle').textContent = l.length + ' items selected';
  $('multiSum').textContent = groupSummary(l);
  const snd = G.resolve(app.project, l).filter(x => G.hasSoundItem(x.type, x.item)), allMuted = snd.length && snd.every(x => x.item.muted);
  const mb = $('multiMute'); mb.textContent = allMuted ? 'Unmute sound' : 'Mute sound'; mb.setAttribute('aria-disabled', snd.length ? 'false' : 'true'); mb.classList.toggle('is-off', !snd.length);
  mb.title = snd.length ? (allMuted ? 'Unmute the ' + plural(snd.length, 'selected item') + ' with sound' : 'Mute the ' + plural(snd.length, 'selected item') + ' with sound') : 'None of the selected items has sound';
  const pl = $('multiPasteLook'); pl.setAttribute('aria-disabled', app.clipboard ? 'false' : 'true'); pl.classList.toggle('is-off', !app.clipboard);
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
  for (const t of qsa('.tog-btn[data-toggle]')) t.setAttribute('aria-pressed', getVal(t.dataset.toggle) ? 'true' : 'false');
  for (const t of qsa('.mute-btn[data-toggle]')) {
    const m = !!getVal(t.dataset.toggle);
    t.setAttribute('aria-pressed', m ? 'true' : 'false');
    t.querySelector('.mb-state').textContent = m ? 'Muted' : 'Sound on';
  }
  fillOutputs();
  trUI.render();
  fxUI.render();
  flUI.render();
  // clip panel
  const c = selected('clip');
  $('clipPanel').hidden = !c; $('clipEmptyHint').hidden = !!c;
  if (c) {
    const lay = layout(p), it = lay.items.find(i => i.clip.id === c.id) || { index: p.clips.indexOf(c), len: clipLen(c) };
    $('clipTitle').textContent = (c.kind === 'image' ? 'Image ' : 'Clip ') + (it.index + 1) + ' of ' + lay.items.length;
    $('clipLenLabel').textContent = fmt(it.len) + ' on timeline';
    const isImg = c.kind === 'image';
    $('trimBlock').hidden = isImg; $('imageDurBlock').hidden = !isImg; $('speedSection').hidden = isImg; if ($('freezeBlock')) $('freezeBlock').hidden = isImg;
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
  const bl = selected('blur');
  stage.classList.toggle('text-edit', !!t || !!o);
  fillCaptionsPanel();
  $('blurPanel').hidden = !bl; $('blurEmptyHint').hidden = (p.blurs || []).length > 0;
  if (bl) $('blurRadiusRow').hidden = bl.shape === 'ellipse';
  const cbl = c && c.blur; $('clipBlurBody').hidden = !(cbl && cbl.enabled); $('clipBlurKeep').hidden = !(cbl && cbl.enabled && cbl.keep);
  syncBgRemoveUI(c, 'clip');
  syncBlurBox();
  $('overlayPanel').hidden = !o; $('overlayEmptyHint').hidden = (p.overlays || []).length > 0;
  if (o) {
    if (document.activeElement !== $('ovlLenInput')) $('ovlLenInput').value = overlayLen(o).toFixed(2);
    $('ovlTrimRow').hidden = o.kind === 'image';
    $('ovlSpeedSection').hidden = o.kind === 'image';
    $('ovlSoundSection').hidden = o.kind === 'image' || !o.hasAudio;
    $('ovlOfflineBanner').hidden = media.has(o.mediaId);
    syncBgRemoveUI(o, 'ovl');
  } else if ($('ovlBgBody')) $('ovlBgBody').hidden = true;
  renderKfPanels();
  $('textPanel').hidden = !t; $('textEmptyHint').hidden = p.texts.length > 0; if (t) taUI.render();
  const a = selected('audio');
  $('audioPanel').hidden = !a; { const h = $('audioAddHint'); if (h) h.hidden = !!a; } // (the Music & audio tracks section was removed: add audio with ＋ Media)
  if (a && document.activeElement !== $('audioLenInput')) $('audioLenInput').value = audioSpan(a, layout(p).total).toFixed(2);
  if (a) {
    $('audioLenLabel').textContent = a.loop ? 'Length on timeline (s)' : 'Length (s)';
    $('loopHint').textContent = a.loop ? (a.loopLen > 0 ? `Repeats the ${fmt(audioLen(a))} trimmed section for ${fmt(a.loopLen)}.` : `Repeats the ${fmt(audioLen(a))} trimmed section until the video ends. Set a length to stop earlier.`) : 'Turn on to repeat a short track under the whole video.';
  }
  $('logoPanel').hidden = !p.logo; $('logoHint').hidden = !!p.logo;
  if (cleanUI) cleanUI.render();
  if (voiceUI) voiceUI.render();
  if (silenceUI) silenceUI.render();
  if (syncUI) syncUI.render();
  if (beatUI) beatUI.render();
  speedUI.render();
  // Toolbar buttons that can't apply right now look dimmed but stay tappable (aria-disabled, not disabled): tapping one
  // explains what to select instead of doing nothing. (A truly disabled button ignores taps and feels "not responding".)
  const multi = app.multi.length > 1, st = multi ? 'multi' : app.selection && selected(app.selection.type) ? app.selection.type : null;
  fillMulti(multi);
  const setState = (sel, ok, tipOk, tipNo) => qsa(sel).forEach(b => { b.disabled = false; b.setAttribute('aria-disabled', ok ? 'false' : 'true'); b.classList.toggle('is-off', !ok); b.title = ok ? tipOk : tipNo; });
  setState('.tl-toolbar [data-action=duplicate]', !!st, multi ? 'Duplicate all selected items (Ctrl+D)' : 'Duplicate selected (Ctrl+D)', TOOL_HINT.duplicate.none);
  setState('.tl-toolbar [data-action=delete]', !!st, multi ? 'Delete all selected items (Del)' : 'Delete selected (Del)', TOOL_HINT.delete.none);
  {
    const maOk = st === 'clip' || st === 'overlay' || st === 'audio';  // (not for a group: it fits one item to another)
    setState('.tl-toolbar [data-action=match]', !!maOk, 'Match: make the selected item fit another one on the timeline (length, start / end, loudness)',
      multi ? 'Match works on one item at a time. Select a single clip, picture, overlay or audio track.' : 'Match: select a clip, picture, overlay or audio track on the timeline first, then tap it to make that item fit another one.');
  }
  {
    // Detach audio (same action as always, now only here): a video clip / video overlay that has sound and isn't muted
    const dItem = st === 'clip' || st === 'overlay' ? selected(st) : null, dVideo = !!dItem && dItem.kind === 'video';
    const dWhy = multi ? 'Detach audio works on one video at a time. Select a single video clip or overlay.' : !dVideo ? 'Detach audio: select a video clip or a video overlay with sound on the timeline first.'
      : dItem.hasAudio === false ? 'This video has no audio, so there is nothing to detach.'
        : st === 'clip' && (dItem.ramp || dItem.reverse) ? 'Detach audio is not available on a clip with a speed curve or Reverse (the detached sound would play at a constant speed). Switch the clip back to a constant speed, or use Mute and keep its sound.'
        : st === 'clip' && dItem.muted ? 'Muted, so there is no sound to detach. Unmute it first, or its audio may already be detached (Audio tab).' : '';
    setState('.tl-toolbar [data-action=detachAudio]', !dWhy, 'Detach audio: copy the selected video\'s sound onto its own audio track and mute the video', dWhy);
  }
  {
    const vt = volumeTarget(), vOk = !vt.why;
    const tipUp = 'Volume up: raise the selected item\'s Volume by 10 points (Shift or Alt: 1 point). Shortcut: ]', tipDown = 'Volume down: lower the selected item\'s Volume by 10 points (Shift or Alt: 1 point). Shortcut: [';
    setState('.tl-toolbar [data-action=volumeDown]', vOk, tipDown, vt.why || tipDown);
    setState('.tl-toolbar [data-action=volumeUp]', vOk, tipUp, vt.why || tipUp);
  }
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
  const box = $(id); if (!box) return; // a list whose section was removed (e.g. the old Music & audio tracks list)
  const focusedIdx = [...box.children].indexOf(document.activeElement);
  box.replaceChildren(...rows.map(build));
  if (focusedIdx >= 0 && box.children[focusedIdx]) box.children[focusedIdx].focus();
}
function renderLists(light) {
  const p = app.project, sel = app.selection || {};
  const isSel = (type, id) => sel.type === type && sel.id === id;
  const texts = [...p.texts].sort((a, b) => a.start - b.start).map(t => ({ t, key: [t.id, fmt(t.start), t.text, t.name, isSel('text', t.id)] }));
  renderList('textList', texts, ({ t }) => { const txt = textLabel(t); return listItem(isSel('text', t.id), `Text at ${fmt(t.start)}: ${txt}`, () => app.select({ type: 'text', id: t.id }, { seekInto: true }),
    el('span', { class: 't', text: fmt(t.start) }), el('span', { class: 'grow', text: txt })); });
  const blrs = [...(p.blurs || [])].sort((a, b) => a.start - b.start).map(b => ({ b, key: [b.id, b.name, b.mode, b.invert, b.shape, fmt(b.start), fmt(b.end), isSel('blur', b.id)] }));
  renderList('blurList', blrs, ({ b }) => listItem(isSel('blur', b.id), `${blurLabel(b)} region at ${fmt(b.start)}`, () => app.select({ type: 'blur', id: b.id }, { seekInto: true }),
    el('span', { class: 'item-ico' }, icon('blur')), el('span', { class: 'grow', text: blurLabel(b) + ' · ' + (b.shape === 'ellipse' ? 'ellipse' : 'box') }), el('span', { class: 't', text: fmt(b.start) + ' · ' + fmt(b.end - b.start) })));
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
  const min = MIN_CLIP * (c.ramp ? meanSpeed(c) : c.speed);
  s = clamp(Number.isFinite(s) ? s : 0, 0, c.srcDuration - min);
  e = clamp(Number.isFinite(e) ? e : c.srcDuration, min, c.srcDuration);
  if (e - s < min) { if (source === 'end') s = Math.max(0, e - min); else e = Math.min(c.srcDuration, s + min); }
  const before = layout(app.project), it0 = before.items.find(i => i.clip.id === c.id);
  app._pendingTrimRipple = app._pendingTrimRipple || { end: it0.end, total: before.total, kf: deepClone(c.keyframes || {}), in0: c.in, out0: c.out, id: c.id, lay0: before };
  const oldC = { ...c }; c.in = s; c.out = e;
  // keyframes stay on the same frames of the source when the start is trimmed
  const P = app._pendingTrimRipple;
  if (hasKeyframes({ keyframes: P.kf })) c.keyframes = rebaseKeyframes(P.kf, c.ramp || c.reverse ? startShift({ ...oldC, in: P.in0, out: P.out0 ?? oldC.out }, c) : (s - P.in0) / (c.speed || 1));
  const it = layout(app.project).items.find(i => i.clip.id === c.id);
  return { it, source };
}
function trimCommit() {
  const r = app._pendingTrimRipple; app._pendingTrimRipple = null;
  if (r && app.rippleEnabled) rippleShift(app.project, r.end - 1e-3, layout(app.project).total - r.total);
  else if (r && r.lay0) holdNextClip(app.project, r.id, r.lay0); // Ripple off: the next clip stays where it was
  app.commit('Trim');
}
$('startRange').addEventListener('input', () => { const r = trimFrom('start'); if (r) app.liveUpdate({ previewAt: r.it.start }); });
$('endRange').addEventListener('input', () => { const r = trimFrom('end'); if (r) app.liveUpdate({ previewAt: Math.max(r.it.start, r.it.end - 0.04) }); });
$('startRange').addEventListener('change', trimCommit); $('endRange').addEventListener('change', trimCommit);
$('clipIn').addEventListener('change', () => { if (trimFrom('inputs')) trimCommit(); });
$('clipOut').addEventListener('change', () => { if (trimFrom('inputs')) trimCommit(); });
$('imageDur').addEventListener('input', () => { const c = selected('clip'); if (!c) return; const b = layout(app.project); app._pendingTrimRipple = app._pendingTrimRipple || { end: b.items.find(i => i.clip.id === c.id).end, total: b.total, id: c.id, lay0: b }; c.out = c.in + parseFloat($('imageDur').value); app.liveUpdate(); });
$('imageDur').addEventListener('change', trimCommit);

function syncBgRemoveUI(item, which) {
  const body = $(which === 'ovl' ? 'ovlBgBody' : 'clipBgBody');
  if (!body) return;
  const br = item && item.bgremove;
  const on = !!(br && br.mode && br.mode !== 'off');
  body.hidden = !on;
  const blurRow = $(which === 'ovl' ? 'ovlBgBlurRow' : 'clipBgBlurRow');
  const colorRow = $(which === 'ovl' ? 'ovlBgColorRow' : 'clipBgColorRow');
  const imgRow = $(which === 'ovl' ? 'ovlBgImageRow' : 'clipBgImageRow');
  if (blurRow) blurRow.hidden = !(br && br.mode === 'blur');
  if (colorRow) colorRow.hidden = !(br && br.mode === 'color');
  if (imgRow) imgRow.hidden = !(br && br.mode === 'image');
  const nameEl = $(which === 'ovl' ? 'ovlBgImgName' : 'clipBgImgName');
  if (nameEl) {
    if (br && br.mediaId && media.peek(br.mediaId)) { nameEl.hidden = false; nameEl.textContent = media.peek(br.mediaId).name || 'Image selected'; }
    else { nameEl.hidden = true; nameEl.textContent = ''; }
  }
  if (on) loadSegmenter({ kind: 'landscape' }).then(() => player && player.requestRender && player.requestRender()).catch(e => console.warn('segmenter', e));
}
async function pickBgImage(which) {
  const input = $(which === 'ovl' ? 'ovlBgImgInput' : 'clipBgImgInput');
  if (!input) return;
  input.value = '';
  input.onchange = async () => {
    const f = input.files && input.files[0]; if (!f) return;
    try {
      const rec = await media.importFile(f, 'image');
      const item = which === 'ovl' ? selected('overlay') : selected('clip');
      if (!item) return;
      item.bgremove = item.bgremove || {}; item.bgremove.mode = 'image'; item.bgremove.mediaId = rec.id;
      app.commit('Background image');
      syncBgRemoveUI(item, which);
      toast('Replacement image set.');
    } catch (e) { toast('Could not add image: ' + (e && e.message || e)); }
  };
  input.click();
}

if ($('clipBgPickImg')) $('clipBgPickImg').onclick = () => pickBgImage('clip');
if ($('ovlBgPickImg')) $('ovlBgPickImg').onclick = () => pickBgImage('ovl');

if ($('freezeDur')) $('freezeDur').addEventListener('input', () => { $('freezeDurOut').textContent = (+$('freezeDur').value).toFixed(1).replace(/\.0$/, '') + 's'; });
$('audioLenInput').addEventListener('change', () => {
  const a = selected('audio'); if (!a) return; const l = parseFloat($('audioLenInput').value); if (!(l > 0)) return;
  if (a.loop) a.loopLen = Math.max(0.2, l); // looped: how long it repeats on the timeline
  else a.out = clamp(a.in + l * audioSpeed(a), a.in + 0.2 * audioSpeed(a), a.srcDuration || 1e9);
  app.commit('Audio length');
});
$('textPosPresets').addEventListener('click', (e) => { const b = e.target.closest('button'); const t = selected('text'); if (!b || !t) return; t.y = parseFloat(b.dataset.y); t.x = 0.5; app.commit('Text position'); });

// ---------------------------------------------------------------- actions
let detachBusy = false;
const DETACH_TIMEOUT = 5000;
/** "Detaching…" state of the Detach audio buttons (spinner + label, disabled look, aria-busy), and its release. */
function setDetachBusy(btns, on) {
  if (!on) detachBusy = false;
  for (const b of btns) {
    b.classList.toggle('busy', on); b.setAttribute('aria-busy', on ? 'true' : 'false');
    const label = b.querySelector('span:not(.spinner)');
    if (label) { if (on) { b.dataset.label = label.textContent; label.textContent = 'Detaching…'; } else if (b.dataset.label) { label.textContent = b.dataset.label; delete b.dataset.label; } }
    let sp = b.querySelector('.spinner');
    if (on && !sp) { sp = document.createElement('span'); sp.className = 'spinner'; sp.setAttribute('aria-hidden', 'true'); b.prepend(sp); }
    if (!on && sp) sp.remove();
  }
}
/** Why the selection has no Volume to change (null when it has one): { item, bind, name } or { why }. */
function volumeTarget() {
  if (app.multi.length) {
    const items = G.resolve(app.project, app.multi).filter(x => G.hasSoundItem(x.type, x.item));
    return items.length ? { group: items, name: plural(items.length, 'item'), where: 'the Mute button of the selection panel' } : { why: 'None of the selected items has sound, so there is no volume to change. Include a video clip, overlay, music or voice track.' };
  }
  const s = app.selection, item = s && selected(s.type);
  if (!s || !item) return { why: 'Nothing selected. Tap a clip, overlay, music or voice track on the timeline first, then tap Volume up or down.' };
  if (s.type === 'clip' || s.type === 'overlay') {
    if (item.kind === 'image') return { why: 'An image has no sound, so there is no volume to change. Select a video clip, overlay, music or voice track.' };
    if (item.hasAudio === false) return { why: 'This video has no audio, so there is no volume to change.' };
    return { item, bind: s.type === 'clip' ? 'clip.volume' : 'ovl.volume', name: item.name || (s.type === 'clip' ? 'Clip' : 'Overlay'), where: s.type === 'clip' ? 'the Clip tab' : 'the Picture-in-picture tab' };
  }
  if (s.type === 'audio') return { item, bind: 'audio.volume', name: item.name || (item.voice ? 'Voice' : 'Music'), where: 'the Audio tab' };
  const what = { text: 'Text', blur: 'A blur region', caption: 'A caption', marker: 'A marker' }[s.type] || 'This item';
  return { why: what + ' has no sound, so there is no volume to change. Select a video clip, overlay, music or voice track.' };
}
function stepSelectedVolume(dir, ev) {
  const t = volumeTarget();
  if (t.why) return toast(t.why, 4500);
  if (t.group) {
    const live = t.group.filter(x => !x.item.muted);
    if (!live.length) return toast('All selected items are muted, so changing their volume would not be heard. Unmute them first (Mute in the selection panel).', 5000);
    const fine = !!(ev && (ev.shiftKey || ev.altKey)); let last = null, hit = 0;
    for (const x of live) { const r = stepVolume(x.item.volume, dir, { fine, max: 2 }); if (!r.atLimit) { x.item.volume = r.level; hit++; last = r.level; } }
    if (!hit) return toast(dir > 0 ? 'Volume is already at the maximum.' : 'Volume is already 0%.', 2200);
    app.commit('Volume', 'vol:multi'); return toast('Volume ' + (live.length > 1 ? 'changed on ' + live.length + ' items' : Math.round(last * 100) + '%'), 1500);
  }
  const { item } = t;
  if (item.muted) return toast('“' + t.name + '” is muted, so changing its volume would not be heard. Unmute it first (Mute button in ' + t.where + ').', 5000);
  const slider = document.querySelector('[data-bind="' + t.bind + '"]'), max = slider && +slider.max > 0 ? +slider.max : 2;
  const fine = !!(ev && (ev.shiftKey || ev.altKey));
  const r = stepVolume(item.volume, dir, { fine, max });
  const pct = Math.round(r.level * 100);
  if (r.atLimit) return toast(dir > 0 ? 'Volume is already at the maximum, ' + pct + '%.' : 'Volume is already 0% (silent).', 2200);
  item.volume = r.level;
  app.commit('Volume', 'vol:' + app.selection.type + ':' + app.selection.id);
  toast('Volume ' + pct + '%' + (r.level === 0 ? ' (silent)' : r.level >= max - 1e-9 ? ' (max)' : ''), 1500);
}
// ---- group (multi-selection) edits: each is ONE commit, so one Undo reverses the whole group ----
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
function groupSummary(list) {
  const n = {}; for (const s of list) n[s.type] = (n[s.type] || 0) + 1;
  return Object.entries(n).map(([k, v]) => plural(v, G.NOUN[k])).join(' · ');
}
app.groupSummary = groupSummary;
/** Quietly make `list` the selection (the commit that follows redraws everything). */
function setSelQuiet(list) {
  if (list.length > 1) { app._holdMulti = true; app.selection = null; app._holdMulti = false; app.multi = list; }
  else app.selection = list[0] || null;
}
const groupActions = {
  delete(list) {
    const n = G.deleteMany(app.project, list || [], app.rippleEnabled);
    if (!n) { app.selection = null; return toast(TOOL_HINT.delete.none); }
    app.selection = null; app.commit('Delete ' + plural(n, 'item')); toast(plural(n, 'item') + ' deleted. Undo (Ctrl+Z) brings them all back.');
  },
  duplicate(list) {
    const out = G.duplicateMany(app.project, list, app.rippleEnabled);
    setSelQuiet(out); app.commit('Duplicate ' + plural(out.length, 'item')); toast(plural(out.length, 'item') + ' duplicated.');
  },
  split(list) {
    const r = G.splitMany(app.project, list, player.t);
    if (!r.split) return toast('Move the playhead inside at least one of the selected items to split them.');
    setSelQuiet(r.done); app.commit('Split ' + plural(r.split, 'item')); toast(plural(r.split, 'item') + ' split at ' + fmtPrecise(player.t, app.project.settings.fps) + (r.skipped ? ' (' + r.skipped + ' not under the playhead)' : '') + '.');
  },
  mute(list) {
    const r = G.muteMany(app.project, list);
    if (r.muted == null) return toast('None of the selected items has sound to mute.');
    app.commit(r.muted ? 'Mute' : 'Unmute'); toast(plural(r.n, 'item') + (r.muted ? ' muted.' : ' unmuted.'));
  },
};
const actions = {
  split() {
    if (app.multi.length) return groupActions.split(app.multi);
    // Splits the selected item on any track (clip, text, overlay, music/voice); with nothing (or a marker) selected,
    // splits the main video track at the playhead.
    const s = app.selection && app.selection.type !== 'marker' ? app.selection : null;
    const r = splitItem(app.project, s, player.t);
    if (!r || r.fail) return toast(r ? r.reason : 'Nothing to split here.');
    app.selection = { type: r.type, id: r.item.id };
    const what = { clip: 'Clip', text: 'Text', audio: 'Audio', overlay: 'Overlay', blur: 'Blur region', caption: 'Caption' }[r.type];
    app.commit('Split'); toast(what + ' split at ' + fmtPrecise(player.t, app.project.settings.fps));
  },
  duplicate() {
    if (app.multi.length) return groupActions.duplicate(app.multi);
    const s = app.selection, item = s && selected(s.type);
    if (!s || !item) return toast(TOOL_HINT.duplicate.none);
    if (s.type === 'clip') { const b = duplicateClip(app.project, s.id, app.rippleEnabled); if (!b) return toast('Could not duplicate this clip.'); app.selection = { type: 'clip', id: b.id }; }
    else if (s.type === 'text') { const b = deepClone(item); b.id = uid('txt'); b.start = item.end; b.end = item.end + (item.end - item.start); app.project.texts.push(b); app.selection = { type: 'text', id: b.id }; }
    else if (s.type === 'audio') { const b = deepClone(item); b.id = uid('aud'); b.start = item.start + audioSpan(item, layout(app.project).total); app.project.audio.push(b); app.selection = { type: 'audio', id: b.id }; }
    else if (s.type === 'overlay') { const b = deepClone(item); b.id = uid('ovl'); b.start = item.start + overlayLen(item); app.project.overlays.push(b); app.selection = { type: 'overlay', id: b.id }; }
    else if (s.type === 'blur') { const b = deepClone(item); b.id = uid('blr'); b.start = item.end; b.end = item.end + (item.end - item.start); app.project.blurs.push(b); app.selection = { type: 'blur', id: b.id }; }
    else if (s.type === 'caption') { const b = deepClone(item); b.id = uid('cap'); const len = item.end - item.start; b.start = item.end; b.end = item.end + len; if (b.words) b.words = b.words.map(w => ({ ...w, start: w.start + len, end: w.end + len })); app.project.captions.push(b); app.selection = { type: 'caption', id: b.id }; }
    else if (s.type === 'marker') {
      // a copy of the marker at the playhead (or a second later when the playhead is already on it)
      const total = layout(app.project).total, here = Math.abs(player.t - item.time) > 0.05 ? player.t : Math.min(total, item.time + 1);
      const b = { ...deepClone(item), id: uid('mk'), time: here, name: 'Marker ' + (app.project.markers.length + 1) };
      app.project.markers.push(b); app.selection = { type: 'marker', id: b.id };
    } else return toast(TOOL_HINT.duplicate.none);
    const what = { clip: 'Clip', text: 'Text', audio: item.voice ? 'Voice track' : 'Music track', overlay: 'Overlay', blur: 'Blur region', caption: 'Caption', marker: 'Marker' }[s.type];
    app.commit('Duplicate'); toast(what + ' duplicated.');
  },
  // The timeline toolbar Delete (and the Del/Backspace key) is the only way to delete a timeline item: the per-panel
  // Delete buttons and the right-click "Delete" were removed. Covers every item type plus multi-select; null-safe.
  delete() {
    const multi = Array.isArray(app.multi) ? app.multi : [];
    if (multi.length) return groupActions.delete(multi);
    const s = app.selection, item = s && s.type && selected(s.type);
    if (!s || !item) return toast(TOOL_HINT.delete.none);
    const p = app.project;
    if (s.type === 'clip') removeClip(p, s.id, app.rippleEnabled);
    else {
      const key = { text: 'texts', audio: 'audio', marker: 'markers', overlay: 'overlays', blur: 'blurs', caption: 'captions' }[s.type];
      if (!key) return toast(TOOL_HINT.delete.none);
      p[key] = (p[key] || []).filter(t => t && t.id !== s.id);
    }
    const what = { clip: 'Clip', text: 'Text', audio: item.voice ? 'Voice track' : 'Music track', overlay: 'Overlay', blur: 'Blur region', caption: 'Caption', marker: 'Marker' }[s.type];
    app.selection = null; app.commit('Delete'); toast(what + ' deleted. Undo (Ctrl+Z) brings it back.');
  },
  selectAll() { app.selectAll(); },
  deselect() { app.select(null); },
  muteSel() { const l = app.selList(); if (!l.length) return toast('Select clips, overlays or audio tracks first.'); groupActions.mute(l); },
  copy() {
    const l = app.selList(); if (!l.length) return toast('Select something on the timeline first, then copy it (Ctrl+C).');
    app.clipboard = G.copyItems(app.project, l); fillInspector();
    toast('Copied ' + plural(l.length, 'item') + '. Move the playhead and paste with Ctrl+V.', 2600);
  },
  cut() {
    const l = app.selList(); if (!l.length) return toast('Select something on the timeline first, then cut it (Ctrl+X).');
    app.clipboard = G.copyItems(app.project, l);
    const n = G.deleteMany(app.project, l, app.rippleEnabled); app.selection = null;
    app.commit('Cut ' + plural(n, 'item')); toast('Cut ' + plural(n, 'item') + '. Paste with Ctrl+V; Undo (Ctrl+Z) puts them back.', 2800);
  },
  paste() {
    if (!app.clipboard) return toast('Nothing copied yet. Select items and press Ctrl+C (or Ctrl+X) first.');
    const out = G.pasteItems(app.project, app.clipboard, player.t, app.rippleEnabled);
    if (!out.length) return;
    setSelQuiet(out); app.commit('Paste ' + plural(out.length, 'item'));
    if (timeline.autoFit) timeline.fit();
    toast('Pasted ' + plural(out.length, 'item') + ' at ' + fmt(player.t) + '. An overlap goes to a new lane.', 2600);
  },
  pasteLook() {
    if (!app.clipboard) return toast('Nothing copied yet. Copy an item with its look (effects, filter, animation, volume), select the target items, then press Ctrl+Shift+V.');
    const l = app.selList(); if (!l.length) return toast('Select the items to give that look to first.');
    const n = G.pasteAttributes(app.project, app.clipboard, l);
    if (!n) return toast('The copied item has no matching look for the selected items (clips and overlays share a look; text, audio and blur regions match their own kind).', 4200);
    app.commit('Paste attributes'); toast('Look pasted onto ' + plural(n, 'item') + '.', 2200);
  },
  async freezeFrame() {
    const p = app.project, t = player.t, tg = freezeTarget(p, t);
    if (tg.fail) return toast(tg.fail);
    const c = tg.it.clip, url = media.url(c.mediaId);
    if (!url) return toast('This clip\'s file is not stored on this device, so a frame cannot be taken. Relink it first.');
    const btn = $('freezeBtn'); if (!btn || btn.dataset.busy) return; btn.dataset.busy = '1'; btn.textContent = 'Taking the frame…';
    try {
      player.pause();
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
      const src = await thumbVideoAt(v, url, tg.srcTime);
      if (!src || !src.w) throw new Error('this browser could not decode the video here');
      const k = Math.min(1, 2560 / Math.max(src.w, src.h)), cv = document.createElement('canvas');
      cv.width = Math.round(src.w * k); cv.height = Math.round(src.h * k);
      cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.95));
      if (!blob) throw new Error('could not save the frame');
      const rec = await media.importFile(new File([blob], 'Freeze ' + (c.name || 'frame') + ' ' + fmt(tg.srcTime) + '.jpg', { type: 'image/jpeg' }), 'image');
      v.removeAttribute('src'); v.load();
      const r = insertFreeze(app.project, t, rec, +$('freezeDur').value || FREEZE_DEFAULT);
      if (r.fail) return toast(r.fail);
      app.selection = { type: 'clip', id: r.freeze.id };
      app.commit('Freeze frame'); if (timeline.autoFit) timeline.fit();
      toast('Froze the frame for ' + freezeLen(+$('freezeDur').value || FREEZE_DEFAULT) + ' s. Undo (Ctrl+Z) takes it back.');
    } catch (e) { console.warn('Freeze frame', e); toast('Could not freeze a frame: ' + (e && e.message ? e.message : 'unknown error')); }
    finally { delete btn.dataset.busy; btn.textContent = '❄ Freeze frame at playhead'; }
  },
  async autoReframe() {
    const c = selected('clip');
    if (!c) return toast('Select a video clip first.');
    if (c.kind === 'image') return toast('Auto reframe needs a video clip (not a still image).');
    if (!c.mediaId) return toast('This clip has no video file.');
    const btn = $('reframeBtn'), prog = $('reframeProg'), bar = $('reframeBar'), st = $('reframeStatus');
    if (btn && btn.dataset.busy) return;
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    if (prog) prog.hidden = false;
    if (bar) bar.style.width = '0%';
    if (st) st.textContent = 'Loading face model…';
    const ac = new AbortController();
    const onCancel = () => ac.abort();
    if ($('reframeCancel')) $('reframeCancel').onclick = onCancel;
    player.pause();
    try {
      const target = ($('reframeTarget') && $('reframeTarget').value) || 'project';
      const setRatio = !($('reframeSetRatio') && !$('reframeSetRatio').checked);
      const r = await autoReframeClip(app.project, c, async () => {
        const m = await media.get(c.mediaId); return m && m.blob;
      }, {
        target, setProjectRatio: setRatio && target !== 'project', setFit: true, signal: ac.signal,
        onProgress: (p) => {
          const frac = Math.max(0, Math.min(1, p.frac || 0));
          if (bar) bar.style.width = (frac * 100).toFixed(1) + '%';
          if (!st) return;
          if (p.phase === 'download') st.textContent = 'Downloading face model…';
          else if (p.phase === 'load') st.textContent = 'Loading face model…';
          else if (p.phase === 'detect') st.textContent = 'Tracking face… ' + (p.i || 0) + '/' + (p.n || '?');
          else st.textContent = 'Working…';
        },
      });
      app.commit('Auto reframe');
      sizeStage(); renderAll();
      const msg = r.faces
        ? ('Reframed with ' + r.keys + ' keyframes (' + r.faces + ' faces found). Edit them under Keyframes.')
        : ('No face found — centred the crop (' + r.keys + ' keyframes). Undo if you want the old framing.');
      toast(msg, 5000);
    } catch (e) {
      if (e instanceof ReframeCancelled || (e && e.name === 'ReframeCancelled')) toast('Auto reframe cancelled.');
      else { console.warn('Auto reframe', e); toast('Could not auto reframe: ' + (e && e.message ? e.message : 'unknown error'), 6000); }
    } finally {
      if (btn) { delete btn.dataset.busy; btn.disabled = false; }
      if (prog) prog.hidden = true;
    }
  },
  volumeDown(_b, ev) { stepSelectedVolume(-1, ev); },
  volumeUp(_b, ev) { stepSelectedVolume(1, ev); },
  match() { app.match.open(); },
  moveLeft() { const c = selected('clip'); if (!c) return; const i = app.project.clips.indexOf(c); if (i > 0) { moveClip(app.project, i, i - 1); app.commit('Move clip'); } },
  moveRight() { const c = selected('clip'); if (!c) return; const i = app.project.clips.indexOf(c); if (i < app.project.clips.length - 1) { moveClip(app.project, i, i + 1); app.commit('Move clip'); } },
  resetTransform() { const c = selected('clip'); if (!c) return; c.transform = defaultTransform(); c.fit = 'inherit'; app.commit('Reset frame'); },
  rotL() { const c = selected('clip'); if (!c) return; c.transform.rotate = ((c.transform.rotate || 0) + 270) % 360; app.commit('Rotate'); },
  rotR() { const c = selected('clip'); if (!c) return; c.transform.rotate = ((c.transform.rotate || 0) + 90) % 360; app.commit('Rotate'); },
  resetClipColor() { const c = selected('clip'); if (!c) return; c.color = { ...defaultColor(), preset: c.color.preset, filterAmount: c.color.filterAmount }; app.commit('Reset color'); }, // the sliders only: the filter has its own Remove
  resetGlobalColor() { const k = app.project.color; app.project.color = { ...defaultColor(), preset: k.preset, filterAmount: k.filterAmount }; app.commit('Reset color'); },
  addText() {
    const p = app.project, total = layout(p).total;
    const start = clamp(player.t, 0, Math.max(0, total - 0.5));
    const t = newText(start, Math.min(4, Math.max(1, (total || 4) - start)), p.texts.length ? 'New text' : 'Your title here');
    p.texts.push(t); app.selection = { type: 'text', id: t.id };
    app.commit('Add text'); showTab('text');
    setTimeout(() => { const ta = qs('#textPanel textarea'); ta && ta.focus(); ta && ta.select(); }, 50);
  },
  textStartHere() { const t = selected('text'); if (!t) return; const len = t.end - t.start; t.start = player.t; if (t.end <= t.start + 0.1) t.end = t.start + len; app.commit('Text start'); },
  textEndHere() { const t = selected('text'); if (!t) return; if (player.t > t.start + 0.1) { t.end = player.t; app.commit('Text end'); } else toast('Playhead must be after the text start.'); },
  audioStartHere() { const a = selected('audio'); if (!a) return; a.start = player.t; app.commit('Move music'); },
  addMarker() {
    const t = player.t;
    const m = { id: uid('mk'), time: t, name: 'Marker ' + (app.project.markers.length + 1) };
    app.project.markers.push(m); app.selection = { type: 'marker', id: m.id };
    app.commit('Add marker'); toast('Marker added at ' + fmt(t) + '. Drag it to move it, or select it and press Delete to remove it.');
  },
  removeLogo() { app.project.logo = null; app.commit('Remove logo'); },
  ovlStartHere() { const o = selected('overlay'); if (!o) return; o.start = Math.max(0, player.t); app.commit('Move overlay'); },
  addBlur() {
    const p = app.project, total = layout(p).total;
    if (!p.clips.length) return toast('Add a video clip first, then add a blur region over it.');
    const start = clamp(player.t, 0, Math.max(0, total - 0.5));
    const b = newBlur(start, Math.min(4, Math.max(0.5, total - start)));
    p.blurs = p.blurs || []; p.blurs.push(b); app.selection = { type: 'blur', id: b.id };
    app.commit('Add blur region'); showTab('look');
    toast('Blur region added. Drag it on the preview and pull the handles to resize. Turn on “Blur everything outside” for a background blur.', 4200);
  },
  blurStartHere() { const b = selected('blur'); if (!b) return; const len = b.end - b.start; b.start = Math.max(0, player.t); if (b.end <= b.start + 0.1) b.end = b.start + len; app.commit('Blur start'); },
  blurEndHere() { const b = selected('blur'); if (!b) return; if (player.t > b.start + 0.1) { b.end = player.t; app.commit('Blur end'); } else toast('Playhead must be after the blur region start.'); },
  addKeyframe() {
    let k = kfTarget();
    if (!k) { const t = app.selection && selected(app.selection.type) ? app.selection.type : 'none'; return toast(TOOL_HINT.addKeyframe[t] || TOOL_HINT.addKeyframe.none, 4500); }
    let moved = false;
    if (!k.inside) { // the playhead is elsewhere: jump to the nearest point of the selected item instead of refusing
      player.pause(); player.setTime(k.start + clamp(k.raw, 0.02, Math.max(0.02, k.len - 0.02))); moved = true;
      k = kfTarget(); if (!k || !k.inside) return toast('Could not place a keyframe on this item. Tap the timeline above it, then use ◆ Add in its Keyframes section (or press Shift+K).', 4500);
    }
    const vals = animated(k.type, k.item, k.local);
    for (const pr of animPropsOf(k.type, k.item)) setKeyframe(k.item, pr, k.local, vals[pr]);
    app.commit(k.type === 'audio' ? 'Add volume keyframe' : 'Add keyframe');
    if (k.type === 'audio') return toast('◆ Volume keyframe at ' + fmtPrecise(player.t, app.project.settings.fps) + (moved ? ' (playhead moved onto the track)' : '') + ' — move to another time and set its level in the list below, or drag the point on the track.', 5000);
    toast('◆ Keyframe at ' + fmtPrecise(player.t, app.project.settings.fps) + (moved ? ' (playhead moved onto the item)' : '') + (k.type === 'blur' ? ' — move to another time and drag the box or change its size so it follows the subject.' : ' — move to another time and change position, scale, rotation or opacity.'), 3500);
  },
  kfPrev() { const k = kfTarget(); if (!k) return; const ts = kfTimes(k.item).filter(x => x < k.raw - 1e-3); if (ts.length) { player.pause(); player.setTime(k.start + ts[ts.length - 1] + 1e-4); } },
  kfNext() { const k = kfTarget(); if (!k) return; const ts = kfTimes(k.item).filter(x => x > k.raw + 1e-3); if (ts.length) { player.pause(); player.setTime(k.start + ts[0] + 1e-4); } },
  /**
   * Detach audio. The new track is created synchronously (no decoding, no waiting on the media), so it can never hang; the button
   * shows "Detaching…" at once and ignores extra taps; the format check is header-only, raced against a hard timeout, and its verdict
   * only adds a clear message (or, for a file with no sound at all, undoes the detach). The waveform fills in later in the background.
   */
  async detachAudio() {
    if (detachBusy) return;
    const s = app.selection;
    if (!s || (s.type !== 'clip' && s.type !== 'overlay') || !selected(s.type)) return toast('Select a video clip or overlay first, then tap Detach audio.', 4000);
    detachBusy = true;
    const btns = qsa('[data-action=detachAudio]'), t0 = performance.now();
    const guard = setTimeout(() => setDetachBusy(btns, false), DETACH_TIMEOUT + 2000); // last resort: the button can never stay stuck
    setDetachBusy(btns, true);
    try {
      await Promise.race([new Promise(r => requestAnimationFrame(() => setTimeout(r, 40))), new Promise(r => setTimeout(r, 150))]); // let "Detaching…" paint first
      if (!selected(s.type) || !app.selection || app.selection.id !== s.id || app.selection.type !== s.type) return; // the selection changed during that instant
      const src = s.type === 'overlay' ? app.project.overlays.find(x => x.id === s.id) : app.project.clips.find(x => x.id === s.id);
      const r = detachAudio(app.project, s);
      if (r.fail) return toast(r.reason, 4500);
      const mediaId = src.mediaId;
      app.commit('Detach audio'); // (the video stays selected for a moment so the button keeps showing "Detaching…"; the new track is already in the project)
      media.fillPeaks(mediaId).catch(() => { }); // waveform in the background (no-op when it is already there)
      const verdict = await Promise.race([media.checkAudio(mediaId).catch(() => 'unknown'), new Promise(r => setTimeout(() => r('timeout'), DETACH_TIMEOUT))]);
      const left = 450 - (performance.now() - t0); if (left > 0) await new Promise(r => setTimeout(r, left)); // keep the "Detaching…" state visible long enough to notice
      if (verdict === 'none') { // the file really has no sound track: put everything back
        const at = app.project.audio.findIndex(x => x.id === r.audio.id); if (at >= 0) app.project.audio.splice(at, 1);
        src.muted = false;
        for (const list of [app.project.clips, app.project.overlays || []]) for (const x of list) if (x.mediaId === mediaId) x.hasAudio = false;
        const rec = media.recs.get(mediaId); if (rec) rec.hasAudio = false; db.updateMediaMeta(mediaId, { hasAudio: false }).catch(() => { });
        app.commit('Detach audio (no audio)');
        return toast('This video has no audio, so there is nothing to detach.', 5000);
      }
      if (app.selection && app.selection.type === s.type && app.selection.id === s.id) app.select({ type: 'audio', id: r.audio.id }); // to the new track, unless they tapped something else meanwhile
      showTab('audio');
      const row = document.querySelector('#audioList [data-id="' + r.audio.id + '"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      toast(verdict === 'undecodable'
        ? 'Audio detached onto its own track, but this audio format can’t be read by your browser, so it may be silent (and show no waveform) in the preview and the export.'
        : verdict === 'timeout'
          ? 'Audio detached onto its own track (Audio tab). Reading its audio format is taking long, so the waveform may appear later.'
          : 'Audio detached onto its own track (Audio tab). The video is muted; move, trim, fade or keyframe the audio separately.', verdict === 'undecodable' ? 8000 : 5000);
    } catch (err) {
      console.warn(err); toast('Could not detach the audio: ' + ((err && err.message) || err), 5000);
    } finally { clearTimeout(guard); setDetachBusy(btns, false); }
  },
  addVolumeKey() {
    let k = kfTarget(); if (!k || !['clip', 'overlay', 'audio'].includes(k.type)) return;
    if (k.type !== 'audio' && !(hasSound(k.item) && k.item.kind !== 'image')) return toast('This item has no sound to keyframe.', 3000);
    if (!k.inside) { player.pause(); player.setTime(k.start + clamp(k.raw, 0.02, Math.max(0.02, k.len - 0.02))); k = kfTarget(); if (!k || !k.inside) return; }
    setKeyframe(k.item, 'volume', k.local, volumeEnv(k.item, k.local), 'linear');
    app.commit('Add volume keyframe'); toast('◆ Volume keyframe at ' + fmtPrecise(player.t, app.project.settings.fps) + ' — set its level in the Keyframes list, or drag the point on the timeline item.', 4000);
  },
  kfClear() { const k = kfTarget(); if (!k) return; k.item.keyframes = {}; app.commit('Clear keyframes'); toast('Keyframes cleared'); },
};
app.actions = actions;

// ---------------------------------------------------------------- keyframe panels
const KF_STATE = new Map(); // item id -> 'open' | 'closed' (what the user chose; otherwise open only when the item has keyframes)
const KF_LABEL = { x: 'Position', y: 'Position', scale: 'Size', w: 'Size', h: 'Size', rotation: 'Rotation', opacity: 'Opacity', volume: 'Volume' };
function renderKfPanels() {
  // ONE Keyframes section per selected item (it sits in the tab of that item: Clip, Text, PiP, Audio track, Blur region). Motion keys and the volume
  // envelope are listed together by time; the ◆ next to a Volume slider only adds a volume key to this same list.
  for (const panel of qsa('.kf-panel')) {
    const type = panel.dataset.kf;
    const k = kfTarget(type);
    if (!k) { if (panel._key) { panel._key = ''; panel.replaceChildren(); } continue; }
    const kf = k.item.keyframes || {};
    const times = kfTimes(k.item, true);
    const rows = times.map(lt => {
      const props = ANIM_PROPS.filter(pr => (kf[pr] || []).some(x => Math.abs(x.t - lt) < 1 / 120));
      const first = props.map(pr => (kf[pr] || []).find(x => Math.abs(x.t - lt) < 1 / 120))[0];
      const vk = (kf.volume || []).find(x => Math.abs(x.t - lt) < 1 / 120);
      return { lt, props, ease: (first && first.ease) || 'linear', vol: vk ? vk.v : null };
    });
    const state = KF_STATE.get(k.item.id), open = state ? state === 'open' : times.length > 0;
    const key = [type, k.item.id, k.start.toFixed(3), open ? 1 : 0, rows.map(r => r.lt + r.props.join('') + r.ease + r.vol).join(',')].join('|');
    if (panel._key !== key) {
      panel._key = key;
      const d = el('details', { class: 'kf-details' });
      d.open = open;
      d.append(el('summary', { title: 'Keyframes make a value change over time. Shift+K adds one at the playhead.' }, el('h2', { text: 'Keyframes' }), el('span', { class: 'hint mono', text: times.length ? times.length + ' ◆' : 'none' }),
        el('button', { class: 'btn primary small', type: 'button', 'data-action': 'addKeyframe', title: 'Add a keyframe at the playhead (Shift+K)', text: '◆ Add' })));
      d.querySelector('summary').addEventListener('click', (e) => { if (e.target.closest('button')) return; KF_STATE.set(k.item.id, d.open ? 'closed' : 'open'); });
      const btns = el('div', { class: 'button-row' },
        el('button', { class: 'btn secondary small', type: 'button', 'data-action': 'kfPrev', 'aria-label': 'Previous keyframe', text: '◀ ◆' }),
        el('button', { class: 'btn secondary small', type: 'button', 'data-action': 'kfNext', 'aria-label': 'Next keyframe', text: '◆ ▶' }),
        times.length ? el('button', { class: 'btn ghost danger small', type: 'button', 'data-action': 'kfClear', text: 'Clear all' }) : null);
      const list = el('div', { class: 'item-list kf-list' });
      for (const r of rows) {
        const lt = r.lt, kids = [el('button', { type: 'button', class: 't', text: '◆ ' + fmtPrecise(k.start + lt, app.project.settings.fps), title: 'Jump to keyframe', onclick: () => { player.pause(); player.setTime(k.start + lt + 1e-4); } })];
        if (type !== 'audio') kids.push(el('span', { class: 'hint kf-props', text: [...new Set(r.props.map(pr => KF_LABEL[pr]))].join(' · ') }));
        kids.push(el('span', { class: 'grow' }));
        if (r.vol != null) {
          const num = el('input', { class: 'field mono vol-input', type: 'number', min: '0', max: String(VOL_KEY_MAX * 100), step: '5', inputmode: 'numeric', 'aria-label': 'Volume at ' + fmt(k.start + lt) + ' (percent of the slider)' });
          num.value = String(Math.round(r.vol * 100));
          num.addEventListener('change', () => { const kk = kfTarget(type); if (!kk) return; const n = parseFloat(num.value); if (!Number.isFinite(n)) { num.value = String(Math.round(r.vol * 100)); return; } setKeyframe(kk.item, 'volume', lt, clamp(n / 100, 0, VOL_KEY_MAX)); app.commit('Volume keyframe'); });
          kids.push(num, el('span', { class: 'hint', text: '%' }));
        }
        kids.push(easeSelect(r.ease, (v) => { const kk = kfTarget(type); if (!kk) return; setEaseAt(kk.item, lt, v, ANIM_PROPS); app.commit('Keyframe easing'); }),
          el('button', { type: 'button', text: '✕', 'aria-label': 'Delete keyframe', onclick: () => { const kk = kfTarget(type); if (!kk) return; removeKeyframesAt(kk.item, lt, ANIM_PROPS); app.commit('Delete keyframe'); } }));
        list.append(el('div', { class: 'item kf-row' + (r.vol != null ? ' vol-row' : ''), 'data-lt': String(lt) }, ...kids));
      }
      const hint = type === 'audio' ? 'The line on the track is a multiplier of the Volume slider (the middle is 100%, the top 200%). Drag a point on the track to move it.'
        : type === 'blur' ? 'Position and size are animated. Move the playhead to where the subject has moved, then drag the box (or its handles) to set another keyframe.'
          : times.length ? 'Move the playhead and change position, size, rotation or opacity: a keyframe is set for you. Volume: use the ◆ next to the Volume slider.' : 'Add a keyframe, move to another time and change something: it animates between them.';
      d.append(btns, list, el('p', { class: 'hint', text: hint }));
      panel.replaceChildren(d);
    }
    for (const row of panel.querySelectorAll('.kf-row')) row.classList.toggle('selected', Math.abs(parseFloat(row.dataset.lt) - k.raw) < 1 / 60);
  }
}
function easeSelect(value, onChange) {
  const sel = el('select', { class: 'mini-select', 'aria-label': 'Easing' });
  for (const [v, l] of [['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['easeInOut', 'Ease in/out'], ['hold', 'Hold']]) sel.append(el('option', { value: v, text: l }));
  sel.value = value; sel.addEventListener('change', () => onChange(sel.value));
  return sel;
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
    } catch (e) { (/No video track|Unsupported/i.test(e.message || '') ? console.info : console.warn)('Import failed:', e.message || e); toast('Could not read ' + f.name + ': ' + (e.message || e) + (/No video track|Timed out|Media error|decode/i.test(e.message || '') ? '. This browser can’t show its picture (often iPhone H.265/HEVC on a laptop). Try a different video, or convert it to H.264 first.' : ''), 8000); }
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
media.onChange(() => { timeline.render(); player.invalidate(); fillInspector(); if (wsLayout) wsLayout.refreshBin(true); });

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
  (p.blurs || []).forEach(b => { s.add(b.start); s.add(b.end); });
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
  const handled0 = () => e.preventDefault();
  if (qs('dialog[open]')) return;
  if (ctx === 'control' && CONTROL_KEYS.has(e.key)) return; // e.g. arrows move the focused slider, Space presses the focused button
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); actions.duplicate(); return; }
  if (mod && !e.altKey) {
    const kk = e.key.toLowerCase();
    if (kk === 'a') { e.preventDefault(); actions.selectAll(); return; }
    if (kk === 'c') { e.preventDefault(); actions.copy(); return; }
    if (kk === 'x') { e.preventDefault(); actions.cut(); return; }
    if (kk === 'v') { e.preventDefault(); e.shiftKey ? actions.pasteLook() : actions.paste(); return; }
  }
  if (!mod && (e.code === 'BracketLeft' || e.code === 'BracketRight')) { handled0(); actions[e.code === 'BracketLeft' ? 'volumeDown' : 'volumeUp'](null, e); return; }
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
    case 'Escape': if (voice.state === 'countdown') voice.cancelCountdown(); else if (document.getElementById('ctxMenu')) closeCtx(); else app.select(null); break;
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
if ($('selectBtn')) $('selectBtn').onclick = () => { // (null-safe: a stale cached page may lack the button)
  app.selectMode = !app.selectMode; $('selectBtn').setAttribute('aria-pressed', app.selectMode); document.body.classList.toggle('select-mode', app.selectMode);
  toast(app.selectMode ? 'Select mode on: tap items to add or remove them, drag on empty space to select a box. Tap Select again to finish.' : 'Select mode off', app.selectMode ? 4200 : 1500);
};
// ---- right-click (or long-press) menu on the timeline: the item actions in one place ----
function closeCtx() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); document.removeEventListener('pointerdown', ctxAway, true); }
function ctxAway(e) { const m = document.getElementById('ctxMenu'); if (m && !m.contains(e.target)) closeCtx(); }
app.openCtx = (x, y, type, id) => {
  closeCtx();
  if (type && id && !app.isSel(type, id)) app.select({ type, id });
  const list = app.selList(), one = list.length === 1 ? selected(list[0].type) : null, n = list.length;
  const hasVid = !!one && (list[0].type === 'clip' || list[0].type === 'overlay') && one.kind === 'video' && one.hasAudio !== false && !one.muted;
  const rows = [
    ['Cut', 'cut', 'Ctrl+X', n > 0], ['Copy', 'copy', 'Ctrl+C', n > 0], ['Paste', 'paste', 'Ctrl+V', !!app.clipboard], ['Paste look', 'pasteLook', 'Ctrl+Shift+V', !!app.clipboard && n > 0], null,
    ['Duplicate', 'duplicate', 'Ctrl+D', n > 0], ['Split at playhead', 'split', 'S', true], null, // Delete lives only on the timeline toolbar (and the Del key)
    ['Detach audio', 'detachAudio', '', hasVid], ['Mute / unmute sound', 'muteSel', '', n > 0], null,
    ['Select all', 'selectAll', 'Ctrl+A', true],
  ];
  const m = el('div', { id: 'ctxMenu', class: 'ctx-menu', role: 'menu', 'aria-label': n > 1 ? n + ' items' : 'Timeline item' });
  for (const r of rows) {
    if (!r) { m.appendChild(el('i', { class: 'ctx-sep', role: 'separator' })); continue; }
    const b = el('button', { type: 'button', role: 'menuitem', class: 'ctx-item' + (r[3] ? '' : ' is-off'), 'aria-disabled': r[3] ? 'false' : 'true' }, el('span', { text: r[0] }), el('kbd', { text: r[2] }));
    b.onclick = () => { closeCtx(); if (r[3]) actions[r[1]](b); else toast(r[1] === 'detachAudio' ? 'Select one video clip or overlay that has sound.' : 'Nothing to do here yet.'); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
  const first = m.querySelector('.ctx-item:not(.is-off)'); if (first) first.focus({ preventScroll: true });
  m.addEventListener('keydown', (e) => {
    const items = [...m.querySelectorAll('.ctx-item')], i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(); }
  });
  setTimeout(() => document.addEventListener('pointerdown', ctxAway, true), 0);
};

// tabs
let wsLayout = null; // workspace layout (js/layout-ui.js): library dock on the left, properties on the right, only on wide windows
function showTab(name, src) {
  if (wsLayout && wsLayout.active) wsLayout.showTab(name, src === 'select');
  else {
    qsa('.tabs button').forEach(x => { const on = x.dataset.tab === name; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; });
    qsa('.tab-panel').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
    const act = qs('.tabs button.active'); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (app.timeline) app.timeline.render(); // the join markers show which join the Transitions tab is editing
  if (name === 'look') { flUI.render(); fxUI.render(); } // draws the effect previews the first time the tab is shown
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

/** Media bin: put a file that is already in this project onto the timeline again (clips/photos at the end, music at the playhead). */
async function addMediaToTimeline(id) {
  const m = await media.get(id);
  if (!m) { toast('That file is no longer stored on this device. Add it again with ＋ Media.'); return; }
  const p = app.project;
  if (m.kind === 'audio') { const a = newAudio(m, player.t < layout(p).total - 0.5 ? player.t : 0); p.audio.push(a); app.selection = { type: 'audio', id: a.id }; }
  else { const c = newClipFromMedia(m, p.settings); p.clips.push(c); app.selection = { type: 'clip', id: c.id }; }
  app.commit('Add from media bin'); if (timeline.autoFit) timeline.fit();
  toast('“' + (m.name || 'File').replace(/\.[^/.]+$/, '') + '” added');
}
// wide windows get the workspace layout (library | preview | properties, timeline below); narrow ones keep the original layout
wsLayout = initLayout({
  $, qs, qsa, app, media, addToTimeline: addMediaToTimeline,
  resized: () => { sizeStage(); if (timeline.autoFit) timeline.fit(); },
  afterToggle: (isOn) => {
    if (isOn) return;
    const t = app.selection && ({ clip: 'clip', text: 'text', audio: 'audio', overlay: 'pip', blur: 'look', caption: 'captions' })[app.selection.type];
    showTab(t || wsLayout.leftName || 'clip');
  },
});
app.layout = wsLayout;
wsLayout.start();
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
{ // the project-wide filter picker uses the same library as the Looks tab
  const sel = $('globalFilter'); if (sel) sel.append(el('option', { value: 'none', text: 'None' }));
  if (sel) for (const g of FILTER_GROUPS) { const og = el('optgroup', { label: g }); for (const f of FILTERS.filter(x => x.group === g)) og.append(el('option', { value: f.id, text: f.label })); sel.append(og); }
}
for (const [k, v] of Object.entries(FONTS)) { $('fontSelect').append(el('option', { value: k, text: v.label })); }

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


// ---------------------------------------------------------------- blur box on the preview (drag to move, handles to resize)
const blurBox = $('blurBox');
/** What the on-preview box edits right now: the selected blur region, or the sharp area of the selected clip's background blur. */
function blurTarget() {
  const b = selected('blur');
  if (b) {
    const len = b.end - b.start, raw = player.t - b.start, local = clamp(raw, 0, len), A = animated('blur', b, local);
    return { kind: 'blur', item: b, start: b.start, len, local, inside: raw >= -1e-4 && raw <= len + 1e-4, x: A.x, y: A.y, w: A.w, h: A.h, shape: b.shape, invert: b.invert, label: b.invert ? 'Sharp area' : b.mode === 'pixelate' ? 'Pixelate' : 'Blur' };
  }
  const c = selected('clip');
  if (c && c.blur && c.blur.enabled && c.blur.keep) {
    const cb = c.blur;
    return { kind: 'clip', item: c, x: cb.x, y: cb.y, w: cb.w, h: cb.h, shape: cb.shape, invert: true, inside: true, label: 'Sharp area' };
  }
  return null;
}
function syncBlurBox() {
  const T = app.project.clips.length && !$('stageWrap').hidden ? blurTarget() : null;
  const blurLayer = $('blurLayer');
  blurLayer.hidden = !T;
  if (!T) return;
  blurLayer.style.left = stage.offsetLeft + 'px'; blurLayer.style.top = stage.offsetTop + 'px';
  blurLayer.style.width = stage.offsetWidth + 'px'; blurLayer.style.height = stage.offsetHeight + 'px';
  const st = blurBox.style;
  st.left = ((T.x - T.w / 2) * 100) + '%'; st.top = ((T.y - T.h / 2) * 100) + '%'; st.width = (T.w * 100) + '%'; st.height = (T.h * 100) + '%';
  blurBox.classList.toggle('ellipse', T.shape === 'ellipse'); blurBox.classList.toggle('invert', !!T.invert);
  blurBox.style.opacity = T.inside ? '' : '0.55';
  const tag = $('blurTag'); if (tag.textContent !== T.label) tag.textContent = T.label;
}
(() => {
  let d = null, refresh = false;
  const MIN = 0.03;
  const apply = (T, x, y, w, h) => {
    x = clamp(x, -0.5, 1.5); y = clamp(y, -0.5, 1.5); w = clamp(w, MIN, 3); h = clamp(h, MIN, 3);
    if (T.kind === 'blur') {
      const it = T.item;
      for (const [k, v] of [['x', x], ['y', y], ['w', w], ['h', h]]) { if (hasKeyframes(it, k)) setKeyframe(it, k, T.local, v); else it[k] = v; }
    } else Object.assign(T.item.blur, { x, y, w, h });
  };
  const soon = () => { if (refresh) return; refresh = true; requestAnimationFrame(() => { refresh = false; syncBlurBox(); fillInspector(); }); };
  blurBox.addEventListener('pointerdown', (e) => {
    const T = blurTarget(); if (!T) return;
    e.preventDefault(); e.stopPropagation();
    if (player.playing) player.pause();
    if (T.kind === 'blur' && !T.inside) { player.setTime(T.start + clamp(player.t - T.start, 0.01, Math.max(0.01, T.len - 0.01))); }
    const T2 = blurTarget(), h = e.target.closest('.bh');
    const r = stage.getBoundingClientRect();
    d = { T: T2, hd: h ? h.dataset.h.split(',').map(Number) : null, x0: e.clientX, y0: e.clientY, w: r.width, h: r.height, o: { x: T2.x, y: T2.y, w: T2.w, h: T2.h }, moved: false, id: e.pointerId };
    try { blurBox.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    blurBox.focus({ preventScroll: true });
  });
  blurBox.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dx = (e.clientX - d.x0) / d.w, dy = (e.clientY - d.y0) / d.h, o = d.o;
    if (Math.abs(dx) + Math.abs(dy) > 0.003) d.moved = true;
    if (!d.moved) return;
    let { x, y, w, h } = o;
    if (!d.hd) {
      x = o.x + dx; y = o.y + dy;
      if (Math.abs(x - 0.5) < 0.012) x = 0.5; if (Math.abs(y - 0.5) < 0.012) y = 0.5; // snap to the center lines
    } else {
      const [hx, hy] = d.hd;
      if (hx) { let a = o.x - o.w / 2, b = o.x + o.w / 2; if (hx > 0) b += dx; else a += dx; if (b - a < MIN) { if (hx > 0) b = a + MIN; else a = b - MIN; } x = (a + b) / 2; w = b - a; }
      if (hy) { let a = o.y - o.h / 2, b = o.y + o.h / 2; if (hy > 0) b += dy; else a += dy; if (b - a < MIN) { if (hy > 0) b = a + MIN; else a = b - MIN; } y = (a + b) / 2; h = b - a; }
    }
    apply(d.T, x, y, w, h);
    d.T = { ...d.T, x, y, w, h };
    player.requestRender(); syncBlurBox(); soon();
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const wasMoved = d.moved, hd = d.hd, kind = d.T.kind; d = null;
    if (wasMoved) app.commit(hd ? 'Resize blur region' : 'Move blur region');
    void kind;
  };
  blurBox.addEventListener('pointerup', end); blurBox.addEventListener('pointercancel', end);
  blurBox.addEventListener('keydown', (e) => {
    const T = blurTarget(); if (!T || !e.key.startsWith('Arrow')) return;
    e.preventDefault(); e.stopPropagation();
    if (T.kind === 'blur' && !T.inside) return;
    const step = e.shiftKey ? 0.02 : 0.005, dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0, dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
    if (e.altKey) apply(T, T.x, T.y, T.w + dx * 2, T.h + dy * 2); else apply(T, T.x + dx, T.y + dy, T.w, T.h);
    app.commit('Adjust blur region'); blurBox.focus({ preventScroll: true });
  });
})();

// ---------------------------------------------------------------- projects
/** Free memory held for media the open project no longer uses (object URLs, decoded images, GIF frames). */
function releaseUnusedMedia() {
  const keep = new Set([...mediaIdsOf(app.project), ...app.history.mediaIds()]);
  media.retain(keep);
  if (thumb.v) { thumb.v.removeAttribute('src'); thumb.v.load(); delete thumb.v.dataset.url; }
  for (const v of thumb.ov.values()) { v.removeAttribute('src'); v.load(); }
  thumb.ov.clear();
  designer.reset();
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
  app.project = newProject(cleanProjectName(name) || defaultProjectName());
  app.selection = null; app.history.reset(app.project);
  releaseUnusedMedia();
  await saveNow();
  renderAll(); player.setTime(0);
  refreshCaps();
}
app.openProject = openProject;
/** "Sep 29, 8:52 PM" (locale aware); the year only for another year. */
function editedLabel(t) {
  const d = new Date(t || Date.now()), o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  try { return new Intl.DateTimeFormat(undefined, o).format(d).replace(/[\u202f\u00a0]/g, ' '); } catch { return d.toLocaleString(); }
}
// Header project name: tap the name (or the pencil) to edit in place. Enter / leaving the field saves, Esc cancels,
// empty falls back to the dated default name, 80 characters at most. One undo step.
(() => {
  const wrap = $('pnameWrap'), btn = $('projectNameBtn'), inp = $('projectNameInput'), pen = $('renameProjectBtn');
  let cancelled = false, editing = false;
  const stop = () => { editing = false; inp.hidden = true; btn.hidden = false; pen.hidden = false; wrap.classList.remove('editing'); };
  const start = () => {
    if (editing) return; editing = true; cancelled = false;
    inp.value = app.project.name; btn.hidden = true; pen.hidden = true; inp.hidden = false; wrap.classList.add('editing');
    inp.focus(); inp.select();
  };
  const save = () => {
    if (!editing) return;
    const n = cleanProjectName(inp.value) || defaultProjectName(app.project.created);
    stop();
    if (n !== app.project.name) { app.project.name = n; app.commit('Rename project'); toast('Project renamed'); }
    btn.focus();
  };
  btn.addEventListener('click', start); pen.addEventListener('click', start);
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; stop(); btn.focus(); }
  });
  inp.addEventListener('blur', () => { if (editing && !cancelled) save(); });
  app.editProjectName = start;
})();
async function renderProjectList() {
  const list = $('projectList'); list.replaceChildren();
  const projects = await db.listProjects();
  for (const p of projects) {
    const first = p.clips && p.clips[0];
    let thumb = '';
    if (first) { const m = await media.get(first.mediaId); thumb = m && m.strip ? m.strip[0] : ''; }
    const dur = layout(migrate(p)).total;
    const shown = p.id === app.project.id ? app.project.name : fixedProjectName(p);
    const card = el('div', { class: 'project-card' + (p.id === app.project.id ? ' current' : ''), 'aria-current': p.id === app.project.id ? 'true' : null },
      el('div', { class: 'pthumb', style: thumb ? { backgroundImage: `url(${thumb})` } : {} }),
      el('div', {},
        el('h3', { title: shown }, shown, p.id === app.project.id ? el('span', { class: 'ptag', text: 'Current' }) : null),
        el('div', { class: 'pmeta', text: `${(p.clips || []).length} ${(p.clips || []).length === 1 ? 'clip' : 'clips'} · ${fmt(dur)}` }),
        el('div', { class: 'pmeta', text: 'Last edited ' + editedLabel(p.updated) }),
        el('div', { class: 'button-row' },
          el('button', { class: 'btn primary small', type: 'button', text: p.id === app.project.id ? 'Open (current)' : 'Open', onclick: async () => { await openProject(p.id); closeDialog('projectsDialog'); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Rename', onclick: async () => { const n0 = prompt('Project name', shown); if (n0 === null) return; const n = cleanProjectName(n0) || defaultProjectName(p.created || p.updated); if (p.id === app.project.id) { app.project.name = n; app.commit('Rename project'); await saveNow(); } else { p.name = n; p.updated = Date.now(); await db.saveProject(p); } renderProjectList(); renderAll(); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Duplicate', onclick: async () => { if (p.id === app.project.id) await saveNow(); const src = p.id === app.project.id ? JSON.parse(JSON.stringify(app.project)) : p; const c = { ...deepClone(src), id: uid('prj'), name: src.name + ' copy', created: Date.now(), updated: Date.now() }; await db.saveProject(c); renderProjectList(); toast('Project duplicated'); } }),
          el('button', { class: 'btn secondary small', type: 'button', text: 'Back up project', title: 'Save project file (.vedit)', onclick: () => exportProjectFile(p.id) }),
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
$('newProject').onclick = async () => { const n = prompt('Name your new project (leave empty for the date)', defaultProjectName()); if (n === null) return; await createProject(cleanProjectName(n) || defaultProjectName()); closeDialog('projectsDialog'); toast('New project created'); };
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
  toast(embed ? 'Project file saved with media (.vedit)' : 'Project file saved (media stays on this device)');
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
    p.id = uid('prj'); p.updated = Date.now(); // (migrate already gave a placeholder name a dated one)
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
const thumb = { canvas: $('thumbCanvas'), comp: new Compositor(), v: null, ov: new Map() };
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
  for (const b of p.blurs || []) { b.fadeIn = 0; b.fadeOut = 0; } // ...and blur / privacy regions at full strength
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
    src = await thumbVideoAt(thumb.v, url, sourceTime(it, t));
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
  const single = { ...lay, items: [{ ...it, xIn: 0, xOut: 0, fadeInBlack: 0, fadeOutBlack: 0 }] };
  thumb.comp.render(c.getContext('2d'), F.width, F.height, p, single, tt, () => src, { getOverlaySource: (o) => ovSrc.get(o.id) || null, noCaptions: true });
  return c;
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
    openDialog('thumbDialog');
    await Promise.race([designer.open(), new Promise((_, rej) => setTimeout(() => rej(new Error('The frame took too long to load')), 25000))]);
  } catch (e) {
    console.warn('Thumbnail maker', e);
    toast('Could not prepare the thumbnail frame: ' + (e && e.message ? e.message : 'unknown error') + '. Try another frame.');
    if (!$('thumbDialog').open) { try { openDialog('thumbDialog'); } catch { /* dialog unsupported */ } }
  } finally { thumbOpening = false; }
}
$('thumbBtn').onclick = openThumb;
const designer = initDesigner({
  $, app, media, getFrame: thumbFrame, fmt: thumbFmt, autoFmt: () => thumbFormat(app.project, 'auto'), scheduleSave, toast,
  playhead: () => player.t, duration: () => layout(app.project).total, fmtTime: fmt,
});
$('thumbDialog').addEventListener('close', () => designer.close());
const YT_THUMB_LIMIT = 2 * 1024 * 1024;
/** Render the thumbnail to a file (JPG kept under YouTube's 2 MB, or PNG). Returns { blob, note, name, F } or null after a toast. */
async function makeThumbFile() {
  try { await designer.render(false); } catch (e) { toast('Could not create thumbnail: ' + (e && e.message || 'error')); return null; }
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
  if (!blob) { toast('Could not create thumbnail.'); return null; }
  return { blob, note, F, name: `${exportBaseName(app.project)}-thumbnail-${F.short}-${F.width}x${F.height}.${P.type === 'png' ? 'png' : 'jpg'}` };
}
$('thumbSave').onclick = async () => {
  const t = await makeThumbFile(); if (!t) return;
  download(t.blob, t.name);
  toast(`${t.F.label} thumbnail saved (${fmtBytes(t.blob.size)}, ${t.F.width}×${t.F.height}).${t.note}`);
};
$('thumbShare').onclick = async () => {
  const t = await makeThumbFile(); if (!t) return;
  const r = await shareOrDownload([new File([t.blob], t.name, { type: t.blob.type })], { title: t.name, download });
  if (r === 'downloaded') toast(`Sharing is not available here, so the thumbnail was saved instead (${fmtBytes(t.blob.size)}).${t.note}`, 4000);
  else if (r === 'shared') toast('Thumbnail shared');
};
app.thumbRefresh = () => designer.render(true);
app.designer = designer;

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
    $('shareExport').onclick = async () => {
      const r = await shareOrDownload([file], { title: p.name, download });
      if (r === 'downloaded') toast('Sharing is not available here, so the video was saved instead.', 4000); else if (r === 'shared') toast('Video shared');
    };
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

// ---------------------------------------------------------------- save audio (Export audio only: the whole timeline's sound as a file)
const bind = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); }; // (a stale cached page may lack the element: skip, never throw)
let extractJob = null; // { abort, kind } while running
let extractSrc = null; // what the dialog is about: { title, name, run(opts) -> result, trimText? }
let lastExtract = null;

// ---------------------------------------------------------------- captions (tab, SRT, find/replace, auto-transcribe)
for (const k of FONT_KEYS) $('capFontSelect')?.append(el('option', { value: k, text: FONTS[k].label }));
const sortedCaptions = () => [...(app.project.captions || [])].sort((a, b) => a.start - b.start);
/** Re-split every caption to the style's words-per-caption (text is kept; word timings are carried along). */
function resplitCaptions() {
  const p = app.project, n0 = p.captions.length; if (!n0) return;
  p.captions = rechunk(p.captions, { maxWords: p.captionStyle.maxWords });
  if (app.selection && app.selection.type === 'caption' && !selected('caption')) app.selection = null;
  toast('Captions re-split into ' + p.captions.length + ' (about ' + p.captionStyle.maxWords + ' words each). Undo (Ctrl+Z) brings the old split back.', 4500);
}

function syncDuckControls() {
  const a = selected('audio'), box = $('duckControls');
  if (!box) return;
  if (!a) { box.hidden = true; return; }
  normalizeDuck(a);
  box.hidden = !a.duck;
  const set = (id, v, out, fmt) => { const e = $(id), o = $(out); if (!e) return; if (document.activeElement !== e) e.value = v; if (o) o.textContent = fmt(v); };
  set('duckDb', a.duckDb, 'duckDbOut', (v) => (+v).toFixed(0) + ' dB');
  set('duckAttack', a.duckAttack, 'duckAttackOut', (v) => (+v).toFixed(2) + ' s');
  set('duckRelease', a.duckRelease, 'duckReleaseOut', (v) => (+v).toFixed(2) + ' s');
  const tr = $('duckTrigger'); if (tr && document.activeElement !== tr) tr.value = a.duckTrigger || 'any';
}
function fillCaptionsPanel() {
  if (!$('capPanel')) return; // (a stale cached page)
  const p = app.project, n = (p.captions || []).length, c = selected('caption');
  $('capPanel').hidden = !c;
  $('capEmptyHint').hidden = n > 0;
  $('capCount').textContent = n ? n + (n === 1 ? ' caption' : ' captions') : '';
  $('transBtn').textContent = n ? '↻ Re-transcribe…' : '✨ Generate…';
  for (const b of qsa('#capPresets button')) b.classList.toggle('selected', b.dataset.preset === p.captionStyle.preset);
  if (txUI) txUI.render();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#capPresets button'); if (!b) return;
  const p = app.project, before = p.captionStyle.maxWords;
  p.captionStyle = applyPreset(p.captionStyle, b.dataset.preset);
  if (p.captionStyle.maxWords !== before) resplitCaptions();
  app.commit('Caption style');
});
actions.addCaption = function addCaption() {
  const p = app.project, total = layout(p).total;
  if (!p.clips.length) return toast('Add a video first, then add captions at the playhead.', 4000);
  if (p.captions.length >= MAX_CAPTIONS) return toast('That is the maximum number of captions.', 4000);
  let start = Math.min(player.t, Math.max(0, total - 0.5));
  const here = p.captions.find(c => start >= c.start && start < c.end); if (here) start = here.end; // never on top of another
  const next = sortedCaptions().find(c => c.start > start + 0.05);
  let end = start + 2; if (next && next.start < end) end = Math.max(start + 0.3, next.start);
  const c = newCaption(start, end, 'New caption');
  p.captions.push(c); app.selection = { type: 'caption', id: c.id };
  app.commit('Add caption'); player.setTime(c.start + 0.01); timeline.reveal(c.start); showTab('captions');
  const ta = qs('[data-bind="cap.text"]'); if (ta && !matchMedia('(pointer:coarse)').matches) { ta.focus(); ta.select(); }
};
function stepCaption(dir) {
  const list = sortedCaptions(); if (!list.length) return toast('No captions yet.');
  const cur = selected('caption');
  const ref = cur ? cur.start : player.t - (dir > 0 ? 0 : 1e-3);
  const hit = dir > 0 ? list.find(c => c.start > ref + (cur ? 1e-6 : 1e-3)) : [...list].reverse().find(c => c.start < ref - (cur ? 1e-6 : 0));
  if (!hit) return toast(dir > 0 ? 'That is the last caption.' : 'That is the first caption.', 1800);
  app.select({ type: 'caption', id: hit.id }, { seekInto: true });
}
actions.capPrev = () => stepCaption(-1);
actions.capNext = () => stepCaption(1);
actions.downloadSrt = function downloadSrt() {
  const p = app.project; if (!p.captions.length) return toast('No captions to download yet.');
  const name = safeName(p.name, 'captions') + '.srt';
  download(new File([formatSrt(p.captions)], name, { type: 'application/x-subrip' }), name);
  toast('Saved ' + name, 3000);
};
actions.clearCaptions = function clearCaptions() {
  const p = app.project, n = p.captions.length; if (!n) return toast('There are no captions to clear.');
  if (!confirm('Remove all ' + n + ' captions? You can undo this (Ctrl+Z).')) return;
  p.captions = []; if (app.selection && app.selection.type === 'caption') app.selection = null;
  app.commit('Clear captions'); toast('Captions cleared. Undo brings them back.', 3500);
};
actions.capReplaceAll = function capReplaceAll() {
  const find = $('capFind').value.trim(), rep = $('capReplace').value;
  if (!find) return toast('Type the word to find first.');
  const re = new RegExp('(^|[^\\p{L}\\p{N}])' + find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu');
  let n = 0;
  for (const c of app.project.captions) {
    const t = c.text.replace(re, (_m, pre) => { n++; return pre + rep; });
    if (t !== c.text) { c.text = t.replace(/\s+/g, ' ').trim(); reconcileWords(c); }
  }
  $('capFixOut').textContent = n ? n + (n === 1 ? ' fix made.' : ' fixes made.') : 'Not found.';
  if (n) app.commit('Replace in captions');
};
bind('srtInput', 'change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 20e6) return toast('That file is too large to be a subtitle file.', 4000);
  const { captions: list, skipped } = parseSrt(await f.text());
  if (!list.length) return toast('No captions found in “' + f.name + '”. It should be an .srt (or .vtt) subtitle file.', 5000);
  const p = app.project;
  if (p.captions.length && !confirm('Replace the ' + p.captions.length + ' captions you have with the ' + list.length + ' from “' + f.name + '”? You can undo this.')) return;
  p.captions = list.slice(0, MAX_CAPTIONS); app.selection = null;
  app.commit('Import captions'); toast(list.length + ' captions imported from “' + f.name + '”' + (skipped ? ' (' + skipped + ' unreadable skipped)' : '') + '.', 4000);
});

// ---- auto-transcribe dialog
let transJob = null, transScope = null;
const fmtEta = (s) => s == null || !isFinite(s) ? '' : s < 90 ? Math.max(1, Math.round(s)) + ' s left' : Math.round(s / 60) + ' min left';
const isPhone = () => matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 700;
function transSelection() {
  const s = app.selection, item = s && selected(s.type), lay = layout(app.project);
  if (!item) return null;
  if (s.type === 'clip') { const it = lay.items.find(i => i.clip.id === item.id); return it && it.clip.kind === 'video' && it.clip.hasAudio !== false ? { start: it.start, end: it.end, name: item.name } : null; }
  if (s.type === 'overlay') return item.kind === 'video' && item.hasAudio !== false ? { start: item.start, end: Math.min(lay.total, item.start + overlayLen(item)), name: item.name } : null;
  if (s.type === 'audio') return { start: item.start, end: Math.min(lay.total, item.start + audioSpan(item, lay.total)), name: item.name };
  return null;
}
let transCached = false;
async function refreshTransNote() {
  const model = $('tdModel').value, lang = $('tdLang').value, repo = trans.repoFor(model, lang), m = trans.MODELS[model];
  const cached = transCached = await trans.isModelCached(repo);
  $('tdNote').textContent = cached
    ? 'Already on this device (' + m.note + '), so it works offline and nothing is downloaded. Your audio never leaves this device.'
    : 'First time only: downloads about ' + m.mb + ' MB (' + m.note + ') plus a ' + trans.RUNTIME_MB + ' MB speech engine. It is kept on this device so it works offline afterwards. Your audio never leaves this device.';
  $('tdGo').textContent = cached ? 'Start' : 'Download ' + (m.mb + trans.RUNTIME_MB) + ' MB & start';
  $('tdFree').hidden = !(await trans.anyModelCached());
}
function refreshTransWarn() {
  const sc = $('tdSelOnly').checked && transScope ? transScope : null, total = layout(app.project).total;
  const dur = sc ? sc.end - sc.start : total;
  const speed = trans.hooks.engine ? 1 : isPhone() ? 4 : 12; // speech finder skips quiet stretches; several engines share the work
  const warn = $('tdWarn');
  const slow = dur > 600 && isPhone() || dur > 2400;
  warn.hidden = !slow && dur < 900;
  warn.textContent = isPhone() && dur > 600
    ? 'This is ' + fmtDuration(dur) + ' of audio. On a phone it can take roughly ' + Math.round(dur / speed / 60) + '+ min and the screen must stay on. A laptop is much faster: use Fast quality, or generate on a laptop and import the .srt here.'
    : 'This is ' + fmtDuration(dur) + ' of audio. It can take roughly ' + Math.max(1, Math.round(dur / speed / 60)) + ' min on this device. Keep this window open.';
}
actions.transcribe = async function transcribeAction() {
  if (transJob) return openDialog('transDialog');
  const p = app.project;
  if (!p.clips.length) return toast('Add a video first, then generate captions from its speech.', 4000);
  if (!trans.hooks.engine && typeof Worker === 'undefined') return toast('This browser can’t run the speech engine.', 5000);
  const total = layout(p).total;
  if (!layout(p).items.some(i => i.clip.kind === 'video' && i.clip.hasAudio !== false && !i.clip.muted) && !(p.audio || []).some(a => a.voice && !a.muted)) return toast('There is no speech to caption: the clips are silent, muted or photos. (Voice and detached audio tracks count.)', 6000);
  transScope = transSelection();
  const n = p.captions.length;
  $('tdSource').textContent = (n ? 'This replaces the ' + n + ' captions you have now (undo brings them back). ' : '') + 'Speech from your clips, voiceovers and detached audio (' + fmt(total) + '). Music is ignored.';
  $('tdSelRow').hidden = !transScope; $('tdSelOnly').checked = false;
  if (transScope) $('tdSelText').textContent = 'Only “' + (transScope.name || 'the selected item') + '” (' + fmt(transScope.start) + ' – ' + fmt(transScope.end) + '). Other captions stay.';
  $('tdOptions').hidden = false; $('tdProgress').classList.remove('show'); $('tdBar').style.width = '0%';
  $('tdGo').disabled = false; $('tdGo').classList.remove('busy'); $('tdCancel').textContent = 'Cancel';
  refreshTransWarn(); await refreshTransNote();
  openDialog('transDialog');
};
bind('tdModel', 'change', () => { refreshTransNote(); try { localStorage.setItem('ve-trans-model', $('tdModel').value); } catch { /* optional */ } });
bind('tdLang', 'change', () => { refreshTransNote(); try { localStorage.setItem('ve-trans-lang', $('tdLang').value); } catch { /* optional */ } });
bind('tdSelOnly', 'change', refreshTransWarn);
bind('tdCustom', 'change', () => { try { localStorage.setItem('ve-trans-words', $('tdCustom').value); } catch { /* optional */ } });
(() => {
  if ($('tdModel')) for (const [k, m] of Object.entries(trans.MODELS)) $('tdModel').append(el('option', { value: k, text: m.label + ' (' + m.mb + ' MB' + (k === 'fast' ? ', best on phones' : ', slower') + ')' }));
  if ($('tdLang')) for (const [k, l] of trans.LANGUAGES) $('tdLang').append(el('option', { value: k, text: l }));
  try { const m = localStorage.getItem('ve-trans-model'), l = localStorage.getItem('ve-trans-lang'), w = localStorage.getItem('ve-trans-words'); if (trans.MODELS[m]) $('tdModel').value = m; if (l && [...$('tdLang').options].some(o => o.value === l)) $('tdLang').value = l; if (w) $('tdCustom').value = w; } catch { /* optional */ }
})();
bind('tdFree', 'click', async () => { if (await trans.clearModels()) { toast('Downloaded speech models removed.', 3000); refreshTransNote(); } });
bind('tdGo', 'click', async () => {
  if (transJob) return;
  const p = app.project, ctl = new AbortController();
  const model = $('tdModel').value, language = $('tdLang').value, custom = $('tdCustom').value;
  const scope = $('tdSelOnly').checked && transScope ? { start: transScope.start, end: transScope.end } : null;
  let engine = null;
  transJob = { abort: () => { ctl.abort(); try { engine && engine.terminate(); } catch { /* gone */ } } };
  $('tdOptions').hidden = true; $('tdProgress').classList.add('show'); $('tdGo').disabled = true; $('tdGo').classList.add('busy'); $('tdFree').hidden = true;
  const set = (f, txt, right) => { $('tdBar').style.width = Math.round(clamp(f, 0, 1) * 100) + '%'; $('tdStatus').textContent = txt; $('tdPercent').textContent = right != null ? right : Math.round(clamp(f, 0, 1) * 100) + '%'; };
  set(0, 'Starting…');
  try { await navigator.wakeLock?.request('screen').then(l => (app._wakeT = l)); } catch { /* optional */ }
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  const t0 = performance.now();
  try {
    const words = await trans.transcribe({
      project: p, media, range: scope, language, model, custom, signal: ctl.signal, setEngine: (e) => { engine = e; },
      onProgress: (m) => {
        if (m.phase === 'download') set(m.frac, m.bytes && !transCached ? 'Downloading the speech model… ' + (m.bytes / 1048576).toFixed(0) + ' of ~' + (m.totalBytes / 1048576).toFixed(0) + ' MB' : 'Loading the speech model…');
        else if (m.phase === 'load') set(1, 'Getting ready…', '');
        else set(m.frac, 'Listening… ' + fmt(m.doneSec) + ' of ' + fmt(m.totalSec) + (m.etaSec != null && m.frac < 1 ? ' · ' + fmtEta(m.etaSec) : ''));
      },
    });
    if (ctl.signal.aborted) throw new trans.TranscribeCancelled();
    if (!words.length) { $('tdStatus').textContent = 'No speech was found.'; toast('No speech was found, so no captions were made. Check that the clip has audible speech.', 6000); return; }
    const made = trans.wordsToCaptions(words, p.captionStyle.maxWords);
    const keep = scope ? p.captions.filter(c => c.end <= scope.start + 1e-3 || c.start >= scope.end - 1e-3) : [];
    p.captions = [...keep, ...made].sort((a, b) => a.start - b.start).slice(0, MAX_CAPTIONS);
    p.captionStyle.show = true; app.selection = null;
    app.commit('Generate captions');
    set(1, 'Done', '100%');
    closeDialog('transDialog'); showTab('captions');
    if (app.shortsAfterCaptions) { app.shortsAfterCaptions = false; setTimeout(() => actions.shorts(), 250); }
    const secs = Math.round((performance.now() - t0) / 1000);
    toast(made.length + ' captions made in ' + (secs < 90 ? secs + ' s' : Math.round(secs / 60) + ' min') + '. Tap one on the timeline to fix a word. Names may need a check.', 7000);
  } catch (e) {
    if (e instanceof trans.TranscribeCancelled || ctl.signal.aborted) { toast('Captions cancelled. Nothing was changed.', 3500); closeDialog('transDialog'); }
    else {
      console.warn('Transcribe:', e);
      const offline = !navigator.onLine;
      const msg = (offline ? 'The speech model needs to be downloaded once, and this device is offline. Connect to the internet and try again. ' : 'Could not make captions: ') + (offline ? '' : ((e && e.message) || e));
      $('tdOptions').hidden = false; $('tdProgress').classList.remove('show'); $('tdWarn').hidden = false; $('tdWarn').textContent = msg; toast(msg, 8000);
    }
  } finally {
    app.shortsAfterCaptions = false; transJob = null; try { app._wakeT && app._wakeT.release(); } catch { /* ignore */ }
    $('tdGo').disabled = false; $('tdGo').classList.remove('busy');
    if ($('transDialog').open && !$('tdOptions').hidden) { refreshTransNote(); }
  }
});
bind('tdCancel', 'click', () => { if (transJob) transJob.abort(); else closeDialog('transDialog'); });
bind('transDialog', 'close', () => { app.shortsAfterCaptions = false; if (transJob) transJob.abort(); });
function openExtractDialog() {
  const S = extractSrc;
  if (!$('extractDialog') || !$('exGo')) return toast('This copy of the page is out of date. Reload it (or close and reopen the app) to use Export audio only.', 6000);
  $('exSource').textContent = S.text;
  $('exTrimRow').hidden = !S.trimText; $('exTrimText').textContent = S.trimText; $('exTrim').checked = true;
  $('exFormat').disabled = false;
  resetExtractUI();
  openDialog('extractDialog');
}
function resetExtractUI() {
  $('exProgress').classList.remove('show'); $('exResult').hidden = true; $('exBar').style.width = '0%'; $('exPercent').textContent = '0%'; $('exStatus').textContent = 'Starting…';
  $('exGo').disabled = false; $('exGo').textContent = 'Save audio'; $('exGo').classList.remove('busy'); $('exCancel').textContent = 'Close';
}
bind('exGo', 'click', async () => {
  if (extractJob || !extractSrc) return; // double taps: one job
  const S = extractSrc;
  const ctl = new AbortController();
  extractJob = { abort: () => ctl.abort() }; updateSummary();
  $('exGo').disabled = true; $('exGo').textContent = 'Saving…'; $('exGo').classList.add('busy'); $('exFormat').disabled = true; $('exCancel').textContent = 'Cancel';
  $('exProgress').classList.add('show'); $('exResult').hidden = true; $('exStatus').textContent = 'Reading the audio…';
  const t0 = performance.now();
  const setP = (f, txt) => { $('exBar').style.width = (f * 100).toFixed(1) + '%'; $('exPercent').textContent = Math.floor(f * 100) + '%'; if (txt) $('exStatus').textContent = txt; };
  try { await navigator.wakeLock?.request('screen').then(l => (app._wakeX = l)); } catch { /* optional */ }
  try {
    const res = await S.run({
      format: $('exFormat').value, trim: !S.trimText || $('exTrim').checked ? S.trim : null, signal: ctl.signal,
      makeSink: (ext) => createSink({ ext }),
      onProgress: (f, txt) => setP(f, txt || (f < 1 ? 'Saving… ' + Math.floor(f * 100) + '%' : 'Finishing…')),
      onWarn: (m) => toast(m, 6000),
    });
    const name = safeName(S.title, 'audio') + '.' + res.ext;
    const file = new File([res.blob], name, { type: res.mime });
    download(file, name);
    if (lastExtract) URL.revokeObjectURL(lastExtract.url);
    lastExtract = { name, url: URL.createObjectURL(file) };
    setP(1, 'Done');
    const how = res.plan ? (res.plan.copy ? ' · copied without re-encoding' : ' · ' + res.plan.codec.toUpperCase()) : '';
    $('exResultText').replaceChildren(el('b', { text: name }), ` · ${fmtBytes(res.blob.size)}${how}`, el('br'), el('span', { class: 'hint', text: (res.plan && res.plan.note ? res.plan.note + ' ' : '') + 'Saved to your downloads · took ' + fmtDuration((performance.now() - t0) / 1000) + '.' }));
    $('exDownload').href = lastExtract.url; $('exDownload').download = name;
    $('exShare').onclick = async () => { const r = await shareOrDownload([file], { title: name, download }); if (r === 'downloaded') toast('Sharing is not available here, so the file was saved instead.', 4000); else if (r === 'shared') toast('Audio shared'); };
    $('exResult').hidden = false; $('exProgress').classList.remove('show');
    toast('Audio saved: ' + name, 4000);
  } catch (e) {
    if (e instanceof ExtractCancelled || (e && e.name === 'ExtractCancelled')) { $('exStatus').textContent = 'Cancelled. Nothing was saved.'; toast('Cancelled'); }
    else {
      (e && e.code ? console.info : console.warn)('Save audio:', e && e.message || e);
      const msg = e && e.code ? e.message : 'Could not save the audio: ' + ((e && e.message) || e);
      $('exStatus').textContent = msg; toast(msg, 6000);
    }
  } finally {
    extractJob = null; try { app._wakeX && app._wakeX.release(); } catch { /* ignore */ }
    $('exGo').disabled = false; $('exGo').textContent = 'Save audio'; $('exGo').classList.remove('busy'); $('exFormat').disabled = false; $('exCancel').textContent = 'Close';
    updateSummary();
  }
});
bind('exCancel', 'click', () => { if (extractJob) extractJob.abort(); else closeDialog('extractDialog'); });
bind('extractDialog', 'close', () => { if (extractJob) extractJob.abort(); }); // closing the sheet cancels the job
bind('exportAudioBtn', 'click', () => {
  const p = app.project; if (!p.clips.length || exporting) return;
  if (extractJob) return openDialog('extractDialog');
  const missing = [...p.clips, ...(p.overlays || [])].filter(c => !media.has(c.mediaId));
  if (missing.length) return toast('Relink missing media before exporting (red clips).');
  extractSrc = {
    title: p.name || 'audio', text: 'The whole timeline’s sound, mixed (volume, fades, speed, music, voiceover) · ' + fmt(layout(p).total) + ' · no picture', trimText: '', trim: null,
    run: (o) => exportTimelineAudio(JSON.parse(JSON.stringify(app.project)), media, o),
  };
  openExtractDialog();
});

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
      // A newer version that is already downloaded is applied by itself while nothing has been edited in this tab (the project is
      // in IndexedDB either way), once per tab session; otherwise the "new version ready" bar asks. Otherwise an installed app
      // keeps running its old cached copy until every window is closed, so a fix never seems to arrive.
      const autoApply = () => {
        let done = false; try { done = sessionStorage.getItem('ve.autoUpdated') === '1'; } catch { /* storage blocked */ }
        if (done || app._updateRequested || app.rev !== 0 || exporting || extractJob || voice.busy || player.playing || !reg.waiting) return false;
        try { sessionStorage.setItem('ve.autoUpdated', '1'); } catch { /* ignore */ }
        app._updateRequested = true; reg.waiting.postMessage({ type: 'SKIP_WAITING' }); return true;
      };
      app.autoApplyUpdate = autoApply;
      if (reg.waiting && hadController && !autoApply()) showUpdate();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller && !autoApply()) showUpdate(); });
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

// ---------------------------------------------------------------- Add media dialog + files shared from other apps
const addMedia = initAddMedia({ importFiles, openDialog, closeDialog });
app.addMedia = addMedia;
const shorts = initShorts({ app, media, db, actions, openDialog, closeDialog, toast, cleanProjectName, openProject, showProjects: () => { renderProjectList(); openDialog('projectsDialog'); } });
app.shorts = shorts; actions.shorts = () => shorts.open();
app.match = initMatch({ app, media, toast, openDialog, closeDialog });
let inboxBusy = null;
/** Take what the service worker stored from the OS share sheet (files, or a link) and put it into the project. */
function consumeInbox() {
  if (inboxBusy) return inboxBusy;
  inboxBusy = (async () => {
    const inbox = await db.inboxAll().catch(() => []);
    if (!inbox.length) return;
    const files = inbox.filter(x => x.blob).map(x => new File([x.blob], x.name || 'shared', { type: x.type || x.blob.type || '' }));
    const link = inbox.find(x => x.link);
    if (files.length) { showTab('clip'); toast(`Received ${files.length} shared file${files.length > 1 ? 's' : ''}…`, 2500); await importFiles(files); }
    if (link && addMedia.receiveLink(link.link)) toast('A link was shared. Tap Import to download it.', 5000);
    await db.inboxDelete(inbox.map(x => x.id)).catch(() => { });
  })().catch(e => { console.warn(e); toast('The shared files could not be added: ' + (e.message || e), 5000); }).finally(() => { inboxBusy = null; });
  return inboxBusy;
}
// The installed app can stay open while another app shares to it (service worker tells us), or be launched with the files (launchQueue).
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'SHARED') consumeInbox(); });
if ('launchQueue' in window) {
  const seen = new Set();
  window.launchQueue.setConsumer(async (lp) => {
    if (!lp || !lp.files || !lp.files.length) return;
    const fs = []; for (const h of lp.files) { try { const f = await h.getFile(); const k = f.name + f.size + f.lastModified; if (!seen.has(k)) { seen.add(k); fs.push(f); } } catch { /* unreadable handle */ } }
    if (fs.length) { showTab('clip'); await importFiles(fs); }
  });
}

async function boot() {
  const theme = await db.kvGet('theme').catch(() => null); if (theme) applyTheme(theme);
  const ripple = await db.kvGet('ripple').catch(() => null); if (ripple === false) { app.rippleEnabled = false; $('rippleBtn').setAttribute('aria-pressed', 'false'); }
  const snap = await db.kvGet('snap').catch(() => null); if (snap === false) { app.snapEnabled = false; $('snapBtn').setAttribute('aria-pressed', 'false'); }
  ensureFonts().then(() => player.requestRender());
  // projects saved as "Untitled project" (or with no name) get a dated name from their created / updated time; other names are untouched
  try { for (const sp of await db.listProjects()) { const fx = fixedProjectName(sp); if (fx !== sp.name) { sp.name = fx; await db.saveProject(sp); } } } catch (e) { console.warn('project name migration', e); }
  const last = await db.kvGet('lastProject').catch(() => null);
  let ok = last ? await openProject(last) : false;
  if (!ok) { const all = await db.listProjects(); if (all.length) ok = await openProject(all[0].id); }
  if (!ok) await createProject();
  const onboarded = await db.kvGet('onboarded').catch(() => true);
  if (!onboarded) { if (app.project.clips.length) db.kvSet('onboarded', true).catch(() => { }); else $('onboard').hidden = false; }
  // files shared to the installed app (Android share sheet → share_target)
  if (new URLSearchParams(location.search).get('shared') === 'error') {
    toast('Nothing usable was shared, or it could not be received. Add your files with ＋ Media instead.', 6000);
    history.replaceState(null, '', location.pathname);
  } else if (new URLSearchParams(location.search).has('shared')) {
    await consumeInbox();
    history.replaceState(null, '', location.pathname);
  }
  db.gc(app.history.mediaIds()).catch(() => { });
  cleanupExports().catch(() => { }); // temporary export files from earlier sessions
  $('saveToDiskRow').hidden = !window.showSaveFilePicker;
  app.ready = true;
  document.documentElement.dataset.ready = '1';
}
boot().catch(e => { console.error(e); toast('Startup problem: ' + e.message); });
