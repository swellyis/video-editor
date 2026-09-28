// Interactive multi-track timeline (video / text / audio + markers). Pointer events: mouse, pen and touch.
import { layout, clipLen, audioLen, moveClip, rippleShift, MIN_CLIP } from './model.js';
import { clamp, fmt, el } from './util.js';

const HANDLE = 14;

export class Timeline {
  constructor(root, app) {
    this.root = root; this.app = app;
    this.pps = 60; this.autoFit = true;
    this.nodes = new Map();
    this.drag = null;
    this.build();
  }
  build() {
    this.root.innerHTML = '';
    this.heads = el('div', { class: 'tl-heads' },
      el('div', { class: 'tl-head ruler-head' }, el('span', { text: 'TIME' })),
      el('div', { class: 'tl-head video-head' }, el('span', { text: 'VIDEO' })),
      el('div', { class: 'tl-head text-head' }, el('span', { text: 'TEXT' })),
      el('div', { class: 'tl-head audio-head' }, el('span', { text: 'MUSIC' })));
    this.scroll = el('div', { class: 'tl-scroll', tabindex: '0', 'aria-label': 'Timeline' });
    this.content = el('div', { class: 'tl-content' });
    this.ruler = el('div', { class: 'tl-ruler' });
    this.vTrack = el('div', { class: 'tl-track tl-video' });
    this.tTrack = el('div', { class: 'tl-track tl-text' });
    this.aTrack = el('div', { class: 'tl-track tl-audio' });
    this.playhead = el('div', { class: 'tl-playhead' }, el('div', { class: 'tl-playhead-knob' }));
    this.insert = el('div', { class: 'tl-insert' });
    this.snapLine = el('div', { class: 'tl-snapline' });
    this.tip = el('div', { class: 'tl-tip' });
    this.content.append(this.ruler, this.vTrack, this.tTrack, this.aTrack, this.playhead, this.insert, this.snapLine, this.tip);
    this.scroll.append(this.content);
    this.root.append(this.heads, this.scroll);
    this.ruler.addEventListener('pointerdown', e => this.onScrubStart(e));
    for (const tr of [this.vTrack, this.tTrack, this.aTrack]) tr.addEventListener('pointerdown', e => { if (e.target === tr) this.onEmptyDown(e); });
    this.scroll.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, this.timeAtClient(e.clientX)); }
    }, { passive: false });
    new ResizeObserver(() => { if (this.autoFit) this.fit(); else this.render(); }).observe(this.scroll);
  }
  get project() { return this.app.project; }
  x(t) { return 12 + t * this.pps; }
  timeAtClient(cx) { const r = this.content.getBoundingClientRect(); return Math.max(0, (cx - r.left - 12) / this.pps); }

  fit() {
    const total = layout(this.project).total;
    const w = this.scroll.clientWidth - 40;
    if (total > 0 && w > 50) this.pps = clamp(w / total, 2, 400);
    this.render();
  }
  zoomBy(f, anchor) {
    this.autoFit = false;
    const t = anchor ?? this.app.player.t;
    const before = this.x(t) - this.scroll.scrollLeft;
    this.pps = clamp(this.pps * f, 2, 600);
    this.render();
    this.scroll.scrollLeft = this.x(t) - before;
    this.app.onZoom && this.app.onZoom(this.pps);
  }
  setZoom(pps) { this.autoFit = false; const t = this.app.player.t; const before = this.x(t) - this.scroll.scrollLeft; this.pps = clamp(pps, 2, 600); this.render(); this.scroll.scrollLeft = this.x(t) - before; }

  snapPoints(exclude) {
    const p = this.project, lay = layout(p), pts = [0, lay.total, this.app.player.t];
    for (const it of lay.items) { pts.push(it.start, it.end); }
    for (const t of p.texts) if (t.id !== exclude) pts.push(t.start, t.end);
    for (const a of p.audio) if (a.id !== exclude) pts.push(a.start, a.start + audioLen(a));
    for (const m of p.markers) if (m.id !== exclude) pts.push(m.time);
    return pts;
  }
  snap(t, exclude, candidates) {
    if (!this.app.snapEnabled) { this.snapLine.style.display = 'none'; return { t, snapped: false }; }
    const th = 9 / this.pps; let best = null, bd = th;
    for (const p of this.snapPoints(exclude)) for (const c of (candidates || [0])) { const d = Math.abs(t + c - p); if (d < bd) { bd = d; best = p - c; } }
    if (best == null) { this.snapLine.style.display = 'none'; return { t, snapped: false }; }
    return { t: best, snapped: true };
  }
  showSnap(time) { this.snapLine.style.display = 'block'; this.snapLine.style.left = this.x(time) + 'px'; }

  _node(key, create, parent) {
    let n = this.nodes.get(key);
    if (!n) { n = create(); this.nodes.set(key, n); }
    if (n.parentNode !== parent) parent.appendChild(n);
    n._seen = this._gen;
    return n;
  }

  render() {
    const p = this.project, lay = layout(p);
    this._gen = (this._gen || 0) + 1;
    const sel = this.app.selection || {};
    const width = Math.max(this.scroll.clientWidth, this.x(Math.max(lay.total, ...p.audio.map(a => a.start + audioLen(a)), ...p.texts.map(t => t.end))) + 240);
    this.content.style.width = width + 'px';
    // ruler ticks
    const secs = width / this.pps;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find(s => s * this.pps >= 70) || 600;
    const minor = steps.slice().reverse().find(s => s < major && s * this.pps >= 12) || major;
    let html = '';
    for (let t = 0; t <= secs; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += `<div class="tick${isMajor ? ' major' : ''}" style="left:${this.x(t)}px">${isMajor ? `<span>${major < 1 ? t.toFixed(1) + 's' : fmt(t)}</span>` : ''}</div>`;
    }
    if (this._rulerKey !== html) { this._rulerHtml && this._rulerHtml.remove(); this._rulerHtml = el('div', { class: 'ticks', html }); this.ruler.prepend(this._rulerHtml); this._rulerKey = html; }
    // markers
    for (const m of p.markers) {
      const n = this._node('m:' + m.id, () => {
        const d = el('div', { class: 'tl-marker', title: m.name });
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'marker', d._id));
        return d;
      }, this.ruler);
      n._id = m.id; n.dataset.id = m.id;
      n.style.left = this.x(m.time) + 'px';
      n.title = (m.name || 'Marker') + ' · ' + fmt(m.time);
      n.dataset.label = m.name || '';
      n.classList.toggle('sel', sel.type === 'marker' && sel.id === m.id);
    }
    // video clips
    for (const it of lay.items) {
      const c = it.clip;
      const n = this._node('c:' + c.id, () => {
        const d = el('div', { class: 'tl-clip' },
          el('div', { class: 'strip' }), el('div', { class: 'xfade' }),
          el('div', { class: 'meta' }, el('b'), el('span')),
          el('div', { class: 'badges' }),
          el('div', { class: 'h-l', 'aria-label': 'Trim start' }), el('div', { class: 'h-r', 'aria-label': 'Trim end' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'clip', d._id));
        return d;
      }, this.vTrack);
      n._id = c.id; n.dataset.id = c.id;
      const w = Math.max(6, it.len * this.pps);
      n.style.left = this.x(it.start) + 'px'; n.style.width = w + 'px';
      n.style.zIndex = String(10 + it.index);
      n.classList.toggle('sel', sel.type === 'clip' && sel.id === c.id);
      n.classList.toggle('image', c.kind === 'image');
      const rec = this.app.media.peek(c.mediaId);
      n.classList.toggle('offline', !rec);
      n.querySelector('.meta b').textContent = c.name;
      n.querySelector('.meta span').textContent = fmt(it.len) + (c.kind === 'video' && c.speed !== 1 ? ' · ' + c.speed + '×' : '');
      const badges = [];
      if (c.kind === 'video' && (c.muted || !c.hasAudio)) badges.push('🔇');
      if (c.transition.type !== 'cut' && (it.index > 0 || c.transition.type === 'fade')) badges.push(c.transition.type === 'crossfade' ? '⧓' : '◐');
      if (c.color.preset !== 'none') badges.push('◑');
      n.querySelector('.badges').textContent = badges.join(' ');
      const xf = n.querySelector('.xfade');
      xf.style.width = (it.xIn * this.pps) + 'px'; xf.style.display = it.xIn > 0 ? 'block' : 'none';
      this.renderStrip(n.querySelector('.strip'), c, rec, w);
    }
    // text lanes
    const tl = this.lanes(p.texts.map(t => ({ id: t.id, s: t.start, e: t.end })));
    this.tTrack.style.height = Math.max(34, tl.count * 26 + 8) + 'px';
    for (const t of p.texts) {
      const n = this._node('t:' + t.id, () => {
        const d = el('div', { class: 'tl-item tl-textitem' }, el('span'), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'text', d._id));
        return d;
      }, this.tTrack);
      n._id = t.id; n.dataset.id = t.id;
      n.style.left = this.x(t.start) + 'px'; n.style.width = Math.max(8, (t.end - t.start) * this.pps) + 'px';
      n.style.top = (4 + tl.lane.get(t.id) * 26) + 'px';
      n.querySelector('span').textContent = (t.text || '(empty)').replace(/\n/g, ' ');
      n.classList.toggle('sel', sel.type === 'text' && sel.id === t.id);
    }
    // audio lanes
    const al = this.lanes(p.audio.map(a => ({ id: a.id, s: a.start, e: a.start + audioLen(a) })));
    this.aTrack.style.height = Math.max(42, al.count * 38 + 6) + 'px';
    for (const a of p.audio) {
      const n = this._node('a:' + a.id, () => {
        const d = el('div', { class: 'tl-item tl-audioitem' }, el('canvas', { class: 'wave' }), el('span'), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'audio', d._id));
        return d;
      }, this.aTrack);
      n._id = a.id; n.dataset.id = a.id;
      const w = Math.max(8, audioLen(a) * this.pps);
      n.style.left = this.x(a.start) + 'px'; n.style.width = w + 'px';
      n.style.top = (3 + al.lane.get(a.id) * 38) + 'px';
      n.querySelector('span').textContent = '♪ ' + a.name + (a.duck ? ' · duck' : '');
      n.classList.toggle('sel', sel.type === 'audio' && sel.id === a.id);
      n.classList.toggle('offline', !this.app.media.peek(a.mediaId));
      this.renderWave(n.querySelector('.wave'), a, w);
    }
    // remove stale
    for (const [k, n] of this.nodes) if (n._seen !== this._gen) { n.remove(); this.nodes.delete(k); }
    this.vTrack.classList.toggle('empty', !lay.items.length);
    this.updatePlayhead(this.app.player.t);
  }
  lanes(items) {
    const lane = new Map(), ends = [];
    for (const it of [...items].sort((a, b) => a.s - b.s)) {
      let i = ends.findIndex(e => e <= it.s + 1e-6);
      if (i < 0) { i = ends.length; ends.push(0); }
      ends[i] = it.e; lane.set(it.id, i);
    }
    return { lane, count: Math.max(1, ends.length) };
  }
  renderStrip(strip, c, rec, w) {
    const frames = rec && rec.strip ? rec.strip : [];
    const tileW = 64;
    const n = Math.min(80, Math.max(1, Math.ceil(w / tileW)));
    const key = [frames.length, n, c.in.toFixed(2), c.out.toFixed(2), c.speed, Math.round(this.pps)].join('|');
    if (strip._key === key) return;
    strip._key = key;
    strip.innerHTML = '';
    if (!frames.length) return;
    for (let i = 0; i < n; i++) {
      let idx = 0;
      if (c.kind === 'video' && rec.duration) {
        const srcT = c.in + ((i + 0.5) / n) * (c.out - c.in);
        idx = clamp(Math.floor((srcT / rec.duration) * frames.length), 0, frames.length - 1);
      }
      const im = document.createElement('img'); im.src = frames[idx]; im.alt = ''; im.draggable = false; im.decoding = 'async';
      strip.appendChild(im);
    }
  }
  renderWave(cv, a, w) {
    const rec = this.app.media.peek(a.mediaId);
    const peaks = rec && rec.peaks;
    const W = Math.min(4000, Math.round(w)), H = 30;
    const key = [W, a.in, a.out, !!peaks].join('|');
    if (cv._key === key) return; cv._key = key;
    cv.width = W; cv.height = H; cv.style.width = W + 'px';
    const x = cv.getContext('2d'); x.clearRect(0, 0, W, H);
    if (!peaks) return;
    x.fillStyle = 'rgba(255,255,255,.35)';
    const len = a.out - a.in;
    for (let px = 0; px < W; px += 2) {
      const t = a.in + (px / W) * len;
      const v = (peaks.data[Math.floor(t * peaks.rate)] || 0) / 255;
      const h = Math.max(1, v * H);
      x.fillRect(px, (H - h) / 2, 1.5, h);
    }
  }
  updatePlayhead(t, follow) {
    const x = this.x(t);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (follow) {
      const sl = this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > sl + w - 40 || x < sl) this.scroll.scrollLeft = Math.max(0, x - 60);
    }
  }

  // ---------- interactions ----------
  contentX(e) { const r = this.content.getBoundingClientRect(); return e.clientX - r.left; }
  onScrubStart(e) {
    if (e.target.closest('.tl-marker')) return;
    e.preventDefault();
    this.ruler.setPointerCapture(e.pointerId);
    const wasPlaying = this.app.player.playing;
    if (wasPlaying) this.app.player.pause();
    const move = (ev) => { this.app.seek(this.timeAtClient(ev.clientX)); this.autoScroll(ev); };
    const up = () => { this.ruler.removeEventListener('pointermove', move); this.ruler.removeEventListener('pointerup', up); this.ruler.removeEventListener('pointercancel', up); this.stopAuto(); };
    this.ruler.addEventListener('pointermove', move); this.ruler.addEventListener('pointerup', up); this.ruler.addEventListener('pointercancel', up);
    move(e);
  }
  onEmptyDown(e) {
    const sx = e.clientX, sy = e.clientY, target = e.currentTarget;
    const up = (ev) => {
      target.removeEventListener('pointerup', up);
      if (Math.abs(ev.clientX - sx) < 6 && Math.abs(ev.clientY - sy) < 6) { this.app.select(null); this.app.seek(this.timeAtClient(ev.clientX)); }
    };
    target.addEventListener('pointerup', up);
    if (e.pointerType === 'mouse') { this.app.select(null); this.app.seek(this.timeAtClient(e.clientX)); target.removeEventListener('pointerup', up); }
  }
  autoScroll(ev) {
    const r = this.scroll.getBoundingClientRect();
    const edge = 36;
    let v = 0;
    if (ev.clientX < r.left + edge) v = -Math.ceil((r.left + edge - ev.clientX) / 3);
    else if (ev.clientX > r.right - edge) v = Math.ceil((ev.clientX - (r.right - edge)) / 3);
    this._autoV = v; this._autoEv = ev;
    if (v && !this._autoTimer) this._autoTimer = setInterval(() => {
      if (!this._autoV) return this.stopAuto();
      this.scroll.scrollLeft += this._autoV;
      if (this.drag && this.drag.onMove) this.drag.onMove(this._autoEv);
    }, 16);
  }
  stopAuto() { clearInterval(this._autoTimer); this._autoTimer = null; this._autoV = 0; }

  onItemDown(e, type, id) {
    const node = e.currentTarget;
    const isTouch = e.pointerType !== 'mouse';
    const alreadySel = this.app.selection && this.app.selection.type === type && this.app.selection.id === id;
    const handle = e.target.classList.contains('h-l') ? 'l' : e.target.classList.contains('h-r') ? 'r' : 'body';
    e.stopPropagation();
    if (isTouch && !alreadySel) {
      // Touch: first tap selects (lets the timeline scroll natively); drag once selected.
      const sx = e.clientX, sy = e.clientY;
      const up = (ev) => { node.removeEventListener('pointerup', up); if (Math.abs(ev.clientX - sx) < 8 && Math.abs(ev.clientY - sy) < 8) this.app.select({ type, id }, { seekInto: true }); };
      node.addEventListener('pointerup', up, { once: true });
      return;
    }
    e.preventDefault();
    if (!alreadySel) this.app.select({ type, id });
    this.startDrag(e, node, type, id, handle);
  }

  startDrag(e, node, type, id, handle) {
    const p = this.project;
    const x0 = this.contentX(e) + 0; const sl0 = this.scroll.scrollLeft;
    const lay0 = layout(p);
    const snapshot = JSON.parse(JSON.stringify(p));
    let moved = false;
    const d = this.drag = { type, id, handle };
    const pointerId = e.pointerId;
    try { node.setPointerCapture(pointerId); } catch { }
    const dtOf = (ev) => (this.contentX(ev) - x0) / this.pps;
    const tip = (txt, t) => { this.tip.textContent = txt; this.tip.style.display = 'block'; this.tip.style.left = this.x(t) + 'px'; };

    if (type === 'clip') {
      const idx = p.clips.findIndex(c => c.id === id), c = p.clips[idx], it0 = lay0.items[idx];
      const orig = { in: c.in, out: c.out };
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!moved && Math.abs(dt * this.pps) < 4) return;
        moved = true; this.autoScroll(ev);
        if (handle === 'l') {
          if (c.kind === 'image') c.out = clamp(orig.out - dt, MIN_CLIP, 3600);
          else c.in = clamp(orig.in + dt * c.speed, 0, orig.out - MIN_CLIP * c.speed);
          tip((c.kind === 'image' ? 'Length ' : 'In ') + (c.kind === 'image' ? fmt(c.out) : c.in.toFixed(2) + 's'), it0.start);
          this.app.liveUpdate({ previewAt: it0.start });
        } else if (handle === 'r') {
          let end = it0.start + (orig.out - orig.in) / (c.kind === 'image' ? 1 : c.speed) + dt;
          const s = this.snap(end, null); if (s.snapped && Math.abs(s.t - it0.end) > 1e-3) { end = s.t; this.showSnap(end); } else this.snapLine.style.display = 'none';
          const len = Math.max(MIN_CLIP, end - it0.start);
          if (c.kind === 'image') c.out = c.in + len; else c.out = clamp(orig.in + len * c.speed, orig.in + MIN_CLIP * c.speed, c.srcDuration);
          tip('Out ' + (c.kind === 'image' ? fmt(c.out) : c.out.toFixed(2) + 's') + ' · ' + fmt(clipLen(c)), it0.start + clipLen(c));
          this.app.liveUpdate({ previewAt: Math.max(it0.start, it0.start + clipLen(c) - 0.04) });
        } else {
          node.classList.add('dragging');
          node.style.transform = `translateX(${dt * this.pps}px)`;
          const t = this.timeAtClient(ev.clientX);
          let to = lay0.items.length;
          for (let i = 0; i < lay0.items.length; i++) { const it = lay0.items[i]; if (t < (it.start + it.end) / 2) { to = i; break; } }
          d.to = to;
          const ix = to < lay0.items.length ? lay0.items[to].start : lay0.total;
          this.insert.style.display = 'block'; this.insert.style.left = this.x(ix) + 'px';
        }
      };
      d.onUp = () => {
        this.insert.style.display = 'none'; node.classList.remove('dragging'); node.style.transform = '';
        if (!moved) return;
        if (handle === 'body') {
          if (d.to != null) { const to = d.to > idx ? d.to - 1 : d.to; if (to !== idx) { moveClip(p, idx, to); this.app.commit('Reorder clip'); return; } }
          this.render(); return;
        }
        if (this.app.rippleEnabled) rippleShift(p, it0.end - 1e-3, layout(p).total - lay0.total);
        this.app.commit('Trim clip');
      };
    } else if (type === 'text') {
      const t0 = p.texts.find(t => t.id === id); const o = { s: t0.start, e: t0.end };
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!moved && Math.abs(dt * this.pps) < 4) return;
        moved = true; this.autoScroll(ev);
        if (handle === 'body') {
          const len = o.e - o.s; let s = Math.max(0, o.s + dt);
          const sn = this.snap(s, id, [0, len]); if (sn.snapped) { s = Math.max(0, sn.t); this.showSnap(Math.abs(sn.t - s) < 1e-6 ? s : s + len); }
          t0.start = s; t0.end = s + len; tip(fmt(t0.start) + ' → ' + fmt(t0.end), t0.start);
        } else if (handle === 'l') {
          let s = clamp(o.s + dt, 0, o.e - 0.2); const sn = this.snap(s, id); if (sn.snapped) { s = clamp(sn.t, 0, o.e - 0.2); this.showSnap(s); }
          t0.start = s; tip('Start ' + fmt(s), s);
        } else {
          let e2 = Math.max(o.s + 0.2, o.e + dt); const sn = this.snap(e2, id); if (sn.snapped) { e2 = Math.max(o.s + 0.2, sn.t); this.showSnap(e2); }
          t0.end = e2; tip('End ' + fmt(e2), e2);
        }
        this.app.liveUpdate({ previewAt: handle === 'r' ? t0.end - 0.05 : t0.start + 0.01, keepTime: handle === 'body' });
      };
      d.onUp = () => { if (moved) this.app.commit('Move text'); };
    } else if (type === 'audio') {
      const a = p.audio.find(x => x.id === id); const o = { s: a.start, i: a.in, out: a.out };
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!moved && Math.abs(dt * this.pps) < 4) return;
        moved = true; this.autoScroll(ev);
        if (handle === 'body') {
          let s = Math.max(0, o.s + dt); const len = o.out - o.i;
          const sn = this.snap(s, id, [0, len]); if (sn.snapped) { s = Math.max(0, sn.t); this.showSnap(s); }
          a.start = s; tip('Starts ' + fmt(s), s);
        } else if (handle === 'l') {
          const dd = clamp(dt, -Math.min(o.i, o.s), (o.out - o.i) - 0.2);
          a.in = o.i + dd; a.start = o.s + dd; tip('Trim in ' + a.in.toFixed(1) + 's', a.start);
        } else {
          let end = o.s + (o.out - o.i) + dt; const sn = this.snap(end, id); if (sn.snapped) { end = sn.t; this.showSnap(end); }
          a.out = clamp(o.i + (end - o.s), o.i + 0.2, a.srcDuration || 1e9); tip('Ends ' + fmt(a.start + audioLen(a)), a.start + audioLen(a));
        }
        this.app.liveUpdate({ keepTime: true });
      };
      d.onUp = () => { if (moved) this.app.commit('Edit music'); };
    } else if (type === 'marker') {
      const m = p.markers.find(x => x.id === id); const o = m.time;
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!moved && Math.abs(dt * this.pps) < 4) return;
        moved = true; this.autoScroll(ev);
        let t = Math.max(0, o + dt); const sn = this.snap(t, id); if (sn.snapped) { t = sn.t; this.showSnap(t); }
        m.time = t; tip(fmt(t), t);
        this.app.liveUpdate({ keepTime: true });
      };
      d.onUp = () => { if (moved) this.app.commit('Move marker'); else this.app.seek(m.time); };
    }
    const move = (ev) => { if (ev.pointerId === pointerId) d.onMove(ev); };
    const end = (ev) => {
      if (ev.pointerId !== pointerId) return;
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', cancel);
      this.stopAuto(); this.tip.style.display = 'none'; this.snapLine.style.display = 'none';
      this.drag = null;
      d.onUp();
    };
    const cancel = (ev) => {
      // restore on cancel
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', cancel);
      this.stopAuto(); this.tip.style.display = 'none'; this.snapLine.style.display = 'none'; this.insert.style.display = 'none';
      node.classList.remove('dragging'); node.style.transform = '';
      this.drag = null;
      if (moved) { this.app.restore(snapshot); }
    };
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', end); node.addEventListener('pointercancel', cancel);
    void sl0;
  }
}
