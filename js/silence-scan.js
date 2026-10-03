// Remove silences, the scan: reads one recording's sound in short pieces (never the whole file) and makes a loudness curve,
// one value per 20 ms. An hour of sound is 180,000 numbers. Decoding is done by the browser's own audio decoder and the arithmetic
// is a few multiplications per sample, so this runs on the page in small steps (it gives way to the screen between pieces) with
// progress, an estimate of the time left, and a Cancel that works at any moment.
import { HOP, toDb } from './silence.js';

const PIECE_SEC = 10;
const tick = () => new Promise(r => setTimeout(r, 0));
export class ScanCancelled extends Error { constructor() { super('Cancelled'); this.name = 'ScanCancelled'; } }

/**
 * Loudness curve of `blob`'s sound between source seconds `from` and `to`.
 * Returns { db: Float32Array, t0, hop, sr, pieces }. Level = 10*log10(mean of the square, over the channels), in dB below full scale.
 */
export async function scanLoudness(blob, name, duration, from, to, { signal, onProgress } = {}) {
  const { SourceReader } = await import('./audio.js');
  const reader = await new SourceReader(blob, name, duration).open();
  try {
    const sr = reader.sr, win = Math.max(1, Math.round(HOP * sr)), n = Math.max(1, Math.ceil((to - from) / HOP));
    const db = new Float32Array(n).fill(-120);
    const t0 = Date.now();
    let i = 0, pieces = 0;
    const s0 = Math.round(from * sr);
    while (i < n) {
      if (signal && signal.aborted) throw new ScanCancelled();
      const take = Math.min(n - i, Math.round(PIECE_SEC / HOP));
      const chans = await reader.read(s0 + i * win, take * win);
      for (let w = 0; w < take; w++) {
        let sum = 0; const a = w * win;
        for (let c = 0; c < chans.length; c++) { const d = chans[c]; let s = 0; for (let k = a; k < a + win; k++) s += d[k] * d[k]; sum += s; }
        db[i + w] = toDb(sum / (win * chans.length));
      }
      i += take; pieces++;
      const frac = i / n, el = (Date.now() - t0) / 1000;
      onProgress && onProgress({ frac, etaSec: frac > 0.02 ? el * (1 - frac) / frac : null });
      await tick();
    }
    return { db, t0: from, hop: HOP, sr, pieces };
  } finally { try { reader.close(); } catch { /* ignore */ } }
}
