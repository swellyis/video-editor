// Snap to beat, the scan: reads one music item's sound in 10-second pieces (never the whole file) and keeps only an "onset strength" curve,
// 200 values per second (an hour is 720,000 numbers, about 3 MB): how much new sound starts at each moment, in a low band (kick, bass) and a
// high band (hats, snare, clicks, plucks). The sound is decoded by the browser; the arithmetic is small and runs in small steps with a Cancel.
import { ORATE } from './beat.js';

const PIECE_SEC = 10;
const GATE = 4;   // dB: smaller rises are noise, not onsets
const tick = () => new Promise(r => setTimeout(r, 0));
export class BeatCancelled extends Error { constructor() { super('Cancelled'); this.name = 'BeatCancelled'; } }

/** Streaming onset meter: feed mono samples (any chunk sizes) with push(); it appends one value per 1/ORATE s to `out`. */
export class OnsetMeter {
  constructor(sr) {
    this.sr = sr; this.frame = 0; this.pos = 0; this.edge = Math.round(sr / ORATE);   // frame f ends at sample round((f + 1) * sr / ORATE): exact rate even if sr / ORATE is not whole
    // low band: two one-pole low-passes at ~180 Hz; high band: one-pole high-pass at ~2 kHz (cheap, enough for onsets)
    this.lpA = 1 - Math.exp(-2 * Math.PI * 180 / sr); this.hpA = Math.exp(-2 * Math.PI * 2000 / sr);
    this.ring = new Float64Array(8); this.l1 = 0; this.l2 = 0; this.hx = 0; this.hy = 0; this.el = 0; this.eh = 0; this.k = 0;
    const F = -60; this.pl = F; this.ph = F; this.pl2 = F; this.ph2 = F; this.floor = F;
  }
  /** x: Float32Array of mono samples; returns an array of the onset values completed by this chunk. */
  push(x) {
    const out = [], { lpA, hpA, floor } = this;
    let { l1, l2, hx, hy, el, eh, k, pos, edge, frame } = this;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      l1 += lpA * (v - l1); l2 += lpA * (l1 - l2);
      const y = hpA * (hy + v - hx); hx = v; hy = y;
      el += l2 * l2; eh += y * y;
      k++; pos++;
      if (pos >= edge) {
        // loudness over the last 4 frames (20 ms): steady tones that beat against each other do not flicker, a hit still shows at once
        const R = this.ring, j = frame & 3; R[j] = el / k; R[4 + j] = eh / k;
        const dl = Math.max(floor, 10 * Math.log10((R[0] + R[1] + R[2] + R[3]) / 4 + 1e-10)), dh = Math.max(floor, 10 * Math.log10((R[4] + R[5] + R[6] + R[7]) / 4 + 1e-10));
        if (frame === 0) { this.pl = this.pl2 = dl; this.ph = this.ph2 = dh; }   // no onset out of the start-up of the filters
        out.push(Math.max(0, dl - Math.max(this.pl, this.pl2) - GATE) + Math.max(0, dh - Math.max(this.ph, this.ph2) - GATE));
        this.pl2 = this.pl; this.ph2 = this.ph; this.pl = dl; this.ph = dh; el = 0; eh = 0; k = 0; frame++; edge = Math.round((frame + 1) * this.sr / ORATE);
      }
    }
    this.l1 = l1; this.l2 = l2; this.hx = hx; this.hy = hy; this.el = el; this.eh = eh; this.k = k; this.pos = pos; this.edge = edge; this.frame = frame;
    return out;
  }
}

/** Onset strength of `blob`'s sound between source seconds `from` and `to`: Float32Array, ORATE values per second, starting at `from`. */
export async function scanOnsets(blob, name, duration, from, to, { signal, onProgress } = {}) {
  const { SourceReader } = await import('./audio.js');
  const reader = await new SourceReader(blob, name, duration).open();
  try {
    const sr = reader.sr, at = (f) => Math.round(f * sr / ORATE), n = Math.max(1, Math.floor((to - from) * ORATE));
    const out = new Float32Array(n), meter = new OnsetMeter(sr);
    const s0 = Math.round(from * sr), per = Math.round(PIECE_SEC * ORATE), t0 = Date.now();
    let i = 0;
    while (i < n) {
      if (signal && signal.aborted) throw new BeatCancelled();
      const take = Math.min(n - i, per), want = at(i + take) - at(i), chans = await reader.read(s0 + at(i), want), nc = chans.length;
      let mono = chans[0];
      if (nc > 1) { mono = new Float32Array(chans[0].length); for (let c = 0; c < nc; c++) for (let k = 0; k < mono.length; k++) mono[k] += chans[c][k] / nc; }
      const vals = meter.push(mono.subarray(0, want));
      for (let k = 0; k < vals.length && i + k < n; k++) out[i + k] = vals[k];
      i += take;
      const frac = i / n, el = (Date.now() - t0) / 1000;
      onProgress && onProgress({ frac, etaSec: frac > 0.02 ? el * (1 - frac) / frac : null });
      await tick();
    }
    return out;
  } finally { try { reader.close(); } catch { /* ignore */ } }
}
