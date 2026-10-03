// Change voice: pitch shifting and tone (formant) control, and a "radio" effect. Plain JavaScript, no library, no download.
//
// Pitch shifter = a phase vocoder with identity phase locking (Laroche & Dolson, "New phase-vocoder techniques for pitch-shifting,
// harmonizing and other exotic effects", 1999): the spectrum is cut into regions around its peaks, every region is moved by the
// pitch ratio and keeps its internal phase relations, and the peak's phase advances at the shifted frequency. The length never changes.
// Formants: before shifting, the spectral envelope (cepstral smoothing) is divided out; afterwards the envelope, warped by the Tone
// setting, is put back. So Deeper / Higher change the pitch of the voice without the "giant" / "chipmunk" colour, and Tone moves
// the colour on its own.
// Streaming: feed any chunk sizes through push(); the output has exactly the input length once finish() has run, and nothing is
// held beyond one window, so an hour of sound needs no more memory than a second.
export const SR = 48000;
export const N = 4096, H = 512; // 85 ms windows, 8x overlap
const LIFTER = 70; // cepstral smoothing: keeps formants, drops the individual harmonics (pitch >= ~ 700 Hz period of 70 samples @48k)

class FFT2 {
  constructor(n) {
    this.n = n; this.rev = new Uint32Array(n); this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  }
  /** in place; inverse = true gives the unscaled inverse transform */
  run(re, im, inverse) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = sg * this.sin[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}
const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };
const wrap = (x) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

/** Pitch (semitones) and Tone (semitones of formant shift) on a mono stream. pitch = tone = 0 passes the sound through untouched. */
export class PitchStream {
  constructor({ pitch = 0, tone = 0 } = {}) {
    this.r = Math.pow(2, pitch / 12); this.f = Math.pow(2, tone / 12);
    this.bypass = pitch === 0 && tone === 0;
    this.fft = new FFT2(N); this.win = hann(N);
    let s = 0; for (let i = 0; i < N; i += H) s += this.win[i] * this.win[i]; this.gain = 1 / s;
    const h = N / 2 + 1;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.mag = new Float64Array(h); this.ph = new Float64Array(h); this.prevPh = new Float64Array(h); this.sPh = new Float64Array(h);
    this.env = new Float64Array(h); this.nm = new Float64Array(h); this.np = new Float64Array(h); this.set = new Uint8Array(h);
    this.cr = new Float64Array(N); this.ci = new Float64Array(N);
    this.inp = new Float32Array(N * 4); this.inLen = 0; this.inOff = N / 2 * -1; // padded coordinate of inp[0] = -N/2 (zeros before the start)
    this.inp.fill(0, 0, N / 2); this.inLen = N / 2; this.inOff = 0; // padded stream p[n] = x[n - N/2]: start with N/2 zeros
    this.acc = new Float32Array(N * 4); this.accOff = 0; // overlap-add output in padded coordinates, from accOff
    this.nextFrame = 0; this.total = 0; this.emitted = 0; this.peaks = new Int32Array(h);
  }
  close() { }
  _env(mag) { // smooth spectral envelope of the magnitudes (cepstral smoothing of the log spectrum)
    const h = N / 2 + 1, cr = this.cr, ci = this.ci;
    for (let k = 0; k < h; k++) { const v = Math.log(mag[k] + 1e-9); cr[k] = v; ci[k] = 0; }
    for (let k = 1; k < N / 2; k++) { cr[N - k] = cr[k]; ci[N - k] = 0; }
    this.fft.run(cr, ci, true); // cepstrum (unscaled)
    for (let n = 0; n < N; n++) { const q = Math.min(n, N - n); const w = q <= LIFTER ? 1 : q < LIFTER * 1.5 ? 0.5 + 0.5 * Math.cos(Math.PI * (q - LIFTER) / (LIFTER * 0.5)) : 0; cr[n] = cr[n] * w / N; ci[n] = 0; }
    this.fft.run(cr, ci, false);
    for (let k = 0; k < h; k++) this.env[k] = Math.exp(cr[k]);
  }
  _frame(s) { // s = padded start of the frame
    const re = this.re, im = this.im, win = this.win, h = N / 2 + 1, mag = this.mag, ph = this.ph;
    const base = s - this.inOff;
    for (let i = 0; i < N; i++) { re[i] = this.inp[base + i] * win[i]; im[i] = 0; }
    this.fft.run(re, im, false);
    for (let k = 0; k < h; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
    const r = this.r, f = this.f, env = this.env, nm = this.nm, np = this.np, set = this.set;
    this._env(mag);
    nm.fill(0); set.fill(0);
    // peaks
    const pk = this.peaks; let np_ = 0;
    for (let k = 2; k < h - 2; k++) { const m = mag[k]; if (m > mag[k - 1] && m > mag[k + 1] && m >= mag[k - 2] && m >= mag[k + 2] && m > 1e-7) pk[np_++] = k; }
    if (np_ === 0) { pk[np_++] = 1; }
    for (let a = 0; a < np_; a++) {
      const p = pk[a], lo = a === 0 ? 0 : (pk[a - 1] + p + 1) >> 1, hi = a === np_ - 1 ? h - 1 : (p + pk[a + 1]) >> 1;
      const om = (2 * Math.PI * p) / N, dev = wrap(ph[p] - this.prevPh[p] - H * om) / H, w = om + dev; // true frequency (rad/sample)
      const d = Math.round(p * r) - p, q = p + d;
      if (q < 0 || q >= h) continue;
      const sp = this.sPh[q] + H * w * r;
      for (let k = lo; k <= hi; k++) {
        const j = k + d; if (j < 0 || j >= h) continue;
        const src = j / f, i0 = Math.min(h - 2, Math.floor(src)), fr = Math.min(1, src - i0);
        const tgt = env[i0] * (1 - fr) + env[Math.min(h - 1, i0 + 1)] * fr; // envelope of the target colour
        const m = mag[k] * (tgt / (env[k] + 1e-12));
        if (!set[j] || m > nm[j]) { nm[j] = m; np[j] = sp + (ph[k] - ph[p]); set[j] = 1; }
      }
      this.sPh[q] = sp;
    }
    for (let k = 0; k < h; k++) { if (set[k]) this.sPh[k] = np[k]; this.prevPh[k] = ph[k]; }
    for (let k = 0; k < h; k++) { re[k] = nm[k] * Math.cos(np[k]); im[k] = nm[k] * Math.sin(np[k]); }
    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    im[0] = 0; im[N / 2] = 0;
    this.fft.run(re, im, true);
    const g = this.gain / N, ao = s - this.accOff;
    for (let i = 0; i < N; i++) this.acc[ao + i] += re[i] * win[i] * g;
  }
  _ensure(arrName, need) {
    const a = this[arrName]; if (a.length >= need) return;
    const b = new Float32Array(Math.max(need, a.length * 2)); b.set(a); this[arrName] = b;
  }
  _run(final) {
    for (;;) {
      const s = this.nextFrame * H;
      if (s + N > this.inOff + this.inLen) break;
      this._ensure('acc', s - this.accOff + N);
      this._frame(s); this.nextFrame++;
    }
    // emit finished output: x-coordinate m is final when padded index m + N/2 < nextFrame * H
    const limit = final ? this.total : Math.min(this.total, this.nextFrame * H - N / 2);
    const out = new Float32Array(Math.max(0, limit - this.emitted));
    for (let i = 0; i < out.length; i++) out[i] = this.acc[this.emitted + i + N / 2 - this.accOff];
    this.emitted += out.length;
    // drop what is no longer needed (input before the next frame, output already emitted)
    const keepIn = this.nextFrame * H - this.inOff;
    if (keepIn > N * 2) { this.inp.copyWithin(0, keepIn, this.inLen); this.inLen -= keepIn; this.inOff += keepIn; }
    const dropAcc = Math.min(this.emitted + N / 2, this.nextFrame * H) - this.accOff;
    if (dropAcc > N * 2) { const rest = this.acc.length - dropAcc; this.acc.copyWithin(0, dropAcc, this.acc.length); this.acc.fill(0, rest); this.accOff += dropAcc; }
    return out;
  }
  async push(x) {
    if (this.bypass) { this.total += x.length; this.emitted += x.length; return Float32Array.from(x); }
    this.total += x.length;
    this._ensure('inp', this.inLen + x.length); this.inp.set(x, this.inLen); this.inLen += x.length;
    return this._run(false);
  }
  async finish() {
    if (this.bypass) return new Float32Array(0);
    const pad = new Float32Array(N + H); this._ensure('inp', this.inLen + pad.length); this.inp.set(pad, this.inLen); this.inLen += pad.length;
    return this._run(true);
  }
}

/** Radio / telephone voice: band-pass 300 Hz - 3.4 kHz, light compression, a little warmth, gain set to keep the loudness. */
export class RadioStream {
  constructor() {
    this.hp = [bq('hp', 320, 0.8), bq('hp', 320, 0.8)]; this.lp = [bq('lp', 3200, 0.8), bq('lp', 3200, 0.8)];
    this.env = 0; this.atk = Math.exp(-1 / (0.005 * SR)); this.rel = Math.exp(-1 / (0.12 * SR));
    this.makeup = 3.2; this.thr = 0.1; this.ratio = 3.5;
  }
  close() { }
  _go(x) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let v = x[i];
      for (const f of this.hp) v = f.p(v);
      for (const f of this.lp) v = f.p(v);
      const a = Math.abs(v); this.env = a > this.env ? this.atk * this.env + (1 - this.atk) * a : this.rel * this.env + (1 - this.rel) * a;
      let g = 1; if (this.env > this.thr) g = Math.pow(this.env / this.thr, 1 / this.ratio - 1);
      v = Math.tanh(v * g * this.makeup * 1.3) / 1.3; // soft clip
      out[i] = v;
    }
    return out;
  }
  async push(x) { return this._go(x); }
  async finish() { return new Float32Array(0); }
}
function bq(type, f0, Q) { // RBJ biquad
  const w = (2 * Math.PI * f0) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; } else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  const a0 = 1 + al, a1 = (-2 * c) / a0, a2 = (1 - al) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
  let z1 = 0, z2 = 0;
  return { p(x) { const y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y; } };
}

/** Keeps the loudness of the result close to the loudness of the original (slow, per 0.1 s block), so effects never make the voice jump in level. */
class LevelMatch {
  constructor() { this.bs = 4800; this.d = Math.exp(-1 / 30); this.inAcc = 0; this.inN = 0; this.inE = []; this.base = 0; this.sIn = 0; this.sOut = 0; this.g = 1; this.done = 0; this.pend = new Float32Array(0); }
  feed(x) { for (let i = 0; i < x.length; i++) { this.inAcc += x[i] * x[i]; if (++this.inN === this.bs) { this.inE.push(this.inAcc); this.inAcc = 0; this.inN = 0; } } }
  _block(chunk, final) {
    const b = this.done - this.base, ein = this.inE[b] !== undefined ? this.inE[b] : this.inAcc * (this.bs / Math.max(1, this.inN));
    let eo = 0; for (let i = 0; i < chunk.length; i++) eo += chunk[i] * chunk[i];
    eo *= this.bs / chunk.length;
    this.sIn = this.sIn * this.d + ein; this.sOut = this.sOut * this.d + eo;
    const target = Math.min(1.8, Math.max(0.55, Math.sqrt((this.sIn + 1e-7) / (this.sOut + 1e-7)))), g0 = this.g, g1 = g0 + (target - g0) * (final ? 1 : 0.25);
    for (let i = 0; i < chunk.length; i++) chunk[i] *= g0 + (g1 - g0) * (i / chunk.length);
    this.g = g1; this.done++;
    if (this.done - this.base > 64) { this.inE.splice(0, 32); this.base += 32; }
    return chunk;
  }
  process(y, final) {
    const all = new Float32Array(this.pend.length + y.length); all.set(this.pend, 0); all.set(y, this.pend.length);
    const out = new Float32Array(all.length - (final ? 0 : all.length % this.bs)); let o = 0;
    for (; o + this.bs <= out.length; o += this.bs) out.set(this._block(all.slice(o, o + this.bs), false), o);
    if (final && o < out.length) out.set(this._block(all.slice(o), true), o);
    this.pend = final ? new Float32Array(0) : all.slice(out.length);
    return out;
  }
}

/** Pitch + tone, then the radio effect when asked, then the level match. Same push / finish protocol as the cleaning streams. */
export class VoiceStream {
  constructor({ pitch = 0, tone = 0, radio = false } = {}) {
    this.stages = [new PitchStream({ pitch, tone })]; if (radio) this.stages.push(new RadioStream());
    this.lm = pitch === 0 && tone === 0 && !radio ? null : new LevelMatch();
  }
  async push(x) { if (this.lm) this.lm.feed(x); let y = x; for (const s of this.stages) y = await s.push(y); return this.lm ? this.lm.process(y, false) : y; }
  async finish() {
    let tail = new Float32Array(0);
    for (const s of this.stages) {
      const a = tail.length ? await s.push(tail) : new Float32Array(0), b = await s.finish();
      tail = new Float32Array(a.length + b.length); tail.set(a, 0); tail.set(b, a.length);
    }
    return this.lm ? this.lm.process(tail, true) : tail;
  }
  close() { }
}
