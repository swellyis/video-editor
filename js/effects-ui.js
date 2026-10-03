// Effects tab (the first section of the Effects tab, which is the old Look tab): a library of 15 effects as small previews, in the style of the
// Transitions tab. Tap one to put it on the selected clip or picture-in-picture overlay (one undo step, then a short preview plays). Up to 3 stack
// on an item, each with its own intensity, in a draw order you can change. The data is item.fx = [{type, amount}] (see effects.js); the picture maths
// is fx-gl.js, shared with the player and both exports. One place for it: nothing else in the app sets effects.
import { EFFECTS, GROUPS, MAX_FX, fxInfo, fxLabel, addFx, moveFx, normFx } from './effects.js';
import { FxGL } from './fx-gl.js';
import { layout, overlayLen, laneOf } from './model.js';
import { deepClone } from './util.js';

const TW = 160, TH = 90;
const pct = (v) => Math.round(v * 100) + '%';

/** The sample picture the previews are drawn on: warm sky, sun, hills and a cross, with a few fine lines so sharpen / grain / pixelate show. */
export function samplePicture() {
  const c = document.createElement('canvas'); c.width = TW; c.height = TH; const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, TH); sky.addColorStop(0, '#2f4f8f'); sky.addColorStop(0.55, '#e08a55'); sky.addColorStop(1, '#f6c27a');
  x.fillStyle = sky; x.fillRect(0, 0, TW, TH);
  const sun = x.createRadialGradient(112, 40, 1, 112, 40, 20); sun.addColorStop(0, '#fffbe0'); sun.addColorStop(0.35, '#ffe38a'); sun.addColorStop(1, 'rgba(255,200,90,0)');
  x.fillStyle = sun; x.fillRect(80, 8, 64, 64);
  x.fillStyle = '#233a3a'; x.beginPath(); x.moveTo(0, 90); x.lineTo(0, 62); x.quadraticCurveTo(40, 44, 80, 62); x.quadraticCurveTo(120, 48, 160, 60); x.lineTo(160, 90); x.fill();
  x.fillStyle = '#10201f'; x.fillRect(30, 30, 4, 34); x.fillRect(22, 38, 20, 4); // a cross on the hill
  x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 1; for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(8 + i * 3, 74); x.lineTo(60 + i * 5, 74 + i * 2); x.stroke(); }
  x.fillStyle = '#fff'; x.fillRect(50, 14, 2, 2); x.fillRect(64, 22, 2, 2); x.fillRect(40, 8, 2, 2);
  return c;
}

export function initEffectsUI(ctx) {
  const { $, app, commit } = ctx;
  const panel = $('tab-look'), typesEl = $('fxTypes');
  if (!panel || !typesEl) return { render() { }, selectedItem() { return null; } };
  let msg = '', lastId = null, cur = null, playTimer = 0, eng = null, pic = null, drawn = false;
  const previewOn = () => { try { return localStorage.getItem('ve.fxPreview') !== '0' && !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // ---- the target: the selected clip or overlay
  function item() {
    const s = app.selection; if (!s) return null;
    const arr = s.type === 'clip' ? app.project.clips : s.type === 'overlay' ? app.project.overlays : null;
    const obj = arr && arr.find(x => x.id === s.id);
    if (!obj) return null;
    if (!Array.isArray(obj.fx)) obj.fx = [];
    return { kind: s.type, obj, list: arr };
  }
  const setMsg = (m) => { msg = m; $('fxNote').textContent = m; };
  function span(it) {
    if (it.kind === 'clip') { const x = layout(app.project).items.find(i => i.clip.id === it.obj.id); return x ? { start: x.start, end: x.end, n: x.index + 1 } : null; }
    return { start: it.obj.start, end: it.obj.start + overlayLen(it.obj), n: 0 };
  }

  // ---- previews (a canvas per effect; the same shader chain as the editor)
  const cards = new Map(), loops = new Map(), rest = new Map();
  const engine = () => { if (!eng) eng = new FxGL(); return eng.ok ? eng : null; };
  function paint(cv, type, t) {
    const e = engine(), x = cv.getContext('2d'); if (!pic) pic = samplePicture();
    const r = e && e.process(pic, TW, TH, [{ type, amount: fxInfo(type).amount }], t);
    x.clearRect(0, 0, TW, TH); x.drawImage(r || pic, 0, 0);
  }
  /** a moment when the effect is clearly visible (animated ones are only strong at some instants): the frame that differs most from the plain picture */
  function restingT(type) {
    if (rest.has(type)) return rest.get(type);
    const e = engine(); let best = 0.05;
    if (e) {
      const probe = document.createElement('canvas'); probe.width = 40; probe.height = 23; const px = probe.getContext('2d', { willReadFrequently: true });
      const grab = (list, t) => { const r = e.process(pic, TW, TH, list, t); px.drawImage(r || pic, 0, 0, 40, 23); return px.getImageData(0, 0, 40, 23).data; };
      const base = grab([{ type: 'bars', amount: 0 }], 0); let bd = -1;
      for (let k = 0; k < 24; k++) {
        const t = 0.05 + k * 0.13, d = grab([{ type, amount: fxInfo(type).amount }], t); let s = 0;
        for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - base[i]) + Math.abs(d[i + 1] - base[i + 1]) + Math.abs(d[i + 2] - base[i + 2]);
        if (s > bd * 1.06) { bd = s; best = t; }
      }
    }
    rest.set(type, best); return best;
  }
  function loop(cv, type) {
    let on = true, t0 = performance.now();
    const step = (now) => { if (!on) return; paint(cv, type, restingT(type) + (now - t0) / 1000); requestAnimationFrame(step); };
    requestAnimationFrame(step);
    return () => { on = false; paint(cv, type, restingT(type)); };
  }
  const fine = (() => { try { return matchMedia('(pointer: fine)').matches; } catch { return false; } })();
  for (const g of GROUPS) {
    const row = document.createElement('div'); row.className = 'tr-group'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', g);
    const h = document.createElement('span'); h.className = 'tr-gl'; h.textContent = g; h.setAttribute('aria-hidden', 'true'); row.append(h);
    const grid = document.createElement('div'); grid.className = 'tr-grid';
    for (const f of EFFECTS.filter(x => x.group === g)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-type fx-card'; b.dataset.fx = f.id; b.setAttribute('aria-pressed', 'false');
      const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.setAttribute('aria-hidden', 'true');
      const lb = document.createElement('span'); lb.className = 'tr-lbl'; lb.textContent = f.label;
      b.append(cv, lb);
      b.addEventListener('click', () => choose(f.id));
      const play = () => { if (reduced() || !drawn) return; if (!loops.has(f.id)) loops.set(f.id, loop(cv, f.id)); };
      const stop = () => { const s = loops.get(f.id); if (s) { s(); loops.delete(f.id); } };
      b.addEventListener('pointerenter', play); b.addEventListener('pointerleave', stop); b.addEventListener('focus', play); b.addEventListener('blur', stop);
      b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { play(); setTimeout(stop, 1800); } });
      void fine;
      grid.append(b); cards.set(f.id, { b, cv });
    }
    row.append(grid); typesEl.append(row);
  }
  function drawAll() { // the first time the tab is shown (WebGL is not touched until then)
    if (drawn) return; drawn = true; if (!pic) pic = samplePicture();
    for (const [id, { cv }] of cards) paint(cv, id, restingT(id));
  }

  // ---- changing the project (one undo step each)
  function playPreview(it) {
    clearTimeout(playTimer);
    const sp = span(it); if (!sp || !previewOn()) return;
    const player = app.player; if (player.playing) player.pause();
    const t = player.t, from = t >= sp.start && t < sp.end - 0.3 ? t : sp.start;
    app.seek(from); player.play(1);
    playTimer = setTimeout(() => { player.pause(); app.seek(from); }, Math.min(1800, Math.max(500, (sp.end - from) * 1000)));
  }
  function choose(type) {
    const it = item();
    if (!it) { // nothing selected: take the clip at the playhead, say so, change nothing
      const t = app.player ? app.player.t : 0, x = layout(app.project).items.find(i => t >= i.start && t < i.end) || layout(app.project).items[0];
      if (!x) { setMsg('Add a clip first, then tap an effect.'); return; }
      app.select({ type: 'clip', id: x.clip.id }); render();
      setMsg(`Clip ${x.index + 1} selected. Tap an effect to put it on this clip.`); return;
    }
    const r = addFx(it.obj.fx, type);
    if (r.why === 'have') { cur = type; setMsg(fxLabel(type) + ' is already on this ' + (it.kind === 'clip' ? 'clip' : 'overlay') + '. Drag Intensity to change it, or tap Remove.'); render(); return; }
    if (r.why === 'full') { setMsg(`A ${it.kind === 'clip' ? 'clip' : 'overlay'} can have up to ${MAX_FX} effects. Select one below and tap Remove first.`); render(); return; }
    it.obj.fx = r.list; cur = type; msg = '';
    commit('Effect: ' + fxLabel(type));
    playPreview(item());
  }
  function remove() {
    const it = item(); if (!it || !cur) return;
    const k = it.obj.fx.findIndex(f => f.type === cur); if (k < 0) return;
    it.obj.fx = it.obj.fx.filter((_, i) => i !== k); cur = it.obj.fx.length ? it.obj.fx[Math.min(k, it.obj.fx.length - 1)].type : null; msg = '';
    commit('Remove effect');
  }
  function move(d) {
    const it = item(); if (!it || !cur) return;
    const k = it.obj.fx.findIndex(f => f.type === cur), l = moveFx(it.obj.fx, k, d); if (l === it.obj.fx) return;
    it.obj.fx = l; msg = ''; commit('Reorder effects');
  }
  $('fxAmt').addEventListener('input', () => {
    const it = item(); if (!it || !cur) return; const f = it.obj.fx.find(x => x.type === cur); if (!f) return;
    f.amount = +$('fxAmt').value / 100; $('fxAmtOut').textContent = pct(f.amount); app.liveUpdate();
  });
  $('fxAmt').addEventListener('change', () => { const it = item(); if (it && cur) commit('Effect intensity'); });
  $('fxRemove').addEventListener('click', remove);
  $('fxEarlier').addEventListener('click', () => move(-1));
  $('fxLater').addEventListener('click', () => move(1));
  $('fxAll').addEventListener('click', () => {
    const it = item(); if (!it || !it.obj.fx.length) return;
    const lane = laneOf(it.obj), same = it.list.filter(x => x !== it.obj && laneOf(x) === lane);
    if (!same.length) { setMsg('There is no other ' + (it.kind === 'clip' ? 'clip' : 'overlay') + ' on this lane.'); return; }
    for (const x of same) x.fx = normFx(deepClone(it.obj.fx));
    const n = same.length; commit('Effects on all clips in the lane'); setMsg(`Put ${it.obj.fx.length === 1 ? 'this effect' : 'these ' + it.obj.fx.length + ' effects'} on ${n} other ${it.kind === 'clip' ? (n === 1 ? 'clip' : 'clips') : (n === 1 ? 'overlay' : 'overlays')} in this lane.`);
  });

  function noteFor(it) {
    if (!it) return app.project.clips.length ? 'Select a clip or overlay on the timeline, then tap an effect. Tapping one now picks the clip at the playhead.' : 'Add a clip first, then tap an effect.';
    if (!it.obj.fx.length) return 'No effects yet. Tap one below; it applies to the whole ' + (it.kind === 'clip' ? 'clip' : 'overlay') + '.';
    const f = it.obj.fx.find(x => x.type === cur);
    return f && fxInfo(f.type).fixed ? fxLabel(f.type) + ' has no intensity: it is on or off.' : `Effects are applied in the order shown (first one first).`;
  }
  function render() {
    if (panel.classList.contains('active')) drawAll();
    const it = item(), id = it ? it.obj.id : null;
    if (id !== lastId) { lastId = id; msg = ''; cur = null; }
    const list = it ? it.obj.fx : [];
    if (!list.some(f => f.type === cur)) cur = list.length ? list[list.length - 1].type : null;
    const sp = it && span(it);
    $('fxFor').textContent = !it ? 'No clip selected' : it.kind === 'clip' ? `Clip ${sp ? sp.n : ''}: ${it.obj.name}` : `Overlay: ${it.obj.name}`;
    const st = $('fxStack'); st.textContent = '';
    list.forEach((f, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fx-chip' + (f.type === cur ? ' selected' : ''); b.dataset.fx = f.type; b.setAttribute('aria-pressed', f.type === cur ? 'true' : 'false');
      b.textContent = `${i + 1}. ${fxLabel(f.type)}` + (fxInfo(f.type).fixed ? '' : ' · ' + pct(f.amount));
      b.addEventListener('click', () => { cur = f.type; msg = ''; render(); });
      st.append(b);
    });
    for (const [tid, { b }] of cards) { const on = list.some(f => f.type === tid); b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    const f = list.find(x => x.type === cur), fixed = !!f && fxInfo(f.type).fixed;
    $('fxAmt').disabled = !f || fixed; if (f && document.activeElement !== $('fxAmt')) $('fxAmt').value = String(Math.round(f.amount * 100));
    $('fxAmtOut').textContent = f && !fixed ? pct(f.amount) : '—';
    const k = list.findIndex(x => x.type === cur);
    $('fxRemove').disabled = !f; $('fxEarlier').disabled = !f || k < 1; $('fxLater').disabled = !f || k < 0 || k >= list.length - 1;
    $('fxAll').disabled = !it || !list.length;
    if (!msg) $('fxNote').textContent = noteFor(it);
  }
  return { render, selectedItem: item, labelOf: (o) => (o.fx || []).map(f => fxLabel(f.type)).join(' + ') };
}
