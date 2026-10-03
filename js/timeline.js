// Interactive multi-track timeline (video / text / audio + markers). Pointer events: mouse, pen and touch.
import { textLabel, blurLabel, layout, clipLen, audioLen, audioSpan, audioSpeed, loopSeams, moveClip, rippleShift, MIN_CLIP, overlayLen, kfTimes, rebaseKeyframes, hasKeyframes, volumeEnv, hasSound, VOL_KEY_MAX, laneOf, laneCount, insertLane, spanCtx, findItem, planItem, placeItem, moveClipTo, holdNextClip } from './model.js';
import { clamp, fmt, el, icon, toast } from './util.js';
import { retimeWords } from './captions.js';
import { timelineBeats, thin } from './beat.js';

function muteBadge(title, extra = '') {
  const i = icon('spkOff', 'ico badge-ico mute-badge' + (extra ? ' ' + extra : ''));
  i.setAttribute('role', 'img'); i.setAttribute('aria-hidden', 'false'); i.setAttribute('aria-label', title);
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = title; i.prepend(t);
  return i;
}
/** One stack of generic lanes (no track names): each row is ROW px high, items are ITEM_H high; ZONE = the "new lane" strips shown above and below while dragging. */
const ROW = 44, ITEM_H = 38, ZONE = 16;
export class Timeline {
  /** Sizes the lane stack and returns the top offset (px) of an item from its lane. The highest lane is the top row. */
  laneGeo() {
    const n = laneCount(this.project), zone = this._zones ? ZONE : 0;
    const h = Math.max(ROW + 6, zone * 2 + n * ROW);
    this.lanes.style.height = h + 'px';
    this.geo = { n, zone, rowH: ROW, track: this.lanes, h };
    return (it) => zone + (n - 1 - laneOf(it)) * ROW + (ROW - ITEM_H) / 2;
  }

  constructor(root, app) {
    this.root = root; this.app = app;
    this.pps = 60; this.autoFit = true;
    this.nodes = new Map();
    this.geo = {};
    this.drag = null;
    this.build();
  }
  build() {
    this.root.innerHTML = '';
    this.laneHeads = el('div', { class: 'tl-lane-heads' });
    this.heads = el('div', { class: 'tl-heads' }, el('div', { class: 'tl-head ruler-head', 'aria-hidden': 'true' }), this.laneHeads);
    this.scroll = el('div', { class: 'tl-scroll', tabindex: '0', 'aria-label': 'Timeline' });
    this.content = el('div', { class: 'tl-content' });
    this.ruler = el('div', { class: 'tl-ruler' });
    this.lanes = el('div', { class: 'tl-track tl-lanes' });
    this.playhead = el('div', { class: 'tl-playhead' }, el('div', { class: 'tl-playhead-knob' }));
    this.insert = el('div', { class: 'tl-insert' });
    this.snapLine = el('div', { class: 'tl-snapline' });
    this.drop = el('div', { class: 'tl-drop' });
    this.tip = el('div', { class: 'tl-tip' });
    this.content.append(this.ruler, this.lanes, this.playhead, this.insert, this.snapLine, this.drop, this.tip);
    this.scroll.append(this.content);
    this.root.append(this.heads, this.scroll);
    this.ruler.addEventListener('pointerdown', e => this.onScrubStart(e));
    this.lanes.addEventListener('pointerdown', e => { if (e.target === this.lanes) this.onEmptyDown(e); });
    // the ruler only draws ticks for the visible range; redraw as the timeline scrolls
    this.scroll.addEventListener('scroll', () => { if (this._rulerRaf) return; this._rulerRaf = requestAnimationFrame(() => { this._rulerRaf = 0; this.renderRuler(); this.renderCaps(); }); }, { passive: true });
    this.scroll.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, this.timeAtClient(e.clientX)); }
    }, { passive: false });
    new ResizeObserver(() => { if (this.autoFit) this.fit(); else this.render(); }).observe(this.scroll);
    this.pinchSetup();
  }
  /** Two fingers on the timeline zoom it (pinch). A drag in progress is cancelled when the second finger lands. */
  pinchSetup() {
    const ptrs = new Map(), dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2) {
        e.stopPropagation();
        if (this.drag && this.drag.abort) this.drag.abort();
        const [a, b] = [...ptrs.values()];
        this._pinch = { d0: dist(), pps0: this.pps, anchor: this.timeAtClient((a[0] + b[0]) / 2) };
      }
    }, true);
    this.scroll.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (this._pinch && ptrs.size === 2) { const f = this._pinch.pps0 * dist() / this._pinch.d0 / this.pps; if (Math.abs(f - 1) > 0.004) this.zoomBy(f, this._pinch.anchor); }
    }, true);
    const gone = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) this._pinch = null; };
    this.scroll.addEventListener('pointerup', gone, true); this.scroll.addEventListener('pointercancel', gone, true);
  }
  get project() { return this.app.project; }
  // ---------- lane sound buttons (left of each lane that holds something with sound) ----------
  /** The items of a lane that make sound (video with audio, overlay video with audio, music / voice). */
  laneAudible(lane) {
    const p = this.project;
    return [...p.clips.filter(c => laneOf(c) === lane && c.kind === 'video' && c.hasAudio), ...(p.overlays || []).filter(o => laneOf(o) === lane && o.kind === 'video' && o.hasAudio), ...p.audio.filter(a => laneOf(a) === lane)];
  }
  toggleLaneMute(lane) {
    const items = this.laneAudible(lane); if (!items.length) return;
    const target = !items.every(x => x.muted);
    for (const x of items) x.muted = target;
    this.app.commit((target ? 'Mute' : 'Unmute') + ' lane');
    toast((target ? 'Muted' : 'Unmuted') + ' everything on this lane', 1400);
  }
  renderHeads() {
    const n = this.geo.n, zone = this.geo.zone, heads = this.laneHeads;
    heads.style.paddingTop = zone + 'px'; heads.style.height = this.geo.h + 'px';
    while (heads.children.length > n) heads.lastChild.remove();
    while (heads.children.length < n) {
      const row = el('div', { class: 'tl-head lane-head' });
      const b = el('button', { class: 'track-mute', type: 'button', 'aria-pressed': 'false' }, icon('spk', 'ico spk-on'), icon('spkOff', 'ico spk-off'));
      b.addEventListener('click', () => this.toggleLaneMute(+row.dataset.lane));
      row.append(b); heads.appendChild(row);
    }
    [...heads.children].forEach((row, i) => {
      const lane = n - 1 - i, items = this.laneAudible(lane), muted = items.filter(x => x.muted).length;
      const all = items.length > 0 && muted === items.length, some = muted > 0 && !all, b = row.firstChild;
      row.dataset.lane = String(lane); row.style.height = ROW + 'px';
      b.hidden = !items.length; b.dataset.lane = String(lane);
      b.setAttribute('aria-pressed', all ? 'true' : some ? 'mixed' : 'false');
      b.setAttribute('aria-label', (all ? 'Unmute' : 'Mute') + ' lane ' + (lane + 1));
      b.title = (all ? 'Unmute' : 'Mute') + ' everything on this lane' + (some ? ' (some items are muted)' : '');
    });
  }
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
  /** Scroll sideways so time t is in view (used when jumping between captions). */
  reveal(t) { const x = this.x(t), sl = this.scroll.scrollLeft, w = this.scroll.clientWidth; if (x < sl + 20 || x > sl + w - 40) this.scroll.scrollLeft = Math.max(0, x - w / 3); }
  setZoom(pps) { this.autoFit = false; const t = this.app.player.t; const before = this.x(t) - this.scroll.scrollLeft; this.pps = clamp(pps, 2, 600); this.render(); this.scroll.scrollLeft = this.x(t) - before; }


  // ---------- free placement helpers (drag between lanes, drop indicator) ----------
  /** Show "new lane" strips above and below the lane stack while an item is dragged. */
  beginZones() {
    if (this._zones) return;
    this._zones = true; this._zoneEls = [];
    for (const pos of ['top', 'bot']) {
      const z = el('div', { class: 'tl-zone ' + pos, text: 'New lane', 'aria-hidden': 'true' });
      this.lanes.appendChild(z); this._zoneEls.push(z);
    }
    this.render();
  }
  endZones() {
    if (!this._zones) return;
    for (const z of this._zoneEls) z.remove();
    this._zones = false; this._zoneEls = [];
    this.drop.style.display = 'none';
    this.render();
  }
  /** The lane under a pointer height: a lane number, or { newAt } for the strips above (new top lane) / below (new bottom lane). `orig` when far from the lanes. */
  laneTarget(clientY, orig) {
    const g = this.geo; if (!g) return orig;
    const r = g.track.getBoundingClientRect(), y = clientY - r.top;
    if (y < -ROW || y > r.height + ROW) return orig;
    if (y < g.zone) return { newAt: g.n };
    if (y >= r.height - g.zone) return { newAt: 0 };
    return g.n - 1 - clamp(Math.floor((y - g.zone) / ROW), 0, g.n - 1);
  }
  hideDrop() { this.drop.style.display = 'none'; }
  /** Dashed outline of where the dragged item will land: an existing lane row, or the new-lane strip / line. */
  showDropLane(plan, len) {
    const g = this.geo; if (!g) return;
    const top0 = g.track.offsetTop, st = this.drop.style;
    st.display = 'block'; st.left = this.x(plan.start) + 'px'; st.width = Math.max(8, len * this.pps) + 'px';
    if (plan.newAt != null) {
      const yb = g.zone + (g.n - plan.newAt) * ROW; // boundary between the lanes where the new one opens
      st.top = (top0 + (plan.newAt >= g.n ? 1 : plan.newAt === 0 ? g.h - g.zone + 1 : yb - 3)) + 'px'; st.height = (plan.newAt >= g.n || plan.newAt === 0 ? g.zone - 2 : 6) + 'px';
      this.drop.className = 'tl-drop new';
    } else { st.top = (top0 + g.zone + (g.n - 1 - plan.lane) * ROW + (ROW - ITEM_H) / 2) + 'px'; st.height = ITEM_H + 'px'; this.drop.className = 'tl-drop'; }
  }
  /** Follow the pointer vertically with the dragged node (its horizontal position is the item's own start). */
  ghostY(node, d, clientY, dx = 0) {
    const tr = node.parentNode, nat = tr.getBoundingClientRect().top + node.offsetTop;
    node.style.transform = `translate(${dx}px, ${clientY - d.grabY - nat}px)`;
  }

  snapPoints(exclude) {
    const p = this.project, lay = layout(p), pts = [0, lay.total, this.app.player.t];
    for (const it of lay.items) if (it.clip.id !== exclude) { pts.push(it.start, it.end); }
    for (const t of p.texts) if (t.id !== exclude) pts.push(t.start, t.end);
    for (const b of p.blurs || []) if (b.id !== exclude) pts.push(b.start, b.end);
    for (const c of p.captions || []) if (c.id !== exclude) pts.push(c.start, c.end);
    for (const a of p.audio) if (a.id !== exclude) pts.push(a.start, a.start + audioSpan(a, lay.total));
    this._beatPts = new Set();   // Snap to beat: the beats of every music item that has "Snap to beats" on (thinned when zoomed out so they never form a wall)
    for (const a of p.audio) if (a.id !== exclude && a.beat && a.beat.on !== false && !a.loop) for (const t of thin(timelineBeats(a), this.pps, 16)) { pts.push(t); this._beatPts.add(t); }
    for (const m of p.markers) if (m.id !== exclude) pts.push(m.time);
    for (const o of p.overlays || []) if (o.id !== exclude) pts.push(o.start, o.start + overlayLen(o));
    return pts;
  }
  snap(t, exclude, candidates) {
    if (!this.app.snapEnabled || this._noSnap) { this.snapLine.style.display = 'none'; return { t, snapped: false }; }
    const th = 9 / this.pps; let best = null, bd = th;
    let bp = null;
    for (const p of this.snapPoints(exclude)) for (const c of (candidates || [0])) { const d = Math.abs(t + c - p); if (d < bd) { bd = d; best = p - c; bp = p; } }
    if (best == null) { this.snapLine.style.display = 'none'; return { t, snapped: false }; }
    this.snapLine.classList.toggle('beat', this._beatPts.has(bp));   // the guide is a different colour when it is a beat you snapped to
    return { t: best, snapped: true, beat: this._beatPts.has(bp) };
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
    const width = Math.max(this.scroll.clientWidth, this.x(Math.max(lay.total, ...p.audio.map(a => a.start + audioSpan(a, lay.total)), ...p.texts.map(t => t.end), ...(p.captions || []).slice(-1).map(c => c.end), ...(p.blurs || []).map(b => b.end), ...(p.overlays || []).map(o => o.start + overlayLen(o)))) + 240);
    this.content.style.width = width + 'px';
    this._width = width;
    this.renderRuler();
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
    // one stack of lanes: clips, overlays, text, blur regions, captions and sound all sit in it
    const top = this.laneGeo();
    // video clips
    for (const it of lay.items) {
      const c = it.clip;
      const n = this._node('c:' + c.id, () => {
        const d = el('div', { class: 'tl-clip' },
          el('div', { class: 'strip' }), el('div', { class: 'xfade' }), el('div', { class: 'kfs' }), el('div', { class: 'volenv' }),
          el('div', { class: 'meta' }, el('b'), el('span')),
          el('div', { class: 'badges' }),
          el('div', { class: 'h-l', 'aria-label': 'Trim start' }), el('div', { class: 'h-r', 'aria-label': 'Trim end' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'clip', d._id));
        this.keyable(d, 'clip');
        return d;
      }, this.lanes);
      n._id = c.id; n.dataset.id = c.id;
      const w = Math.max(6, it.len * this.pps);
      n.style.left = this.x(it.start) + 'px'; n.style.width = w + 'px'; n.classList.toggle('narrow', w < 64);
      n.style.top = top(c) + 'px';
      n.classList.toggle('sel', sel.type === 'clip' && sel.id === c.id); n.setAttribute('aria-pressed', n.classList.contains('sel') ? 'true' : 'false');
      n.classList.toggle('image', c.kind === 'image');
      const rec = this.app.media.peek(c.mediaId);
      n.classList.toggle('offline', !rec);
      n.querySelector('.meta b').textContent = c.name;
      n.setAttribute('aria-label', `${c.kind === 'image' ? 'Image' : 'Clip'} ${it.index + 1}: ${c.name}, ${fmt(it.start)} to ${fmt(it.end)}`);
      n.querySelector('.meta span').textContent = fmt(it.len) + (c.kind === 'video' && c.speed !== 1 ? ' · ' + c.speed + '×' : '');
      const badges = [];
      if (c.kind === 'video' && c.muted && c.hasAudio) badges.push('muted');
      else if (c.kind === 'video' && !c.hasAudio) badges.push('noaudio');
      if (c.transition.type !== 'cut' && (it.index > 0 || c.transition.type === 'fade')) badges.push(c.transition.type === 'crossfade' ? 'xfade' : '◐');
      if (c.color.preset !== 'none') badges.push('◑');
      const bkey = badges.join(' ');
      const bEl = n.querySelector('.badges');
      if (bEl._key !== bkey) { bEl._key = bkey; bEl.replaceChildren(...badges.flatMap((b, i) => [i ? ' ' : '', b === 'xfade' ? icon('crossfade', 'ico badge-ico') : b === 'muted' ? muteBadge('Muted') : b === 'noaudio' ? muteBadge('No audio in this clip', 'dim') : b])); }
      const xf = n.querySelector('.xfade');
      xf.style.width = (it.xIn * this.pps) + 'px'; xf.style.display = it.xIn > 0 ? 'block' : 'none';
      this.renderStrip(n.querySelector('.strip'), c, rec, w);
      this.renderKfs(n, c, it.start, it.len);
      this.renderVolEnv(n, c, 'clip', it.start, it.len, ITEM_H, sel.type === 'clip' && sel.id === c.id && hasSound(c));
    }
    // overlays (picture-in-picture)
    for (const o of p.overlays || []) {
      const n = this._node('o:' + o.id, () => {
        const d = el('div', { class: 'tl-item tl-ovlitem' }, el('div', { class: 'strip' }), el('span'), el('div', { class: 'kfs' }), el('div', { class: 'volenv' }), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'overlay', d._id));
        this.keyable(d, 'overlay');
        return d;
      }, this.lanes);
      n._id = o.id; n.dataset.id = o.id;
      n.style.left = this.x(o.start) + 'px'; n.style.width = Math.max(8, overlayLen(o) * this.pps) + 'px'; n.classList.toggle('narrow', overlayLen(o) * this.pps < 64);
      n.style.top = top(o) + 'px';
      const lab = n.querySelector('span'), keyed = !!(o.chroma && o.chroma.enabled), om = o.kind === 'video' && o.hasAudio && o.muted, lk = keyed + '|' + o.name + '|' + om;
      if (lab._key !== lk) { lab._key = lk; lab.replaceChildren(icon(keyed ? 'key' : 'pip', 'ico item-ico'), ' ' + o.name, ...(om ? [' ', muteBadge('Muted')] : [])); }
      n.classList.toggle('sel', sel.type === 'overlay' && sel.id === o.id); n.setAttribute('aria-pressed', n.classList.contains('sel') ? 'true' : 'false');
      n.setAttribute('aria-label', `Overlay ${o.name}${om ? ' (muted)' : ''}, ${fmt(o.start)} to ${fmt(o.start + overlayLen(o))}`);
      const orec = this.app.media.peek(o.mediaId);
      n.classList.toggle('offline', !orec);
      this.renderStrip(n.querySelector('.strip'), o, orec, Math.max(8, overlayLen(o) * this.pps));
      this.renderKfs(n, o, o.start, overlayLen(o));
      this.renderVolEnv(n, o, 'overlay', o.start, overlayLen(o), ITEM_H, sel.type === 'overlay' && sel.id === o.id && hasSound(o));
    }
    // text
    for (const t of p.texts) {
      const n = this._node('t:' + t.id, () => {
        const d = el('div', { class: 'tl-item tl-textitem' }, el('span'), el('div', { class: 'kfs' }), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'text', d._id));
        this.keyable(d, 'text');
        return d;
      }, this.lanes);
      n._id = t.id; n.dataset.id = t.id;
      n.style.left = this.x(t.start) + 'px'; n.style.width = Math.max(8, (t.end - t.start) * this.pps) + 'px'; n.classList.toggle('narrow', (t.end - t.start) * this.pps < 64);
      n.style.top = top(t) + 'px';
      n.querySelector('span').textContent = textLabel(t);
      n.classList.toggle('sel', sel.type === 'text' && sel.id === t.id); n.setAttribute('aria-pressed', n.classList.contains('sel') ? 'true' : 'false');
      n.setAttribute('aria-label', `Text “${textLabel(t).slice(0, 60)}”, ${fmt(t.start)} to ${fmt(t.end)}`);
      n.classList.toggle('animated', !!(t.anim && (t.anim.in !== 'none' || t.anim.out !== 'none')));
      this.renderKfs(n, t, t.start, t.end - t.start);
    }
    this.renderCaps();
    // blur / privacy regions
    for (const b of p.blurs || []) {
      const n = this._node('b:' + b.id, () => {
        const d = el('div', { class: 'tl-item tl-blurritem' }, el('span'), el('div', { class: 'kfs' }), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'blur', d._id));
        this.keyable(d, 'blur');
        return d;
      }, this.lanes);
      n._id = b.id; n.dataset.id = b.id;
      n.style.left = this.x(b.start) + 'px'; n.style.width = Math.max(8, (b.end - b.start) * this.pps) + 'px'; n.classList.toggle('narrow', (b.end - b.start) * this.pps < 64);
      n.style.top = top(b) + 'px';
      const lab = n.querySelector('span'), bk = blurLabel(b);
      if (lab._key !== bk) { lab._key = bk; lab.replaceChildren(icon('blur', 'ico item-ico'), ' ' + bk); }
      n.classList.toggle('sel', sel.type === 'blur' && sel.id === b.id); n.setAttribute('aria-pressed', n.classList.contains('sel') ? 'true' : 'false');
      n.setAttribute('aria-label', `${blurLabel(b)} (${b.invert ? 'blur outside' : b.mode === 'pixelate' ? 'pixelate' : 'blur'} region), ${fmt(b.start)} to ${fmt(b.end)}`);
      n.classList.toggle('animated', hasKeyframes(b));
      this.renderKfs(n, b, b.start, b.end - b.start);
    }
    // music, voice and detached audio
    for (const a of p.audio) {
      const n = this._node('a:' + a.id, () => {
        const d = el('div', { class: 'tl-item tl-audioitem' }, el('canvas', { class: 'wave' }), el('div', { class: 'seams' }), el('div', { class: 'volenv' }), el('span'), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        d.addEventListener('pointerdown', e => this.onItemDown(e, 'audio', d._id));
        this.keyable(d, 'audio');
        return d;
      }, this.lanes);
      n._id = a.id; n.dataset.id = a.id;
      const span = audioSpan(a, lay.total);
      const w = Math.max(8, span * this.pps);
      n.style.left = this.x(a.start) + 'px'; n.style.width = w + 'px'; n.classList.toggle('narrow', w < 64);
      n.style.top = top(a) + 'px';
      const alab = n.querySelector('span'), atxt = (a.voice ? '🎙 ' : '♪ ') + a.name + (a.loop ? ' · loop' : '') + (a.duck && !a.muted ? ' · duck' : '') + '|' + !!a.muted;
      if (alab._key !== atxt) { alab._key = atxt; alab.replaceChildren(...(a.muted ? [muteBadge('Muted'), ' '] : []), atxt.slice(0, atxt.lastIndexOf('|'))); }
      n.classList.toggle('muted', !!a.muted);
      n.classList.toggle('voice', !!a.voice);
      n.classList.toggle('loop', !!a.loop);
      const seams = n.querySelector('.seams'), sk = a.loop ? loopSeams(a, lay.total).map(t => ((t - a.start) * this.pps).toFixed(1)).join(',') : '';
      if (seams._key !== sk) { seams._key = sk; seams.replaceChildren(...(sk ? sk.split(',').slice(0, 400).map(x => { const i = document.createElement('i'); i.style.left = x + 'px'; return i; }) : [])); }
      n.classList.toggle('sel', sel.type === 'audio' && sel.id === a.id); n.setAttribute('aria-pressed', n.classList.contains('sel') ? 'true' : 'false');
      n.setAttribute('aria-label', `${a.voice ? 'Voice' : 'Music'} ${a.name}${a.loop ? ' (loop)' : ''}${a.muted ? ' (muted)' : ''}, ${fmt(a.start)} to ${fmt(a.start + span)}`);
      n.classList.toggle('offline', !this.app.media.peek(a.mediaId));
      this.renderWave(n.querySelector('.wave'), a, w, null, 30, 1, span);
      this.renderVolEnv(n, a, 'audio', a.start, span, ITEM_H, sel.type === 'audio' && sel.id === a.id);
    }
    this.renderSilences(top);
    this.renderBeats(top);
    // remove stale
    for (const [k, n] of this.nodes) if (n._seen !== this._gen) { n.remove(); this.nodes.delete(k); }
    this.lanes.classList.toggle('empty', this.geo.n === 0);
    this.renderHeads();
    this.updatePlayhead(this.app.player.t);
  }
  /** Remove silences: the stretches found in the selected recording, drawn over the items that play it (no lane of their own). */
  renderSilences(top) {
    const marks = (this.app.silence && this.app.silence.marks && this.app.silence.marks()) || [];
    const geo = { clip: p => p.clips, overlay: p => p.overlays || [], audio: p => p.audio };
    let k = 0;
    for (const m of marks) {
      const item = geo[m.type](this.project).find(x => x.id === m.id); if (!item) continue;
      const n = this._node('s:' + k++, () => { const d = document.createElement('div'); d.className = 'tl-sil'; return d; }, this.lanes);
      n.style.left = this.x(m.t0) + 'px'; n.style.width = Math.max(3, (m.t1 - m.t0) * this.pps) + 'px'; n.style.top = top(item) + 'px';
      n.classList.toggle('cur', !!m.cur); n.title = 'Silence · ' + fmt(m.t1 - m.t0) + ' to remove';
    }
  }
  /** Snap to beat: small ticks on a music item whose beats are known (only the visible ones, thinned when zoomed out; no lane of their own). */
  renderBeats(top) {
    const vw = Math.max(1, this.scroll.clientWidth), t0 = (this.scroll.scrollLeft - vw - 12) / this.pps, t1 = (this.scroll.scrollLeft + 2 * vw) / this.pps;
    let k = 0;
    for (const a of this.project.audio) {
      if (!a.beat || a.loop) continue;
      const all = timelineBeats(a); if (!all.length) continue;
      const ts = thin(all, this.pps), y = top(a), on = a.beat.on !== false;
      for (const t of ts) {
        if (t < t0 || t > t1) continue;
        const n = this._node('b:' + k++, () => { const d = document.createElement('div'); d.className = 'tl-beat'; return d; }, this.lanes);
        n.style.left = this.x(t) + 'px'; n.style.top = (y + 24) + 'px'; n.classList.toggle('off', !on);
      }
    }
  }
  /** Captions: only the blocks near the visible part are in the DOM (an hour of speech is thousands). */
  renderCaps() {
    const p = this.project, caps = p.captions || [];
    if (!this.capNodes) this.capNodes = new Map();
    if (!caps.length) { for (const n of this.capNodes.values()) n.remove(); this.capNodes.clear(); return; }
    const top = this.laneGeo(), sel = this.app.selection || {};
    const vw = Math.max(1, this.scroll.clientWidth), x0 = this.scroll.scrollLeft - vw, x1 = this.scroll.scrollLeft + 2 * vw;
    const t0 = (x0 - 12) / this.pps, t1 = (x1 - 12) / this.pps;
    const gen = (this._capGen = (this._capGen || 0) + 1);
    for (const c of caps) {
      if (c.end < t0 || c.start > t1) continue;
      let n = this.capNodes.get(c.id);
      if (!n) {
        n = el('div', { class: 'tl-item tl-capitem' }, el('span'), el('div', { class: 'h-l' }), el('div', { class: 'h-r' }));
        n.addEventListener('pointerdown', e => this.onItemDown(e, 'caption', n._id));
        this.keyable(n, 'caption'); this.capNodes.set(c.id, n);
      }
      if (n.parentNode !== this.lanes) this.lanes.appendChild(n);
      n._id = c.id; n.dataset.id = c.id; n._gen = gen;
      n.style.left = this.x(c.start) + 'px'; n.style.width = Math.max(4, (c.end - c.start) * this.pps - 1) + 'px'; n.classList.toggle('narrow', (c.end - c.start) * this.pps < 64);
      n.style.top = top(c) + 'px';
      const lab = n.firstChild; if (lab._key !== c.text) { lab._key = c.text; lab.textContent = c.text; }
      const on = sel.type === 'caption' && sel.id === c.id;
      n.classList.toggle('sel', on); n.setAttribute('aria-pressed', on ? 'true' : 'false');
      n.setAttribute('aria-label', `Caption “${c.text.slice(0, 60)}”, ${fmt(c.start)} to ${fmt(c.end)}`);
    }
    for (const [id, n] of this.capNodes) if (n._gen !== gen) { n.remove(); this.capNodes.delete(id); }
  }
  /** Ruler ticks for the visible part of the timeline (plus a screen of margin each side), not the whole length. */
  renderRuler() {
    const width = this._width || this.content.clientWidth, vw = Math.max(1, this.scroll.clientWidth);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find(s => s * this.pps >= 70) || 600;
    const minor = steps.slice().reverse().find(s => s < major && s * this.pps >= 12) || major;
    const block = Math.max(vw, 800); // window snapped to blocks so small scrolls don't rebuild
    const x0 = Math.max(0, Math.floor((this.scroll.scrollLeft - vw) / block) * block), x1 = Math.min(width, x0 + vw + 3 * block);
    const t0 = Math.max(0, Math.floor(((x0 - 12) / this.pps) / minor) * minor), t1 = (x1 - 12) / this.pps;
    const key = [this.pps.toFixed(4), x0, x1].join('|');
    if (this._rulerKey === key) return;
    this._rulerKey = key;
    let html = '';
    for (let i = Math.round(t0 / minor), t = t0; t <= t1 && i < 1e6; i++, t = i * minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += `<div class="tick${isMajor ? ' major' : ''}" style="left:${this.x(t)}px">${isMajor ? `<span>${major >= 1 ? fmt(t) : t < 60 ? t.toFixed(1) + 's' : fmt(Math.floor(t + 1e-6)) + '.' + Math.round(((t + 1e-6) % 1) * 10) % 10}</span>` : ''}</div>`;
    }
    const d = el('div', { class: 'ticks', html });
    if (this._rulerHtml) this._rulerHtml.replaceWith(d); else this.ruler.prepend(d);
    this._rulerHtml = d;
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
  renderKfs(n, item, start, len) {
    const box = n.querySelector('.kfs'); if (!box) return;
    const times = kfTimes(item, false); // motion keys (◆); the volume envelope has its own line and dots
    const wpx = (len || 0) * this.pps;
    const key = times.join(',') + '|' + this.pps.toFixed(3) + '|' + wpx.toFixed(0);
    if (box._key === key) return; box._key = key;
    box.innerHTML = '';
    for (const lt of times) {
      const d = el('button', { class: 'kf', type: 'button', title: 'Keyframe at ' + fmt(start + lt) + ' — click to jump', 'aria-label': 'Keyframe ' + fmt(start + lt) });
      d.style.left = (lt * this.pps) + 'px';
      d.dataset.t = String(lt);
      // keep trim handles usable: diamonds sitting on an edge are display-only
      if (len && (lt * this.pps < 10 || lt * this.pps > wpx - 10)) d.classList.add('edge');
      d.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      d.addEventListener('click', (e) => { e.stopPropagation(); const it = this._findItem(n._id); if (it) { this.app.select(it.sel); this.app.seek(it.start + lt + 1e-4); } });
      box.appendChild(d);
    }
  }
  /**
   * Volume envelope on a timeline item: a line (1× sits in the middle, the top is 200%) and, on the selected item, draggable dots
   * (drag sideways to move a key in time, up/down to change its level). `full` shows the flat 1× line on a selected item without keys.
   * Unselected items only show the line + dots as decoration (taps go to the item, so selecting and trimming keep working).
   */
  renderVolEnv(n, item, type, start, len, H, full) {
    const box = n.querySelector('.volenv'); if (!box) return;
    const keys = (item.keyframes && item.keyframes.volume) || [];
    const W = Math.max(1, Math.round((len || 0) * this.pps));
    const show = keys.length > 0 || full;
    const key = show ? [W, H, full ? 1 : 0, JSON.stringify(keys)].join('|') : '';
    if (box._key === key) return; box._key = key;
    box.replaceChildren(); box.classList.toggle('editable', !!full);
    if (!show) return;
    const NS = 'http://www.w3.org/2000/svg', pad = type === 'clip' ? 8 : 5;
    const yOf = (v) => (type === 'clip' ? H - pad - (H * 0.4) * Math.min(v, VOL_KEY_MAX) / VOL_KEY_MAX * 1 : pad + (H - 2 * pad) * (1 - Math.min(v, VOL_KEY_MAX) / VOL_KEY_MAX));
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('aria-hidden', 'true');
    const pts = [], N = Math.min(600, Math.max(2, Math.round(W / 3)));
    for (let i = 0; i <= N; i++) { const t = (i / N) * (len || 0); pts.push((i / N * W).toFixed(1) + ',' + yOf(volumeEnv(item, t)).toFixed(1)); }
    const line = document.createElementNS(NS, 'polyline'); line.setAttribute('points', pts.join(' ')); line.setAttribute('class', 'venv-line' + (keys.length ? '' : ' flat')); svg.append(line);
    if (full || keys.length) {
      const one = document.createElementNS(NS, 'line'); one.setAttribute('x1', 0); one.setAttribute('x2', W); one.setAttribute('y1', yOf(1)); one.setAttribute('y2', yOf(1)); one.setAttribute('class', 'venv-unity'); svg.insertBefore(one, line);
    }
    box.append(svg);
    keys.forEach((k, idx) => {
      const cx = (k.t * this.pps).toFixed(1), cy = yOf(k.v).toFixed(1);
      if (full) { // an invisible larger circle makes the point easy to grab with a finger (about the height of the item)
        const h = document.createElementNS(NS, 'circle'); h.setAttribute('cx', cx); h.setAttribute('cy', cy); h.setAttribute('r', '17'); h.setAttribute('class', 'venv-hit');
        h.addEventListener('pointerdown', (e) => this.onVolDotDown(e, n._id, type, k, yOf, H, len)); svg.append(h);
      }
      const d = document.createElementNS(NS, 'circle');
      d.setAttribute('cx', cx); d.setAttribute('cy', cy); d.setAttribute('r', '5.5'); d.setAttribute('class', 'venv-dot');
      d.dataset.t = String(k.t); d.dataset.v = String(k.v);
      d.addEventListener('pointerdown', (e) => this.onVolDotDown(e, n._id, type, k, yOf, H, len));
      svg.append(d);
    });
  }
  onVolDotDown(e, id, type, key, yOf, H, len) {
    const box = e.currentTarget.closest('.volenv'); if (!box.classList.contains('editable')) return; // unselected: let the tap select the item
    e.stopPropagation(); e.preventDefault();
    const p = this.project, snapshot = JSON.parse(JSON.stringify(p));
    const x0 = e.clientX, y0 = e.clientY, t0 = key.t, v0 = key.v;
    const kf = type === 'clip' ? (p.clips.find(c => c.id === id) || {}).keyframes : type === 'overlay' ? ((p.overlays || []).find(c => c.id === id) || {}).keyframes : (p.audio.find(c => c.id === id) || {}).keyframes;
    if (!kf || !kf.volume) return;
    const span = type === 'clip' ? H * 0.4 : H - 10; // pixels for 0..200%
    let moved = false;
    const tip = (t, v) => { this.tip.textContent = `${fmt(t)} · ${Math.round(v * 100)}%`; this.tip.style.display = 'block'; this.tip.style.left = this.x(this._itemStart(id) + t) + 'px'; };
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return; moved = true;
      let t = clamp(t0 + dx / this.pps, 0, len), v = clamp(v0 - dy / span * VOL_KEY_MAX, 0, VOL_KEY_MAX);
      if (!ev.shiftKey) v = Math.round(v * 20) / 20; // 5% steps; hold Shift for fine control
      if (kf.volume.some(o => o !== key && Math.abs(o.t - t) < 1 / 120)) t = key.t; // never land on another key
      key.t = Math.round(t * 1000) / 1000; key.v = Math.round(v * 1000) / 1000; kf.volume.sort((a, b) => a.t - b.t);
      for (const o of kf.volume) { delete o.e0; delete o.e1; }
      tip(key.t, key.v); this.app.liveUpdate({ keepTime: true });
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
      this.tip.style.display = 'none'; this.drag = null;
      if (moved) this.app.commit('Move volume keyframe');
      else { const it = this._itemStartSel(id, type); if (it) this.app.seek(it.start + key.t + 1e-4); }
    };
    const cancel = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); this.tip.style.display = 'none'; this.drag = null; if (moved) this.app.restore(snapshot); };
    this.drag = { type: 'volkey' };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
  }
  _itemStart(id) {
    const p = this.project, it = layout(p).items.find(i => i.clip.id === id); if (it) return it.start;
    const o = (p.overlays || []).find(x => x.id === id); if (o) return o.start;
    const a = p.audio.find(x => x.id === id); return a ? a.start : 0;
  }
  _itemStartSel(id, type) { return { start: this._itemStart(id) }; }
  _findItem(id) {
    const p = this.project, lay = layout(p);
    const it = lay.items.find(i => i.clip.id === id); if (it) return { sel: { type: 'clip', id }, start: it.start };
    const t = p.texts.find(x => x.id === id); if (t) return { sel: { type: 'text', id }, start: t.start };
    const o = (p.overlays || []).find(x => x.id === id); if (o) return { sel: { type: 'overlay', id }, start: o.start };
    const bl = (p.blurs || []).find(x => x.id === id); if (bl) return { sel: { type: 'blur', id }, start: bl.start };
    const cp = (p.captions || []).find(x => x.id === id); if (cp) return { sel: { type: 'caption', id }, start: cp.start };
    return null;
  }
  renderWave(cv, a, w, recIn, Hh = 30, speed = 1, span = null) {
    if (!a) { if (cv._key !== 'none') { cv._key = 'none'; cv.width = 0; cv.style.display = 'none'; } return; }
    const rec = recIn || this.app.media.peek(a.mediaId);
    const peaks = rec && rec.peaks;
    const W = Math.min(4000, Math.round(w)), H = Hh;
    const loopLen = a.loop && span ? span : 0;
    const key = [W, a.in, a.out, !!peaks, a.muted, a.volume, loopLen, a.phase || 0, a.speed || 1].join('|');
    if (cv._key === key) return; cv._key = key;
    cv.style.display = peaks ? '' : 'none';
    cv.width = W; cv.height = H; cv.style.width = W + 'px';
    const x = cv.getContext('2d'); x.clearRect(0, 0, W, H);
    if (!peaks) return;
    x.fillStyle = Hh < 30 ? (a.muted ? 'rgba(255,255,255,.25)' : 'rgba(140,220,255,.85)') : 'rgba(255,255,255,.35)';
    const len = a.out - a.in;
    for (let px = 0; px < W; px += 2) {
      const sp = audioSpeed(a), L1 = len / sp; // L1 = one pass on the timeline
      const t = loopLen ? a.in + (((px / W) * loopLen + (a.phase || 0)) % L1) * sp : a.in + (px / W) * len; // looped tracks repeat
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
    const sx = e.clientX, sy = e.clientY, target = e.currentTarget, pid = e.pointerId;
    if (e.pointerType === 'mouse') { this.app.select(null); this.app.seek(this.timeAtClient(e.clientX)); return; }
    // touch/pen: a tap (not a scroll) seeks; the listeners go away on up or when the browser takes over for scrolling
    const done = () => { target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', done); };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      done();
      if (Math.abs(ev.clientX - sx) < 6 && Math.abs(ev.clientY - sy) < 6) { this.app.select(null); this.app.seek(this.timeAtClient(ev.clientX)); }
    };
    target.addEventListener('pointerup', up); target.addEventListener('pointercancel', done);
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
      const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
      const done = () => { node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', done); };
      const up = (ev) => { if (ev.pointerId !== pid) return; done(); if (Math.abs(ev.clientX - sx) < 8 && Math.abs(ev.clientY - sy) < 8) this.app.select({ type, id }, { seekInto: true }); };
      node.addEventListener('pointerup', up); node.addEventListener('pointercancel', done);
      return;
    }
    e.preventDefault();
    if (!alreadySel) this.app.select({ type, id });
    this.startDrag(e, node, type, id, handle);
  }

  startDrag(e, node, type, id, handle) {
    const p = this.project;
    const kb = !!e.kb; // keyboard nudge/trim: same edit logic as a drag, without pointer capture, threshold or auto-scroll
    const x0 = kb ? 0 : this.contentX(e);
    const lay0 = layout(p);
    const snapshot = JSON.parse(JSON.stringify(p));
    let moved = false;
    const d = this.drag = { type, id, handle };
    const pointerId = e.pointerId;
    if (!kb) try { node.setPointerCapture(pointerId); } catch { }
    // moving a whole item can also go up/down (lane changes), so vertical movement starts the drag too
    const y0 = kb ? 0 : e.clientY;
    d.vertical = !kb && handle === 'body' && type !== 'marker';
    { const nr = node.parentNode.getBoundingClientRect(); d.grabY = y0 - (nr.top + node.offsetTop); }
    const dtOf = (ev) => (kb ? ev.dt : (this.contentX(ev) - x0) / this.pps);
    const gate = (ev, dt) => { if (!moved && !kb && Math.hypot(dt * this.pps, d.vertical ? ev.clientY - y0 : 0) < 4) return false; moved = true; if (!kb) this.autoScroll(ev); return true; };
    const tip = (txt, t) => { this.tip.textContent = txt; this.tip.style.display = 'block'; this.tip.style.left = this.x(t) + 'px'; };

    if (type === 'clip') {
      const idx = p.clips.findIndex(c => c.id === id), c = p.clips[idx], it0 = lay0.items[idx];
      const orig = { in: c.in, out: c.out, kf: JSON.parse(JSON.stringify(c.keyframes || {})) };
      const keyed = hasKeyframes(c);
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!gate(ev, dt)) return;
        if (handle === 'l') {
          if (c.kind === 'image') c.out = clamp(orig.out - dt, MIN_CLIP, 3600);
          else c.in = clamp(orig.in + dt * c.speed, 0, orig.out - MIN_CLIP * c.speed);
          // keep keyframes on the same content: trimming the start shifts them by the trimmed amount
          if (keyed) c.keyframes = rebaseKeyframes(orig.kf, c.kind === 'image' ? (orig.out - c.out) : (c.in - orig.in) / c.speed);
          tip((c.kind === 'image' ? 'Length ' : 'In ') + (c.kind === 'image' ? fmt(c.out) : c.in.toFixed(2) + 's'), it0.start);
          this.app.liveUpdate({ previewAt: it0.start });
        } else if (handle === 'r') {
          let end = it0.start + (orig.out - orig.in) / (c.kind === 'image' ? 1 : c.speed) + dt;
          const s = this.snap(end, null); if (s.snapped && Math.abs(s.t - it0.end) > 1e-3) { end = s.t; this.showSnap(end); } else this.snapLine.style.display = 'none';
          const len = Math.max(MIN_CLIP, end - it0.start);
          if (c.kind === 'image') c.out = c.in + len; else c.out = clamp(orig.in + len * c.speed, orig.in + MIN_CLIP * c.speed, c.srcDuration);
          tip('Out ' + (c.kind === 'image' ? fmt(c.out) : c.out.toFixed(2) + 's') + ' · ' + fmt(clipLen(c)), it0.start + clipLen(c));
          this.app.liveUpdate({ previewAt: Math.max(it0.start, it0.start + clipLen(c) - 0.04) });
        }
        // (moving the whole clip is handled below, with every other kind of item)
      };
      d.onUp = () => {
        this.insert.style.display = 'none'; node.classList.remove('dragging'); node.style.transform = '';
        if (!moved) return;
        if (this.app.rippleEnabled) rippleShift(p, it0.end - 1e-3, layout(p).total - lay0.total);
        else holdNextClip(p, id, lay0);
        this.app.commit('Trim clip');
      };
    } else if (type === 'text' || type === 'blur' || type === 'caption') {
      const t0 = (type === 'blur' ? p.blurs : type === 'caption' ? p.captions : p.texts).find(t => t.id === id); const o = { s: t0.start, e: t0.end, kf: JSON.parse(JSON.stringify(t0.keyframes || {})) };
      const cw = type === 'caption' && t0.words ? JSON.parse(JSON.stringify(t0.words)) : null; // captions carry their word timings along
      const capWords = () => { if (cw) { t0.words = cw; retimeWords(t0, o.s, o.e); } };
      const keyed = hasKeyframes(t0);
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!gate(ev, dt)) return;
        if (handle === 'body') {
          const len = o.e - o.s; let s = Math.max(0, o.s + dt);
          const sn = this.snap(s, id, [0, len]); if (sn.snapped) { s = Math.max(0, sn.t); this.showSnap(Math.abs(sn.t - s) < 1e-6 ? s : s + len); }
          t0.start = s; t0.end = s + len; tip(fmt(t0.start) + ' → ' + fmt(t0.end), t0.start);
        } else if (handle === 'l') {
          let s = clamp(o.s + dt, 0, o.e - 0.2); const sn = this.snap(s, id); if (sn.snapped) { s = clamp(sn.t, 0, o.e - 0.2); this.showSnap(s); }
          t0.start = s; tip('Start ' + fmt(s), s);
          if (keyed) t0.keyframes = rebaseKeyframes(o.kf, s - o.s);
        } else {
          let e2 = Math.max(o.s + 0.2, o.e + dt); const sn = this.snap(e2, id); if (sn.snapped) { e2 = Math.max(o.s + 0.2, sn.t); this.showSnap(e2); }
          t0.end = e2; tip('End ' + fmt(e2), e2);
        }
        capWords();
        this.app.liveUpdate(handle === 'body' ? { keepTime: true } : { previewAt: handle === 'r' ? t0.end - 0.05 : t0.start + 0.01 }); // moving: the playhead stays (it is a snap target)
      };
      d.onUp = () => { if (moved) this.app.commit(type === 'blur' ? 'Move blur region' : type === 'caption' ? 'Edit caption' : 'Move text'); };
    } else if (type === 'audio') {
      const a = p.audio.find(x => x.id === id); const o = { s: a.start, i: a.in, out: a.out, span: audioSpan(a, lay0.total), ll: a.loopLen, kf: JSON.parse(JSON.stringify(a.keyframes || {})) };
      const sp = audioSpeed(a), keyed = hasKeyframes(a);
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!gate(ev, dt)) return;
        const len0 = (o.out - o.i) / sp; // one pass on the timeline
        if (handle === 'body') {
          let s = Math.max(0, o.s + dt);
          const sn = this.snap(s, id, [0, len0]); if (sn.snapped) { s = Math.max(0, sn.t); this.showSnap(s); }
          a.start = s; tip('Starts ' + fmt(s), s);
        } else if (handle === 'l') {
          const dd = clamp(dt, -Math.min(o.i / sp, o.s), len0 - 0.2);
          a.in = o.i + dd * sp; a.start = o.s + dd; tip('Trim in ' + a.in.toFixed(1) + 's', a.start);
          if (a.loop && o.ll > 0) a.loopLen = Math.max(0.2, o.ll - dd); // keep the looped end in place
          if (keyed) a.keyframes = rebaseKeyframes(o.kf, dd); // the volume envelope stays on the same sound
        } else {
          if (a.loop) { // looped: the right edge sets how long it repeats
            let end = o.s + o.span + dt; const sn = this.snap(end, id); if (sn.snapped) { end = sn.t; this.showSnap(end); }
            a.loopLen = Math.max(0.2, end - a.start); tip('Loops until ' + fmt(a.start + a.loopLen), a.start + a.loopLen);
          } else {
            let end = o.s + len0 + dt; const sn = this.snap(end, id); if (sn.snapped) { end = sn.t; this.showSnap(end); }
            a.out = clamp(o.i + (end - o.s) * sp, o.i + 0.2 * sp, a.srcDuration || 1e9); tip('Ends ' + fmt(a.start + audioLen(a)), a.start + audioLen(a));
          }
        }
        this.app.liveUpdate({ keepTime: true });
      };
      d.onUp = () => { if (moved) this.app.commit('Edit music'); };
    } else if (type === 'overlay') {
      const o = p.overlays.find(x => x.id === id); const or = { s: o.start, i: o.in, out: o.out, kf: JSON.parse(JSON.stringify(o.keyframes || {})) };
      const keyed = hasKeyframes(o);
      const sp = o.kind === 'image' ? 1 : (o.speed || 1);
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!gate(ev, dt)) return;
        const len0 = (or.out - or.i) / sp;
        if (handle === 'body') {
          let s = Math.max(0, or.s + dt);
          const sn = this.snap(s, id, [0, len0]); if (sn.snapped) { s = Math.max(0, sn.t); this.showSnap(s); }
          o.start = s; tip('Starts ' + fmt(s), s);
        } else if (handle === 'l') {
          const dd = clamp(dt, o.kind === 'image' ? -or.s : -Math.min(or.i / sp, or.s), len0 - MIN_CLIP);
          if (o.kind === 'image') { o.out = or.out - dd; } else o.in = or.i + dd * sp;
          o.start = or.s + dd; tip('Starts ' + fmt(o.start), o.start);
          if (keyed) o.keyframes = rebaseKeyframes(or.kf, dd);
        } else {
          let end = or.s + len0 + dt; const sn = this.snap(end, id); if (sn.snapped) { end = sn.t; this.showSnap(end); }
          const len = Math.max(MIN_CLIP, end - or.s);
          o.out = o.kind === 'image' ? or.i + len : clamp(or.i + len * sp, or.i + MIN_CLIP * sp, o.srcDuration || 1e9);
          tip('Ends ' + fmt(o.start + overlayLen(o)), o.start + overlayLen(o));
        }
        this.app.liveUpdate(handle === 'body' ? { keepTime: true } : { previewAt: handle === 'r' ? o.start + overlayLen(o) - 0.05 : o.start + 0.01 });
      };
      d.onUp = () => { if (moved) this.app.commit('Edit overlay'); };
    } else if (type === 'marker') {
      const m = p.markers.find(x => x.id === id); const o = m.time;
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!gate(ev, dt)) return;
        let t = Math.max(0, o + dt); const sn = this.snap(t, id); if (sn.snapped) { t = sn.t; this.showSnap(t); }
        m.time = t; tip(fmt(t), t);
        this.app.liveUpdate({ keepTime: true });
      };
      d.onUp = () => { if (moved) this.app.commit('Move marker'); else this.app.seek(m.time); };
    }

    // ---- moving a whole item (any kind): any start time, any lane, a new lane above/below; one undo step ----
    if (!kb && handle === 'body' && type !== 'marker') {
      const fi = findItem(p, id); if (!fi) return d;
      const kind = fi.kind, item = fi.item, orig = laneOf(item), ripple = this.app.rippleEnabled && kind === 'clip';
      const label = { clip: 'Move clip', overlay: 'Move overlay', text: 'Move text', blur: 'Move blur region', audio: 'Move audio', caption: 'Move caption' }[kind];
      const ctx0 = spanCtx(p), [a0, b0] = ctx0.span(kind, item), len = b0 - a0;
      const baseMove = d.onMove;          // trims are handled by the branches above; for text, blur, audio, captions and overlays it also sets item.start (snapped) live
      d.target = orig;
      d.onMove = (ev) => {
        const dt = dtOf(ev);
        if (!moved && Math.hypot(dt * this.pps, ev.clientY - y0) < 4) return;
        this.beginZones();
        node.classList.add('dragging');
        let start;
        if (kind === 'clip') {
          if (!gate(ev, dt)) return;
          start = Math.max(0, a0 + dt); const sn = this.snap(start, id, [0, len]);
          if (sn.snapped) { start = Math.max(0, sn.t); this.showSnap(Math.abs(sn.t - start) < 1e-6 ? start : start + len); } else this.snapLine.style.display = 'none';
          d.start = start;
        } else { baseMove(ev); start = spanCtx(p).span(kind, item)[0]; }
        d.target = this.laneTarget(ev.clientY, orig);
        if (ripple) {
          // Ripple on: the main sequence stays joined, so the clip is re-ordered by where it is dropped; the lane only changes its row
          const t = this.timeAtClient(ev.clientX), its = lay0.items;
          let to = its.length; for (let i = 0; i < its.length; i++) if (t < (its[i].start + its[i].end) / 2) { to = i; break; }
          d.to = to; d.plan = planItem(p, kind, item, its[Math.min(to, its.length - 1)] ? its[Math.min(to, its.length - 1)].start : start, d.target);
          const ix = to < its.length ? its[to].start : lay0.total;
          this.insert.style.display = 'block'; this.insert.style.left = this.x(ix) + 'px'; this.insert.style.top = this.lanes.offsetTop + 'px'; this.insert.style.height = this.geo.h + 'px';
          this.hideDrop(); tip('Ripple on: clips stay joined. Turn Ripple off to leave a gap', ix);
        } else {
          d.plan = planItem(p, kind, item, start, d.target);
          this.showDropLane(d.plan, len);
          tip(d.plan.newAt != null ? 'New lane' : 'Starts ' + fmt(d.plan.start), d.plan.start);
        }
        this.ghostY(node, d, ev.clientY, kind === 'clip' ? (start - a0) * this.pps : 0);
      };
      d.onUp = () => {
        this.insert.style.display = 'none';
        if (!moved) return;
        let sel = { type, id };
        if (ripple) {
          const idx = p.clips.findIndex(c => c.id === id);
          if (d.to != null) { const to = d.to > idx ? d.to - 1 : d.to; if (to !== idx) moveClip(p, idx, to); }
          if (d.target && typeof d.target === 'object') { insertLane(p, d.target.newAt); item.lane = d.target.newAt; } else if (d.target != null) item.lane = d.target;
        } else {
          const start = kind === 'clip' ? d.start : spanCtx(p).span(kind, item)[0];
          const plan = placeItem(p, kind, item, start, d.target ?? orig, { ripple: false });
          if (plan.kind !== kind) { sel = { type: plan.kind, id: plan.item.id }; toast('Layered over the clip. Transitions and colour grade do not apply to layers.', 3200); }
        }
        this.app.selection = sel;
        this.app.commit(label);
      };
    }
    if (kb) return d; // caller drives onMove/onUp
    const move = (ev) => { if (ev.pointerId === pointerId) { this._noSnap = ev.altKey; d.onMove(ev); } };   // Alt: no snapping
    const settle = () => { this._noSnap = false; node.classList.remove('dragging'); node.style.transform = ''; this.endZones(); this.hideDrop(); };
    const end = (ev) => {
      if (ev.pointerId !== pointerId) return;
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', cancel);
      this.stopAuto(); this.tip.style.display = 'none'; this.snapLine.style.display = 'none';
      this.drag = null;
      settle();
      d.onUp();
    };
    const cancel = (ev) => {
      // restore on cancel
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', cancel);
      this.stopAuto(); this.tip.style.display = 'none'; this.snapLine.style.display = 'none'; this.insert.style.display = 'none';
      this.drag = null; settle();
      if (moved) { this.app.restore(snapshot); }
    };
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', end); node.addEventListener('pointercancel', cancel);
    d.abort = () => cancel({});
  }

  /**
   * Keyboard access for timeline items: Tab to focus, Enter/Space selects, Left/Right moves by one frame (Shift: 1 s;
   * main clips swap places with their neighbour), Alt+Left/Right trims the end. Other keys (S, Delete...) reach the app.
   */
  keyable(d, type) {
    d.tabIndex = 0; d.setAttribute('role', 'button');
    d.addEventListener('keydown', (e) => {
      const id = d._id, fps = this.project.settings.fps || 30;
      const isSel = this.app.selection && this.app.selection.type === type && this.app.selection.id === id;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.app.select({ type, id }, { seekInto: true }); return; }
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey) return;
      e.preventDefault(); e.stopPropagation();
      if (!isSel) this.app.select({ type, id });
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (type === 'clip' && !e.altKey && !this.app.rippleEnabled) { // Ripple off: nudge the clip itself (a frame, or 1 s with Shift); it stops at its neighbours
        const p = this.project, it = layout(p).items.find(i => i.clip.id === id); if (!it) return;
        const to = moveClipTo(p, id, it.start + (e.shiftKey ? 1 : 1 / fps) * dir);
        if (to == null || Math.abs(to - it.start) < 1e-4) toast('No room to move: the next clip is in the way (drag it past, or turn Ripple on to swap clips).', 2600);
        else this.app.commit('Move clip');
        this._refocus(type, id); return;
      }
      if (type === 'clip' && !e.altKey) {
        const p = this.project, idx = p.clips.findIndex(c => c.id === id), to = idx + dir;
        if (idx < 0 || to < 0 || to >= p.clips.length) return;
        moveClip(p, idx, to); this.app.commit('Reorder clip'); this._refocus(type, id); return;
      }
      const step = (e.shiftKey ? 1 : 1 / fps) * dir;
      if (!e.altKey && type !== 'marker') { // nudge: same lane, never over a neighbour (it takes the nearest free spot, or a new lane when there is none)
        const p = this.project, fi = findItem(p, id); if (!fi) return;
        const at = spanCtx(p).span(fi.kind, fi.item)[0];
        const plan = placeItem(p, fi.kind, fi.item, at + step, laneOf(fi.item));
        this.app.selection = { type: plan.kind, id: plan.item.id };
        this.app.commit({ clip: 'Move clip', overlay: 'Move overlay', text: 'Move text', blur: 'Move blur region', audio: 'Move audio', caption: 'Move caption' }[fi.kind]);
        this._refocus(plan.kind, plan.item.id); return;
      }
      this._noSnap = true;
      try {
        const drag = this.startDrag({ kb: true, pointerId: -1 }, d, type, id, e.altKey ? 'r' : 'body');
        drag.onMove({ dt: step });
        this.tip.style.display = 'none'; this.snapLine.style.display = 'none'; this.drag = null;
        drag.onUp();
      } finally { this._noSnap = false; }
      this._refocus(type, id);
    });
  }
  _refocus(type, id) {
    const n = type === 'caption' ? (this.capNodes && this.capNodes.get(id)) : this.nodes.get({ clip: 'c:', overlay: 'o:', text: 't:', blur: 'b:', audio: 'a:' }[type] + id);
    if (n && document.activeElement !== n) n.focus({ preventScroll: true });
  }
}
