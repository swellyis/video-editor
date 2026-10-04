// Text tab: the animation library (looping previews drawn by the SAME drawText the video uses), In / Out / Loop, speed, Remove, Apply to all,
// and the ready-made sermon text. It is the ONE place to animate text; every change is one undo step.
import { newText, cleanTextAnim, layout } from './model.js';
import { drawText } from './render.js';
import { ANIMS, KINDS, groupsOf, label, summary, setAnim, removeAnim, applyToAll, TEMPLATES, buildTemplate } from './textanim.js';

export const TW = 160, TH = 90, CYCLE = 2.8, SAMPLE_DUR = 2.4;
const NOTES = {
  in: 'Plays when the text appears. Duration is how long the move takes.',
  out: 'Plays just before the text disappears. Duration is how long the move takes.',
  loop: 'Keeps moving while the text is on screen. Speed 1× is a calm pace.',
  karaoke: 'Karaoke lights up each word in turn, once, across the time the text is on screen.',
};
/** The sample layer a card previews: the animation is the only thing that differs between cards. */
export function sampleLayer(kind, id) {
  const t = newText(0, SAMPLE_DUR, 'Amazing grace');
  Object.assign(t, { x: 0.5, y: 0.5, size: 0.2, style: 'clean', font: 'sans', maxWidth: 0.95, fadeIn: 0, fadeOut: 0 });
  t.anim = cleanTextAnim({ in: kind === 'in' ? id : 'none', out: kind === 'out' ? id : 'none', loop: kind === 'loop' ? id : 'none', inDur: 0.9, outDur: 0.9, loopSpeed: 1.2 });
  return t;
}
/** Local time to show when nothing is moving (reduced motion / before the first frame): in the middle of the move. */
export const restLocal = (kind) => (kind === 'in' ? 0.45 : kind === 'out' ? SAMPLE_DUR - 0.45 : 1.1);
export function drawCard(ctx, kind, id, local) {
  const g = ctx.createLinearGradient(0, 0, TW, TH); g.addColorStop(0, '#1f2a44'); g.addColorStop(1, '#43304f');
  ctx.save(); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.fillStyle = g; ctx.fillRect(0, 0, TW, TH); ctx.restore();
  drawText(ctx, TW, TH, sampleLayer(kind, id), 1, local);
}

export function initTextAnimUI(ctx) {
  const { $, app, commit, selected, showTab, player, toast } = ctx;
  const grid = $('taGrid'); if (!grid) return { render() { }, kind: () => 'in' };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  let kind = 'in', cards = [], raf = 0, shown = new Set(), lastBuilt = '';
  const cur = () => selected('text');

  // ---- sermon text templates
  const tplEl = $('taTemplates');
  for (const tp of TEMPLATES) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ta-tp'; b.dataset.tpl = tp.id; b.title = tp.hint;
    b.innerHTML = '<b></b><small></small>'; b.firstChild.textContent = tp.label; b.lastChild.textContent = tp.hint;
    b.addEventListener('click', () => addTemplate(tp.id));
    tplEl.append(b);
  }
  function ratioOf(p) {
    const r = p.settings.ratio;
    if (r !== 'original') return r;
    const c = p.clips.find(x => x.width && x.height); return c && c.height / c.width >= 1.5 ? '9:16' : '16:9';
  }
  function addTemplate(id) {
    const p = app.project, total = layout(p).total;
    const at = Math.min(Math.max(0, player.t), Math.max(0, total - 1.5));
    const layers = buildTemplate(id, { at, total, ratio: ratioOf(p) });
    if (!layers.length) return;
    p.texts.push(...layers); app.selection = { type: 'text', id: layers[0].id };
    commit('Add text: ' + TEMPLATES.find(x => x.id === id).label);
    showTab('text'); player.setTime(layers[0].start + Math.min(1.2, (layers[0].end - layers[0].start) * 0.5));
    toast(TEMPLATES.find(x => x.id === id).label + ' added at the playhead (' + layers.length + (layers.length > 1 ? ' layers' : ' layer') + '). Tap one on the timeline to edit its words, look and animation.', 5000);
  }

  // ---- the grid
  function build() {
    const t = cur(); const key = kind;
    stop(); grid.replaceChildren(); cards = []; shown = new Set(); lastBuilt = key;
    for (const g of groupsOf(kind)) {
      const row = document.createElement('div'); row.className = 'tr-group'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', g.name);
      const h = document.createElement('span'); h.className = 'tr-gl'; h.textContent = g.name; h.setAttribute('aria-hidden', 'true'); row.append(h);
      const gr = document.createElement('div'); gr.className = 'tr-grid ta-grid';
      for (const a of g.items) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-type ta-card'; b.dataset.anim = a.id; b.dataset.kind = kind; b.setAttribute('aria-pressed', 'false');
        const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.setAttribute('aria-hidden', 'true');
        const lb = document.createElement('span'); lb.className = 'tr-lbl'; lb.textContent = a.label;
        b.append(cv, lb); b.addEventListener('click', () => choose(a.id));
        gr.append(b); cards.push({ b, cv, id: a.id, cx: cv.getContext('2d') });
        drawCard(cv.getContext('2d'), kind, a.id, restLocal(kind));
      }
      row.append(gr); grid.append(row);
    }
    start(); void t;
  }
  let io = null;
  function start() {
    if (reduced()) return;
    if (!io && 'IntersectionObserver' in window) io = new IntersectionObserver((es) => { for (const e of es) { const c = cards.find(x => x.cv === e.target); if (c) { if (e.isIntersecting) shown.add(c); else shown.delete(c); } } });
    if (io) for (const c of cards) io.observe(c.cv); else cards.forEach(c => shown.add(c));
    const t0 = performance.now(); let last = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33 || document.hidden || !grid.offsetParent) return; last = now;
      const local = Math.min(SAMPLE_DUR, ((now - t0) / 1000) % CYCLE);
      for (const c of shown) drawCard(c.cx, kind, c.id, local);
    };
    raf = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; if (io) io.disconnect(); }

  function choose(id) {
    const t = cur(); if (!t) return;
    const a = cleanTextAnim(t.anim);
    if (a[kind] === id) return;                 // already chosen: nothing to do, no empty undo step
    setAnim(t, kind, id);
    commit('Text animation');
    player.setTime(t.start + 0.001); player.play();
  }

  function render() {
    const t = cur(); if (!t) return;
    const a = cleanTextAnim(t.anim);
    for (const x of $('taKinds').children) { const on = x.dataset.kind === kind; x.classList.toggle('selected', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (lastBuilt !== kind) build();
    for (const c of cards) { const on = a[kind] === c.id; c.b.classList.toggle('selected', on); c.b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    for (const r of document.querySelectorAll('#taLib .ta-speed')) r.hidden = r.dataset.kind !== kind;
    $('taHiRow').hidden = !(kind === 'loop' && a.loop === 'karaoke');
    for (const sp of document.querySelectorAll('#taLib .ta-speed[data-kind=loop]')) sp.hidden = kind !== 'loop' || a.loop === 'karaoke';
    $('taSummary').textContent = summary(t);
    $('taNote').textContent = kind === 'loop' && a.loop === 'karaoke' ? NOTES.karaoke : NOTES[kind];
    $('taRemove').disabled = a[kind] === 'none';
    $('taRemove').textContent = 'Remove ' + KINDS[kind].toLowerCase();
    const others = app.project.texts.length - 1;
    $('taAll').disabled = others < 1;
    $('taAll').title = others < 1 ? 'Add another text layer first' : 'Give every text layer this ' + KINDS[kind].toLowerCase() + ' animation';
  }
  $('taKinds').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.kind === kind) return; kind = b.dataset.kind; render(); });
  $('taRemove').addEventListener('click', () => { const t = cur(); if (!t) return; if (removeAnim(t, kind)) { commit('Remove text animation'); toast(KINDS[kind] + ' animation removed.'); } });
  $('taAll').addEventListener('click', () => {
    const t = cur(); if (!t) return;
    const n = applyToAll(app.project, t, [kind]);
    if (!n) return toast('Every text layer already has this ' + KINDS[kind].toLowerCase() + ' animation.');
    commit('Text animation on all'); toast(KINDS[kind] + ' “' + label(kind, cleanTextAnim(t.anim)[kind]) + '” applied to ' + n + ' other text layer' + (n === 1 ? '' : 's') + '. Undo puts them back.', 5000);
  });
  void ANIMS;
  return { render, kind: () => kind, setKind(k) { kind = k; render(); }, addTemplate };
}
