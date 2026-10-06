// Sample a clip's video, run face detection, write pan/zoom keyframes. Progress + cancel.
import { seekVideo } from './media.js';
import { layout, clipLen, sourceTime } from './model.js';
import { buildReframe, resolveTarget, ReframeCancelled, DEFAULTS } from './reframe.js';
import { loadFaceDetector, detectFaces, FACE_MB, isFaceCached } from './face.js';

export { FACE_MB, isFaceCached, ReframeCancelled, DEFAULTS, resolveTarget };

/**
 * Sample faces along a clip. getBlob() → Blob of the source video.
 * onProgress({ phase, frac, t, i, n })
 * signal: AbortSignal
 */
export async function sampleClipFaces(clip, getBlob, {
  sampleSec = DEFAULTS.sampleSec, mode = 'short', onProgress, signal, maxSamples = 400,
} = {}) {
  if (signal && signal.aborted) throw new ReframeCancelled();
  const blob = await getBlob();
  if (!blob) throw new Error('This clip’s video file is missing on this device. Relink it first.');
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('Could not open the video for face tracking.'));
      setTimeout(() => rej(new Error('Timed out opening the video.')), 30000);
    });
    const sw = v.videoWidth || clip.width || 1280, sh = v.videoHeight || clip.height || 720;
    // Keyframe times are CLIP time (seconds from the clip's start on the timeline); each one samples the source frame that is
    // shown then: trim (in/out), speed, reverse and speed ramps all go through the same mapping as playback (sourceTime).
    const dur = Math.max(0.1, clipLen(clip));
    const srcAt = (local) => sourceTime({ clip, start: 0 }, local);
    const step = Math.max(0.15, sampleSec);
    const times = [];
    for (let t = 0; t <= dur + 1e-6; t += step) times.push(Math.min(dur, t));
    if (times[times.length - 1] < dur - 0.05) times.push(dur);
    if (times.length > maxSamples) {
      const keep = [times[0]];
      const stride = (times.length - 1) / (maxSamples - 1);
      for (let i = 1; i < maxSamples - 1; i++) keep.push(times[Math.round(i * stride)]);
      keep.push(times[times.length - 1]);
      times.length = 0; times.push(...keep);
    }
    onProgress && onProgress({ phase: 'download', frac: 0 });
    const det = await loadFaceDetector({
      mode,
      onProgress: (p) => onProgress && onProgress({ phase: p.phase, frac: (p.frac || 0) * 0.15 }),
    });
    const canvas = document.createElement('canvas');
    // Downscale for speed; BlazeFace uses 128² internally anyway.
    const maxEdge = 640;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    canvas.width = Math.max(2, Math.round(sw * scale));
    canvas.height = Math.max(2, Math.round(sh * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const samples = [];
    const n = times.length;
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) throw new ReframeCancelled();
      const local = times[i];
      const srcT = srcAt(local);
      try { await seekVideo(v, Math.min(Math.max(0, srcT), Math.max(0, v.duration - 0.05)), 6000); } catch { /* keep prior frame */ }
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      let faces = [];
      try { faces = await detectFaces(det, canvas); } catch (e) { console.warn('face detect', e); }
      samples.push({ t: local, src: srcT, faces });
      onProgress && onProgress({ phase: 'detect', frac: 0.15 + 0.85 * ((i + 1) / n), t: local, i: i + 1, n });
    }
    return { samples, sw, sh, dur };
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute('src'); try { v.load(); } catch { /* */ }
  }
}

/**
 * Run auto reframe on one clip: detect → build keyframes → mutate clip.
 * opts.target: '9:16'|'1:1'|'4:5'|'16:9'|'project'
 * opts.setProjectRatio: if true and target is a known ratio, set project.settings.ratio + fit cover
 */
export async function autoReframeClip(project, clip, getBlob, opts = {}) {
  const { samples, sw, sh } = await sampleClipFaces(clip, getBlob, opts);
  // the run takes a while: if the clip left the project (deleted, another project opened) don't write into a detached copy
  if (opts.stillValid && !opts.stillValid()) { const e = new ReframeCancelled(); e.stale = true; throw e; }
  const built = buildReframe(samples, sw, sh, opts.target || 'project', { ...opts, projectRatio: project && project.settings && project.settings.ratio, transform: clip.transform });
  const { applyReframeToClip } = await import('./reframe.js');
  const info = applyReframeToClip(clip, built.keyframes, { setFit: opts.setFit !== false });
  if (opts.setProjectRatio && built.target && built.target.key && built.target.key !== 'custom') {
    project.settings.ratio = built.target.key;
    if (project.settings.fit === 'contain') project.settings.fit = 'cover';
  }
  return { ...built, ...info, sw, sh, layout: layout(project) };
}

/** Apply reframe to every main-timeline video clip (used after Shorts create). */
export async function autoReframeProject(project, getBlobFor, opts = {}) {
  const results = [];
  const clips = (project.clips || []).filter(c => c.kind !== 'image' && c.mediaId);
  let i = 0;
  for (const c of clips) {
    const r = await autoReframeClip(project, c, () => getBlobFor(c), {
      ...opts,
      onProgress: (p) => opts.onProgress && opts.onProgress({ ...p, clip: i, clips: clips.length, frac: (i + (p.frac || 0)) / Math.max(1, clips.length) }),
    });
    results.push(r); i++;
  }
  return results;
}
