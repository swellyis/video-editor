// Speed section extras for the selected video clip: Constant | Curve mode (speed ramps with presets and a small curve editor) and Reverse.
// The maths lives in ramp.js (pure); the clip stores clip.ramp / clip.reverse so everything is saved, undone and exported like any other setting.
import * as R from './ramp.js';
import { layout, rippleShift, clipLen } from './model.js';
import { fmt } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 300, H = 132, PADX = 12, PADY = 12, LOG_LO = Math.log2(R.RAMP_MIN), LOG_HI = Math.log2(R.RAMP_MAX);

export function initSpeedUI(ctx) {
  const { $, app, player, toast, selected } = ctx;
  const mode = $('speedMode'); if (!mode || !$('rampSvg')) return { render() { } };
  const svg = $('rampSvg'), presetsBox = $('rampPresets');
  let drag = null;

  const clip = () => { const c = selected('clip'); return c && c.kind === 'video' ? c : null; };
  const xOf = (c, t) => PADX + (t - c.in) / Math.max(1e-6, c.out - c.in) * (W - 2 * PADX);
  const tOf = (c, x) => c.in + Math.min(1, Math.max(0, (x - PADX) / (W - 2 * PADX))) * (c.out - c.in);
  const yOf = (s) => PADY + (1 - (Math.log2(s) - LOG_LO) / (LOG_HI - LOG_LO)) * (H - 2 * PADY);
  const sOf = (y) => 2 ** (LOG_LO + (1 - Math.min(1, Math.max(0, (y - PADY) / (H - 2 * PADY)))) * (LOG_HI - LOG_LO));
  const el = (n, a = {}) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const fx = (s) => (s >= 10 ? s.toFixed(0) : s.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')) + '×';

  // Change a clip's timeline length (speed, ramp...): with Ripple on everything after it moves with it, like the plain Speed control
  function reshape(c, fn, label, key) {
    const before = layout(app.project);
    fn();
    if (app.rippleEnabled) { const it = before.items.find(i => i.clip.id === c.id); if (it) rippleShift(app.project, it.end - 1e-3, layout(app.project).total - before.total); }
    app.commit(label, key);
  }

  for (const p of R.PRESETS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.preset = p.id; b.textContent = p.name; b.title = p.name + ': ' + p.hint;
    b.onclick = () => { const c = clip(); if (!c) return; reshape(c, () => { c.ramp = R.fromPreset(p.id, c); if (!('audio' in c.ramp)) c.ramp.audio = 'follow'; }, 'Speed curve: ' + p.name); };
    presetsBox.appendChild(b);
  }
  mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); const c = clip(); if (!b || !c) return;
    if (b.dataset.mode === 'curve' && !c.ramp) {
      const s = Math.min(R.RAMP_MAX, Math.max(R.RAMP_MIN, c.speed || 1));
      reshape(c, () => { c.ramp = { pts: [{ t: c.in, s }, { t: c.out, s }], audio: 'follow' }; }, 'Speed curve');
      toast('Speed curve on. Pick a preset (Montage, Hero time...) or tap the curve to add points.', 3600);
    } else if (b.dataset.mode === 'const' && c.ramp) {
      reshape(c, () => { c.speed = Math.min(4, Math.max(0.25, Math.round(R.meanSpeed(c) * 100) / 100)); delete c.ramp; }, 'Constant speed');
      toast('Back to a constant speed (' + c.speed + '×, the average of the curve).', 3000);
    }
  });
  $('rampSound').addEventListener('change', () => {
    const c = clip(); if (!c || !c.ramp) return;
    c.ramp.audio = $('rampSound').checked ? 'follow' : 'mute'; app.commit('Speed curve sound');
  });
  $('reverseBtn').addEventListener('click', () => {
    const c = clip(); if (!c) return;
    if (c.reverse) { delete c.reverse; app.commit('Reverse off'); toast('Reverse off.', 1800); return; }
    c.reverse = true; app.commit('Reverse');
    const rec = app.media.peek ? app.media.peek(c.mediaId) : null, big = rec && rec.size > 1.5 * 1024 ** 3;
    toast(big ? 'Reversed. This file is very large (' + (rec.size / 1024 ** 3).toFixed(1) + ' GB): the preview seeks frame by frame and the export decodes in small blocks, so it will be slow. Trimming the clip first helps.' : 'Reversed (video and sound). Undo (Ctrl+Z) turns it back.', big ? 7000 : 2600);
    prepare(c);
  });
  function prepare(c) {
    if (!c.reverse || !c.hasAudio || c.muted) return;
    player.prepareReverse(c, () => render());
  }

  // ---- the curve editor ----
  const pointer = (e) => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; };
  function ramp(c) { return R.withEnds(c.ramp, c); }
  svg.addEventListener('pointerdown', (e) => {
    const c = clip(); if (!c || !c.ramp) return;
    const t = e.target.closest('[data-i]'), pt = pointer(e);
    let w = ramp(c), i;
    if (t) i = +t.dataset.i;
    else {
      const w2 = R.addPoint(w, c, tOf(c, pt.x), sOf(pt.y));
      if (!w2) { toast(w.pts.length >= R.RAMP_MAX_POINTS ? 'That is the most points a curve can have (' + R.RAMP_MAX_POINTS + '). Remove one first.' : 'Too close to another point.', 2600); return; }
      w = w2; i = w.pts.findIndex(p => Math.abs(p.t - tOf(c, pt.x)) < 1e-6 || p === w.pts.find(q => Math.abs(q.t - Math.min(c.out - R.MIN_GAP, Math.max(c.in + R.MIN_GAP, tOf(c, pt.x)))) < 1e-9));
      if (i < 0) i = w.pts.length - 2;
      c.ramp = { ...w, audio: c.ramp.audio }; app.liveUpdate();
    }
    e.preventDefault(); try { svg.setPointerCapture(e.pointerId); } catch { /* gone */ }
    drag = { id: e.pointerId, i, c, before: layout(app.project), moved: !t };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { c } = drag, pt = pointer(e); drag.moved = true;
    c.ramp = { ...R.movePoint(ramp(c), c, drag.i, tOf(c, pt.x), sOf(pt.y)), audio: c.ramp.audio };
    app.liveUpdate();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { c, before, moved } = drag; drag = null;
    if (moved) {
      if (app.rippleEnabled) { const it = before.items.find(i => i.clip.id === c.id); if (it) rippleShift(app.project, it.end - 1e-3, layout(app.project).total - before.total); }
      app.commit('Edit speed curve', 'ramp:' + c.id);
    }
  };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', (e) => {
    const c = clip(), t = e.target.closest('[data-i]'); if (!c || !c.ramp || !t) return;
    const w = ramp(c), i = +t.dataset.i;
    if (i <= 0 || i >= w.pts.length - 1) { toast('The first and last points stay; drag them up or down to change the speed there.', 2800); return; }
    reshape(c, () => { c.ramp = { ...R.removePoint(w, c, i), audio: c.ramp.audio }; }, 'Remove curve point');
  });
  svg.addEventListener('keydown', (e) => {
    const c = clip(), t = e.target.closest('[data-i]'); if (!c || !c.ramp || !t) return;
    const w = ramp(c), i = +t.dataset.i, p = w.pts[i], span = c.out - c.in; let ns = p.s, nt = p.t;
    if (e.key === 'ArrowUp') ns = p.s * 1.1; else if (e.key === 'ArrowDown') ns = p.s / 1.1;
    else if (e.key === 'ArrowRight') nt = p.t + span * 0.01; else if (e.key === 'ArrowLeft') nt = p.t - span * 0.01;
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (i > 0 && i < w.pts.length - 1) { e.preventDefault(); e.stopPropagation(); reshape(c, () => { c.ramp = { ...R.removePoint(w, c, i), audio: c.ramp.audio }; }, 'Remove curve point'); } return; }
    else return;
    e.preventDefault(); e.stopPropagation();
    reshape(c, () => { c.ramp = { ...R.movePoint(w, c, i, nt, ns), audio: c.ramp.audio }; }, 'Edit speed curve', 'ramp:' + c.id);
    const n = svg.querySelector('[data-i="' + i + '"]'); if (n) n.focus();
  });

  function draw(c) {
    const w = ramp(c); svg.replaceChildren();
    svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, class: 'ramp-bg', rx: 8 }));
    for (const s of [0.25, 0.5, 1, 2, 4]) {
      svg.appendChild(el('line', { x1: PADX, x2: W - PADX, y1: yOf(s), y2: yOf(s), class: s === 1 ? 'ramp-one' : 'ramp-grid' }));
      const tx = el('text', { x: W - PADX + 1, y: yOf(s) + 3, class: 'ramp-tick', 'text-anchor': 'start' }); tx.textContent = ''; svg.appendChild(tx);
      const lb = el('text', { x: 2, y: yOf(s) - 2, class: 'ramp-tick' }); lb.textContent = fx(s); svg.appendChild(lb);
    }
    let d = '';
    for (let k = 0; k <= 96; k++) { const t = c.in + (c.out - c.in) * k / 96; d += (k ? 'L' : 'M') + xOf(c, t).toFixed(1) + ' ' + yOf(R.speedAt(w, t)).toFixed(1); }
    svg.appendChild(el('path', { d, class: 'ramp-path', fill: 'none' }));
    // playhead (where the timeline playhead sits in this clip, in source time)
    const lay = layout(app.project), it = lay.items.find(i => i.clip.id === c.id);
    if (it && player.t >= it.start && player.t <= it.end) {
      const st = Math.min(c.out, Math.max(c.in, ctx.sourceTime(it, player.t))), x = xOf(c, st);
      svg.appendChild(el('line', { x1: x, x2: x, y1: PADY - 4, y2: H - PADY + 4, class: 'ramp-head' }));
    }
    w.pts.forEach((p, i) => {
      const g = el('circle', { cx: xOf(c, p.t), cy: yOf(p.s), r: 6.5, class: 'ramp-pt' + (i === 0 || i === w.pts.length - 1 ? ' end' : ''), 'data-i': i, tabindex: 0, role: 'slider',
        'aria-label': 'Curve point ' + (i + 1) + ' of ' + w.pts.length + ': ' + fx(p.s) + ' at ' + fmt(p.t - c.in) + ' into the clip. Arrow keys move it, Delete removes it.', 'aria-valuetext': fx(p.s), 'aria-valuemin': R.RAMP_MIN, 'aria-valuemax': R.RAMP_MAX, 'aria-valuenow': p.s.toFixed(2) });
      svg.appendChild(el('circle', { cx: xOf(c, p.t), cy: yOf(p.s), r: 15, class: 'ramp-hit', 'data-i': i }));
      svg.appendChild(g);
    });
  }

  function render() {
    const c = clip(), on = !!c;
    mode.querySelectorAll('button').forEach(b => b.classList.toggle('selected', on && (b.dataset.mode === 'curve') === !!c.ramp));
    const curve = on && !!c.ramp;
    $('speedConst').hidden = curve; $('speedCurve').hidden = !curve;
    $('reverseBtn').setAttribute('aria-pressed', on && c.reverse ? 'true' : 'false'); $('reverseBtn').classList.toggle('selected', on && !!c.reverse);
    $('reverseBtn').textContent = on && c.reverse ? '↺ Reversed (tap to undo)' : '↺ Reverse';
    const info = $('reverseInfo');
    if (on && c.reverse) {
      const st = c.hasAudio && !c.muted ? player.revState(c) : { state: 'none' };
      info.textContent = st.state === 'loading' ? 'Preparing the reversed sound… ' + Math.round(st.progress * 100) + '%' : st.state === 'toolong' ? 'Sound of reversed clips over 3 min is in the export, not the preview.' : st.state === 'failed' ? 'Could not prepare the reversed sound for the preview.' : st.state === 'ready' ? 'Video and sound reversed.' : c.hasAudio ? '' : 'Video reversed (no sound in this clip).';
    } else info.textContent = '';
    if (!curve) return;
    presetsBox.querySelectorAll('button').forEach(b => b.classList.toggle('selected', c.ramp.preset === b.dataset.preset));
    $('rampSound').checked = c.ramp.audio !== 'mute';
    $('rampInfo').textContent = 'Footage ' + fmt(c.out - c.in) + ' plays in ' + fmt(clipLen(c)) + ' (average ' + fx(R.meanSpeed(c)) + '). Tap the curve to add a point, drag to move, double-tap a point to remove.';
    if (!drag) draw(c); else draw(c);
  }
  return { render };
}
