// Signal processing for "Clean voice": everything here is plain JavaScript that runs in the worker (and in tests).
//  - FFT:        mixed-radix complex FFT (the 960-point frame of the Strong model is not a power of two)
//  - Resampler:  streaming windowed-sinc sample-rate converter (any source rate -> 48 kHz), no seams between chunks
//  - RnStream:   RNNoise (WebAssembly) on 48 kHz audio, 10 ms frames, with an optional share of the original kept in
//  - DfStream:   streaming STFT -> neural network (DPDFNet, ONNX) -> inverse STFT, state carried across the whole file
// Every stream takes any number of samples at a time (push) and hands back the same total number of samples (finish),
// time-aligned with the input, so a one-hour file is processed in small pieces with flat memory.

export const SR = 48000;

/** Mixed-radix FFT (any N whose factors are small): complex in, complex out, forward = e^{-i...}. */
export class FFT {
  constructor(n) {
    this.n = n; this.cos = new Float64Array(n); this.sin = new Float64Array(n);
    for (let k = 0; k < n; k++) { const a = (-2 * Math.PI * k) / n; this.cos[k] = Math.cos(a); this.sin[k] = Math.sin(a); }
    this.factors = []; let m = n;
    for (const p of [2, 3, 5, 7]) while (m % p === 0) { this.factors.push(p); m /= p; }
    if (m > 1) this.factors.push(m);
    this.tr = new Float64Array(Math.max(...this.factors, 2)); this.ti = new Float64Array(this.tr.length);
  }
  /** out may not alias in. */
  forward(inRe, inIm, outRe, outIm) { this._rec(inRe, inIm, 0, 1, outRe, outIm, 0, this.n, 0); }
  _rec(xr, xi, off, stride, or, oi, oo, n, level) {
    if (n === 1) { or[oo] = xr[off]; oi[oo] = xi[off]; return; }
    const p = this.factors[level], m = n / p;
    for (let r = 0; r < p; r++) this._rec(xr, xi, off + r * stride, stride * p, or, oi, oo + r * m, m, level + 1);
    const N = this.n, step = N / n, pstep = N / p, c = this.cos, s = this.sin, tr = this.tr, ti = this.ti;
    for (let k = 0; k < m; k++) {
      for (let r = 0; r < p; r++) {
        const re = or[oo + r * m + k], im = oi[oo + r * m + k];
        const w = (r * k * step) % N, wc = c[w], ws = s[w];
        tr[r] = re * wc - im * ws; ti[r] = re * ws + im * wc;
      }
      for (let q = 0; q < p; q++) {
        let sr = tr[0], si = ti[0];
        for (let r = 1; r < p; r++) {
          const w = ((r * q) % p) * pstep, wc = c[w], ws = s[w];
          sr += tr[r] * wc - ti[r] * ws; si += tr[r] * ws + ti[r] * wc;
        }
        or[oo + q * m + k] = sr; oi[oo + q * m + k] = si;
      }
    }
  }
}

export const vorbisWindow = (n) => {
  const w = new Float32Array(n), half = n / 2;
  for (let i = 0; i < n; i++) { const s = Math.sin(0.5 * Math.PI * (i + 0.5) / half); w[i] = Math.sin(0.5 * Math.PI * s * s); }
  return w;
};

/** Streaming band-limited resampler (windowed sinc, 24 taps per side). push() returns what is ready, finish() the rest. */
export class Resampler {
  constructor(srcRate, dstRate = SR, taps = 24) {
    this.src = srcRate; this.dst = dstRate; this.taps = taps; this.ratio = srcRate / dstRate;
    this.cut = Math.min(1, dstRate / srcRate); // low-pass when going down
    this.buf = new Float32Array(0); this.base = 0; // buf holds source samples [base, base+buf.length)
    this.nOut = 0; this.nIn = 0; this.same = srcRate === dstRate;
  }
  _blackman(x) { return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x); } // x in [-1, 1]
  _gen(final) {
    const T = this.taps, out = []; let o = this.nOut;
    for (;; o++) {
      const pos = o * this.ratio; // source position of output sample o
      const i0 = Math.floor(pos);
      if (!final && i0 + T + 1 >= this.base + this.buf.length) break;
      if (final && o >= Math.round(this.nIn / this.ratio)) break;
      let acc = 0;
      for (let j = i0 - T + 1; j <= i0 + T; j++) {
        const k = j - this.base; if (k < 0 || k >= this.buf.length) continue;
        const d = pos - j, a = d * this.cut;
        const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
        acc += this.buf[k] * sinc * this._blackman(d / T);
      }
      out.push(acc * this.cut);
    }
    this.nOut = o;
    const keepFrom = Math.max(this.base, Math.floor(o * this.ratio) - T - 2);
    if (keepFrom > this.base) { this.buf = this.buf.slice(keepFrom - this.base); this.base = keepFrom; }
    return Float32Array.from(out);
  }
  push(x) {
    if (this.same) { this.nIn += x.length; this.nOut += x.length; return x; }
    const nb = new Float32Array(this.buf.length + x.length); nb.set(this.buf); nb.set(x, this.buf.length); this.buf = nb; this.nIn += x.length;
    return this._gen(false);
  }
  finish() { return this.same ? new Float32Array(0) : this._gen(true); }
}

/** Growable float buffer with an absolute start index. */
class Ring {
  constructor() { this.a = new Float32Array(1 << 16); this.n = 0; this.base = 0; }
  append(x) {
    if (this.n + x.length > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + x.length)); b.set(this.a.subarray(0, this.n)); this.a = b; }
    this.a.set(x, this.n); this.n += x.length;
  }
  get end() { return this.base + this.n; }
  at(i) { return this.a[i - this.base]; }
  dropBefore(i) { const k = Math.min(this.n, Math.max(0, i - this.base)); if (k > 0) { this.a.copyWithin(0, k, this.n); this.n -= k; this.base += k; } }
  take(from, to) { const o = this.a.slice(from - this.base, to - this.base); return o; }
}

/**
 * Base of the two engines. A model answers `D` samples late; this class hands out the answer re-aligned with the input
 * (output sample j belongs to input sample j), mixes a share `dry` of the untouched signal back in, and makes sure the
 * total output length equals the total input length once finish() has flushed the delay.
 */
class Aligned {
  constructor(D, dry) { this.D = D; this.dry = Math.max(0, Math.min(1, dry || 0)); this.x = new Ring(); this.y = new Ring(); this.emitted = 0; this.total = 0; }
  _take(final) {
    const limit = final ? this.total : Math.min(this.total, this.y.end - this.D);
    if (limit <= this.emitted) return new Float32Array(0);
    const out = this.y.take(this.emitted + this.D, limit + this.D);
    if (this.dry > 0) { const dr = this.x.take(this.emitted, limit); for (let i = 0; i < out.length; i++) out[i] = out[i] * (1 - this.dry) + dr[i] * this.dry; }
    this.emitted = limit; this.y.dropBefore(limit + this.D); this.x.dropBefore(Math.min(limit, this.consumed()));
    return out;
  }
  consumed() { return this.emitted; }
  async push(x) { this.total += x.length; this.x.append(x); await this._run(false); return this._take(false); }
  async finish() { await this._run(true); return this._take(true); }
}

/** RNNoise (BSD) on 48 kHz mono. It answers one 10 ms frame late. */
export class RnStream extends Aligned {
  constructor(mod, { dry = 0 } = {}) {
    super(480, dry);
    this.m = mod; this.st = mod._rnnoise_create(0); this.inP = mod._malloc(1920); this.outP = mod._malloc(1920); this.fed = 0; this.f = new Float32Array(480);
  }
  consumed() { return this.fed; }
  _one() {
    const m = this.m, i0 = this.inP >> 2, o0 = this.outP >> 2, f = this.f; let h = m.HEAPF32;
    for (let i = 0; i < 480; i++) h[i0 + i] = f[i] * 32768;
    m._rnnoise_process_frame(this.st, this.outP, this.inP);
    h = m.HEAPF32; const out = new Float32Array(480);
    for (let i = 0; i < 480; i++) out[i] = h[o0 + i] / 32768;
    this.y.append(out);
  }
  async _run(final) {
    while (this.x.end - this.fed >= 480) { for (let i = 0; i < 480; i++) this.f[i] = this.x.at(this.fed + i); this._one(); this.fed += 480; }
    if (final) {
      const tail = this.x.end - this.fed;
      if (tail > 0) { this.f.fill(0); for (let i = 0; i < tail; i++) this.f[i] = this.x.at(this.fed + i); this._one(); this.fed += 480; }
      this.f.fill(0);
      while (this.y.end < this.total + this.D) this._one();
    }
  }
  close() { try { this.m._rnnoise_destroy(this.st); this.m._free(this.inP); this.m._free(this.outP); } catch { /* ignore */ } }
}

/**
 * Streaming STFT -> network -> inverse STFT for DPDFNet (48 kHz, 960-point vorbis-window frames, hop 480, centred frames
 * with reflected edges). `model.init()` gives the starting state; `await model.run(spec, state)` takes the 481 complex bins of
 * ONE frame ([re, im] interleaved) and returns { spec, state }. The network looks 4 frames (1920 samples) ahead.
 */
export class DfStream extends Aligned {
  constructor(model, { dry = 0 } = {}) {
    super(1920, dry);
    this.N = 960; this.H = 480; this.K = 481; this.model = model; this.state = model.init();
    this.win = vorbisWindow(this.N); this.fft = new FFT(this.N);
    this.fr = new Float64Array(this.N); this.fi = new Float64Array(this.N); this.or = new Float64Array(this.N); this.oi = new Float64Array(this.N);
    this.acc = new Float32Array(this.N * 4); this.wacc = new Float32Array(this.N * 4); this.accBase = 0; // overlap-add buffers, absolute index = original sample index
    this.frame = 0; this.spec = new Float32Array(this.K * 2); this.nf = null;
  }
  consumed() { return Math.max(0, (this.frame - 1) * this.H); }
  _get(idx, n) {
    if (idx >= 0 && idx < this.x.end) return this.x.at(idx);
    if (idx >= 0 && this.frame >= (this.nf || Infinity)) return 0; // beyond the signal in the flush frames
    if (n != null && n < 2) return n === 1 ? this.x.at(0) : 0;
    let j = idx < 0 ? -idx : 2 * ((n == null ? this.x.end : n) - 1) - idx; // mirror the edge (what a centred STFT does)
    if (n != null) while (j < 0 || j >= n) { if (j < 0) j = -j; if (j >= n) j = 2 * (n - 1) - j; }
    return j >= 0 && j < this.x.end ? this.x.at(j) : 0;
  }
  async _frameStep(n) {
    const { N, H, K, win, fr, fi } = this, i = this.frame, start = i * H - N / 2;
    for (let k = 0; k < N; k++) { fr[k] = this._get(start + k, n) * win[k]; fi[k] = 0; }
    this.fft.forward(fr, fi, this.or, this.oi);
    const sp = this.spec;
    for (let k = 0; k < K; k++) { sp[2 * k] = this.or[k]; sp[2 * k + 1] = this.oi[k]; }
    const r = await this.model.run(sp, this.state);
    this.state = r.state;
    const e = r.spec, or = this.or, oi = this.oi;
    // inverse real FFT through a forward FFT of the conjugate (Hermitian-extended) spectrum
    for (let k = 0; k < K; k++) { fr[k] = e[2 * k]; fi[k] = -e[2 * k + 1]; }
    fi[0] = 0; fi[K - 1] = 0;
    for (let k = 1; k < K - 1; k++) { fr[N - k] = e[2 * k]; fi[N - k] = e[2 * k + 1]; }
    this.fft.forward(fr, fi, or, oi);
    // overlap-add at original index start .. start+N
    const need = start + N - this.accBase;
    if (need > this.acc.length) { const L = Math.max(need, this.acc.length * 2); const a = new Float32Array(L), w = new Float32Array(L); a.set(this.acc); w.set(this.wacc); this.acc = a; this.wacc = w; }
    for (let k = 0; k < N; k++) {
      const p = start + k - this.accBase; if (p < 0) continue;
      this.acc[p] += (or[k] / N) * win[k]; this.wacc[p] += win[k] * win[k];
    }
    this.frame++;
    // everything before frame*H - ... is now complete: original index < (frame-1)*H + ... ; see class notes
    const done = (this.frame - 1) * H; // samples < done are covered by all their frames
    const from = Math.max(this.accBase, this.y.end), to = done;
    if (to > from) {
      const out = new Float32Array(to - from);
      for (let j = from; j < to; j++) { const w = this.wacc[j - this.accBase]; out[j - from] = this.acc[j - this.accBase] / (w > 1e-8 ? w : 1); }
      this.y.append(out);
    }
    const cut = done - this.accBase;
    if (cut > N * 2) { this.acc.copyWithin(0, cut); this.wacc.copyWithin(0, cut); this.acc.fill(0, this.acc.length - cut); this.wacc.fill(0, this.wacc.length - cut); this.accBase = done; }
  }
  async _run(final) {
    const { H } = this;
    if (!final) {
      for (;;) {
        const i = this.frame, need = i * H + H + (i === 0 ? 1 : 0); // frame i reads up to sample i*H + 479 (frame 0 also the mirrored 480)
        if (this.x.end < need) break;
        await this._frameStep(null);
      }
      return;
    }
    const n = this.total; if (n === 0) return;
    this.nf = 1 + Math.floor(n / H);
    while (this.y.end < n + this.D) await this._frameStep(n);
  }
}
