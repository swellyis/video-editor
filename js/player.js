// Real-time preview engine: plays the whole sequence across clips with a shared clock.
import { layout, sourceTime, clipGain, musicGain, speechIntervals, duckIntervalsFor, audioSpan, audioSpeed, audioSourceTime, overlayLen, overlaySourceTime, overlayGain, hasKeyframes, soundTargets } from './model.js';
import { clamp } from './util.js';
import { speedAt } from './ramp.js';
import { renderClipAudio, PREVIEW_AUDIO_MAX } from './audio.js';

const POOL_MAX = 8;

const LOOK_AHEAD = 0.1; // seconds of gain-ramp lookahead for items with a volume envelope
export class Player {
  constructor({ canvas, getProject, media, compositor, onTime, onState, audio = true }) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.getProject = getProject; this.media = media; this.comp = compositor;
    this.onTime = onTime || (() => { }); this.onState = onState || (() => { });
    this.audioEnabled = audio;
    this.t = 0; this.playing = false; this.rate = 1;
    this.videos = new Map(); this.audios = new Map(); this.aux = new Map(); this.cleanBypass = false; // aux: cleaned-sound players that stand in for a video's own sound (Clean voice)
    this.ac = null; this.lay = { items: [], total: 0 }; this.speech = [];
    this.lastBoxes = []; this._raf = 0; this._renderQueued = false; this.external = false;
    this.lastUse = new Map();
    this.revBuf = new Map(); this.revNodes = new Map(); // reversed clips: their sound is rendered once (same mixer as the export) and played from memory
  }
  get total() { return this.lay.total; }
  invalidate() {
    const p = this.getProject();
    this.lay = layout(p); this.speech = speechIntervals(this.lay, p);
    this.duck = new Map(); // per voice track: ducking driven only by OTHER speech sources
    for (const a of p.audio) if (a.voice) this.duck.set(a.id, duckIntervalsFor(a, this.lay, p, this.speech));
    const live = new Set([...p.clips.map(c => c.id), ...(p.overlays || []).map(o => o.id)]), liveA = new Set(p.audio.map(a => a.id));
    for (const [id, v] of this.videos) {
      const c = p.clips.find(x => x.id === id) || (p.overlays || []).find(x => x.id === id);
      if (!live.has(id) || (c && c.mediaId !== v.mediaId)) this._dropVideo(id);
    }
    for (const id of [...this.audios.keys()]) if (!liveA.has(id)) this._dropAudio(id);
    for (const [id, e] of [...this.aux]) { const it = p.clips.find(x => x.id === id) || (p.overlays || []).find(x => x.id === id); if (!it || this._cleanFor(it) !== e.mediaId) this._dropAux(id); }
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
        for (const a of this.aux.values()) this._wire(a);
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
  /** Set an element's gain. With `later` (the gain LOOK_AHEAD seconds from now, for items with a volume envelope) the gain follows a
   *  WebAudio linear ramp toward it, re-planned every tick, so envelope changes are smooth instead of stepping once per frame. */
  _setGain(entry, v, later) {
    v = this.muteAll ? 0 : Math.max(0, v);
    if (entry.gain) {
      const now = this.ac.currentTime, g = entry.gain.gain;
      if (later != null && !this.muteAll) {
        const cur = g.value; g.cancelScheduledValues(now); g.setValueAtTime(cur, now); g.linearRampToValueAtTime(Math.max(0, later), now + LOOK_AHEAD);
        entry.ramped = true; return;
      }
      if (entry.ramped) { entry.ramped = false; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
      if (Math.abs(g.value - v) > 0.001) g.setTargetAtTime(v, now, 0.02);
    } else if (this.audioEnabled && this.ac && !this.muteAll) {
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
  /** The processed (Change voice, else Clean voice) copy to play instead of an item's own sound, when it is switched on, ready on this device, and not being compared. */
  _cleanFor(item) { if (this.cleanBypass) return null; for (const id of soundTargets(item)) if (this.media.has(id)) return id; return null; }
  _getAux(item, cid) {
    let e = this.aux.get(item.id);
    if (e && e.mediaId === cid) return e;
    if (e) this._dropAux(item.id);
    const url = this.media.url(cid); if (!url) return null;
    e = { el: this._makeEl('audio', url), mediaId: cid, gain: null };
    this._wire(e); this.aux.set(item.id, e);
    return e;
  }
  _dropAux(id) {
    const e = this.aux.get(id); if (!e) return;
    try { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); } catch { }
    try { e.gain && e.gain.disconnect(); } catch { }
    this.aux.delete(id);
  }
  /** Play the cleaned sound of a video clip / overlay in step with its picture (same source time, speed, gain). */
  /** Key of a reversed clip's rendered sound (changes when anything that shapes its sound changes). */
  revKey(c) { return [c.mediaId, c.in.toFixed(3), c.out.toFixed(3), c.speed, c.ramp ? JSON.stringify(c.ramp) : 0, c.hasAudio, (c.clean && c.clean.level) || '', c.change ? 1 : 0].join('|'); }
  revState(c) { const e = this.revBuf.get(this.revKey(c)); return e ? { state: e.state, progress: e.progress } : { state: 'idle', progress: 0 }; }
  /** Render the reversed clip's sound (progress callback 0..1). Safe to call again: one render per key. */
  prepareReverse(c, onProgress) {
    const key = this.revKey(c);
    let e = this.revBuf.get(key);
    if (e) { if (onProgress && e.state === 'loading') e.cbs.push(onProgress); if (onProgress && e.state !== 'loading') onProgress(1); return e.promise || Promise.resolve(); }
    e = { state: 'loading', progress: 0, buf: null, cbs: onProgress ? [onProgress] : [] };
    this.revBuf.set(key, e);
    if (this.revBuf.size > 6) { const k = this.revBuf.keys().next().value; this.revBuf.delete(k); }
    const len = layout({ ...this.getProject(), clips: [{ ...c, gap: 0 }] }).total;
    if (!c.hasAudio || c.kind !== 'video') { e.state = 'none'; return Promise.resolve(); }
    if (len > PREVIEW_AUDIO_MAX) { e.state = 'toolong'; return Promise.resolve(); }
    e.promise = renderClipAudio(this.getProject(), c, this.media, { onProgress: (f) => { e.progress = f; for (const cb of e.cbs) cb(f); } })
      .then((buf) => { e.buf = buf; e.state = buf ? 'ready' : 'none'; })
      .catch((err) => { console.warn('Reverse sound', err); e.state = 'failed'; })
      .finally(() => { e.progress = 1; for (const cb of e.cbs) cb(1); e.cbs = []; });
    return e.promise;
  }
  _stopRev(id) { const n = this.revNodes.get(id); if (!n) return; try { n.src.stop(); n.src.disconnect(); n.g.disconnect(); } catch { /* already stopped */ } this.revNodes.delete(id); }
  _driveRev(it, on, t, used) {
    const c = it.clip;
    if (!on || !this.ac) return;
    const key = this.revKey(c), e = this.revBuf.get(key);
    if (!e) { this.prepareReverse(c); return; }
    if (e.state !== 'ready') return;
    used.add(c.id);
    const off = Math.max(0, t - it.start);
    let n = this.revNodes.get(c.id);
    if (n && (n.key !== key || Math.abs((this.ac.currentTime - n.startedAt) - off) > 0.25)) { this._stopRev(c.id); n = null; } // edited, or the playhead jumped
    if (!n) {
      const src = this.ac.createBufferSource(); src.buffer = e.buf; const g = this.ac.createGain();
      src.connect(g).connect(this.ac.destination); src.start(0, Math.min(off, e.buf.duration - 0.001));
      n = { src, g, key, startedAt: this.ac.currentTime - off }; this.revNodes.set(c.id, n);
    }
    n.g.gain.value = clipGain(it, t);
  }
  _driveAux(item, cid, active, fwd, desired, pr, g0, g1) {
    const e = this._getAux(item, cid); if (!e) return false;
    const el = e.el;
    if (active && fwd) {
      if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
      if (el.paused) { if (Math.abs(el.currentTime - desired) > 0.04) el.currentTime = desired; el.play().catch(() => { }); }
      else if (Math.abs(el.currentTime - desired) > 0.3 && !el.seeking) el.currentTime = desired;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - desired) > 0.05 && !el.seeking) el.currentTime = desired;
    }
    this._setGain(e, g0, g1);
    return true;
  }
  _getAudio(a) {
    const mid = this._cleanFor(a) || a.mediaId;
    let e = this.audios.get(a.id);
    if (e && e.mediaId === mid) return e;
    if (e) this._dropAudio(a.id);
    const url = this.media.url(mid);
    if (!url) return null;
    e = { el: this._makeEl('audio', url), mediaId: mid, gain: null };
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
    const needed = new Set(), auxNeeded = new Set(), revUsed = new Set();
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
      const rev = !!c.reverse, desired = active ? sourceTime(it, t) : (rev ? Math.max(c.in, c.out - 0.001) : c.in);
      const cspd = c.ramp ? speedAt(c.ramp, desired) : c.speed; // a speed curve changes the playback rate as the clip plays
      if (active && fwd && !rev) {
        const pr = clamp(cspd * this.rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        if (el.paused) {
          if (Math.abs(el.currentTime - desired) > 0.04) el.currentTime = desired;
          el.play().catch(() => { });
        } else if (Math.abs(el.currentTime - desired) > 0.3 && !el.seeking) el.currentTime = desired;
        if (el.readyState < 3 || el.seeking) ready = false;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - desired) > 0.015 && !el.seeking) el.currentTime = desired;
        if (active && !(rev && fwd) && (el.readyState < 2 || el.seeking)) ready = false; // reversed clips are played by seeking: the clock does not wait for each seek (the last frame stays up meanwhile)
      }
      if (rev && c.kind === 'video' && c.hasAudio && !c.muted && c.volume > 0 && !(c.ramp && c.ramp.audio === 'mute')) this._driveRev(it, active && fwd && this.rate === 1, t, revUsed);
      {
        const live = active && fwd && !rev && this.rate === 1 && !(c.ramp && c.ramp.audio === 'mute'), g0 = live ? clipGain(it, t) : 0, g1 = live && hasKeyframes(c, 'volume') ? clipGain(it, Math.min(it.end, t + LOOK_AHEAD)) : null;
        const cid = c.kind === 'video' && !rev ? this._cleanFor(c) : null;
        if (cid) { this._setGain(v, 0); if (this._driveAux(c, cid, active, fwd, desired, clamp(cspd * this.rate, 0.0625, 16), g0, g1)) auxNeeded.add(c.id); }
        else this._setGain(v, g0, g1);
      }
    }
    for (const o of p.overlays || []) {
      const len = overlayLen(o);
      const active = t >= o.start && t < o.start + len;
      const pre = !active && fwd && o.start > t && o.start - t < 1.5;
      if (!active && !pre) continue;
      if (o.kind === 'image') { if (!this.media.imageSync(o.mediaId)) this.media.image(o.mediaId).then(() => this.requestRender()).catch(() => { }); continue; }
      const v = this._getVideo(o); if (!v) continue;
      needed.add(o.id); this.lastUse.set(o.id, now);
      const el = v.el, desired = active ? overlaySourceTime(o, t) : o.in;
      if (active && fwd) {
        const pr = clamp((o.speed || 1) * this.rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        if (el.paused) { if (Math.abs(el.currentTime - desired) > 0.04) el.currentTime = desired; el.play().catch(() => { }); }
        else if (Math.abs(el.currentTime - desired) > 0.3 && !el.seeking) el.currentTime = desired;
        if (el.readyState < 3 || el.seeking) ready = false;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - desired) > 0.015 && !el.seeking) el.currentTime = desired;
      }
      {
        const g0 = active && fwd && this.rate === 1 ? overlayGain(o, t) : 0, g1 = active && fwd && this.rate === 1 && hasKeyframes(o, 'volume') ? overlayGain(o, Math.min(o.start + len, t + LOOK_AHEAD)) : null;
        const cid = this._cleanFor(o);
        if (cid) { this._setGain(v, 0); if (this._driveAux(o, cid, active, fwd, desired, clamp((o.speed || 1) * this.rate, 0.0625, 16), g0, g1)) auxNeeded.add(o.id); }
        else this._setGain(v, g0, g1);
      }
    }
    for (const [id, v] of this.videos) {
      if (needed.has(id)) continue;
      if (!v.el.paused) v.el.pause();
      this._setGain(v, 0);
    }
    for (const [id, e] of this.aux) { if (auxNeeded.has(id)) continue; if (!e.el.paused) e.el.pause(); this._setGain(e, 0); }
    if (this.videos.size > POOL_MAX) {
      const idle = [...this.videos.keys()].filter(id => !needed.has(id)).sort((a, b) => (this.lastUse.get(a) || 0) - (this.lastUse.get(b) || 0));
      while (this.videos.size > POOL_MAX && idle.length) this._dropVideo(idle.shift());
    }
    // music
    for (const a of p.audio) {
      const len = audioSpan(a, this.total);
      const active = t >= a.start && t < a.start + len && t < this.total;
      const pre = !active && fwd && a.start > t && a.start - t < 1.5;
      if (!active && !pre) { const e = this.audios.get(a.id); if (e) { if (!e.el.paused) e.el.pause(); this._setGain(e, 0); } continue; }
      const e = this._getAudio(a); if (!e) continue;
      const desired = active ? audioSourceTime(a, t) : audioSourceTime(a, a.start);
      if (active && fwd) {
        const arate = clamp(audioSpeed(a) * this.rate, 0.0625, 16);
        if (Math.abs(e.el.playbackRate - arate) > 1e-3) e.el.playbackRate = arate;
        if (e.el.paused) { if (Math.abs(e.el.currentTime - desired) > 0.04) e.el.currentTime = desired; e.el.play().catch(() => { }); }
        else if (Math.abs(e.el.currentTime - desired) > 0.3 || (a.loop && e.el.currentTime >= a.out - 0.02)) e.el.currentTime = desired; // loops jump back to the in-point
      } else {
        if (!e.el.paused) e.el.pause();
        if (Math.abs(e.el.currentTime - desired) > 0.05) e.el.currentTime = desired;
      }
      const iv = this.duck.get(a.id) || this.speech;
      this._setGain(e, active && fwd && this.rate === 1 ? musicGain(a, t, iv, this.total) : 0, active && fwd && this.rate === 1 && hasKeyframes(a, 'volume') ? musicGain(a, Math.min(a.start + len, t + LOOK_AHEAD), iv, this.total) : null);
    }
    for (const id of [...this.revNodes.keys()]) if (!revUsed.has(id)) this._stopRev(id);
    return ready;
  }

  getSource = (it) => {
    const c = it.clip;
    if (c.kind === 'image') return this.media.imageSourceAt(c.mediaId, (this.t - it.start) + (c.in || 0), () => this.requestRender());
    const v = this.videos.get(c.id);
    if (!v || !v.el.videoWidth || (v.el.readyState < 2 && !v.el._hasFrame)) return null;
    return { img: v.el, w: v.el.videoWidth, h: v.el.videoHeight };
  };
  getOverlaySource = (o) => {
    if (o.kind === 'image') return this.media.imageSourceAt(o.mediaId, (this.t - o.start) + (o.in || 0), () => this.requestRender());
    const v = this.videos.get(o.id);
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
    const r = this.comp.render(this.ctx, W, H, p, this.lay, this.t, this.getSource, { getLogo: this.getLogo, getOverlaySource: this.getOverlaySource });
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
    for (const id of [...this.aux.keys()]) this._dropAux(id);
    if (this.ac) this.ac.close().catch(() => { });
  }
}
