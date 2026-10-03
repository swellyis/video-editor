// Sync, the scan: reads one recording's sound in 10-second pieces (never the whole file) and keeps only a loudness envelope of the voice band
// (300-3400 Hz), 200 values per second. An hour is 720,000 numbers (about 3 MB). The sound is decoded by the browser; the arithmetic is small,
// so this runs on the page in small steps with progress and a Cancel that works at any moment.
import { RATE } from './sync.js';

const PIECE_SEC = 10;
const tick = () => new Promise(r => setTimeout(r, 0));
export class SyncCancelled extends Error { constructor() { super('Cancelled'); this.name = 'SyncCancelled'; } }

/** dB envelope of `blob`'s sound between source seconds `from` and `to`: Float32Array, RATE values per second, starting at `from`. */
export async function scanEnvelope(blob, name, duration, from, to, { signal, onProgress } = {}) {
  const { SourceReader } = await import('./audio.js');
  const reader = await new SourceReader(blob, name, duration).open();
  try {
    const sr = reader.sr, win = Math.max(1, Math.round(sr / RATE)), n = Math.max(1, Math.floor((to - from) * RATE));
    const out = new Float32Array(n).fill(-100);
    // voice band: one-pole high-pass ~300 Hz then two one-pole low-passes ~3.4 kHz (cheap and enough for an envelope)
    const hp = Math.exp(-2 * Math.PI * 300 / sr), lp = 1 - Math.exp(-2 * Math.PI * 3400 / sr);
    let hx = 0, hy = 0, l1 = 0, l2 = 0;
    const s0 = Math.round(from * sr), per = Math.round(PIECE_SEC * RATE), t0 = Date.now();
    let i = 0;
    while (i < n) {
      if (signal && signal.aborted) throw new SyncCancelled();
      const take = Math.min(n - i, per), chans = await reader.read(s0 + i * win, take * win), nc = chans.length;
      for (let w = 0; w < take; w++) {
        let sum = 0; const a = w * win;
        for (let k = a; k < a + win; k++) {
          let x = 0; for (let c = 0; c < nc; c++) x += chans[c][k]; x /= nc;
          const y = hp * (hy + x - hx); hx = x; hy = y;
          l1 += lp * (y - l1); l2 += lp * (l1 - l2);
          sum += l2 * l2;
        }
        out[i + w] = 10 * Math.log10(sum / win + 1e-10);
      }
      i += take;
      const frac = i / n, el = (Date.now() - t0) / 1000;
      onProgress && onProgress({ frac, etaSec: frac > 0.02 ? el * (1 - frac) / frac : null });
      await tick();
    }
    return out;
  } finally { try { reader.close(); } catch { /* ignore */ } }
}
