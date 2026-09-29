// Audio mixing for export, streamed in short chunks so memory stays flat for hour-long timelines:
// clip audio (speed, fades, transitions) + overlay audio + music/voice tracks (looping, ducking).
// Sources are decoded on demand with WebCodecs (via Mediabunny) — never whole files — and time-stretched with a
// streaming WSOLA when a clip's speed isn't 1×.
import { clipGain, musicGain, speechIntervals, duckIntervalsFor, audioLen, audioSpan, overlayLen, overlayGain } from './model.js';
import { loadMediabunny } from './media.js';

export const CHUNK_SEC = 10;
const FALLBACK_DECODE_LIMIT = 80 * 1024 * 1024; // whole-file decodeAudioData fallback only for files up to 80 MB

/** Legacy whole-file decode (small files only; used when WebCodecs can't decode a format). */
async function decodeWhole(blob) {
  if (blob.size > FALLBACK_DECODE_LIMIT) throw new Error('file too large to decode in memory');
  const ac = new OfflineAudioContext(2, 1, 48000);
  return await ac.decodeAudioData(await blob.arrayBuffer());
}

/** Sequential, sample-accurate reader of one media file's audio (native sample rate, up to 2 channels). */
class SourceReader {
  constructor(blob, name) { this.blob = blob; this.name = name; this.chunks = []; this.it = null; this.done = false; }
  async open() {
    try {
      const mb = await loadMediabunny();
      this.input = new mb.Input({ source: new mb.BlobSource(this.blob), formats: mb.ALL_FORMATS });
      const track = await this.input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) throw new Error('no decodable audio track');
      this.sink = new mb.AudioBufferSink(track);
      this.sr = track.sampleRate; this.ch = Math.min(2, track.numberOfChannels || 1);
    } catch (e) {
      this.input && this.input.dispose && this.input.dispose(); this.input = null;
      this.whole = await decodeWhole(this.blob); // throws for large files
      this.sr = this.whole.sampleRate; this.ch = Math.min(2, this.whole.numberOfChannels);
    }
    return this;
  }
  _restart(s0) {
    if (this.it) this.it.return().catch(() => { });
    this.chunks = []; this.done = false;
    this.itStart = Math.max(0, s0 - Math.round(this.sr * 0.05));
    this.lowMark = this.itStart; // reads before this need a restart
    this.it = this.sink.buffers(this.itStart / this.sr);
  }
  /** Returns channel arrays of `n` samples starting at absolute sample index s0 (zeros where there's no audio). */
  async read(s0, n) {
    n = Math.max(0, Math.round(n)); s0 = Math.round(s0);
    const out = Array.from({ length: this.ch }, () => new Float32Array(n));
    if (!n) return out;
    if (this.whole) {
      for (let c = 0; c < this.ch; c++) {
        const d = this.whole.getChannelData(Math.min(c, this.whole.numberOfChannels - 1));
        const a = Math.max(0, s0), b = Math.min(d.length, s0 + n);
        if (b > a) out[c].set(d.subarray(a, b), a - s0);
      }
      return out;
    }
    const last = this.chunks[this.chunks.length - 1];
    const hi = last ? last.s0 + last.n : this.itStart;
    if (!this.it || s0 < this.lowMark || s0 > hi + this.sr * 3) this._restart(s0);
    const end = s0 + n;
    while (!this.done && (!this.chunks.length || this.chunks[this.chunks.length - 1].s0 + this.chunks[this.chunks.length - 1].n < end)) {
      const r = await this.it.next();
      if (r.done) { this.done = true; break; }
      const b = r.value.buffer, cs = Math.round(r.value.timestamp * this.sr);
      const ch = []; for (let c = 0; c < this.ch; c++) ch.push(b.getChannelData(Math.min(c, b.numberOfChannels - 1)));
      this.chunks.push({ s0: cs, n: b.length, ch });
    }
    for (const k of this.chunks) {
      const a = Math.max(s0, k.s0), b = Math.min(end, k.s0 + k.n);
      if (b <= a) continue;
      for (let c = 0; c < this.ch; c++) out[c].set(k.ch[c].subarray(a - k.s0, b - k.s0), a - s0);
    }
    // forget audio well behind the read position (keeps memory to a few seconds per source)
    const keepFrom = s0 - this.sr * 1;
    while (this.chunks.length > 1 && this.chunks[0].s0 + this.chunks[0].n < keepFrom) { this.chunks.shift(); this.lowMark = this.chunks[0].s0; }
    return out;
  }
  close() { try { this.it && this.it.return().catch(() => { }); } catch { } try { this.input && this.input.dispose && this.input.dispose(); } catch { } this.chunks = []; this.whole = null; }
}

/** WSOLA time-stretch (pitch preserving) of whole arrays. speed>1 = faster/shorter. */
export function timeStretch(channels, sr, speed) {
  const inLen = channels[0].length;
  const src = { sr, ch: channels.length, read: async () => { throw new Error('sync'); } };
  const st = new Stretcher(src, 0, sr, speed, channels);
  return st.runSync(Math.max(1, Math.floor(inLen / speed)));
}

/**
 * Streaming WSOLA: output sample j of the segment corresponds to input around base + j*speed.
 * Same algorithm as the old whole-buffer version, but it pulls input and releases output incrementally.
 */
class Stretcher {
  constructor(reader, base, sr, speed, whole) {
    this.r = reader; this.base = base; this.sr = sr; this.speed = speed; this.whole = whole || null;
    this.N = Math.round(sr * 0.046) & ~1; this.Hs = this.N >> 1; this.Ha = this.Hs * speed; this.tol = Math.round(sr * 0.010);
    this.win = new Float32Array(this.N); for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.N - 1));
    this.nch = reader.ch;
    this.k = 0; this.prevA = 0;
    this.in0 = 0; this.inCh = whole || Array.from({ length: this.nch }, () => new Float32Array(0)); // input window [in0, in0+len)
    this.acc0 = 0; this.acc = Array.from({ length: this.nch }, () => new Float32Array(0)); this.norm = new Float32Array(0); // overlap-add accumulator
    this.fin = 0; // output samples < fin are final
    this.pieces = []; // finalized output pieces { s, n, d: [Float32Array per channel] }, kept briefly for re-reads
  }
  _inGet(ci, i) { const j = i - this.in0; const d = this.inCh[ci]; return j >= 0 && j < d.length ? d[j] : undefined; }
  async _ensureIn(upto, from) {
    if (this.whole) { this.inCh = this.whole; this.in0 = 0; return; }
    const have = this.in0 + this.inCh[0].length;
    if (upto <= have && from >= this.in0) return;
    const drop = Math.max(this.in0, Math.min(from, have)) - this.in0;
    const need = Math.max(upto, have + Math.round(this.sr * 2)) - have;
    const fresh = await this.r.read(this.base + have, need);
    this.inCh = this.inCh.map((d, c) => { const o = new Float32Array(d.length - drop + need); o.set(d.subarray(drop)); o.set(fresh[c], d.length - drop); return o; });
    this.in0 += drop;
  }
  _frame() {
    const { N, Hs, tol, win } = this;
    const k = this.k, s = k * Hs, nominal = Math.round(k * this.Ha);
    let best = nominal;
    if (k > 0) {
      const nat = this.prevA + Hs; let bestC = -Infinity;
      const ref = this.inCh[0], o = this.in0;
      for (let d = -tol; d <= tol; d += 3) {
        const a = nominal + d; if (a < 0) continue;
        let c = 0; for (let i = 0; i < N; i += 8) c += (ref[a + i - o] || 0) * (ref[nat + i - o] || 0);
        if (c > bestC) { bestC = c; best = a; }
      }
    }
    best = Math.max(0, best);
    // grow accumulator to hold [acc0, s+N)
    const needLen = s + N - this.acc0;
    if (this.norm.length < needLen) {
      const L = Math.max(needLen, this.norm.length * 2 | 0, 8192);
      this.acc = this.acc.map(d => { const o = new Float32Array(L); o.set(d); return o; });
      const nn = new Float32Array(L); nn.set(this.norm); this.norm = nn;
    }
    const off = s - this.acc0;
    for (let ci = 0; ci < this.nch; ci++) {
      const inp = this.inCh[ci], out = this.acc[ci], io = best - this.in0;
      for (let i = 0; i < N; i++) { const x = inp[io + i]; if (x === undefined) break; out[off + i] += x * win[i]; }
    }
    for (let i = 0; i < N; i++) this.norm[off + i] += win[i];
    this.prevA = best; this.k++;
    return s + Hs; // everything before this is final
  }
  _finalize(upto) {
    // move final samples [fin, upto) from accumulator into `keep`
    const n = upto - this.fin; if (n <= 0) return;
    const a = this.fin - this.acc0;
    const fresh = this.acc.map(d => { const o = new Float32Array(n); for (let i = 0; i < n; i++) { const w = this.norm[a + i]; o[i] = w > 1e-3 ? d[a + i] / w : 0; } return o; });
    this.pieces.push({ s: this.fin, n, d: fresh });
    this.fin = upto;
    // shift accumulator
    const cut = this.fin - this.acc0;
    this.acc = this.acc.map(d => d.slice(cut)); this.norm = this.norm.slice(cut); this.acc0 = this.fin;
  }
  async pull(o0, n) {
    const o1 = o0 + n;
    while (this.fin < o1) {
      const s = this.k * this.Hs, nominal = Math.round(this.k * this.Ha);
      const lo = Math.max(0, Math.min(nominal - this.tol, this.prevA + this.Hs) - 16);
      await this._ensureIn(Math.max(nominal + this.tol, this.prevA + this.Hs) + this.N + 8, lo);
      const f = this._frame(); void s;
      this._finalize(f);
    }
    const out = this._collect(o0, n);
    const dropTo = o0 - Math.round(this.sr * 0.5); // forget output well before o0
    while (this.pieces.length && this.pieces[0].s + this.pieces[0].n < dropTo) this.pieces.shift();
    return out;
  }
  _collect(o0, n) {
    const out = Array.from({ length: this.nch }, () => new Float32Array(n));
    for (const p of this.pieces) {
      const a = Math.max(o0, p.s), b = Math.min(o0 + n, p.s + p.n);
      if (b > a) for (let c = 0; c < this.nch; c++) out[c].set(p.d[c].subarray(a - p.s, b - p.s), a - o0);
    }
    return out;
  }
  runSync(outLen) {
    while (this.fin < outLen) { const f = this._frame(); this._finalize(f); }
    return this._collect(0, outLen);
  }
}

function applyEnvelope(param, t0, t1, fn, step = 0.02) {
  let lastT = t0, v0 = fn(t0);
  param.setValueAtTime(v0, Math.max(0, t0));
  let pT = t0, pV = v0;
  for (let t = t0 + step; t <= t1 + 1e-9; t += step) {
    const v = fn(Math.min(t, t1));
    if (Math.abs(v - pV) > 1e-5) { if (pT !== lastT) param.linearRampToValueAtTime(pV, pT); param.linearRampToValueAtTime(v, t); lastT = t; }
    pT = t; pV = v;
  }
}

/** Everything audible on the timeline as independent segments (timeline range → source range + gain). */
export function audioSegments(project, lay) {
  const total = lay.total, segs = [];
  const speech = speechIntervals(lay, project);
  for (const it of lay.items) {
    const c = it.clip;
    if (c.kind !== 'video' || !c.hasAudio || c.muted || c.volume <= 0) continue;
    segs.push({ kind: 'clip', mediaId: c.mediaId, name: c.name, t0: it.start, t1: it.end, srcIn: c.in, speed: c.speed || 1, gain: (t) => clipGain(it, t) });
  }
  for (const o of project.overlays || []) {
    if (o.kind !== 'video' || !o.hasAudio || o.muted || o.volume <= 0 || o.start >= total) continue;
    segs.push({ kind: 'overlay', mediaId: o.mediaId, name: o.name, t0: o.start, t1: Math.min(total, o.start + overlayLen(o)), srcIn: o.in, speed: o.speed || 1, gain: (t) => overlayGain(o, t) });
  }
  for (const a of project.audio || []) {
    if (a.volume <= 0 || a.start >= total) continue;
    const iv = duckIntervalsFor(a, lay, project, speech);
    const gain = (t) => musicGain(a, t, iv, total);
    const end = Math.min(total, a.start + audioSpan(a, total));
    if (!a.loop) { segs.push({ kind: 'music', mediaId: a.mediaId, name: a.name, t0: a.start, t1: end, srcIn: a.in, speed: 1, gain }); continue; }
    const L = audioLen(a);
    let t = a.start, src = a.in + ((a.phase || 0) % L);
    for (let n = 0; t < end - 1e-4 && n < 100000; n++) {
      const passEnd = Math.min(end, t + (a.in + L - src));
      segs.push({ kind: 'music', mediaId: a.mediaId, name: a.name, t0: t, t1: passEnd, srcIn: src, speed: 1, gain, loopPass: n });
      t = passEnd; src = a.in;
    }
  }
  return segs.filter(s => s.t1 > s.t0 + 1e-4);
}
export function hasAudio(project, lay) { return audioSegments(project, lay).length > 0; }

/**
 * Async generator of stereo AudioBuffers (CHUNK_SEC each, last one shorter) covering the whole timeline.
 * Memory use is a few seconds of audio per active source, independent of the timeline length.
 */
export async function* mixChunks(project, lay, media, { sampleRate = 48000, chunkSec = CHUNK_SEC, onStatus, onWarn } = {}) {
  const total = lay.total;
  const segs = audioSegments(project, lay).sort((a, b) => a.t0 - b.t0);
  const totalLen = Math.max(1, Math.ceil(total * sampleRate));
  const M = 0.05; // resampler context margin
  const open = new Map(); // seg -> { reader, stretcher } (per segment)
  const failed = new Set();
  const openSeg = async (s) => {
    if (open.has(s)) return open.get(s);
    const rec = await media.get(s.mediaId);
    let st = null;
    if (rec && !failed.has(s.mediaId)) {
      try {
        const reader = await new SourceReader(rec.blob, rec.name).open();
        st = { reader };
        if (Math.abs(s.speed - 1) > 1e-3) st.stretch = new Stretcher(reader, Math.round(s.srcIn * reader.sr), reader.sr, s.speed);
      } catch (e) {
        failed.add(s.mediaId);
        console.info('Audio of', rec.name, 'skipped:', e.message);
        onWarn && onWarn(`Couldn’t decode the audio of “${rec.name}” (${e.message}); it will be silent in the export.`);
      }
    }
    open.set(s, st);
    return st;
  };
  for (let s0 = 0; s0 < totalLen; s0 += Math.round(chunkSec * sampleRate)) {
    const n = Math.min(Math.round(chunkSec * sampleRate), totalLen - s0);
    const T0 = s0 / sampleRate, T1 = (s0 + n) / sampleRate;
    const ctx = new OfflineAudioContext(2, n, sampleRate);
    for (const s of segs) {
      if (s.t0 >= T1 || s.t1 <= T0) continue;
      const st = await openSeg(s); if (!st) continue;
      const r = st.reader, sr = r.sr;
      const a = Math.max(s.t0, T0 - M), b = Math.min(s.t1, T1 + M); // timeline range to fetch (with margin)
      let chans;
      if (st.stretch) {
        const o0 = Math.round((a - s.t0) * sr); // output sample index within the segment
        chans = await st.stretch.pull(o0, Math.max(1, Math.round((b - a) * sr)));
      } else {
        chans = await r.read(Math.round((s.srcIn + (a - s.t0)) * sr), Math.max(1, Math.round((b - a) * sr)));
      }
      const buf = ctx.createBuffer(chans.length, chans[0].length, sr);
      chans.forEach((d, i) => buf.copyToChannel(d, i));
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain();
      src.connect(g).connect(ctx.destination);
      const rel0 = a - T0;
      applyEnvelope(g.gain, Math.max(0, rel0), Math.min(T1 - T0, b - T0), (t) => s.gain(t + T0));
      if (rel0 >= 0) src.start(rel0); else src.start(0, -rel0);
      if (s.t1 <= T1 + M) { /* segment ends in this chunk */ }
    }
    onStatus && onStatus(T1 / total);
    const out = await ctx.startRendering();
    // release readers of segments that are finished
    for (const [s, st] of open) if (s.t1 < T1 - M) { st && st.reader.close(); open.delete(s); }
    yield out;
  }
  for (const st of open.values()) st && st.reader.close();
}

/** Whole mix as one AudioBuffer (short timelines / tests). Returns null when the timeline has no audio. */
export async function mixAudio(project, lay, media, { sampleRate = 48000, onStatus } = {}) {
  if (!hasAudio(project, lay)) return null;
  const len = Math.max(1, Math.ceil(lay.total * sampleRate));
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate });
  let off = 0;
  for await (const b of mixChunks(project, lay, media, { sampleRate })) {
    for (let c = 0; c < 2; c++) out.copyToChannel(b.getChannelData(c), c, off);
    off += b.length;
    onStatus && onStatus('Mixing audio…');
  }
  return out;
}
