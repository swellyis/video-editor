// Real-time preview engine: plays the whole sequence across clips with a shared clock.
import { layout, sourceTime, clipGain, musicGain, speechIntervals, audioLen } from './model.js';
import { clamp } from './util.js';

const POOL_MAX = 8;

export class Player {
  constructor({ canvas, getProject, media, compositor, onTime, onState, audio = true }) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.getProject = getProject; this.media = media; this.comp = compositor;
    this.onTime = onTime || (() => { }); this.onState = onState || (() => { });
    this.audioEnabled = audio;
    this.t = 0; this.playing = false; this.rate = 1;
    this.videos = new Map(); this.audios = new Map();
    this.ac = null; this.lay = { items: [], total: 0 }; this.speech = [];
    this.lastBoxes = []; this._raf = 0; this._renderQueued = false; this.external = false;
    this.lastUse = new Map();
  }
  get total() { return this.lay.total; }
  invalidate() {
    const p = this.getProject();
    this.lay = layout(p); this.speech = speechIntervals(this.lay);
    const live = new Set(p.clips.map(c => c.id)), liveA = new Set(p.audio.map(a => a.id));
    for (const [id, v] of this.videos) {
      const c = p.clips.find(x => x.id === id);
      if (!live.has(id) || (c && c.mediaId !== v.mediaId)) this._dropVideo(id);
    }
    for (const id of [...this.audios.keys()]) if (!liveA.has(id)) this._dropAudio(id);
    if (this.t > this.total) this.t = this.total;
    if (!this.playing) this.sync(this.t, false);
    this.requestRender();
  }
  ensureAudio() {
    if (!this.audioEnabled) return;
    try {
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ac = new AC({ latencyHint: 'interactive' });
        for (const v of this.videos.values()) this._wire(v);
        for (const a of this.audios.values()) this._wire(a);
      }
      if (this.ac.state === 'suspended') this.ac.resume().catch(() => { });
    } catch (e) { console.warn('Audio unavailable', e); }
  }
  _wire(entry) {
    if (!this.ac || entry.gain) return;
    try {
      const src = this.ac.createMediaElementSource(entry.el);
      const g = this.ac.createGain(); g.gain.value = 0;
      src.connect(g).connect(this.ac.destination);
      entry.gain = g; entry.el.muted = false; entry.el.volume = 1;
    } catch (e) { console.warn('Could not route media audio', e); }
  }
  _setGain(entry, v) {
    v = Math.max(0, v);
    if (entry.gain) {
      const now = this.ac.currentTime;
      if (Math.abs(entry.gain.gain.value - v) > 0.001) entry.gain.gain.setTargetAtTime(v, now, 0.02);
    } else if (this.audioEnabled && this.ac) {
      entry.el.muted = v <= 0.001; entry.el.volume = clamp(v, 0, 1);
    } else entry.el.muted = true;
  }
  _makeEl(tag, url) {
    const el = document.createElement(tag);
    el.preload = 'auto'; el.playsInline = true; el.setAttribute('playsinline', ''); el.muted = true;
    if ('preservesPitch' in el) el.preservesPitch = true;
    el.src = url;
    el.addEventListener('seeked', () => this.requestRender());
    el.addEventListener('loadeddata', () => { el._hasFrame = true; this.requestRender(); });
    el.addEventListener('error', () => console.warn('Media failed to load', el.error && el.error.message));
    return el;
  }
  _getVideo(clip) {
    let v = this.videos.get(clip.id);
    if (v) return v;
    const url = this.media.url(clip.mediaId);
    if (!url) return null;
    v = { el: this._makeEl('video', url), mediaId: clip.mediaId, gain: null };
    this._wire(v);
    this.videos.set(clip.id, v);
    return v;
  }
  _dropVideo(id) {
    const v = this.videos.get(id); if (!v) return;
    try { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } catch { }
    try { v.gain && v.gain.disconnect(); } catch { }
    this.videos.delete(id);
  }
  _getAudio(a) {
    let e = this.audios.get(a.id);
    if (e && e.mediaId === a.mediaId) return e;
    if (e) this._dropAudio(a.id);
    const url = this.media.url(a.mediaId);
    if (!url) return null;
    e = { el: this._makeEl('audio', url), mediaId: a.mediaId, gain: null };
    this._wire(e);
    this.audios.set(a.id, e);
    return e;
  }
  _dropAudio(id) {
    const e = this.audios.get(id); if (!e) return;
    try { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); } catch { }
    try { e.gain && e.gain.disconnect(); } catch { }
    this.audios.delete(id);
  }

  /** Position every media element for time t. Returns true if all active sources are ready. */
  sync(t, playing) {
    const p = this.getProject();
    const needed = new Set();
    let ready = true;
    const fwd = playing && this.rate > 0;
    const now = performance.now();
    for (const it of this.lay.items) {
      const c = it.clip;
      const active = t >= it.start && t < it.end;
      const pre = !active && fwd && it.start > t && it.start - t < 1.5;
      if (c.kind === 'image') { if (active || pre) this.media.image(c.mediaId).then(() => this.requestRender()).catch(() => { }); continue; }
      if (!active && !pre) continue;
      const v = this._getVideo(c);
      if (!v) continue;
      needed.add(c.id); this.lastUse.set(c.id, now);
      const el = v.el;
      const desired = active ? sourceTime(it, t) : c.in;
      if (active && fwd) {
        const pr = clamp(c.speed * this.rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        if (el.paused) {
          if (Math.abs(el.currentTime - desired) > 0.04) el.currentTime = desired;
          el.play().catch(() => { });
        } else if (Math.abs(el.currentTime - desired) > 0.3 && !el.seeking) el.currentTime = desired;
        if (el.readyState < 3 || el.seeking) ready = false;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - desired) > 0.015 && !el.seeking) el.currentTime = desired;
        if (active && (el.readyState < 2 || el.seeking)) ready = false;
      }
      this._setGain(v, active && fwd && this.rate === 1 ? clipGain(it, t) : 0);
    }
    for (const [id, v] of this.videos) {
      if (needed.has(id)) continue;
      if (!v.el.paused) v.el.pause();
      this._setGain(v, 0);
    }
    if (this.videos.size > POOL_MAX) {
      const idle = [...this.videos.keys()].filter(id => !needed.has(id)).sort((a, b) => (this.lastUse.get(a) || 0) - (this.lastUse.get(b) || 0));
      while (this.videos.size > POOL_MAX && idle.length) this._dropVideo(idle.shift());
    }
    // music
    for (const a of p.audio) {
      const len = audioLen(a);
      const active = t >= a.start && t < a.start + len && t < this.total;
      const pre = !active && fwd && a.start > t && a.start - t < 1.5;
      if (!active && !pre) { const e = this.audios.get(a.id); if (e) { if (!e.el.paused) e.el.pause(); this._setGain(e, 0); } continue; }
      const e = this._getAudio(a); if (!e) continue;
      const desired = active ? a.in + (t - a.start) : a.in;
      if (active && fwd) {
        if (Math.abs(e.el.playbackRate - this.rate) > 1e-3) e.el.playbackRate = this.rate;
        if (e.el.paused) { if (Math.abs(e.el.currentTime - desired) > 0.04) e.el.currentTime = desired; e.el.play().catch(() => { }); }
        else if (Math.abs(e.el.currentTime - desired) > 0.3) e.el.currentTime = desired;
      } else {
        if (!e.el.paused) e.el.pause();
        if (Math.abs(e.el.currentTime - desired) > 0.05) e.el.currentTime = desired;
      }
      this._setGain(e, active && fwd && this.rate === 1 ? musicGain(a, t, this.speech, this.total) : 0);
    }
    return ready;
  }

  getSource = (it) => {
    const c = it.clip;
    if (c.kind === 'image') { const im = this.media.imageSync(c.mediaId); return im ? { img: im.img, w: im.w, h: im.h } : null; }
    const v = this.videos.get(c.id);
    if (!v || !v.el.videoWidth || (v.el.readyState < 2 && !v.el._hasFrame)) return null;
    return { img: v.el, w: v.el.videoWidth, h: v.el.videoHeight };
  };
  getLogo = () => {
    const p = this.getProject();
    if (!p.logo) return null;
    const im = this.media.imageSync(p.logo.mediaId);
    if (!im) { this.media.image(p.logo.mediaId).then(() => this.requestRender()).catch(() => { }); return null; }
    return im;
  };

  requestRender() {
    if (this._renderQueued || this.playing) return;
    this._renderQueued = true;
    requestAnimationFrame(() => { this._renderQueued = false; this.render(); });
  }
  render() {
    const p = this.getProject();
    const W = this.canvas.width, H = this.canvas.height;
    const r = this.comp.render(this.ctx, W, H, p, this.lay, this.t, this.getSource, { getLogo: this.getLogo });
    this.lastBoxes = r.boxes;
    return r;
  }

  setTime(t, { silent = false } = {}) {
    this.t = clamp(t, 0, this.total);
    if (this.playing) { this._anchorT = this.t; this._anchorWall = performance.now(); this.sync(this.t, true); }
    else { this.sync(this.t, false); this.requestRender(); }
    if (!silent) this.onTime(this.t);
  }
  play(rate = 1) {
    if (!this.lay.items.length) return;
    this.ensureAudio();
    this.rate = rate;
    if (rate > 0 && this.t >= this.total - 0.02) this.t = 0;
    if (rate < 0 && this.t <= 0.02) return;
    this.playing = true;
    this._anchorT = this.t; this._anchorWall = performance.now(); this._last = this._anchorWall; this._stall = 0;
    this.sync(this.t, true);
    this.onState(true);
    cancelAnimationFrame(this._raf);
    const loop = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = (now - this._last) / 1000; this._last = now;
      const ready = this.sync(this.t, true);
      if (!ready && this._stall < 2.5 && this.rate > 0) { this._stall += dt; }
      else { this._stall = ready ? 0 : this._stall; this.t += dt * this.rate; }
      if (this.t >= this.total) { this.t = this.total; this.pause(); this.render(); this.onTime(this.t); return; }
      if (this.t <= 0 && this.rate < 0) { this.t = 0; this.pause(); this.render(); this.onTime(this.t); return; }
      this.render();
      this.onTime(this.t);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false; this.rate = 1;
    cancelAnimationFrame(this._raf);
    this.sync(this.t, false);
    this.onState(false);
    this.requestRender();
  }
  toggle() { this.playing ? this.pause() : this.play(1); }
  destroy() {
    this.pause();
    for (const id of [...this.videos.keys()]) this._dropVideo(id);
    for (const id of [...this.audios.keys()]) this._dropAudio(id);
    if (this.ac) this.ac.close().catch(() => { });
  }
}
