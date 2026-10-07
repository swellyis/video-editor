// Auto Shorts: loudness of the spoken sound along the timeline (for the "emphatic delivery" points). Streams the mix in 30 s pieces at
// 8 kHz mono, so an hour-long recording never sits in memory; one number per `step` seconds. Cancel works between pieces.
import { layout } from './model.js';

export class ScanCancelled extends Error { constructor() { super('Cancelled'); this.name = 'ScanCancelled'; } }
const tick = () => new Promise(r => setTimeout(r, 0));

/** { step, values: Float32Array of RMS per step } for the timeline's speech (clips, voice tracks; not music). onProgress(frac, doneSec, totalSec). */
export async function energyEnvelope({ project, media, step = 0.5, signal, onProgress = () => { } }) {
  const { mixChunks } = await import('./audio.js'); // (loaded only when needed: it pulls in the media decoders)
  const proj = { ...project, audio: (project.audio || []).filter(a => a.voice) };
  const lay = layout(proj), SR = 8000, per = Math.round(SR * step);
  const values = new Float32Array(Math.ceil(lay.total / step) + 1);
  let idx = 0, done = 0;
  for await (const b of mixChunks(proj, lay, media, { sampleRate: SR, chunkSec: 30 })) {
    if (signal && signal.aborted) throw new ScanCancelled();
    const a = b.getChannelData(0), c = b.numberOfChannels > 1 ? b.getChannelData(1) : null, n = b.length;
    for (let s = 0; s < n; s += per) {
      let sum = 0; const e = Math.min(n, s + per);
      for (let k = s; k < e; k++) { const v = c ? (a[k] + c[k]) / 2 : a[k]; sum += v * v; }
      if (idx < values.length) values[idx++] = Math.sqrt(sum / Math.max(1, e - s));
    }
    done += n / SR; onProgress(Math.min(1, done / Math.max(1, lay.total)), done, lay.total);
    await tick();
  }
  return { step, values };
}
