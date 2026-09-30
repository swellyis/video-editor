// Extract the audio of a video / audio file as a stand-alone audio file (M4A, WAV or Opus/Ogg). Streamed through Mediabunny's
// Conversion: packets are copied when the codec can go straight into the container (AAC -> M4A: no decoding at all, so an
// hour-long recording takes seconds), otherwise decoded and encoded in small pieces, never the whole file in memory.
// The picture is never touched, so a video whose picture this browser can't decode (HEVC/H.265 on a laptop without the codec)
// can still give its sound.
import { loadMediabunny } from './media.js';
import { politeSlicer, yieldToMain } from './util.js';

export class ExtractCancelled extends Error { constructor() { super('Extraction cancelled'); this.name = 'ExtractCancelled'; } }
export class ExtractError extends Error { constructor(code, msg) { super(msg); this.name = 'ExtractError'; this.code = code; } }

const CHUNK = 512 * 1024; // small writes to disk: an 8 MB write stalls a throttled phone's main thread for over a second
export const STALL_MS = 45000;
export const PLAN_MS = 15000; // reading the file header must never take longer than this
const withTimeout = (pr, ms, make) => new Promise((res, rej) => { const t = setTimeout(() => rej(make()), ms); pr.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
 // no progress at all for this long = give up with a clear message (never hang silently)

/**
 * Work out what to write. Returns { fmt: 'm4a'|'wav'|'opus', copy: bool, codec, ext, mime } or throws ExtractError:
 *   code 'noaudio'  = the file has no audio track
 *   code 'unreadable' = there is one, but this browser can't decode it (and it can't be copied into the chosen container)
 */
export async function planExtract(blob, want = 'auto') {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    let track;
    try { track = await input.getPrimaryAudioTrack(); }
    catch (e) { throw new ExtractError('unreadable', 'This file can’t be read by your browser.'); }
    if (!track) throw new ExtractError('noaudio', 'This video has no audio.');
    const canDec = await track.canDecode().catch(() => false);
    const info = { codec: track.codec, sampleRate: track.sampleRate, channels: track.numberOfChannels, duration: await track.computeDuration().catch(() => null), canDecode: canDec };
    const enc = async (c) => mb.canEncodeAudio(c, { numberOfChannels: Math.min(2, track.numberOfChannels || 2), sampleRate: track.sampleRate || 48000, bitrate: 192000 }).catch(() => false);
    const P = {
      m4a: { fmt: 'm4a', ext: 'm4a', mime: 'audio/mp4' }, wav: { fmt: 'wav', ext: 'wav', mime: 'audio/wav' }, opus: { fmt: 'opus', ext: 'ogg', mime: 'audio/ogg' },
    };
    const tryM4a = async () => (track.codec === 'aac' ? { ...P.m4a, copy: true, codec: 'aac' } : canDec && await enc('aac') ? { ...P.m4a, copy: false, codec: 'aac' } : null);
    const tryOpus = async () => (canDec && await enc('opus') ? { ...P.opus, copy: false, codec: 'opus' } : null);
    const tryWav = () => (canDec ? { ...P.wav, copy: false, codec: 'pcm-s16' } : null);
    let plan = null, note = '';
    if (want === 'wav') plan = tryWav();
    else if (want === 'opus') plan = await tryOpus();
    else if (want === 'm4a') plan = await tryM4a();
    else plan = (await tryM4a()) || (await tryOpus()) || tryWav();
    if (!plan && want !== 'auto') { plan = (await tryM4a()) || (await tryOpus()) || tryWav(); if (plan) note = 'This browser can’t make that format, so it made ' + plan.fmt.toUpperCase() + ' instead.'; }
    if (!plan) throw new ExtractError('unreadable', 'This audio format can’t be read by your browser' + (track.codec ? ' (' + track.codec + ')' : '') + '.');
    return { ...plan, note, info };
  } finally { try { input.dispose && input.dispose(); } catch { /* ignore */ } }
}

/**
 * options: { format, trim: {start,end} (source seconds), onProgress(frac), signal, makeSink(ext, plan) -> sink (see exporter.createSink) or null for memory, stallMs, planMs }
 * Resolves { blob, ext, mime, plan, streamed }.
 */
export async function extractAudio(blob, options = {}) {
  const { format = 'auto', trim, onProgress, signal, makeSink, stallMs = STALL_MS } = options;
  if (signal && signal.aborted) throw new ExtractCancelled();
  const plan = await withTimeout(planExtract(blob, format), options.planMs || PLAN_MS, () => new ExtractError('stalled', 'Reading this file took too long (it may be damaged or too large for this device).'));
  if (signal && signal.aborted) throw new ExtractCancelled();
  const mb = await loadMediabunny();
  const sink = makeSink ? await makeSink(plan.ext, plan) : null;
  const streamed = !!(sink && sink.writable);
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const fmtObj = plan.fmt === 'wav' ? new mb.WavOutputFormat() : plan.fmt === 'opus' ? new mb.OggOutputFormat() : new mb.Mp4OutputFormat({ fastStart: streamed ? false : 'in-memory' });
  const output = new mb.Output({ format: fmtObj, target: streamed ? new mb.StreamTarget(sink.writable, { chunked: true, chunkSize: CHUNK }) : new mb.BufferTarget() });
  let conversion = null, watchdog = null, stalled = false, cancelled = false;
  const cleanup = async (ok) => {
    clearTimeout(watchdog);
    try { input.dispose && input.dispose(); } catch { /* ignore */ }
    if (!ok && sink) { try { await sink.abort(); } catch { /* ignore */ } }
  };
  const onAbort = () => { cancelled = true; conversion && conversion.cancel().catch(() => { }); };
  signal && signal.addEventListener('abort', onAbort);
  const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { stalled = true; conversion && conversion.cancel().catch(() => { }); }, stallMs); };
  try {
    if (plan.copy) { // AAC into M4A: copy the packets ourselves, yielding to the page every few ms (no decoding, no long tasks)
      const track = await input.getPrimaryAudioTrack();
      const psink = new mb.EncodedPacketSink(track);
      const src = new mb.EncodedAudioPacketSource(track.codec);
      output.addAudioTrack(src);
      const meta = { decoderConfig: await track.getDecoderConfig() };
      const dur = plan.info.duration || 0;
      const t0 = trim && Number.isFinite(trim.start) ? Math.max(0, trim.start) : 0, t1 = trim && Number.isFinite(trim.end) ? trim.end : Infinity;
      await output.start();
      const slice = politeSlicer(8);
      let first = true, n = 0, lastReport = 0;
      const first0 = (await psink.getFirstPacket({ metadataOnly: true }).catch(() => null));
      const base = first0 ? Math.min(0, first0.timestamp) : 0;
      kick(); onProgress && onProgress(0);
      const start = t0 > 0 ? (await psink.getPacket(t0).catch(() => null)) || undefined : undefined;
      for await (const pk of psink.packets(start)) {
        if (cancelled || (signal && signal.aborted)) throw new ExtractCancelled();
        if (pk.timestamp >= t1) break;
        if (pk.timestamp + (pk.duration || 0) <= t0) continue;
        await src.add(t0 > 0 || base < 0 ? pk.clone({ timestamp: Math.max(0, pk.timestamp - t0 - base) }) : pk, first ? meta : undefined);
        first = false; n++;
        await slice(); kick();
        const now = performance.now();
        if (dur && now - lastReport > 120) { lastReport = now; const end = Math.min(t1, dur); onProgress && onProgress(Math.min(0.99, Math.max(0, (pk.timestamp - t0) / Math.max(0.01, end - t0)))); }
      }
      if (cancelled || (signal && signal.aborted)) throw new ExtractCancelled();
      if (!n) throw new ExtractError('empty', 'No audio was found in the selected part.');
      clearTimeout(watchdog);
      src.close(); await output.finalize();
      onProgress && onProgress(1);
      const out = streamed ? await sink.finish() : new Blob([output.target.buffer], { type: plan.mime });
      if (!out || !out.size) throw new ExtractError('empty', 'No audio was produced.');
      await cleanup(true);
      return { blob: out.type ? out : new Blob([out], { type: plan.mime }), ext: plan.ext, mime: plan.mime, plan, streamed: streamed ? sink.kind : null };
    }
    const audio = plan.copy ? {} : { codec: plan.codec, ...(plan.fmt === 'wav' ? {} : { bitrate: 192000 }) };
    if (plan.fmt !== 'wav' && !plan.copy && plan.info.channels > 2) audio.numberOfChannels = 2;
    const opts = { input, output, video: { discard: true }, audio, showWarnings: false };
    if (trim && Number.isFinite(trim.start) && Number.isFinite(trim.end) && trim.end > trim.start && (trim.start > 0.001 || (plan.info.duration && trim.end < plan.info.duration - 0.05))) opts.trim = { start: Math.max(0, trim.start), end: trim.end };
    conversion = await mb.Conversion.init(opts);
    if (!conversion.isValid) {
      const why = (conversion.discardedTracks || []).find(d => d.reason !== 'discarded_by_user');
      throw new ExtractError('unreadable', 'This audio format can’t be read by your browser' + (why ? ' (' + why.reason.replace(/_/g, ' ') + ')' : '') + '.');
    }
    let last = 0;
    conversion.onProgress = (f) => { kick(); if (f > last) last = f; onProgress && onProgress(Math.min(1, last)); };
    kick(); onProgress && onProgress(0);
    await conversion.execute();
    clearTimeout(watchdog);
    if (cancelled) throw new ExtractCancelled();
    onProgress && onProgress(1);
    const out = streamed ? await sink.finish() : new Blob([output.target.buffer], { type: plan.mime });
    if (!out || !out.size) throw new ExtractError('empty', 'No audio was produced.');
    await cleanup(true);
    return { blob: out.type ? out : new Blob([out], { type: plan.mime }), ext: plan.ext, mime: plan.mime, plan, streamed: streamed ? sink.kind : null };
  } catch (e) {
    await cleanup(false);
    if (cancelled || (e && (e.name === 'ConversionCanceledError' || e.name === 'ExtractCancelled'))) {
      if (stalled && !cancelled) throw new ExtractError('stalled', 'Extraction stopped making progress (the file may be damaged or its audio can’t be decoded). Nothing was saved.');
      throw new ExtractCancelled();
    }
    if (stalled) throw new ExtractError('stalled', 'Extraction stopped making progress (the file may be damaged or its audio can’t be decoded). Nothing was saved.');
    if (e instanceof ExtractError) throw e;
    throw new ExtractError('failed', 'Could not extract the audio: ' + (e && e.message || e));
  } finally { signal && signal.removeEventListener('abort', onAbort); }
}

/**
 * Audio-only export of the whole timeline (what "Export video" would sound like, without the picture): the same chunked mixer the
 * video export uses (speed, fades, volume envelopes, ducking, music, voiceover), encoded to M4A (AAC), Opus (.ogg) or WAV.
 * options: { format: 'auto'|'m4a'|'opus'|'wav', onProgress(frac, text), signal, makeSink(ext) }
 */
export async function exportTimelineAudio(project, media, options = {}) {
  const { format = 'auto', onProgress, signal, makeSink } = options;
  const { layout } = await import('./model.js');
  const { mixChunks, hasAudio } = await import('./audio.js');
  const mb = await loadMediabunny();
  const lay = layout(project);
  if (!hasAudio(project, lay)) throw new ExtractError('noaudio', 'There is no audible sound on the timeline (everything is muted, silent or has no audio).');
  const enc = (c) => mb.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 }).catch(() => false);
  let fmt = format;
  if (fmt === 'auto' || fmt === 'm4a') fmt = (await enc('aac')) ? 'm4a' : (await enc('opus')) ? 'opus' : 'wav';
  if (fmt === 'opus' && !(await enc('opus'))) fmt = 'wav';
  const P = { m4a: { ext: 'm4a', mime: 'audio/mp4', codec: 'aac' }, opus: { ext: 'ogg', mime: 'audio/ogg', codec: 'opus' }, wav: { ext: 'wav', mime: 'audio/wav', codec: 'pcm-s16' } }[fmt];
  const sink = makeSink ? await makeSink(P.ext) : null;
  const streamed = !!(sink && sink.writable);
  const output = new mb.Output({
    format: fmt === 'wav' ? new mb.WavOutputFormat() : fmt === 'opus' ? new mb.OggOutputFormat() : new mb.Mp4OutputFormat({ fastStart: streamed ? false : 'in-memory' }),
    target: streamed ? new mb.StreamTarget(sink.writable, { chunked: true, chunkSize: CHUNK }) : new mb.BufferTarget(),
  });
  const src = new mb.AudioBufferSource(fmt === 'wav' ? { codec: P.codec } : { codec: P.codec, bitrate: 192000 });
  output.addAudioTrack(src);
  const warns = [];
  let gen = null;
  try {
    await output.start();
    gen = mixChunks(project, lay, media, { onWarn: (m) => { warns.push(m); options.onWarn && options.onWarn(m); } });
    let done = 0;
    for await (const chunk of gen) {
      if (signal && signal.aborted) throw new ExtractCancelled();
      await src.add(chunk);
      done += chunk.duration;
      onProgress && onProgress(Math.min(0.98, done / Math.max(0.01, lay.total)));
      await yieldToMain();
    }
    if (signal && signal.aborted) throw new ExtractCancelled();
    src.close(); await output.finalize();
    const out = streamed ? await sink.finish() : new Blob([output.target.buffer], { type: P.mime });
    onProgress && onProgress(1);
    return { blob: out.type ? out : new Blob([out], { type: P.mime }), ext: P.ext, mime: P.mime, fmt, duration: lay.total, warns, streamed: streamed ? sink.kind : null };
  } catch (e) {
    try { gen && await gen.return(); } catch { /* ignore */ }
    try { await output.cancel(); } catch { /* ignore */ }
    if (sink) { try { await sink.abort(); } catch { /* ignore */ } }
    if (e instanceof ExtractCancelled || e instanceof ExtractError) throw e;
    throw new ExtractError('failed', 'Could not export the audio: ' + (e && e.message || e));
  }
}
