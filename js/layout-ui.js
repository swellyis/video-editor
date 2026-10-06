// Workspace (Filmora-style) layout: moves the existing editor panels into a left LIBRARY dock (icon rail + panel), a right
// PROPERTIES dock (follows the selection), keeps the preview in the centre and the timeline across the bottom.
// Nodes are MOVED (same ids, same listeners), never copied, and are put back when the window gets too small (phone layout).
// Pure state/maths live in js/layout.js.
import * as L from './layout.js';

const SVG = (d) => `<svg class="ico rail-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const RAIL = [ // data-tab, label, icon, library panel id
  ['clip', 'Media', SVG('<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.6"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 17"/>'), 'libMedia'],
  ['audio', 'Audio', SVG('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'), 'tab-audio'],
  ['text', 'Text', SVG('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'), 'tab-text'],
  ['trans', 'Transitions', SVG('<rect x="3" y="6" width="9" height="12" rx="1.5"/><rect x="12" y="6" width="9" height="12" rx="1.5" stroke-dasharray="2.5 2"/>'), 'tab-trans'],
  ['look', 'Looks', SVG('<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>'), 'tab-look'],
  ['captions', 'Captions', SVG('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 10.5h4M7 14h2.5M13 14h4M14 10.5h3"/>'), 'tab-captions'],
  ['pip', 'PiP', SVG('<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="5.5" rx="1.2"/>'), 'tab-pip'],
];
const PROPS = { clip: ['tab-clip', 'Clip'], text: ['prop-text', 'Text'], audio: ['prop-audio', 'Audio track'], overlay: ['prop-pip', 'Picture-in-picture'], caption: ['prop-captions', 'Caption'], blur: ['prop-blur', 'Blur region'] };

const CLASSIC = (() => { try { return new URLSearchParams(location.search).get('layout') === 'classic'; } catch { return false; } })();

export function initLayout(ctx) {
  const { $, qs, qsa, app, media, addToTimeline, resized } = ctx;
  const editor = qs('.editor'), stageCol = qs('.stage-column'), inspector = qs('.inspector'), tabsEl = qs('.tabs');
  let on = false, st = L.defaults(window.innerWidth), key = '';
  let moves = [], attrLog = [], created = [], leftName = 'clip';
  const sp = {}; let menu = null, menuBtn = null, ro = null;

  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n[k] = v; else n.setAttribute(k, v); } for (const c of kids) if (c != null) n.append(c); return n; };
  const move = (node, to, before = null) => { if (!node) return; const m = document.createComment('ws'); node.parentNode.insertBefore(m, node); moves.push({ node, m }); to.insertBefore(node, before); };
  const setAttr = (node, name, val) => { if (!node) return; attrLog.push({ node, name, had: node.hasAttribute(name), old: node.getAttribute(name) }); if (val == null) node.removeAttribute(name); else node.setAttribute(name, val); };
  const add = (n, parent, before = null) => { created.push(n); parent.insertBefore(n, before); return n; };

  // ---------------------------------------------------------------- state
  const load = () => {
    key = L.storageKey(window.innerWidth);
    let s = null; try { s = L.parse(localStorage.getItem(key)); } catch { /* storage blocked */ }
    st = s || L.defaults(window.innerWidth);
  };
  const save = () => { try { localStorage.setItem(key, L.serialize(st)); } catch { /* storage blocked: layout just isn't remembered */ } };
  const set = (next, persist = true) => { st = next; draw(); if (persist) save(); };

  function draw() {
    if (!on) return;
    const g = L.grid(st, editor.clientWidth || window.innerWidth);
    editor.style.gridTemplateColumns = g.columns; editor.style.gridTemplateRows = g.rows;
    editor.classList.toggle('swap', st.swap);
    const e = g.effective;
    lib.hidden = !st.libShow; lib.classList.toggle('collapsed', !st.libOpen);
    inspector.hidden = !st.propShow;
    sp.lib.hidden = !(st.libShow && st.libOpen); sp.props.hidden = !st.propShow;
    reveal.hidden = st.propShow;
    const vmax = L.maxWidth(st, 'lib', editor.clientWidth), pmax = L.maxWidth(st, 'props', editor.clientWidth);
    aria(sp.lib, e.lib, L.LIB_MIN, vmax); aria(sp.props, e.prop, L.PROP_MIN, pmax);
    sp.top.setAttribute('aria-valuenow', Math.round(st.top * 100)); sp.top.setAttribute('aria-valuemin', Math.round(L.TOP_MIN * 100)); sp.top.setAttribute('aria-valuemax', Math.round(L.TOP_MAX * 100));
    libCollapse.setAttribute('aria-expanded', st.libOpen); libCollapse.textContent = st.swap ? '»' : '«';
    propCollapse.textContent = st.swap ? '«' : '»';
    reveal.textContent = (st.swap ? '› ' : '‹ ') + 'Properties';
    editor.classList.toggle('lib-off', !st.libShow);
    if (menu && !menu.hidden) syncMenu();
  }
  const aria = (n, v, lo, hi) => { n.setAttribute('aria-valuenow', Math.round(v)); n.setAttribute('aria-valuemin', lo); n.setAttribute('aria-valuemax', Math.round(hi)); };

  // ---------------------------------------------------------------- build / tear down
  let lib, libMain, libBody, libRail, libTitle, libCollapse, propBody, propTitle, propCollapse, reveal, binGrid, binEmpty, binKey = '';
  function enable() {
    if (on) return;
    const cur = (qs('.tabs button.active') || {}).dataset; leftName = (cur && cur.tab) || 'clip';
    load();
    moves = []; attrLog = []; created = [];
    document.body.classList.add('ws');
    // LIBRARY dock = icon rail (the existing .tabs buttons) + one panel at a time
    libRail = el('div', { class: 'lib-rail' });
    libTitle = el('h2', { id: 'libTitle', text: 'Library' });
    libCollapse = el('button', { class: 'dock-btn', id: 'libCollapse', type: 'button', 'aria-label': 'Collapse the library panel', title: 'Collapse / expand the library (Alt+1)', onclick: () => set(L.toggle(st, 'lib')) });
    libBody = el('div', { class: 'dock-body', id: 'libBody' });
    libMain = el('div', { class: 'lib-main' }, el('div', { class: 'dock-head', title: 'Drag this header to the other side to dock the library there' }, libTitle, libCollapse), libBody);
    libMain.firstChild.addEventListener('pointerdown', (e) => headDrag(e, 'lib', libMain.firstChild));
    lib = add(el('aside', { class: 'lib-dock', id: 'libDock', 'aria-label': 'Library' }, libRail, libMain), editor, stageCol);
    move(tabsEl, libRail);
    setAttr(tabsEl, 'aria-orientation', 'vertical'); setAttr(tabsEl, 'aria-label', 'Library');
    // rail buttons: icon + short label, in Filmora order (restored on exit)
    const btns = {}; qsa('.tabs button', tabsEl).forEach(b => { btns[b.dataset.tab] = b; });
    const orig = [...tabsEl.children];
    for (const [tab, label, svg, panel] of RAIL) {
      const b = btns[tab]; if (!b) continue;
      attrLog.push({ node: b, html: b.innerHTML });
      b.innerHTML = svg + '<span class="rail-label"></span>'; b.lastChild.textContent = label;
      setAttr(b, 'aria-label', label); setAttr(b, 'title', label + ' library'); setAttr(b, 'aria-controls', panel);
      tabsEl.append(b);
    }
    created.push({ restoreOrder: orig });
    // library panels
    const mediaPanel = add(buildBin(), libBody);
    for (const [, , , pid] of RAIL) { const p = $(pid); if (p && p !== mediaPanel && pid !== 'tab-clip') move(p, libBody); }
    for (const [, , , pid] of RAIL) { const p = $(pid) || null; if (!p) continue; setAttr(p, 'role', 'tabpanel'); setAttr(p, 'aria-labelledby', 'tabbtn-' + (RAIL.find(r => r[3] === pid) || [])[0]); }
    // PROPERTIES dock = the old inspector (what is left of it) + the panels of the selected item
    inspector.classList.add('props-dock'); setAttr(inspector, 'aria-label', 'Properties');
    propTitle = el('h2', { id: 'propTitle', text: 'Properties' });
    propCollapse = el('button', { class: 'dock-btn', id: 'propCollapse', type: 'button', 'aria-label': 'Hide the properties panel', title: 'Hide / show properties (Alt+2)', onclick: () => set(L.toggle(st, 'props')) });
    propBody = el('div', { class: 'dock-body', id: 'propBody' });
    const propHead = add(el('div', { class: 'dock-head', title: 'Drag this header to the other side to dock properties there' }, propTitle, propCollapse), inspector, inspector.firstChild);
    propHead.addEventListener('pointerdown', (e) => headDrag(e, 'props', propHead));
    inspector.insertBefore(propBody, inspector.children[1]); created.push(propBody);
    const clipPanel = $('tab-clip'); move(clipPanel, propBody); setAttr(clipPanel, 'role', null); setAttr(clipPanel, 'aria-labelledby', null);
    const wrap = (id, inner) => { const w = add(el('div', { class: 'tab-panel prop-panel', id }), propBody); move($(inner), w); return w; };
    wrap('prop-text', 'textPanel'); wrap('prop-audio', 'audioPanel'); wrap('prop-pip', 'overlayPanel'); wrap('prop-captions', 'capPanel'); wrap('prop-blur', 'blurPanel'); move($('multiPanel'), propBody);
    add(el('div', { class: 'tab-panel prop-panel prop-empty', id: 'prop-empty' },
      el('h3', { text: 'Nothing selected' }),
      el('p', { class: 'hint', text: 'Select a clip, title, caption, music track, overlay or blur region on the timeline (or in the preview) and its settings appear here. Browse and add things from the library on the left.' })), propBody);
    // splitters
    const mk = (part, vertical, label) => {
      const s = add(el('div', { class: 'splitter ' + (vertical ? 'v' : 'h'), id: 'spl-' + part, role: 'separator', tabindex: '0', 'data-part': part, 'aria-orientation': vertical ? 'vertical' : 'horizontal', 'aria-label': label, title: label + ' (drag, arrow keys, double-click to reset)' }), editor);
      s.addEventListener('pointerdown', (e) => dragStart(e, part, s)); s.addEventListener('dblclick', () => set(L.resetPart(st, part))); s.addEventListener('keydown', (e) => splitKey(e, part));
      sp[part] = s; return s;
    };
    mk('lib', true, 'Resize the library panel'); mk('props', true, 'Resize the properties panel'); mk('top', false, 'Resize the timeline');
    reveal = add(el('button', { class: 'dock-reveal', id: 'propReveal', type: 'button', 'aria-label': 'Show the properties panel', title: 'Show properties (Alt+2)', onclick: () => set(L.setShown(st, 'props', true)) }), editor);
    // Layout menu button in the header
    const actions = qs('.masthead-actions');
    menuBtn = add(el('button', { class: 'btn secondary layout-btn', id: 'layoutBtn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Panels, presets and reset (Alt+0 resets)', onclick: toggleMenu }, el('span', { 'aria-hidden': 'true', text: '▦ ' }), 'Layout'), actions, actions.firstChild);
    // drag media from the bin onto the timeline / preview
    for (const t of [qs('.timeline-panel'), $('dropTarget')]) { t.addEventListener('dragover', onDragOver); t.addEventListener('drop', onDrop); }
    ro = new ResizeObserver(() => { resized && resized(); }); ro.observe($('dropTarget'));
    on = true;
    draw(); setLeft(leftName); syncProps(); refreshBin(true);
    resized && resized();
  }
  function disable() {
    if (!on) return;
    on = false; closeMenu(true);
    if (ro) ro.disconnect(); ro = null;
    for (const t of [qs('.timeline-panel'), $('dropTarget')]) { t.removeEventListener('dragover', onDragOver); t.removeEventListener('drop', onDrop); }
    for (let i = moves.length - 1; i >= 0; i--) { const { node, m } = moves[i]; m.replaceWith(node); }
    for (let i = attrLog.length - 1; i >= 0; i--) { const a = attrLog[i]; if ('html' in a) a.node.innerHTML = a.html; else if (a.had) a.node.setAttribute(a.name, a.old); else a.node.removeAttribute(a.name); }
    for (const c of created) { if (c.restoreOrder) tabsEl.append(...c.restoreOrder); }
    for (const c of created) if (c.remove) c.remove();
    inspector.classList.remove('props-dock'); inspector.hidden = false;
    editor.style.gridTemplateColumns = ''; editor.style.gridTemplateRows = ''; editor.classList.remove('swap', 'lib-off', 'dragging');
    document.body.classList.remove('ws');
    for (const k of Object.keys(sp)) delete sp[k];
    moves = []; attrLog = []; created = [];
    resized && resized();
  }

  // ---------------------------------------------------------------- tabs: library on the left, properties follow the selection
  function setLeft(name) {
    const row = RAIL.find(r => r[0] === name) || RAIL[0]; leftName = row[0];
    for (const b of qsa('.tabs button', tabsEl)) { const a = b.dataset.tab === leftName; b.classList.toggle('active', a); b.setAttribute('aria-selected', a ? 'true' : 'false'); b.tabIndex = a ? 0 : -1; }
    for (const r of RAIL) { const p = $(r[3]); if (p) p.classList.toggle('active', r[3] === row[3]); }
    libTitle.textContent = row[1];
    const act = qs('.tabs button.active', tabsEl); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function syncProps() {
    if (!on) return;
    const multi = app.multi && app.multi.length > 1, t = multi ? 'multi' : (app.selection && app.selection.type) || '';
    const row = multi ? ['multiPanel', 'Selection'] : PROPS[t] || ['prop-empty', 'Properties'];
    for (const id of ['tab-clip', 'prop-text', 'prop-audio', 'prop-pip', 'prop-captions', 'prop-blur', 'prop-empty', 'multiPanel']) { const p = $(id); if (p) p.classList.toggle('active', id === row[0]); }
    propTitle.textContent = multi ? 'Selection' : PROPS[t] ? row[1] + ' properties' : 'Properties';
  }
  function showTab(name, fromSelect) {
    if (!(fromSelect && name === 'clip')) setLeft(name); // selecting a clip never throws you out of the library you are browsing
    syncProps();
  }
  const openLib = () => { if (!st.libShow || !st.libOpen) set(L.setShown(L.normalize({ ...st, libOpen: true }), 'lib', true)); };

  // ---------------------------------------------------------------- media bin
  const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function buildBin() {
    binGrid = el('div', { class: 'bin-grid', id: 'binGrid', role: 'list', 'aria-label': 'Media in this project' });
    binEmpty = el('p', { class: 'hint', id: 'binEmpty', text: 'Nothing imported yet. Use ＋ Media on the timeline toolbar (or drag files into the preview) and your clips, photos and music show up here.' });
    return el('div', { class: 'tab-panel', id: 'libMedia', role: 'tabpanel' },
      el('section', { class: 'section' },
        el('div', { class: 'section-head' }, el('h2', { text: 'Media' }), el('span', { class: 'hint mono', id: 'binCount' })),
        binGrid, binEmpty,
        el('p', { class: 'hint', text: 'Click a thumbnail to select it on the timeline. ＋ adds it again at the end (music at the playhead), or drag it onto the timeline or preview.' })));
  }
  function mediaItems() {
    const p = app.project, seen = new Map();
    const take = (kind, it) => { if (!it || !it.mediaId || seen.has(it.mediaId)) return; seen.set(it.mediaId, { id: it.mediaId, name: it.name || kind, kind, itemKind: it.kind }); };
    p.clips.forEach(c => take('clip', c)); (p.overlays || []).forEach(o => take('overlay', o)); (p.audio || []).forEach(a => take('audio', a));
    return [...seen.values()];
  }
  function refreshBin(force) {
    if (!on || !binGrid) return;
    const items = mediaItems();
    const k = items.map(i => [i.id, i.name, media.has(i.id) ? 1 : 0].join('|')).join(';') + '#' + (app.selection ? app.selection.id : '');
    if (!force && k === binKey) return; binKey = k;
    binGrid.replaceChildren(...items.map(i => {
      const rec = media.peek(i.id);
      const kind = (rec && rec.kind) || i.itemKind || 'video';
      const isAudio = i.kind === 'audio' || kind === 'audio';
      const thumb = el('span', { class: 'bin-thumb' });
      let src = rec && rec.strip && rec.strip[0];
      if (!src && rec && rec.kind === 'image' && rec.blob) { try { src = media.url(i.id); } catch { /* ignore */ } }
      if (src && !isAudio) thumb.append(el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }));
      else thumb.append(el('span', { class: 'bin-ico', 'aria-hidden': 'true', text: isAudio ? '♪' : '▦' }));
      const dur = rec && rec.duration ? fmtDur(rec.duration) : (kind === 'image' ? 'photo' : '');
      const sel = app.selection && (app.selection.id && [...app.project.clips, ...(app.project.overlays || []), ...(app.project.audio || [])].some(x => x.id === app.selection.id && x.mediaId === i.id));
      const main = el('button', { class: 'bin-main', type: 'button', 'aria-label': `${i.name}${dur ? ', ' + dur : ''}. Select on the timeline`, 'aria-pressed': sel ? 'true' : 'false', onclick: () => selectMedia(i) }, thumb, el('span', { class: 'bin-name', text: i.name }), el('span', { class: 'bin-dur mono', text: dur }));
      const card = el('div', { class: 'bin-item' + (sel ? ' sel' : '') + (rec ? '' : ' missing'), role: 'listitem', draggable: 'true', 'data-mid': i.id }, main,
        el('button', { class: 'bin-add', type: 'button', 'aria-label': 'Add ' + i.name + ' to the timeline', title: isAudio ? 'Add at the playhead' : 'Add to the end of the timeline', onclick: () => addToTimeline(i.id) , text: '＋' }));
      card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-ve-media', i.id); e.dataTransfer.setData('text/plain', i.name); e.dataTransfer.effectAllowed = 'copy'; });
      return card;
    }));
    binEmpty.hidden = items.length > 0;
    const cnt = $('binCount'); if (cnt) cnt.textContent = items.length ? items.length + ' file' + (items.length > 1 ? 's' : '') : '';
  }
  function selectMedia(i) {
    const p = app.project;
    const c = p.clips.find(x => x.mediaId === i.id), o = (p.overlays || []).find(x => x.mediaId === i.id), a = (p.audio || []).find(x => x.mediaId === i.id);
    const sel = c ? { type: 'clip', id: c.id } : o ? { type: 'overlay', id: o.id } : a ? { type: 'audio', id: a.id } : null;
    if (sel) app.select(sel, { seekInto: true });
  }
  const hasMedia = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('application/x-ve-media');
  function onDragOver(e) { if (hasMedia(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }
  function onDrop(e) { if (!hasMedia(e)) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('application/x-ve-media'); if (id) addToTimeline(id); }

  // ---------------------------------------------------------------- splitters
  function dragStart(e, part, node) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); node.setPointerCapture && node.setPointerCapture(e.pointerId);
    editor.classList.add('dragging'); node.classList.add('drag');
    let raf = 0, next = null;
    const move_ = (ev) => {
      const r = editor.getBoundingClientRect();
      if (part === 'top') next = L.setTop(st, (ev.clientY - r.top - L.SPLIT_W / 2) / Math.max(1, r.height - L.SPLIT_W));
      else {
        const fromLeft = part === 'lib' ? !st.swap : st.swap; // is this dock on the left edge?
        const raw = part === 'lib'
          ? (fromLeft ? ev.clientX - r.left : r.right - ev.clientX) - L.RAIL_W - L.SPLIT_W / 2
          : (fromLeft ? ev.clientX - r.left : r.right - ev.clientX) - L.SPLIT_W / 2;
        const min = part === 'lib' ? L.LIB_MIN : L.PROP_MIN;
        if (raw < min - 70) next = part === 'lib' ? L.normalize({ ...st, libOpen: false, preset: 'custom' }) : L.setShown(st, 'props', false); // dragged shut
        else next = L.setWidth(st, part, Math.min(raw, L.maxWidth(st, part, r.width)));
      }
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (next) set(next, false); });
    };
    const up = () => {
      node.removeEventListener('pointermove', move_); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
      editor.classList.remove('dragging'); node.classList.remove('drag'); if (raf) cancelAnimationFrame(raf);
      if (next) set(next, false); save(); resized && resized();
    };
    node.addEventListener('pointermove', move_); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
  }
  function splitKey(e, part) {
    const big = e.shiftKey ? 4 : 1; let next = null;
    if (e.key === 'Enter') next = L.resetPart(st, part);
    else if (part === 'top') {
      if (e.key === 'ArrowUp') next = L.nudge(st, 'top', -0.02 * big); else if (e.key === 'ArrowDown') next = L.nudge(st, 'top', 0.02 * big);
      else if (e.key === 'Home') next = L.setTop(st, L.TOP_MIN); else if (e.key === 'End') next = L.setTop(st, L.TOP_MAX);
    } else {
      const grow = (part === 'lib') !== st.swap ? 1 : -1; // arrow towards the preview shrinks a dock on that side
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (dir) next = L.nudge(st, part, dir * grow * 16 * big);
      else if (e.key === 'Home') next = L.setWidth(st, part, part === 'lib' ? L.LIB_MIN : L.PROP_MIN);
      else if (e.key === 'End') next = L.setWidth(st, part, L.maxWidth(st, part, editor.clientWidth));
    }
    if (!next) return; e.preventDefault(); e.stopPropagation(); /* the splitter owns these keys: no playhead move / shortcut */ if (part !== 'top') next = L.setWidth(next, part, Math.min(part === 'lib' ? next.libW : next.propW, L.maxWidth(next, part, editor.clientWidth))); set(next); resized && resized();
  }


  // ---------------------------------------------------------------- drag a dock by its header to the other side (snap zones)
  function headDrag(e, which, head) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button')) return;
    const x0 = e.clientX, y0 = e.clientY; let zones = null, side = null, done = false;
    head.setPointerCapture && head.setPointerCapture(e.pointerId);
    const mkZones = () => {
      const z = { left: el('div', { class: 'snap-zone left', 'aria-hidden': 'true' }, el('span', { text: 'Dock here' })), right: el('div', { class: 'snap-zone right', 'aria-hidden': 'true' }, el('span', { text: 'Dock here' })) };
      editor.append(z.left, z.right); editor.classList.add('dragging', 'docking'); head.classList.add('grabbing'); return z;
    };
    const end = (apply) => {
      if (done) return; done = true;
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key, true);
      if (zones) { zones.left.remove(); zones.right.remove(); editor.classList.remove('dragging', 'docking'); head.classList.remove('grabbing'); }
      if (apply && side) { const wantSwap = which === 'lib' ? side === 'right' : side === 'left'; if (wantSwap !== st.swap) { set(L.swapSides(st)); resized && resized(); } }
    };
    const mv = (ev) => {
      if (!zones && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) zones = mkZones();
      if (!zones) return;
      const r = editor.getBoundingClientRect(); side = ev.clientX < r.left + r.width / 2 ? 'left' : 'right';
      zones.left.classList.toggle('hot', side === 'left'); zones.right.classList.toggle('hot', side === 'right');
    };
    const up = () => end(true), cancel = () => end(false);
    const key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key, true);
  }

  // ---------------------------------------------------------------- Layout menu
  function buildMenu() {
    const item = (role, label, fn, extra = {}) => { const b = el('button', { class: 'menu-item', type: 'button', role, tabindex: '-1', ...extra }, el('span', { class: 'menu-check', 'aria-hidden': 'true' }), el('span', { text: label })); b.addEventListener('click', () => { fn(); closeMenu(); }); return b; };
    menu = el('div', { class: 'layout-menu', id: 'layoutMenu', role: 'menu', 'aria-label': 'Layout', hidden: '' });
    menu.append(el('div', { class: 'menu-label', text: 'Presets' }));
    for (const k of Object.keys(L.PRESETS)) menu.append(item('menuitemradio', L.PRESET_LABELS[k], () => set(L.applyPreset(st, k)), { 'data-preset': k }));
    menu.append(el('div', { class: 'menu-sep', role: 'separator' }), el('div', { class: 'menu-label', text: 'Panels' }));
    menu.append(item('menuitemcheckbox', 'Library (Alt+1)', () => set(L.setShown(st, 'lib', !st.libShow)), { 'data-panel': 'lib' }));
    menu.append(item('menuitemcheckbox', 'Properties (Alt+2)', () => set(L.setShown(st, 'props', !st.propShow)), { 'data-panel': 'props' }));
    menu.append(item('menuitemcheckbox', 'Swap left / right', () => set(L.swapSides(st)), { 'data-panel': 'swap' }));
    menu.append(el('div', { class: 'menu-sep', role: 'separator' }), item('menuitem', 'Reset layout (Alt+0)', () => reset(), { 'data-reset': '1' }));
    document.body.append(menu);
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.menu-item')]; const i = items.indexOf(document.activeElement);
      if (/^(ArrowDown|ArrowUp|Home|End)$/.test(e.key)) e.stopPropagation(); // menu navigation: never the playhead
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); } else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); menuBtn.focus(); } else if (e.key === 'Tab') closeMenu();
    });
  }
  function syncMenu() {
    for (const b of menu.querySelectorAll('[data-preset]')) b.setAttribute('aria-checked', String(st.preset === b.dataset.preset));
    menu.querySelector('[data-panel=lib]').setAttribute('aria-checked', String(st.libShow));
    menu.querySelector('[data-panel=props]').setAttribute('aria-checked', String(st.propShow));
    menu.querySelector('[data-panel=swap]').setAttribute('aria-checked', String(st.swap));
  }
  const outside = (e) => { if (menu && !menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(); };
  function toggleMenu() { if (menu && !menu.hidden) closeMenu(); else openMenu(); }
  function openMenu() {
    if (!menu) buildMenu();
    syncMenu(); menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true');
    const r = menuBtn.getBoundingClientRect(); menu.style.top = Math.round(r.bottom + 6) + 'px'; menu.style.left = Math.max(8, Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))) + 'px';
    document.addEventListener('pointerdown', outside, true);
    (menu.querySelector('[aria-checked=true]') || menu.querySelector('.menu-item')).focus();
  }
  function closeMenu(destroy) {
    document.removeEventListener('pointerdown', outside, true);
    if (menu) { menu.hidden = true; if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false'); if (destroy) { menu.remove(); menu = null; } }
  }
  function reset() { try { localStorage.removeItem(key); } catch { /* ignore */ } st = L.defaults(window.innerWidth); draw(); save(); resized && resized(); }

  // ---------------------------------------------------------------- window size + hotkeys
  let rt = 0;
  function check() {
    const want = L.isWorkspace(window.innerWidth, window.innerHeight) && !CLASSIC; // ?layout=classic keeps the original single-column layout at any size
    if (want && !on) { enable(); ctx.afterToggle && ctx.afterToggle(true); }
    else if (!want && on) { disable(); ctx.afterToggle && ctx.afterToggle(false); }
    else if (on) { const k = L.storageKey(window.innerWidth); if (k !== key) { save(); load(); } draw(); resized && resized(); }
  }
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(check, 90); });
  tabsEl.addEventListener('click', (e) => { if (on && e.target.closest('button[data-tab]')) openLib(); }, true);
  document.addEventListener('keydown', (e) => {
    if (!on || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Digit1') { e.preventDefault(); set(L.toggle(st, 'lib')); resized && resized(); }
    else if (e.code === 'Digit2') { e.preventDefault(); set(L.toggle(st, 'props')); resized && resized(); }
    else if (e.code === 'Digit0') { e.preventDefault(); reset(); }
  });

  return {
    get active() { return on; },
    get leftName() { return leftName; },
    get state() { return st; },
    start: check, check, showTab, syncProps, refreshBin, reset,
    setState: (s) => set(L.normalize(s)), applyPreset: (n) => set(L.applyPreset(st, n)),
  };
}
