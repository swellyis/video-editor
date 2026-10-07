// Thumbnail designer dialog: tabs (Layouts, Add, Edit, Layers, Backdrop, Look), the canvas with touch-friendly handles (move, resize, rotate), snapping guides,
// its own undo/redo, and saving the design into the project (project.thumb.designs[format]). The drawing itself is js/designer.js, so the preview is exactly the export.
import { FONTS, effectiveColor, colorIsNeutral } from './model.js';
import { ColorGL, drawLogo } from './render.js';
import { FILTERS, GROUPS, filterInfo } from './filters.js';
import {
  MAX_LAYERS, SAFE, DURATION_BADGE, STICKERS, SHAPES, VECTOR_STICKERS, TEMPLATES, normDesign, cloneDesign, templateDesign, legacyDesign,
  newText, newShape, newSticker, newImage, newId, layerBox, hitLayer, aabb, snapBox, renderDesign, defaultBg, defaultAdjust,
} from './designer.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ICON = { text: 'T', shape: '◼', sticker: '★', image: '🖼' };
const SHAPE_LABEL = { rect: 'Rectangle', round: 'Rounded', ellipse: 'Circle', triangle: 'Triangle', line: 'Line', arrow: 'Arrow' };
const STICKER_SVG = {
  cross: '<svg viewBox="-10 -10 20 20"><path d="M-2.6-9h5.2v5h5v5.2h-5V9h-5.2V1.2h-5V-4h5z"/></svg>',
  burst: '<svg viewBox="-10 -10 20 20"><path d="M0-10 2.6-6.5 6.5-8 6.6-3.6 10-2 7.8 1.5 9.8 5.5 5.8 6 4.5 10 1.2 8 -2.2 9.8-3.6 6.2-7.8 6.3-6.6 2.2-10-1.2-6.6-3.8-8-8l4.4.4z"/></svg>',
  play: '<svg viewBox="-10 -10 20 20"><circle r="9.5"/><path d="M-3-5 6 0-3 5z" fill="#fff"/></svg>',
  arrow: '<svg viewBox="-10 -10 20 20"><path d="M-10-3H0V-9L10 0 0 9V3H-10z"/></svg>',
};

export function initDesigner(ctx) {
  const { $, app, media, getFrame, fmt, autoFmt, scheduleSave, toast, playhead, duration, fmtTime } = ctx;
  // A stale cached page (old index.html + new scripts) has no designer markup: inert stub instead of throwing; it heals on reload.
  if (!ctx.$('thumbCanvas') || !ctx.$('thumbStage')) { const no = async () => { throw new Error('This page is out of date. Reload the editor.'); }; return { open: no, render: no, close() { }, reset() { }, paint() { }, undo() { }, redo() { }, setTab() { }, select() { }, sync() { }, design: () => null }; }
  const canvas = $('thumbCanvas'), g = canvas.getContext('2d'), stage = $('thumbStage'), selEl = $('thumbSel');
  const meas = document.createElement('canvas').getContext('2d');
  const S = { fk: '16:9', design: null, sel: null, tab: 'templates', hist: [], hi: -1, frame: null, frameKey: '', imgs: new Map(), logoImg: null, drag: null, open: false, inited: false };
  let gl = null, histTimer = 0, histBusy = false;
  const P = () => app.project.thumb;
  const D = () => S.design;
  const layer = (id) => (D() ? D().layers.find(l => l.id === id) : null);
  const cur = () => (S.sel ? layer(S.sel) : null);

  // ------------------------------------------------------------ load / save / history
  function loadDesign() {
    const F = fmt(); S.fk = F.key;
    const stored = P().designs && P().designs[F.key];
    if (stored) S.design = normDesign(stored);
    else if (P().text || P().sub) { S.design = legacyDesign(P(), F.key); fitText(S.design, F); }
    else S.design = normDesign({ bg: defaultBg(), adjust: defaultAdjust(), layers: [] });
    S.sel = null; S.hist = [JSON.stringify(S.design)]; S.hi = 0;
  }
  /** An older project's headline could be any length (the old maker shrank it to fit): shrink the converted text until its block sits inside the safe area. */
  function fitText(d, F) {
    const sf = SAFE[F.key];
    for (const l of d.layers) {
      if (l.type !== 'text') continue;
      for (let i = 0; i < 40; i++) {
        const b = layerBox(meas, l, F.width, F.height), cy = l.y * F.height;
        if ((b.h / 2 <= cy - sf.y && b.h / 2 <= sf.y + sf.h - cy && b.m.lines.length <= 6) || l.size * F.width <= 24) break;
        l.size *= 0.94;
      }
    }
  }
  function persist() {
    const d = D(); if (!d) return;
    if (!P().designs) P().designs = {};
    P().designs[S.fk] = cloneDesign(d);
    const texts = d.layers.filter(l => l.type === 'text'); // the project keeps the first headline for anything that reads thumb.text
    P().text = texts[0] ? texts[0].text : ''; P().sub = texts[1] ? texts[1].text : '';
    scheduleSave();
  }
  function snapshot() {
    clearTimeout(histTimer); histTimer = 0;
    const j = JSON.stringify(D());
    if (j === S.hist[S.hi]) return;
    S.hist.length = S.hi + 1; S.hist.push(j); S.hi++;
    if (S.hist.length > 60) { S.hist.shift(); S.hi--; }
    syncHistButtons();
  }
  const histSoon = () => { clearTimeout(histTimer); histTimer = setTimeout(snapshot, 500); };
  function syncHistButtons() { $('thumbUndo').disabled = S.hi <= 0; $('thumbRedo').disabled = S.hi >= S.hist.length - 1; }
  function goHist(i) {
    if (histBusy) return;
    snapshot(); // flush a pending edit first
    i = clamp(i, 0, S.hist.length - 1); if (i === S.hi) return;
    S.hi = i; S.design = normDesign(JSON.parse(S.hist[i]));
    if (S.sel && !layer(S.sel)) S.sel = null;
    persist(); syncAll(); render(false); syncHistButtons();
  }
  const undo = () => goHist(S.hi - 1), redo = () => goHist(S.hi + 1);
  const touch = () => { persist(); render(false); histSoon(); };       // live edits (sliders, typing)
  const commit = () => { persist(); render(false); snapshot(); };      // discrete edits (buttons)

  // ------------------------------------------------------------ rendering (one pipeline for preview and export)
  let running = null, again = null;
  function render(refetch) {
    if (running) { again = { refetch: !!(again && again.refetch) || !!refetch }; return running; }
    running = (async () => {
      try { let r = refetch; do { again = null; await renderOnce(r); r = again && again.refetch; } while (again); }
      catch (e) { console.warn('Thumbnail render', e); }
      finally { running = null; }
    })();
    return running;
  }
  const withTimeout = (pr, ms) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function loadImg(id) {
    if (!id) return null;
    if (S.imgs.has(id)) return S.imgs.get(id);
    const im = await withTimeout(media.image(id), 8000).catch(() => null);
    if (im) S.imgs.set(id, im);
    return im;
  }
  async function renderOnce(refetch) {
    if (!D()) return;
    const F = fmt(), W = F.width, H = F.height, d = D(), p = P();
    if (d.bg.type === 'frame') {
      const key = [p.time, F.key, p.fit, p.pip].join('|');
      if (refetch || !S.frame || key !== S.frameKey || S.frame.width !== W) { S.frame = await getFrame(p.time, F); S.frameKey = key; }
    }
    for (const l of D().layers) if (l.type === 'image') await loadImg(l.mediaId);
    if (d.bg.type === 'image') await loadImg(d.bg.mediaId);
    S.logoImg = p.logo && app.project.logo ? await loadImg(app.project.logo.mediaId) : null;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    paint(g, W, H, F.key);
    placeOverlays();
  }
  /** Draw the whole thumbnail (also used for export) onto ctx2d. */
  function paint(c2, W, H, fk) {
    const d = D(), col = effectiveColor({}, { color: d.adjust });
    const bgFilter = colorIsNeutral(col) ? null : (cv) => { if (!gl) gl = new ColorGL(); return gl.ok ? gl.process(cv, W, H, col) : null; };
    renderDesign(c2, W, H, d, { frame: S.frame, bgImage: S.imgs.get(d.bg.mediaId) || null, images: S.imgs }, { bgFilter });
    if (S.logoImg && app.project.logo) { // the project logo, placed by its own settings inside the safe area
      const sf = SAFE[fk] || SAFE['16:9']; c2.save(); c2.translate(sf.x, sf.y); drawLogo(c2, sf.w, sf.h, app.project.logo, S.logoImg); c2.restore();
    }
  }

  // ------------------------------------------------------------ overlays: selection box, handles, guides
  const scaleK = () => { const r = canvas.getBoundingClientRect(); return r.width ? r.width / canvas.width : 1; };
  const canvasOff = () => { const r = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: r.left - s.left, y: r.top - s.top }; };
  function placeOverlays() {
    const F = fmt(), k = scaleK(), o = canvasOff(), sf = SAFE[F.key];
    const safe = $('thumbSafe'); safe.style.cssText = `left:${sf.x / F.width * 100}%;top:${sf.y / F.height * 100}%;width:${sf.w / F.width * 100}%;height:${sf.h / F.height * 100}%`;
    const showG = $('thumbGuides').checked;
    safe.hidden = !showG;
    const b = $('thumbBadge'); b.style.cssText = `left:${DURATION_BADGE.x * 100}%;top:${DURATION_BADGE.y * 100}%;width:${DURATION_BADGE.w * 100}%;height:${DURATION_BADGE.h * 100}%`;
    b.hidden = !(showG && F.key === '16:9');
    canvas.dataset.format = F.key;
    const l = cur();
    selEl.hidden = !l;
    if (!l) return;
    const box = layerBox(meas, l, F.width, F.height);
    selEl.style.cssText = `left:${o.x + (box.cx - box.w / 2) * k}px;top:${o.y + (box.cy - box.h / 2) * k}px;width:${box.w * k}px;height:${box.h * k}px;transform:rotate(${l.rot}deg)`;
    selEl.classList.toggle('locked', l.locked);
    for (const h of selEl.querySelectorAll('.th-h')) {
      const t = h.dataset.h;
      h.hidden = (t === 'e' && l.type === 'sticker') || (t === 's' && (l.type === 'text' || l.type === 'sticker'));
    }
  }
  function showGuides(v, h) {
    const k = scaleK(), o = canvasOff(), gv = $('thumbGuideV'), gh = $('thumbGuideH');
    gv.hidden = v == null; gh.hidden = h == null;
    if (v != null) gv.style.left = (o.x + v * k) + 'px';
    if (h != null) gh.style.top = (o.y + h * k) + 'px';
  }
  const toCanvas = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };

  function topHit(p) {
    const F = fmt(), slop = 8 / scaleK();
    for (let i = D().layers.length - 1; i >= 0; i--) {
      const l = D().layers[i];
      if (hitLayer(layerBox(meas, l, F.width, F.height), p.x, p.y, slop)) return l;
    }
    return null;
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !D()) return;
    const F = fmt(), W = F.width, H = F.height, p = toCanvas(e), hEl = e.target.closest('.th-h');
    let l = cur(), kind;
    if (hEl && l && !l.locked) kind = hEl.dataset.h;
    else {
      const hit = topHit(p);
      if (!hit) { if (S.sel) { S.sel = null; syncAll(); placeOverlays(); } return; }
      if (hit.id !== S.sel) { S.sel = hit.id; if (S.tab !== 'edit' && S.tab !== 'layers') setTab('edit'); syncAll(); placeOverlays(); }
      l = hit; if (l.locked) return;
      kind = 'move';
    }
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* optional */ }
    const box = layerBox(meas, l, W, H);
    S.drag = { kind, id: l.id, p0: p, orig: { x: l.x, y: l.y, w: l.w, h: l.h, size: l.size, rot: l.rot }, c: { x: box.cx, y: box.cy }, d0: Math.hypot(p.x - box.cx, p.y - box.cy) || 1, moved: false, pid: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    const dr = S.drag; if (!dr || e.pointerId !== dr.pid) return;
    const l = layer(dr.id); if (!l) return;
    const F = fmt(), W = F.width, H = F.height, p = toCanvas(e), o = dr.orig;
    if (dr.kind === 'move') {
      let dx = p.x - dr.p0.x, dy = p.y - dr.p0.y;
      if (!dr.moved && Math.hypot(dx, dy) * scaleK() < 3) return;
      dr.moved = true;
      l.x = o.x + dx / W; l.y = o.y + dy / H;
      let gv = null, gh = null;
      if (!e.altKey) {
        const box = layerBox(meas, l, W, H);
        const others = D().layers.filter(x => x.id !== l.id).map(x => aabb(layerBox(meas, x, W, H)));
        const s = snapBox(aabb(box), others, W, H, SAFE[F.key], 9 / scaleK());
        l.x += s.dx / W; l.y += s.dy / H; gv = s.v[0] ?? null; gh = s.h[0] ?? null;
      }
      showGuides(gv, gh);
    } else if (dr.kind === 'rot') {
      let a = Math.atan2(p.y - dr.c.y, p.x - dr.c.x) * 180 / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      if (!e.altKey) for (const s of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) if (Math.abs(a - s) < 4) { a = s; break; }
      l.rot = Math.round(a * 10) / 10;
    } else if (dr.kind === 'e' || dr.kind === 's') {
      const r = o.rot * Math.PI / 180, vx = p.x - dr.c.x, vy = p.y - dr.c.y;
      if (dr.kind === 'e') l.w = clamp(2 * Math.abs(vx * Math.cos(r) + vy * Math.sin(r)) / W, 0.03, 3);
      else l.h = clamp(2 * Math.abs(-vx * Math.sin(r) + vy * Math.cos(r)) / H, 0.01, 3);
      dr.moved = true;
    } else { // corner: scale everything together
      const f = clamp(Math.hypot(p.x - dr.c.x, p.y - dr.c.y) / dr.d0, 0.1, 8);
      if (l.type === 'text') { l.size = clamp(o.size * f, 0.01, 0.6); l.w = clamp(o.w * f, 0.03, 3); }
      else { l.w = clamp(o.w * f, 0.01, 3); l.h = clamp(o.h * f, 0.01, 3); }
      dr.moved = true;
    }
    dr.moved = true;
    render(false); syncEditLive(l);
  });
  const endDrag = (e) => {
    const dr = S.drag; if (!dr || (e && e.pointerId !== dr.pid)) return;
    S.drag = null; showGuides(null, null);
    if (dr.moved) commit();
  };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e) => {
    const hit = topHit(toCanvas(e)); if (!hit) return;
    S.sel = hit.id; setTab('edit'); syncAll(); placeOverlays();
    if (hit.type === 'text') { $('thumbText').focus(); $('thumbText').select(); }
  });
  window.addEventListener('resize', () => { if (S.open) placeOverlays(); });

  // ------------------------------------------------------------ tabs
  function setTab(t) {
    S.tab = t;
    for (const b of document.querySelectorAll('#thumbTabs button')) { const on = b.dataset.tab === t; b.classList.toggle('selected', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    for (const id of ['templates', 'add', 'edit', 'layers', 'bg', 'look']) $('thP-' + id).hidden = id !== t;
    if (t === 'templates') drawTemplatePreviews();
  }
  for (const b of document.querySelectorAll('#thumbTabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  // ------------------------------------------------------------ layouts (templates)
  /** A template applied on top of the current design: the layers are replaced; a video/picture backdrop is kept, a template with its own backdrop (quote card) brings it. */
  function applyTpl(cur0, tpl) {
    const d = cloneDesign(cur0);
    d.layers = tpl.layers; d.adjust.darken = tpl.adjust.darken;
    if (tpl.bg.type !== 'frame') d.bg = tpl.bg;
    else if (d.bg.type === 'gradient' || d.bg.type === 'solid') d.bg = { ...defaultBg() }; // layouts made for a photo go back to the video frame
    return normDesign(d);
  }
  const tplFor = (id) => templateDesign(id, S.fk, P().accent || '#df3f34');
  function drawTemplatePreviews() {
    const F = fmt(), box = $('thTemplates'), tw = 240, th = Math.round(240 * F.height / F.width);
    if (!box.children.length) {
      for (const t of TEMPLATES) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'th-tpl'; b.dataset.tpl = t.id; b.setAttribute('aria-label', 'Layout: ' + t.label);
        const cv = document.createElement('canvas'); const s = document.createElement('span'); s.textContent = t.label; b.append(cv, s);
        b.onclick = () => { if (!D()) return; S.design = applyTpl(D(), tplFor(t.id)); const main = S.design.layers.find(l => l.name === 'Title') || S.design.layers.find(l => l.type === 'text'); S.sel = main ? main.id : null; syncAll(); commit(); toast(`Layout “${t.label}” applied. Undo brings back your old one.`); setTab('edit'); };
        box.append(b);
      }
    }
    for (const b of box.children) {
      const cv = b.querySelector('canvas'); cv.width = tw; cv.height = th;
      const d = applyTpl(D(), tplFor(b.dataset.tpl)), x = cv.getContext('2d');
      renderDesign(x, tw, th, d, { frame: S.frame, bgImage: S.imgs.get(d.bg.mediaId) || null, images: S.imgs }, {});
    }
  }

  // ------------------------------------------------------------ adding layers
  function place(l) {
    if (D().layers.length >= MAX_LAYERS) { toast(`A thumbnail can have up to ${MAX_LAYERS} layers.`); return null; }
    D().layers.push(l); S.sel = l.id; syncAll(); commit(); return l;
  }
  const W0 = () => fmt().width, H0 = () => fmt().height;
  $('thAddText').onclick = () => { if (place(newText({ text: 'YOUR TEXT', size: S.fk === '9:16' ? 0.14 : 0.1, w: 0.8, h: 0.2, color: '#ffffff' }))) setTab('edit'); };
  async function addPicture(file) {
    try {
      const m = await media.importFile(file, 'image'); const im = await loadImg(m.id); const ar = im ? im.w / im.h : 1;
      const w = ar >= 1 ? 0.4 : 0.4 * ar * H0() / W0() * 1.0;
      const l = newImage({ mediaId: m.id, ar, name: (file.name || 'Picture').slice(0, 30), w: clamp(w, 0.1, 0.9), h: clamp(w * W0() / (ar * H0()), 0.1, 0.9), x: 0.5, y: 0.5 });
      if (place(l)) setTab('edit');
    } catch (e) { console.warn(e); toast('Could not read that picture.'); }
  }
  $('thAddPic').onclick = () => $('thFile').click();
  $('thFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addPicture(f); };
  $('thAddLogo').onclick = async () => {
    const lg = app.project.logo; if (!lg) return;
    const im = await loadImg(lg.mediaId); const ar = im ? im.w / im.h : 1;
    const w = 0.2;
    if (place(newImage({ mediaId: lg.mediaId, ar, name: 'Logo', w, h: clamp(w * W0() / (ar * H0()), 0.05, 0.9), x: 0.88, y: 0.14 }))) setTab('edit');
  };
  $('thBgPick').onclick = () => $('thBgFile').click();
  $('thBgFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const m = await media.importFile(f, 'image'); await loadImg(m.id); D().bg.type = 'image'; D().bg.mediaId = m.id; syncAll(); commit(); }
    catch (err) { console.warn(err); toast('Could not read that picture.'); }
  };
  for (const s of SHAPES) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'th-chip'; b.title = SHAPE_LABEL[s]; b.setAttribute('aria-label', 'Add ' + SHAPE_LABEL[s]); b.dataset.shape = s;
    b.innerHTML = { rect: '<svg viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="12"/></svg>', round: '<svg viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="12" rx="4"/></svg>', ellipse: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>', triangle: '<svg viewBox="0 0 20 20"><path d="M10 3 18 17H2z"/></svg>', line: '<svg viewBox="0 0 20 20"><rect x="2" y="9" width="16" height="2.4"/></svg>', arrow: '<svg viewBox="0 0 20 20"><path d="M2 8h9V3l7 7-7 7v-5H2z"/></svg>' }[s];
    b.onclick = () => {
      const tall = S.fk === '9:16', o = { shape: s, fill: P().accent || '#df3f34', x: 0.5, y: 0.5 };
      if (s === 'line') Object.assign(o, { w: 0.4, h: 0.012 }); else if (s === 'ellipse' || s === 'triangle') Object.assign(o, { w: 0.25, h: 0.25 * W0() / H0() }); else Object.assign(o, { w: tall ? 0.6 : 0.3, h: tall ? 0.12 : 0.25 });
      if (place(newShape({ ...o, name: SHAPE_LABEL[s] }))) setTab('edit');
    };
    $('thShapes').append(b);
  }
  for (const ch of STICKERS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'th-chip'; b.textContent = ch; b.setAttribute('aria-label', 'Add sticker ' + ch); b.dataset.emoji = ch;
    b.onclick = () => { const w = S.fk === '9:16' ? 0.3 : 0.16; if (place(newSticker({ kind: 'emoji', char: ch, name: ch, w, h: w * W0() / H0(), x: 0.5, y: 0.5 }))) setTab('edit'); };
    $('thStickers').append(b);
  }
  for (const k of VECTOR_STICKERS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'th-chip'; b.innerHTML = STICKER_SVG[k]; b.setAttribute('aria-label', 'Add ' + k + ' sticker'); b.dataset.vsticker = k;
    b.onclick = () => { const w = S.fk === '9:16' ? 0.3 : 0.16; if (place(newSticker({ kind: k, name: k[0].toUpperCase() + k.slice(1), w, h: w * W0() / H0(), x: 0.5, y: 0.5, color: k === 'play' ? '#e63946' : '#ffd166' }))) setTab('edit'); };
    $('thStickers').append(b);
  }

  // ------------------------------------------------------------ layer actions (selection toolbar + layers list)
  function dup() {
    const l = cur(); if (!l) return;
    if (D().layers.length >= MAX_LAYERS) return toast(`A thumbnail can have up to ${MAX_LAYERS} layers.`);
    const c = { ...JSON.parse(JSON.stringify(l)), id: newId(), x: clamp(l.x + 0.03, 0, 1), y: clamp(l.y + 0.04, 0, 1), locked: false };
    D().layers.splice(D().layers.indexOf(l) + 1, 0, c); S.sel = c.id; syncAll(); commit();
  }
  function del() { const l = cur(); if (!l) return; D().layers.splice(D().layers.indexOf(l), 1); S.sel = null; syncAll(); commit(); }
  function move(dirn) {
    const l = cur(); if (!l) return; const a = D().layers, i = a.indexOf(l), j = i + dirn;
    if (j < 0 || j >= a.length) return;
    a.splice(i, 1); a.splice(j, 0, l); syncAll(); commit();
  }
  $('thumbDup').onclick = dup; $('thumbDel').onclick = del;
  $('thumbFront').onclick = () => move(1); $('thumbBack').onclick = () => move(-1);
  $('thumbLock').onclick = () => { const l = cur(); if (!l) return; l.locked = !l.locked; syncAll(); commit(); };
  $('thumbUndo').onclick = undo; $('thumbRedo').onclick = redo;

  function renderLayers() {
    const ul = $('thLayers'); ul.textContent = '';
    const a = D().layers; $('thLayersNone').hidden = a.length > 0;
    for (let i = a.length - 1; i >= 0; i--) {
      const l = a[i], li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.dataset.id = l.id; b.className = l.id === S.sel ? 'selected' : ''; b.setAttribute('aria-pressed', l.id === S.sel ? 'true' : 'false');
      const name = l.type === 'text' ? (l.text.replace(/\s+/g, ' ').trim().slice(0, 28) || 'Text') : l.type === 'sticker' && l.kind === 'emoji' ? l.char + ' Sticker' : (l.name || l.type);
      b.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="lk"></span>`;
      b.children[0].textContent = l.type === 'sticker' && l.kind === 'emoji' ? l.char : ICON[l.type]; b.children[1].textContent = name; b.children[2].textContent = l.locked ? '🔒' : '';
      b.onclick = () => { S.sel = l.id; syncAll(); placeOverlays(); };
      li.append(b); ul.append(li);
    }
  }

  // ------------------------------------------------------------ Edit panel: show the selected layer's settings
  const setV = (id, v) => { const el = $(id); if (el && el.value !== String(v)) el.value = v; };
  const setC = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  function syncAll() {
    const l = cur(), has = !!l;
    $('thEditNone').hidden = has; $('thEditBox').hidden = !has;
    $('thumbActions').hidden = !has;
    if (has) {
      $('thEditText').hidden = l.type !== 'text'; $('thEditShape').hidden = l.type !== 'shape'; $('thEditSticker').hidden = l.type !== 'sticker'; $('thEditImage').hidden = l.type !== 'image';
      $('thumbLock').textContent = l.locked ? '🔒 Unlock' : '🔓 Lock'; $('thumbLock').setAttribute('aria-pressed', l.locked ? 'true' : 'false');
      $('thumbFront').disabled = D().layers.indexOf(l) >= D().layers.length - 1; $('thumbBack').disabled = D().layers.indexOf(l) <= 0;
      syncEditLive(l, true);
      const dis = l.locked; for (const el of $('thEditBox').querySelectorAll('input,select,textarea,button')) el.disabled = dis;
    }
    renderLayers(); syncBg(); syncLook(); syncHistButtons();
    $('thAddLogo').hidden = !app.project.logo;
    placeOverlays();
  }
  function syncEditLive(l, full) {
    setV('thOpacity', l.opacity); $('thOpacityOut').textContent = Math.round(l.opacity * 100) + '%';
    setV('thRot', Math.round(l.rot)); $('thRotOut').textContent = Math.round(l.rot) + '°';
    if (l.type === 'text') {
      if (full || document.activeElement !== $('thumbText')) setV('thumbText', l.text);
      setV('thumbFont', l.font); setV('thumbColor', l.color); setV('thumbSize', Math.round(l.size * 200) / 2); $('thumbSizeOut').textContent = Math.round(l.size * 200) / 2;
      for (const b of document.querySelectorAll('#thAlign button')) b.classList.toggle('selected', b.dataset.align === l.align);
      setC('thStrokeOn', l.stroke.on); setV('thStrokeColor', l.stroke.color); setV('thStrokeW', l.stroke.w);
      setC('thShadowOn', l.shadow.on); setV('thShadowColor', l.shadow.color); setV('thShadowB', l.shadow.blur);
      setC('thGlowOn', l.glow.on); setV('thGlowColor', l.glow.color); setV('thGlowB', l.glow.blur);
      setC('thBoxOn', l.box.on); setV('thBoxColor', l.box.color); setV('thBoxPad', l.box.pad);
      setV('thSpacing', l.spacing); $('thSpacingOut').textContent = l.spacing.toFixed(2); setV('thLineH', l.lineH); $('thLineHOut').textContent = l.lineH.toFixed(2); setC('thUpper', l.upper);
    } else if (l.type === 'shape') {
      setV('thShapeKind', l.shape); setV('thFill', l.fill); setC('thFill2On', !!l.fill2); setV('thFill2', l.fill2 || '#ffffff');
      setC('thShStrokeOn', l.stroke.on); setV('thShStrokeColor', l.stroke.color); setV('thShStrokeW', l.stroke.w); setV('thRadius', l.radius); $('thRadiusOut').textContent = l.radius.toFixed(2); setC('thShShadow', l.shadow);
    } else if (l.type === 'sticker') setV('thStColor', l.color);
    else {
      setV('thImgRadius', l.radius); $('thImgRadiusOut').textContent = l.radius.toFixed(2); setC('thImgBorderOn', l.border.on); setV('thImgBorderColor', l.border.color); setV('thImgBorderW', l.border.w);
      setC('thImgShadow', l.shadow); setC('thImgFlip', l.flipH);
    }
  }
  // fill the pickers
  for (const [k, v] of Object.entries(FONTS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; $('thumbFont').append(o); }
  for (const s of SHAPES) { const o = document.createElement('option'); o.value = s; o.textContent = SHAPE_LABEL[s]; $('thShapeKind').append(o); }
  { // filters from the shared Filters library, grouped like the Looks tab
    const sel = $('thFilter'); const none = document.createElement('option'); none.value = 'none'; none.textContent = 'None'; sel.append(none);
    for (const gname of GROUPS) {
      const og = document.createElement('optgroup'); og.label = gname;
      for (const f of FILTERS.filter(x => x.group === gname)) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; og.append(o); }
      sel.append(og);
    }
  }

  // bind one control to the selected layer
  function bind(id, ev, fn, discrete) {
    $(id).addEventListener(ev, () => {
      const l = cur(); if (!l || l.locked) return;
      fn(l, $(id));
      if (discrete) commit(); else touch();
      syncEditLive(l); renderLayers(); placeOverlays();
    });
  }
  const num = (el) => parseFloat(el.value);
  bind('thOpacity', 'input', (l, el) => { l.opacity = clamp(num(el), 0, 1); });
  bind('thRot', 'input', (l, el) => { l.rot = clamp(num(el), -180, 180); });
  bind('thumbText', 'input', (l, el) => { l.text = el.value.slice(0, 300); });
  bind('thumbFont', 'change', (l, el) => { l.font = el.value; }, true);
  bind('thumbColor', 'input', (l, el) => { l.color = el.value; });
  bind('thumbSize', 'input', (l, el) => { l.size = clamp(num(el) / 100, 0.01, 0.6); });
  for (const b of document.querySelectorAll('#thAlign button')) b.addEventListener('click', () => { const l = cur(); if (!l || l.locked) return; l.align = b.dataset.align; commit(); syncEditLive(l); });
  const fx = (pre, key, sliderId, sliderKey) => {
    bind(pre + 'On', 'change', (l, el) => { l[key].on = el.checked; }, true);
    bind(pre + 'Color', 'input', (l, el) => { l[key].color = el.value; });
    if (sliderId) bind(sliderId, 'input', (l, el) => { l[key][sliderKey] = num(el); });
  };
  fx('thStroke', 'stroke', 'thStrokeW', 'w'); fx('thShadow', 'shadow', 'thShadowB', 'blur'); fx('thGlow', 'glow', 'thGlowB', 'blur'); fx('thBox', 'box', 'thBoxPad', 'pad');
  bind('thSpacing', 'input', (l, el) => { l.spacing = num(el); }); bind('thLineH', 'input', (l, el) => { l.lineH = num(el); }); bind('thUpper', 'change', (l, el) => { l.upper = el.checked; }, true);
  bind('thShapeKind', 'change', (l, el) => { l.shape = el.value; l.name = SHAPE_LABEL[l.shape]; }, true);
  bind('thFill', 'input', (l, el) => { l.fill = el.value; });
  bind('thFill2On', 'change', (l, el) => { l.fill2 = el.checked ? $('thFill2').value : ''; }, true);
  bind('thFill2', 'input', (l, el) => { if (l.fill2 || $('thFill2On').checked) l.fill2 = el.value; });
  bind('thShStrokeOn', 'change', (l, el) => { l.stroke.on = el.checked; }, true); bind('thShStrokeColor', 'input', (l, el) => { l.stroke.color = el.value; }); bind('thShStrokeW', 'input', (l, el) => { l.stroke.w = num(el); });
  bind('thRadius', 'input', (l, el) => { l.radius = num(el); }); bind('thShShadow', 'change', (l, el) => { l.shadow = el.checked; }, true);
  bind('thStColor', 'input', (l, el) => { l.color = el.value; });
  bind('thImgRadius', 'input', (l, el) => { l.radius = num(el); });
  bind('thImgBorderOn', 'change', (l, el) => { l.border.on = el.checked; }, true); bind('thImgBorderColor', 'input', (l, el) => { l.border.color = el.value; }); bind('thImgBorderW', 'input', (l, el) => { l.border.w = num(el); });
  bind('thImgShadow', 'change', (l, el) => { l.shadow = el.checked; }, true); bind('thImgFlip', 'change', (l, el) => { l.flipH = el.checked; }, true);
  for (const el of document.querySelectorAll('#thEditBox input[type=range],#thEditBox input[type=color],#thEditBox textarea')) el.addEventListener('change', snapshot);

  // ------------------------------------------------------------ Backdrop + Look
  function syncBg() {
    const b = D().bg, p = P(), pr = app.project;
    for (const x of document.querySelectorAll('#thBgType button')) { const on = x.dataset.bg === b.type; x.classList.toggle('selected', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    $('thBgFrame').hidden = b.type !== 'frame'; $('thBgSolid').hidden = b.type !== 'solid'; $('thBgGrad').hidden = b.type !== 'gradient'; $('thBgImage').hidden = b.type !== 'image';
    $('thFitRow').hidden = !(b.type === 'frame' || b.type === 'image');
    $('thumbFit').value = b.type === 'image' ? b.fit : p.fit;
    setV('thBgColor', b.color); setV('thBgGrad1', b.color); setV('thBgGrad2', b.color2); setV('thBgAngle', b.angle); $('thBgAngleOut').textContent = Math.round(b.angle) + '°';
    $('thumbTime').max = Math.max(0.01, duration() - 0.01); $('thumbTime').value = p.time ?? 0; $('thumbTimeOut').textContent = fmtTime(p.time ?? 0);
    $('thumbPip').checked = p.pip; $('thumbLogo').checked = p.logo; $('thumbPipRow').hidden = !(pr.overlays || []).length; $('thumbLogoRow').hidden = !pr.logo;
    $('thBgPick').textContent = b.mediaId && b.type === 'image' ? 'Change picture…' : 'Choose a picture…';
  }
  for (const x of document.querySelectorAll('#thBgType button')) x.addEventListener('click', async () => {
    const t = x.dataset.bg, b = D().bg;
    if (t === 'image' && !b.mediaId) { $('thBgFile').click(); return; } // choosing a picture switches the backdrop to it
    b.type = t; syncBg(); commit(); if (t === 'frame') render(true);
  });
  $('thBgColor').addEventListener('input', () => { D().bg.color = $('thBgColor').value; touch(); });
  $('thBgGrad1').addEventListener('input', () => { D().bg.color = $('thBgGrad1').value; touch(); });
  $('thBgGrad2').addEventListener('input', () => { D().bg.color2 = $('thBgGrad2').value; touch(); });
  $('thBgAngle').addEventListener('input', () => { D().bg.angle = num($('thBgAngle')); $('thBgAngleOut').textContent = Math.round(D().bg.angle) + '°'; touch(); });
  $('thumbFit').addEventListener('change', () => { if (D().bg.type === 'image') D().bg.fit = $('thumbFit').value; else P().fit = $('thumbFit').value; commit(); render(true); });
  for (const id of ['thumbPip', 'thumbLogo']) $(id).addEventListener('change', () => { P().pip = $('thumbPip').checked; P().logo = $('thumbLogo').checked; commit(); render(true); });
  $('thumbTime').addEventListener('input', () => { P().time = num($('thumbTime')); $('thumbTimeOut').textContent = fmtTime(P().time); scheduleSave(); frameSoon(); });
  const frameSoon = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(() => render(true), 60); }; })();
  $('thumbUsePlayhead').onclick = () => { P().time = playhead(); syncBg(); scheduleSave(); render(true); };

  function syncLook() {
    const a = D().adjust;
    setV('thFilter', filterInfo(a.preset) ? a.preset : 'none'); setV('thFilterAmt', a.filterAmount); $('thFilterAmtOut').textContent = Math.round(a.filterAmount * 100) + '%';
    for (const [id, k] of [['thBri', 'brightness'], ['thCon', 'contrast'], ['thSat', 'saturation'], ['thTmp', 'temperature'], ['thumbVignette', 'vignette']]) { setV(id, a[k]); $(id + 'Out').textContent = Math.round(a[k]); }
    setV('thumbDarken', a.darken); $('thumbDarkenOut').textContent = Math.round(a.darken * 100) + '%';
  }
  const lookBind = (id, key) => $(id).addEventListener('input', () => { D().adjust[key] = num($(id)); const o = $(id + 'Out'); if (o) o.textContent = key === 'darken' ? Math.round(D().adjust.darken * 100) + '%' : key === 'filterAmount' ? Math.round(D().adjust.filterAmount * 100) + '%' : Math.round(D().adjust[key]); touch(); });
  for (const [id, k] of [['thBri', 'brightness'], ['thCon', 'contrast'], ['thSat', 'saturation'], ['thTmp', 'temperature'], ['thumbVignette', 'vignette'], ['thumbDarken', 'darken'], ['thFilterAmt', 'filterAmount']]) lookBind(id, k);
  $('thFilter').addEventListener('change', () => { D().adjust.preset = $('thFilter').value; commit(); });
  $('thLookReset').onclick = () => { const dk = D().adjust.darken; D().adjust = { ...defaultAdjust(), darken: dk }; syncLook(); commit(); };
  for (const el of document.querySelectorAll('#thP-bg input[type=range],#thP-bg input[type=color],#thP-look input[type=range]')) el.addEventListener('change', snapshot);

  // ------------------------------------------------------------ format, type, guides, keyboard
  $('thumbFormat').addEventListener('change', () => { P().format = $('thumbFormat').value; snapshot(); open2(true); scheduleSave(); });
  $('thumbType').addEventListener('change', () => { P().type = $('thumbType').value; $('thumbSave').textContent = 'Download ' + (P().type === 'png' ? 'PNG' : 'JPG'); scheduleSave(); });
  $('thumbGuides').addEventListener('change', placeOverlays);
  $('thumbDialog').addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type)) || t.tagName === 'SELECT');
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && (k === 'z' || k === 'y')) { if (typing && t.tagName !== 'SELECT') return; e.preventDefault(); e.stopPropagation(); (k === 'y' || e.shiftKey) ? redo() : undo(); return; }
    if (typing) return;
    const l = cur();
    if (mod && k === 'd') { e.preventDefault(); e.stopPropagation(); dup(); return; }
    if (!l) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); del(); return; }
    const step = (e.shiftKey ? 10 : 1) / canvas.width;
    const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if ((dx || dy) && t.tagName !== 'INPUT' && !l.locked) { e.preventDefault(); e.stopPropagation(); l.x += dx * step; l.y += dy * step * canvas.width / canvas.height; commit(); placeOverlays(); }
  });

  // ------------------------------------------------------------ open
  async function open2(keepTab) {
    loadDesign();
    const F = fmt(), auto = autoFmt();
    $('thumbFormat').options[0].textContent = `Auto · ${auto.label.split(' ')[0]}`;
    $('thumbFormat').value = P().format; $('thumbType').value = P().type;
    $('thumbTitle').textContent = `Thumbnail maker · ${F.width}×${F.height}`;
    $('thumbSave').textContent = 'Download ' + (P().type === 'png' ? 'PNG' : 'JPG');
    canvas.dataset.format = F.key;
    if (!keepTab) setTab(D().layers.length ? 'edit' : 'templates'); else setTab(S.tab);
    syncAll();
    await render(true);
    if (S.tab === 'templates') drawTemplatePreviews();
  }
  return {
    canvas,
    get state() { return S; },
    async open() { S.open = true; await open2(false); },
    close() { snapshot(); S.open = false; },
    render, paint: () => paint(g, canvas.width, canvas.height, S.fk),
    reset() { S.frame = null; S.frameKey = ''; S.imgs.clear(); S.logoImg = null; },
    undo, redo, setTab, select(id) { S.sel = id; syncAll(); },
    sync: syncAll, design: () => D(),
  };
}
