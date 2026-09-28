// Offline audio mixing for export: clip audio (with speed, fades, transitions) + music (with ducking).
import { clipGain, musicGain, speechIntervals, audioLen } from './model.js';
import { loadMediabunny } from './media.js';

const decoded = new Map();

async function decodeWithMediabunny(blob) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(await track.canDecode())) return null;
  const sink = new mb.AudioBufferSink(track);
  const parts = []; let len = 0, sr = 48000, ch = 1;
  for await (const { buffer } of sink.buffers()) { parts.push(buffer); len += buffer.length; sr = buffer.sampleRate; ch = Math.max(ch, buffer.numberOfChannels); }
  if (!len) return null;
  const out = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
  let off = 0;
  for (const b of parts) { for (let c = 0; c < ch; c++) out.copyToChannel(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), c, off); off += b.length; }
  return out;
}

export async function decodeMedia(media, id) {
  if (decoded.has(id)) return decoded.get(id);
  const p = (async () => {
    const rec = await media.get(id);
    if (!rec) return null;
    try {
      const ac = new OfflineAudioContext(2, 1, 48000);
      return await ac.decodeAudioData(await rec.blob.arrayBuffer());
    } catch (e) {
      try { return await decodeWithMediabunny(rec.blob); } catch (e2) { console.warn('Audio decode failed for', rec.name, e2); return null; }
    }
  })();
  decoded.set(id, p);
  const r = await p;
  if (!r) decoded.delete(id);
  return r;
}
export function clearDecodedCache() { decoded.clear(); }

/** WSOLA time-stretch (pitch preserving). speed>1 = faster/shorter. */
export function timeStretch(channels, sr, speed) {
  const inLen = channels[0].length;
  const outLen = Math.max(1, Math.floor(inLen / speed));
  const N = Math.round(sr * 0.046) & ~1, Hs = N >> 1, Ha = Hs * speed, tol = Math.round(sr * 0.010);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const outs = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const ref = channels[0];
  let prevA = 0;
  const DEC = 8, STEP = 3;
  for (let k = 0; ; k++) {
    const s = k * Hs; if (s >= outLen) break;
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const nat = prevA + Hs; let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += STEP) {
        const a = nominal + d; if (a < 0 || a + N >= inLen) continue;
        let c = 0; for (let i = 0; i < N; i += DEC) c += ref[a + i] * (ref[nat + i] || 0);
        if (c > bestC) { bestC = c; best = a; }
      }
    }
    best = Math.max(0, Math.min(best, inLen - 1));
    for (let ci = 0; ci < channels.length; ci++) {
      const inp = channels[ci], out = outs[ci];
      for (let i = 0; i < N; i++) { const x = inp[best + i]; if (x === undefined) break; out[s + i] += x * win[i]; }
    }
    for (let i = 0; i < N; i++) norm[s + i] += win[i];
    prevA = best;
  }
  for (const out of outs) for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return outs.map(o => o.subarray(0, outLen));
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

/** Returns AudioBuffer (stereo, 48k) of the full mix, or null if the sequence has no audio. */
export async function mixAudio(project, lay, media, { sampleRate = 48000, onStatus } = {}) {
  const total = lay.total;
  const hasClipAudio = lay.items.some(it => it.clip.kind === 'video' && it.clip.hasAudio && !it.clip.muted && it.clip.volume > 0);
  const music = project.audio.filter(a => a.volume > 0 && a.start < total);
  if (!hasClipAudio && !music.length) return null;
  const len = Math.max(1, Math.ceil(total * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const speech = speechIntervals(lay);
  let n = 0;
  for (const it of lay.items) {
    const c = it.clip;
    if (c.kind !== 'video' || !c.hasAudio || c.muted || c.volume <= 0) continue;
    onStatus && onStatus('Decoding audio ' + (++n) + '…');
    const buf = await decodeMedia(media, c.mediaId);
    if (!buf) continue;
    const sr = buf.sampleRate;
    const a0 = Math.floor(c.in * sr), a1 = Math.min(buf.length, Math.ceil(c.out * sr));
    if (a1 <= a0) continue;
    let chans = [];
    for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) chans.push(buf.getChannelData(ch).subarray(a0, a1));
    if (Math.abs(c.speed - 1) > 1e-3) chans = timeStretch(chans, sr, c.speed);
    const seg = ctx.createBuffer(chans.length, chans[0].length, sr);
    chans.forEach((d, i) => seg.copyToChannel(d, i));
    const src = ctx.createBufferSource(); src.buffer = seg;
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    applyEnvelope(g.gain, it.start, it.end, (t) => clipGain(it, t));
    src.start(it.start, 0);
    src.stop(it.end);
  }
  for (const a of music) {
    onStatus && onStatus('Decoding music…');
    const buf = await decodeMedia(media, a.mediaId);
    if (!buf) continue;
    const l = Math.min(audioLen(a), total - a.start);
    if (l <= 0) continue;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    applyEnvelope(g.gain, a.start, a.start + l, (t) => musicGain(a, t, speech, total));
    src.start(a.start, a.in, l);
  }
  onStatus && onStatus('Mixing audio…');
  return await ctx.startRendering();
}
