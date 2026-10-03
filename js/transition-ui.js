// Transitions: the one place to choose how a clip joins the one before it. Opened from the small marker on the timeline between two clips
// or from the button in the clip's panel (the panel only shows the current choice). The data is clip.transition on the clip that comes
// AFTER the join (see transitions.js); every change here is one undo step.
import { TYPES, MIN_DUR, MAX_DUR, DEFAULT_DUR, typeInfo, isOverlap, labelOf, maxDuration } from './transitions.js';
import { layout, rippleShift } from './model.js';

const secs = (v) => (Math.round(v * 100) / 100).toString().replace(/(\.\d)0$/, '$1') + ' s';

export function initTransitionUI(ctx) {
  const { $, app, commit } = ctx;
  const box = $('trPicker'); if (!box) return { render() { }, open() { }, close() { } };
  let clipId = null, anchor = null, dragBefore = null, last = DEFAULT_DUR;
  try { const v = parseFloat(localStorage.getItem('ve.trDur')); if (v >= MIN_DUR && v <= MAX_DUR) last = v; } catch { /* optional */ }

  // ---- build the type buttons once, grouped
  const typesEl = $('trTypes'), btns = new Map();
  for (const g of ['Basic', 'Wipe', 'Slide', 'More']) {
    const row = document.createElement('div'); row.className = 'tr-group'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', g === 'Basic' ? 'Basic' : g);
    if (g !== 'Basic') { const h = document.createElement('span'); h.className = 'tr-gl'; h.textContent = g; h.setAttribute('aria-hidden', 'true'); row.append(h); }
    const grid = document.createElement('div'); grid.className = 'tr-grid';
    for (const t of TYPES.filter(x => x.group === g)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-type'; b.dataset.type = t.id; b.textContent = t.label; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => pick(t.id)); grid.append(b); btns.set(t.id, b);
    }
    row.append(grid); typesEl.append(row);
  }

  const clip = () => app.project.clips.find(c => c.id === clipId) || null;
  const info = () => { const lay = layout(app.project), it = lay.items.find(i => i.clip.id === clipId); return it ? { lay, it, prev: it.index > 0 ? lay.items[it.index - 1] : null } : null; };
  const joined = (i) => i && (i.prev ? !(i.it.clip.gap > 1e-6) : true);

  /** Short text for the clip panel and the marker: "Dissolve · 0.5 s". */
  function nameOf(c) { return c.transition.type === 'cut' ? 'Cut' : labelOf(c.transition.type) + ' · ' + secs(c.transition.duration); }

  // ---- changing the project (one undo step each); with Ripple on, things on other lanes after a join move with it
  function rippleJoins(before, after) {
    if (!app.rippleEnabled) return;
    let shifted = 0;
    for (let i = 1; i < before.items.length && i < after.items.length; i++) {
      const d = after.items[i].start - before.items[i].start;
      if (Math.abs(d - shifted) > 1e-9) { rippleShift(app.project, before.items[i].start + shifted - 1e-3, d - shifted); shifted = d; }
    }
    // everything after the last join moves by the final change in total length
    const tail = after.total - before.total;
    if (Math.abs(tail - shifted) > 1e-9) rippleShift(app.project, before.total + shifted - 1e-3, tail - shifted);
  }
  function apply(mutate, label, { live = false, before = null } = {}) {
    const p = app.project, b = before || layout(p);
    mutate(p);
    if (live) { app.liveUpdate({ previewAt: previewTime() }); render(); return; }
    rippleJoins(b, layout(p));
    commit(label); // renderAll() redraws the timeline and calls render() below
    const t = previewTime(); if (t != null && !app.player.playing) app.seek(t);
  }
  function previewTime() { const i = info(); if (!i || i.it.clip.transition.type === 'cut') return null; return i.it.start + (i.it.xIn > 0 ? i.it.xIn / 2 : 0.001); }

  function set(c, type, dur, audio) {
    c.transition = { type, duration: Math.min(MAX_DUR, Math.max(MIN_DUR, dur)) };
    if (audio === 'cut' && isOverlap(type)) c.transition.audio = 'cut';
  }
  function pick(type) {
    const c = clip(); if (!c) return;
    const old = c.transition, dur = old.type === 'cut' ? last : Math.min(MAX_DUR, Math.max(MIN_DUR, old.duration));
    apply(() => set(c, type, dur, old.audio), type === 'cut' ? 'Remove transition' : 'Transition: ' + labelOf(type));
    focusType(type);
  }
  function focusType(type) { const b = btns.get(type); if (b && !b.hidden && !b.disabled) b.focus({ preventScroll: true }); }

  $('trDur').addEventListener('input', () => {
    const c = clip(); if (!c) return;
    if (c.transition.type === 'cut') { $('trDurOut').textContent = secs(+$('trDur').value); return; }
    if (!dragBefore) dragBefore = layout(app.project);
    const v = +$('trDur').value; set(c, c.transition.type, v, c.transition.audio); last = v;
    apply(() => { }, '', { live: true });
  });
  $('trDur').addEventListener('change', () => {
    const c = clip(); const v = +$('trDur').value; last = v; try { localStorage.setItem('ve.trDur', String(v)); } catch { /* optional */ }
    if (!c || c.transition.type === 'cut') { dragBefore = null; render(); return; }
    const b = dragBefore || layout(app.project); dragBefore = null;
    apply(() => set(c, c.transition.type, v, c.transition.audio), 'Transition length', { before: b });
  });
  $('trAudio').addEventListener('change', () => {
    const c = clip(); if (!c) return;
    const hard = !$('trAudio').checked;
    apply(() => set(c, c.transition.type, c.transition.duration, hard ? 'cut' : 'cross'), hard ? 'Hard-cut the sound' : 'Crossfade the sound');
  });
  $('trRemove').addEventListener('click', () => { const c = clip(); if (c && c.transition.type !== 'cut') pick('cut'); });
  $('trAll').addEventListener('click', () => {
    const c = clip(), i = info(); if (!c || !i || !i.prev) return;
    const tr = { ...c.transition };
    apply(() => { for (const x of app.project.clips) if (x !== app.project.clips[0] && !(x.gap > 1e-6)) x.transition = { ...tr }; }, 'Transition on all joins');
    const n = app.project.clips.filter((x, k) => k > 0 && !(x.gap > 1e-6)).length;
    $('trNote').textContent = (tr.type === 'cut' ? 'All ' : 'Applied to all ') + n + ' joins. ' + noteFor(clip(), info());
  });
  $('trClose').addEventListener('click', () => close(true));
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(true); } });
  document.addEventListener('pointerdown', (e) => { if (!box.hidden && !box.contains(e.target) && !(anchor && anchor.contains(e.target)) && !e.target.closest('.tl-join, #trOpen')) close(false); }, true);

  // ---- what the user is told
  function noteFor(c, i) {
    if (!c || !i) return '';
    if (i.prev && !joined(i)) return 'There is a gap before this clip. Close the gap to use a transition.';
    const t = c.transition, kind = typeInfo(t.type).kind;
    if (kind === 'cut') return i.prev ? 'No transition: this clip simply cuts in.' : 'This is the first clip, so there is nothing to blend with. You can fade in from black or white.';
    const prevLen = i.prev ? i.prev.len : Infinity, max = maxDuration(t.type, prevLen, i.it.len);
    const used = kind === 'overlap' ? i.it.xIn : Math.min(t.duration, max);
    let s = '';
    if (t.duration > max + 1e-6) {
      const shorter = prevLen < i.it.len ? 'the clip before' : 'this clip';
      s += `Shortened to ${secs(used)}: ${shorter} is only ${secs(Math.min(prevLen, i.it.len))} long` + (kind === 'overlap' ? ', and a transition can use at most half of it. ' : '. ');
    }
    if (kind === 'overlap') s += `Both clips play together for ${secs(used)}, so the video is ${secs(used)} shorter.`;
    else s += i.prev ? 'The picture dips to ' + (typeInfo(t.type).color === '#ffffff' ? 'white' : 'black') + ' and back. The video length does not change.' : 'Fades in from ' + (typeInfo(t.type).color === '#ffffff' ? 'white' : 'black') + '. The video length does not change.';
    return s.trim();
  }

  function render() {
    const c = clip(), i = info();
    // the clip panel only shows the choice
    const sel = app.selection && app.selection.type === 'clip' ? app.project.clips.find(x => x.id === app.selection.id) : null;
    if (sel) {
      const si = layout(app.project).items.find(x => x.clip.id === sel.id);
      $('trOpenLabel').textContent = nameOf(sel);
      $('trOpen').setAttribute('aria-label', 'Transition into this clip: ' + nameOf(sel) + '. Change');
      $('trOpen').dataset.clip = sel.id;
      const gap = si && si.index > 0 && sel.gap > 1e-6;
      $('trOpenHint').textContent = gap ? 'There is a gap before this clip, so it cuts in. Close the gap to add a transition.' : si && si.index === 0 ? 'The first clip has nothing before it; it can fade in from black or white.' : 'You can also tap the small marker between two clips on the timeline.';
      $('trOpen').disabled = !!gap;
    }
    if (box.hidden) return;
    if (!c || !i) { close(false); return; }
    const first = !i.prev, ok = joined(i), t = c.transition, kind = typeInfo(t.type).kind;
    $('trTitle').textContent = 'Transition';
    $('trJoin').textContent = first ? `Start of clip 1: ${c.name}` : `Between clip ${i.it.index} and clip ${i.it.index + 1}`;
    for (const [id, b] of btns) {
      const k = typeInfo(id).kind;
      b.hidden = first && k === 'overlap'; b.disabled = !ok;
      const on = t.type === id; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const g of typesEl.querySelectorAll('.tr-group')) g.hidden = ![...g.querySelectorAll('.tr-type')].some(b => !b.hidden);
    const cut = t.type === 'cut';
    $('trDur').disabled = cut || !ok;
    if (!dragBefore || document.activeElement !== $('trDur')) $('trDur').value = String(cut ? last : t.duration);
    $('trDurOut').textContent = secs(+$('trDur').value);
    $('trAudioRow').hidden = !isOverlap(t.type); $('trAudio').checked = t.audio !== 'cut'; $('trAudio').disabled = !ok;
    if (!$('trNote').dataset.keep) $('trNote').textContent = noteFor(c, i);
    $('trAll').hidden = first; $('trAll').disabled = !ok || app.project.clips.length < 3;
    $('trRemove').disabled = cut || !ok;
    $('trRemove').hidden = false;
    void kind;
  }

  function place(a) {
    if (window.innerWidth <= 620 || !a) { box.style.left = box.style.top = box.style.bottom = ''; box.classList.add('sheet-mode'); return; }
    box.classList.remove('sheet-mode');
    const r = a.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 16);
    box.style.width = w + 'px';
    box.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    const h = box.offsetHeight || 420, roomAbove = r.top - 8, roomBelow = window.innerHeight - r.bottom - 8;
    const above = roomAbove >= Math.min(h, 420) || roomAbove > roomBelow;
    box.style.maxHeight = Math.max(240, (above ? roomAbove : roomBelow)) + 'px';
    if (above) { box.style.top = 'auto'; box.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
    else { box.style.bottom = 'auto'; box.style.top = (r.bottom + 6) + 'px'; }
  }
  function open(id, from) {
    clipId = id; anchor = from || null; $('trNote').dataset.keep = '';
    const c = clip(); if (!c) return;
    box.hidden = false; render(); place(anchor);
    const i = info(); const first = c.transition.type !== 'cut' && btns.get(c.transition.type) && !btns.get(c.transition.type).hidden ? btns.get(c.transition.type) : (i && i.prev ? btns.get('crossfade') : btns.get('cut'));
    if (first && !first.disabled) first.focus({ preventScroll: true });
    const t = previewTime(); if (t != null && !app.player.playing) app.seek(t);
  }
  function close(refocus) {
    if (box.hidden) return;
    box.hidden = true; const a = anchor; anchor = null; dragBefore = null;
    if (refocus && a && a.isConnected && !a.hidden) a.focus({ preventScroll: true });
    else if (refocus) $('trOpen')?.focus({ preventScroll: true });
  }
  $('trOpen').addEventListener('click', () => { const id = $('trOpen').dataset.clip; if (id) open(id, $('trOpen')); });
  window.addEventListener('resize', () => { if (!box.hidden) place(anchor); });
  return { render, open, close, get isOpen() { return !box.hidden; }, nameOf };
}
