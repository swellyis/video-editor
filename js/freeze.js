// Freeze frame: split the clip at the playhead and put a still image (the frame at that moment) between the halves.
// Pure model code (no DOM): the app captures the frame, imports it as an image and calls insertFreeze().
import { layout, clipAt, splitAt, sourceTime, newClipFromMedia, MIN_CLIP, animated, hasMotion } from './model.js';

export const FREEZE_DEFAULT = 2, FREEZE_MIN = 0.5, FREEZE_MAX = 30;
const deepClone = (o) => JSON.parse(JSON.stringify(o));
export const freezeLen = (n) => { n = Number(n); return Number.isFinite(n) ? Math.min(FREEZE_MAX, Math.max(FREEZE_MIN, Math.round(n * 10) / 10)) : FREEZE_DEFAULT; };

/** Which clip / source second a freeze at timeline time t would use, or a reason it cannot be done. */
export function freezeTarget(project, t) {
  const it = clipAt(layout(project), t);
  if (!it) return { fail: 'Move the playhead onto a video clip to freeze a frame.' };
  if (it.clip.kind === 'image') return { fail: 'This is already a still image. Make it longer in its properties instead.' };
  return { it, srcTime: sourceTime(it, Math.min(t, it.end - 0.001)) };
}

/**
 * Insert a freeze (an image clip made from `imageMedia`, `dur` seconds long) at timeline time t.
 * Inside a clip it is split in two with the freeze between the halves; at a clip's first/last 0.1 s it goes
 * before/after it with no split. Returns { freeze, left, right } or { fail }.
 */
export function insertFreeze(project, t, imageMedia, dur) {
  const tg = freezeTarget(project, t);
  if (tg.fail) return tg;
  const { it } = tg, c = it.clip;
  dur = freezeLen(dur);
  const f = newClipFromMedia(imageMedia, project.settings);
  f.out = f.in + dur; f.name = 'Freeze · ' + (c.name || 'clip');
  // the freeze looks like the clip it was taken from
  for (const k of ['fit', 'bg', 'opacity']) f[k] = c[k];
  for (const k of ['color', 'fx', 'blur']) if (c[k]) f[k] = deepClone(c[k]);
  const local = t - it.start;
  // Hold the exact pose of that moment: keyframed position / size / rotation / opacity are baked into the still's base
  // transform (it has no keyframes of its own), and a Ken Burns move stops where it was (kbFrom = kbTo = progress at t).
  const at = Math.min(Math.max(0, local), Math.max(0, it.len - 1e-6));
  f.transform = deepClone(c.transform || f.transform);
  if (hasMotion(c)) {
    const A = animated('clip', c, at);
    Object.assign(f.transform, { x: A.x, y: A.y, zoom: Math.max(0.05, A.scale), angle: A.rotation });
    f.opacity = A.opacity;
  }
  const kb = f.transform.kenBurns;
  if (kb && kb !== 'none') {
    const k0 = f.transform.kbFrom ?? 0, k1 = f.transform.kbTo ?? 1, m = k0 + (k1 - k0) * (it.len > 0 ? Math.min(1, Math.max(0, at / it.len)) : 0);
    f.transform.kbFrom = m; f.transform.kbTo = m;
  } else f.transform.kenBurns = 'none';
  f.keyframes = {}; f.fadeIn = 0; f.fadeOut = 0; f.gap = 0;
  let idx;
  if (local < MIN_CLIP) { idx = it.index; f.gap = c.gap || 0; c.gap = 0; project.clips.splice(idx, 0, f); return { freeze: f, left: null, right: c }; }
  if (it.end - t < MIN_CLIP) { idx = it.index + 1; project.clips.splice(idx, 0, f); return { freeze: f, left: c, right: null }; }
  const b = splitAt(project, t);
  if (!b) return { fail: 'Move the playhead inside the clip to freeze a frame.' };
  b.transition = { type: 'cut', duration: c.transition.duration };
  project.clips.splice(project.clips.indexOf(c) + 1, 0, f);
  return { freeze: f, left: c, right: b };
}
