// Transitions tab: a library of all 15 transitions as small looping previews (like Filmora / CapCut), plus length, sound, "apply to all" and remove.
// It is the ONE place to choose a transition: the small marker on a join of the timeline opens this tab with that join chosen; so does selecting
// the clip after the join. The data is clip.transition on the clip that comes AFTER the join (see transitions.js); every change is one undo step.
import { TYPES, MIN_DUR, MAX_DUR, DEFAULT_DUR, typeInfo, isOverlap, labelOf, maxDuration } from './transitions.js';
import { layout, rippleShift } from './model.js';
import { drawThumb, loopThumb, restingP, THUMB_W, THUMB_H } from './transition-thumbs.js';

const secs = (v) => (Math.round(v * 100) / 100).toString().replace(/(\.\d)0$/, '$1') + ' s';

export function initTransitionUI(ctx) {
  const { $, app, commit, showTab } = ctx;
  const panel = $('tab-trans'); if (!panel) return { render() { }, open() { }, target() { return null; } };
  let lastId = null, dragBefore = null, last = DEFAULT_DUR, playTimer = 0, msg = '';
  try { const v = parseFloat(localStorage.getItem('ve.trDur')); if (v >= MIN_DUR && v <= MAX_DUR) last = v; } catch { /* optional */ }
  const previewOn = () => { try { return localStorage.getItem('ve.trPreview') !== '0' && !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } };

  // ---- the library: grouped cards, each a small canvas
  const typesEl = $('trTypes'), cards = new Map(), stops = new Map();
  const fine = (() => { try { return matchMedia('(pointer: fine)').matches; } catch { return false; } })();
  for (const g of ['Basic', 'Wipe', 'Slide', 'Zoom']) {
    const row = document.createElement('div'); row.className = 'tr-group'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', g);
    const h = document.createElement('span'); h.className = 'tr-gl'; h.textContent = g; h.setAttribute('aria-hidden', 'true'); row.append(h);
    const grid = document.createElement('div'); grid.className = 'tr-grid';
    for (const t of TYPES.filter(x => x.group === g)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-type'; b.dataset.type = t.id; b.setAttribute('aria-pressed', 'false');
      const cv = document.createElement('canvas'); cv.width = THUMB_W; cv.height = THUMB_H; cv.setAttribute('aria-hidden', 'true');
      const lb = document.createElement('span'); lb.className = 'tr-lbl'; lb.textContent = t.label;
      b.append(cv, lb);
      b.addEventListener('click', () => choose(t.id));
      const play = () => { if (matchMedia('(prefers-reduced-motion: reduce)').matches || b.disabled) return; if (!stops.has(t.id)) stops.set(t.id, loopThumb(cv, t.id)); };
      const rest = () => { const s = stops.get(t.id); if (s) { s(); stops.delete(t.id); } };
      b.addEventListener('pointerenter', play); b.addEventListener('pointerleave', rest); b.addEventListener('focus', play); b.addEventListener('blur', rest);
      b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { play(); setTimeout(rest, 1800); } });
      if (fine) { // desktop: drag a card onto a join marker on the timeline
        b.draggable = true;
        b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-transition', t.id); e.dataTransfer.setData('text/plain', t.label); e.dataTransfer.effectAllowed = 'copy'; rest(); document.body.classList.add('tr-dragging'); });
        b.addEventListener('dragend', () => document.body.classList.remove('tr-dragging'));
      }
      grid.append(b); cards.set(t.id, b); drawThumb(cv.getContext('2d'), t.id, restingP(t.id));
    }
    row.append(grid); typesEl.append(row);
  }

  // ---- which join is being edited: the one chosen on the timeline, else the selected clip's join
  const clipById = (id) => app.project.clips.find(c => c.id === id) || null;
  function target() {
    if (app.trTarget && clipById(app.trTarget)) return app.trTarget;
    const s = app.selection; return s && s.type === 'clip' && clipById(s.id) ? s.id : null;
  }
  function info() {
    const id = target(); if (!id) return null;
    const lay = layout(app.project), it = lay.items.find(i => i.clip.id === id);
    return it ? { id, lay, it, clip: it.clip, prev: it.index > 0 ? lay.items[it.index - 1] : null } : null;
  }
  const joined = (i) => i && (i.prev ? !(i.clip.gap > 1e-6) : true);
  function nearestJoin() {
    const lay = layout(app.project), t = app.player ? app.player.t : 0; let best = null;
    for (const it of lay.items) { if (!it.index) continue; if (it.clip.gap > 1e-6) continue; const d = Math.abs(it.start - t); if (!best || d < best.d) best = { id: it.clip.id, d }; }
    return best && best.id;
  }

  // ---- changing the project (one undo step each); with Ripple on, things on other lanes after a join move with it
  function rippleJoins(before, after) {
    if (!app.rippleEnabled) return;
    let shifted = 0;
    for (let i = 1; i < before.items.length && i < after.items.length; i++) {
      const d = after.items[i].start - before.items[i].start;
      if (Math.abs(d - shifted) > 1e-9) { rippleShift(app.project, before.items[i].start + shifted - 1e-3, d - shifted); shifted = d; }
    }
    const tail = after.total - before.total;
    if (Math.abs(tail - shifted) > 1e-9) rippleShift(app.project, before.total + shifted - 1e-3, tail - shifted);
  }
  function apply(mutate, label, { live = false, before = null } = {}) {
    const p = app.project, b = before || layout(p);
    mutate(p);
    if (live) { app.liveUpdate({ previewAt: restTime() }); render(); return; }
    rippleJoins(b, layout(p));
    commit(label); // renderAll() redraws everything and calls render() below
  }
  function restTime() { const i = info(); if (!i || i.clip.transition.type === 'cut') return null; return i.it.start + (i.it.xIn > 0 ? i.it.xIn / 2 : 0.001); }
  function set(c, type, dur, audio) {
    c.transition = { type, duration: Math.min(MAX_DUR, Math.max(MIN_DUR, dur)) };
    if (audio === 'cut' && isOverlap(type)) c.transition.audio = 'cut';
  }
  /** Play a short stretch around the join so the choice can be seen at once (or just show the middle frame when it is off / reduced motion). */
  function previewAround() {
    clearTimeout(playTimer);
    const i = info(); if (!i || i.clip.transition.type === 'cut') return;
    const player = app.player, mid = restTime();
    if (!previewOn()) { if (!player.playing) app.seek(mid); return; }
    const len = i.it.xIn > 0 ? i.it.xIn : Math.min(i.clip.transition.duration, i.it.len), from = Math.max(0, (i.it.xIn > 0 ? i.it.start : i.it.start - len / 2) - 0.8);
    const to = Math.min(i.lay.total, (i.it.xIn > 0 ? i.it.start + i.it.xIn : i.it.start + len / 2) + 0.8);
    if (player.playing) player.pause();
    app.seek(from); player.play(1);
    playTimer = setTimeout(() => { player.pause(); app.seek(mid); }, Math.max(300, (to - from) * 1000 + 100));
  }
  function choose(type) {
    const i = info();
    if (!i) { // nothing chosen yet: take the join nearest the playhead and say so, without changing anything
      const j = nearestJoin();
      if (!j) { setMsg(app.project.clips.length < 2 ? 'Add a second clip first: a transition joins two clips.' : 'There is no join to put a transition on. Close the gaps between clips first.'); return; }
      app.trTarget = j; lastId = j; const it = layout(app.project).items.find(x => x.clip.id === j); app.seek(it.start); app.timeline && app.timeline.reveal && app.timeline.reveal(it.start);
      app.timeline.render(); setMsg(`Join ${it.index} selected (between clip ${it.index} and clip ${it.index + 1}). Tap a transition to put it there.`); render(); return;
    }
    if (!joined(i)) { setMsg('There is a gap before this clip. Close the gap to use a transition.'); return; }
    if (!i.prev && isOverlap(type)) { setMsg('The first clip has nothing before it. Tap the marker between two clips, or select the second clip, to blend them. Here you can only fade in from black or white.'); return; }
    const c = i.clip, old = c.transition, dur = old.type === 'cut' ? last : Math.min(MAX_DUR, Math.max(MIN_DUR, old.duration));
    msg = '';
    apply(() => set(c, type, dur, old.audio), type === 'cut' ? 'Remove transition' : 'Transition: ' + labelOf(type));
    previewAround();
  }
  const setMsg = (m) => { msg = m; $('trNote').textContent = m; };

  $('trDur').addEventListener('input', () => {
    const i = info(); const c = i && i.clip; if (!c) return;
    if (c.transition.type === 'cut') { $('trDurOut').textContent = secs(+$('trDur').value); last = +$('trDur').value; return; }
    if (!dragBefore) dragBefore = layout(app.project);
    const v = +$('trDur').value; set(c, c.transition.type, v, c.transition.audio); last = v; msg = '';
    apply(() => { }, '', { live: true });
  });
  $('trDur').addEventListener('change', () => {
    const i = info(); const c = i && i.clip; const v = +$('trDur').value; last = v; try { localStorage.setItem('ve.trDur', String(v)); } catch { /* optional */ }
    if (!c || c.transition.type === 'cut') { dragBefore = null; render(); return; }
    const b = dragBefore || layout(app.project); dragBefore = null;
    apply(() => set(c, c.transition.type, v, c.transition.audio), 'Transition length', { before: b });
    previewAround();
  });
  $('trAudio').addEventListener('change', () => {
    const i = info(); const c = i && i.clip; if (!c) return;
    const hard = !$('trAudio').checked; msg = '';
    apply(() => set(c, c.transition.type, c.transition.duration, hard ? 'cut' : 'cross'), hard ? 'Hard-cut the sound' : 'Crossfade the sound');
  });
  $('trRemove').addEventListener('click', () => { const i = info(); if (i && i.clip.transition.type !== 'cut') choose('cut'); });
  $('trAll').addEventListener('click', () => {
    const i = info(); if (!i || !i.prev) return;
    const tr = { ...i.clip.transition };
    apply(() => { for (const x of app.project.clips) if (x !== app.project.clips[0] && !(x.gap > 1e-6)) x.transition = { ...tr }; }, 'Transition on all joins');
    const n = app.project.clips.filter((x, k) => k > 0 && !(x.gap > 1e-6)).length;
    setMsg((tr.type === 'cut' ? 'All ' : 'Applied to all ') + n + ' joins. ' + noteFor(info()));
  });

  // ---- what the user is told
  function noteFor(i) {
    if (!i) return app.project.clips.length < 2 ? 'Add a second clip first: a transition joins two clips.' : 'Tap a transition to put it on the join nearest the playhead, or tap the small marker between two clips first.';
    const c = i.clip;
    if (i.prev && !joined(i)) return 'There is a gap before this clip. Close the gap to use a transition.';
    const t = c.transition, kind = typeInfo(t.type).kind;
    if (kind === 'cut') return i.prev ? 'No transition: this clip simply cuts in. Tap one above to try it.' : 'This is the first clip, so there is nothing to blend with. You can fade in from black or white.';
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
    const i = info(), c = i && i.clip, t = c ? c.transition : null;
    if ((i ? i.id : null) !== lastId) { lastId = i ? i.id : null; msg = ''; }
    const first = !!i && !i.prev, ok = !!i && joined(i);
    $('trJoin').textContent = !i ? 'No join chosen yet' : first ? `Start of clip 1: ${c.name}` : `Join between clip ${i.it.index} and clip ${i.it.index + 1}`;
    for (const [id, b] of cards) {
      const k = typeInfo(id).kind, off = !!i && (!ok || (first && k === 'overlap'));
      b.disabled = false; b.setAttribute('aria-disabled', off ? 'true' : 'false'); b.classList.toggle('off', off);
      const on = !!t && t.type === id; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const cut = !t || t.type === 'cut';
    $('trDur').disabled = cut || !ok;
    if (!dragBefore || document.activeElement !== $('trDur')) $('trDur').value = String(cut ? last : t.duration);
    $('trDurOut').textContent = secs(+$('trDur').value);
    $('trAudioRow').hidden = !t || !isOverlap(t.type); $('trAudio').checked = !t || t.audio !== 'cut'; $('trAudio').disabled = !ok;
    if (!msg) $('trNote').textContent = noteFor(i);
    $('trAll').hidden = !i || first; $('trAll').disabled = !ok || app.project.clips.length < 3;
    $('trRemove').disabled = cut || !ok;
  }
  /** The marker on the timeline (or a drop) chooses a join and shows this tab. */
  function open(id, { type = null, focus = true } = {}) {
    if (!clipById(id)) return;
    app.trTarget = id; msg = ''; clearTimeout(playTimer);
    showTab('trans'); app.timeline && app.timeline.render(); render();
    panel.scrollIntoView({ block: 'nearest' });
    if (type) { choose(type); return; }
    const t = clipById(id).transition.type, b = cards.get(t) || cards.get('crossfade');
    const it = layout(app.project).items.find(x => x.clip.id === id); if (it && !app.player.playing) app.seek(it.start + (it.xIn > 0 ? it.xIn / 2 : 0.001));
    if (focus && b) b.focus({ preventScroll: true });
  }
  return { render, open, target, nameOf: (c) => (c.transition.type === 'cut' ? 'Cut' : labelOf(c.transition.type) + ' · ' + secs(c.transition.duration)) };
}
