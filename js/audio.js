// Audio mixing for export, streamed in short chunks so memory stays flat for hour-long timelines:
// clip audio (speed, fades, transitions) + overlay audio + music/voice tracks (looping, ducking).
// Sources are decoded on demand with WebCodecs (via Mediabunny) — never whole files — and time-stretched with a
// streaming WSOLA when a clip's speed isn't 1×.
import { layout, soundTargets, clipGain, musicGain, speechIntervals, duckIntervalsFor, audioLen, audioSpan, audioSpeed, overlayLen, overlayGain } from './model.js';
import { loadMediabunny } from './media.js';
import { yieldToMain } from './util.js';
import { mapFor, meanSpeed } from './ramp.js';

export const CHUNK_SEC = 10;
const FALLBACK_DECODE_LIMIT = 80 * 1024 * 1024; // whole-file decodeAudioData fallback only for files up to 80 MB

/** Legacy whole-file decode (small files only; used when WebCodecs can't decode a format). */
async function decodeWhole(blob, duration) {
  if (blob.size > FALLBACK_DECODE_LIMIT) throw new Error('file too large to decode in memory');
  // 80 MB of AAC can be hours of PCM. An unknown length (NaN / Infinity: MediaRecorder WebM) is judged by the size cap alone.
  if (Number.isFinite(duration) && duration * 48000 * 2 * 4 > 384 * 1024 * 1024) throw new Error('file too long to decode in memory');
  if (!Number.isFinite(duration) && blob.size > FALLBACK_DECODE_LIMIT / 4) throw new Error('file of unknown length too large to decode in memory');
  const ac = new OfflineAudioContext(2, 1, 48000);
  return await ac.decodeAudioData(await blob.arrayBuffer());
}

/** Sequential, sample-accurate reader of one media file's audio (native sample rate, up to 2 channels). */
export class SourceReader {
  constructor(blob, name, duration) { this.blob = blob; this.name = name; this.duration = duration; this.chunks = []; this.it = null; this.done = false; }
  async open() {
    try {
      const mb = await loadMediabunny();
      this.input = new mb.Input({ source: new mb.BlobSource(this.blob), formats: mb.ALL_FORMATS });
      const track = await this.input.getPrimaryAudioTrack();
      if (!track) { const e = new Error('no audio track'); e.noAudio = true; throw e; }
      if (!(await track.canDecode())) throw new Error('no decodable audio track');
      this.sink = new mb.AudioBufferSink(track);
      this.sr = track.sampleRate; this.ch = Math.min(2, track.numberOfChannels || 1);
    } catch (e) {
      this.input && this.input.dispose && this.input.dispose(); this.input = null;
      if (e.noAudio) throw e; // a file without an audio track is simply silent
      this.whole = await decodeWhole(this.blob, this.duration); // throws for large / long files
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
  /**
   * The real length in seconds, for files whose stored duration is unknown (NaN / Infinity / 0, e.g. WebM from MediaRecorder,
   * which has no duration header): the decoded buffer, else the container scanned to its last packet, else a whole decode. 0 = unknown.
   */
  async realDuration() {
    const good = (d) => Number.isFinite(d) && d > 0;
    if (this.whole && good(this.whole.duration)) return this.whole.duration;
    if (this.input) {
      try { const d = await this.input.computeDuration(); if (good(d)) return d; } catch { /* fall through */ }
    }
    try { const buf = await decodeWhole(this.blob, NaN); if (good(buf.duration)) return buf.duration; } catch { /* too big / undecodable */ }
    return 0;
  }
  close() { try { this.it && this.it.return().catch(() => { }); } catch { } try { this.input && this.input.dispose && this.input.dispose(); } catch { } this.chunks = []; this.whole = null; }
}

/**
 * Reads a source BACKWARDS: virtual sample v is real sample `end - 1 - v`. Reversed clips play this through the normal forward
 * paths (plain read at 1x, or the stretcher for other speeds), so reverse needs no pre-rendered file and no big buffer.
 */
export class ReverseReader {
  constructor(inner, end) { this.inner = inner; this.end = end; this.sr = inner.sr; this.ch = inner.ch; }
  async read(s0, n) {
    n = Math.max(0, Math.round(n)); s0 = Math.round(s0);
    const out = Array.from({ length: this.ch }, () => new Float32Array(n));
    if (!n) return out;
    const a = this.end - s0 - n; // real samples [a, a + n) mirrored
    const lead = Math.max(0, -a), take = n - lead;
    if (take <= 0) return out;
    const got = await this.inner.read(Math.max(0, a), take);
    for (let c = 0; c < this.ch; c++) { const src = got[c], dst = out[c]; for (let i = 0; i < take; i++) dst[i] = src[take - 1 - i]; }
    return out;
  }
  close() { this.inner.close(); }
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
  constructor(reader, base, sr, speed, whole, warp) {
    this.warp = warp || null; // optional output-sample -> input-sample map for a speed curve (monotonic)
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
  _nominal(k) { return this.warp ? Math.round(this.warp(k * this.Hs)) : Math.round(k * this.Ha); }
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
    const k = this.k, s = k * Hs, nominal = this._nominal(k);
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
      const s = this.k * this.Hs, nominal = this._nominal(this.k);
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

/**
 * Gain automation for one source in one chunk: the gain function is sampled every `step` seconds and joined with linear ramps
 * (constant stretches collapse into one ramp). `marks` are times (relative to the chunk) where the curve has a corner or a jump,
 * i.e. volume-envelope keyframes: they are always sampled, and a point 0.5 ms before each is sampled too, so a "hold" key steps
 * within half a millisecond and linear segments are exact.
 */
export function applyEnvelope(param, t0, t1, fn, step = 0.02, marks = null) {
  const times = [];
  for (let t = t0 + step; t < t1 - 1e-9; t += step) times.push(t);
  times.push(t1);
  if (marks) for (const m of marks) if (m > t0 + 1e-6 && m < t1 - 1e-6) { times.push(m); if (m - 0.0005 > t0) times.push(m - 0.0005); }
  times.sort((a, b) => a - b);
  let lastT = t0; const v0 = fn(t0);
  param.setValueAtTime(v0, Math.max(0, t0));
  let pT = t0, pV = v0;
  for (const t of times) {
    if (t <= pT + 1e-9) continue;
    const v = fn(Math.min(t, t1));
    if (Math.abs(v - pV) > 1e-5) { if (pT !== lastT) param.linearRampToValueAtTime(pV, pT); param.linearRampToValueAtTime(v, t); lastT = t; }
    pT = t; pV = v;
  }
}

/** Sequence times of an item's volume-envelope keys (the mixer samples the gain exactly there). */
const envMarks = (item, start) => (item.keyframes && item.keyframes.volume ? item.keyframes.volume.map(k => start + k.t) : null);

/** Everything audible on the timeline as independent segments (timeline range → source range + gain). */
export function audioSegments(project, lay, peaksOf) {
  const total = lay.total, segs = [];
  const speech = speechIntervals(lay, project);
  for (const it of lay.items) {
    const c = it.clip;
    if (c.kind !== 'video' || !c.hasAudio || c.muted || c.volume <= 0) continue;
    if (c.ramp && c.ramp.audio === 'mute') continue; // speed ramp with the sound switched off
    const seg = { kind: 'clip', mediaId: c.mediaId, cleanIds: soundTargets(c), name: c.name, t0: it.start, t1: it.end, srcIn: c.in, speed: c.speed || 1, gain: (t) => clipGain(it, t), marks: envMarks(c, it.start) };
    if (c.ramp || c.reverse) { // speed curve and / or reversed: the mixer reads through a ReverseReader and / or a warped stretcher
      const m = c.ramp ? mapFor(c) : null;
      if (c.reverse) seg.revOut = c.out;
      seg.srcIn = c.reverse ? 0 : c.in;
      if (c.ramp) {
        seg.speed = meanSpeed(c);
        const L = m.len; // (the clip's own length; the layout length can differ by a hair)
        seg.warp = c.reverse ? (sec) => c.out - m.fwd(Math.max(0, L - sec)) : (sec) => m.fwd(Math.min(L, sec)) - c.in;
      }
    }
    segs.push(seg);
  }
  for (const o of project.overlays || []) {
    if (o.kind !== 'video' || !o.hasAudio || o.muted || o.volume <= 0 || o.start >= total) continue;
    segs.push({ kind: 'overlay', mediaId: o.mediaId, cleanIds: soundTargets(o), name: o.name, t0: o.start, t1: Math.min(total, o.start + overlayLen(o)), srcIn: o.in, speed: o.speed || 1, gain: (t) => overlayGain(o, t), marks: envMarks(o, o.start) });
  }
  for (const a of project.audio || []) {
    if (a.muted || a.volume <= 0 || a.start >= total) continue;
    const iv = duckIntervalsFor(a, lay, project, speech, peaksOf);
    const gain = (t) => musicGain(a, t, iv, total);
    const end = Math.min(total, a.start + audioSpan(a, total));
    const sp = audioSpeed(a), marks = envMarks(a, a.start);
    if (!a.loop) { segs.push({ kind: 'music', mediaId: a.mediaId, cleanIds: soundTargets(a), name: a.name, t0: a.start, t1: end, srcIn: a.in, speed: sp, gain, marks }); continue; }
    const L = audioLen(a); // one pass on the timeline; the source section is L * speed long
    let t = a.start, src = a.in + ((a.phase || 0) % L) * sp;
    for (let n = 0; t < end - 1e-4 && n < 100000; n++) {
      const passEnd = Math.min(end, t + (a.in + L * sp - src) / sp);
      segs.push({ kind: 'music', mediaId: a.mediaId, cleanIds: soundTargets(a), name: a.name, t0: t, t1: passEnd, srcIn: src, speed: sp, gain, marks, loopPass: n, share: 'loop:' + a.id });
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
export async function* mixChunks(project, lay, media, { sampleRate = 48000, chunkSec = CHUNK_SEC, onStatus, onWarn, from = 0 } = {}) {
  const total = lay.total;
  const peaksOf = (id) => { try { const r = media.peek && media.peek(id); return r && r.peaks; } catch { return null; } };
  const segs = audioSegments(project, lay, peaksOf).sort((a, b) => a.t0 - b.t0);
  const totalLen = Math.max(1, Math.ceil(total * sampleRate));
  const M = 0.05; // resampler context margin
  // Readers are opened per segment, except that all passes of a looped track share one reader (reading from the
  // loop start again just restarts its decoder), so a 3 s loop under an hour of video opens one decoder, not 1200.
  const keyOf = (s) => s.share || s;
  const lastEnd = new Map(); for (const s of segs) lastEnd.set(keyOf(s), Math.max(lastEnd.get(keyOf(s)) || 0, s.t1));
  const open = new Map(); // key -> { reader }
  const stretchers = new Map(); // seg -> Stretcher (speed-changed clips)
  const failed = new Set(), badClean = new Set(), warnedClean = new Set();
  const openSeg = async (s) => {
    const key = keyOf(s);
    if (!open.has(key)) {
      let st = null;
      for (const cid of s.cleanIds || []) { // Clean voice / Change voice: the processed copy made on this device stands in for the original sound (changed voice first)
        if (st || badClean.has(cid)) continue;
        const crec = await media.get(cid).catch(() => null);
        if (crec && crec.blob) { try { st = { reader: await new SourceReader(crec.blob, crec.name, crec.duration).open() }; } catch (e) { badClean.add(cid); } }
        else badClean.add(cid);
        if (!st && !warnedClean.has(cid)) { warnedClean.add(cid); onWarn && onWarn(`The ${cid.startsWith('chg_') ? 'Change voice' : 'Clean voice'} copy isn’t ready on this device for “${s.name}”, so ${s.cleanIds.length > 1 && cid === s.cleanIds[0] ? 'the next best' : 'its original'} sound was used.`); }
      }
      const rec = st ? null : await media.get(s.mediaId);
      if (rec && !failed.has(s.mediaId)) {
        try { st = { reader: await new SourceReader(rec.blob, rec.name, rec.duration).open() }; }
        catch (e) {
          failed.add(s.mediaId);
          if (e.noAudio) console.info('No audio track in', rec.name);
          else {
            console.info('Audio of', rec.name, 'skipped:', e.message);
            onWarn && onWarn(`Couldn’t decode the audio of “${rec.name}” (${e.message}); it will be silent in the export.`);
          }
        }
      }
      if (st && s.revOut != null) st = { reader: new ReverseReader(st.reader, Math.round(s.revOut * st.reader.sr)) };
      open.set(key, st);
    }
    const st = open.get(key); if (!st) return null;
    if ((Math.abs(s.speed - 1) > 1e-3 || s.warp) && !stretchers.has(s)) {
      const sr0 = st.reader.sr;
      stretchers.set(s, new Stretcher(st.reader, Math.round(s.srcIn * sr0), sr0, s.speed, null, s.warp ? (x) => s.warp(x / sr0) * sr0 : null));
    }
    return { reader: st.reader, stretch: stretchers.get(s) };
  };
  const step = Math.round(chunkSec * sampleRate);
  // `from` (seconds) starts at the chunk containing it (so a range of a long timeline doesn't decode everything before it)
  for (let s0 = from > 0 ? Math.floor(Math.round(from * sampleRate) / step) * step : 0; s0 < totalLen; s0 += step) {
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
      applyEnvelope(g.gain, Math.max(0, rel0), Math.min(T1 - T0, b - T0), (t) => s.gain(t + T0), 0.02, s.marks && s.marks.map(m => m - T0));
      if (rel0 >= 0) src.start(rel0); else src.start(0, -rel0);
      if (s.t1 <= T1 + M) { /* segment ends in this chunk */ }
    }
    onStatus && onStatus(T1 / total);
    const out = await ctx.startRendering();
    await yieldToMain(); // hand the thread back to the page between chunks (touch, paint) so a long mix never freezes the UI
    // release readers whose segments (all loop passes) are finished
    for (const [key, st] of open) if (lastEnd.get(key) < T1 - M) { st && st.reader.close(); open.delete(key); }
    for (const s of stretchers.keys()) if (s.t1 < T1 - M) stretchers.delete(s);
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

/** Longest clip (timeline seconds) whose sound is rendered into memory for the preview (48 kHz stereo = 22 MB per minute). */
export const PREVIEW_AUDIO_MAX = 180;
/**
 * The sound of ONE clip as it plays on the timeline (speed, speed curve, reverse), at unity gain, for the preview of reversed clips.
 * Uses the same mixer as the export, so what you hear is what is exported. Returns an AudioBuffer, or null when it has no sound.
 */
export async function renderClipAudio(project, clip, media, { onProgress, sampleRate = 48000 } = {}) {
  const c = JSON.parse(JSON.stringify(clip));
  Object.assign(c, { gap: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, keyframes: {}, transition: { type: 'cut', duration: 0.6 }, clean: undefined, change: undefined });
  const mini = { ...JSON.parse(JSON.stringify(project)), clips: [c], overlays: [], audio: [], texts: [], blurs: [], captions: [], markers: [] };
  const lay = layout(mini);
  if (!hasAudio(mini, lay)) return null;
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, Math.ceil(lay.total * sampleRate)), sampleRate });
  let off = 0;
  for await (const b of mixChunks(mini, lay, media, { sampleRate, onStatus: (f) => onProgress && onProgress(Math.min(1, f)) })) {
    for (let ch = 0; ch < 2; ch++) out.copyToChannel(b.getChannelData(ch), ch, off);
    off += b.length;
  }
  return out;
}
