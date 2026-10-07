// Multi-angle (pure, no DOM): 2-4 recordings of the same moment (lined up by sound with the Sync engine, or by where they already sit)
// become ONE stretch of the main track that can switch between the angles. Every piece is an ordinary video clip (clip.mc = { g, a }),
// so the preview and the export draw it exactly like any other clip, and it stays editable (trim, split, effects, transitions).
// The group (project.multicams[]) remembers each angle's file and where its footage sits in group time; the sound comes from one chosen
// angle as audio-track segment(s) (audio.mcAudio = group id) that are rebuilt from the pieces after every multi-angle edit.
import { layout, newAudio, normalizeClip, splitAt, NAME_MAX, MIN_CLIP } from './model.js';
import { uid } from './util.js';

export const MIN_ANGLES = 2, MAX_ANGLES = 4, MIN_LEN = 1;
const EPS = 0.002;
const r3 = (v) => Math.round(v * 1000) / 1000;
const listOf = (p, type) => (type === 'clip' ? p.clips : type === 'overlay' ? p.overlays || [] : []);

/** Can this item be an angle? Video clips and video overlays at normal speed, played forwards. */
export function angleOk(type, item) {
  if (!item || (type !== 'clip' && type !== 'overlay')) return { ok: false, reason: 'Only video clips and video overlays can be angles.' };
  if (item.kind !== 'video') return { ok: false, reason: '“' + (item.name || 'This item') + '” is a picture, not a video.' };
  if (item.ramp || item.reverse) return { ok: false, reason: '“' + (item.name || 'This clip') + '” has a speed curve or Reverse. Switch it back to normal first.' };
  if ((item.speed || 1) !== 1) return { ok: false, reason: '“' + (item.name || 'This clip') + '” plays at ' + item.speed + '×. Set it back to 1× first.' };
  if (item.mc) return { ok: false, reason: '“' + (item.name || 'This clip') + '” is already part of a multi-angle clip.' };
  return { ok: true };
}
/** Resolve a selection into angle items (in selection order) or a plain-language refusal. */
export function anglesOf(project, sel) {
  const lay = layout(project), out = [];
  for (const s of sel || []) {
    const item = listOf(project, s.type).find(x => x.id === s.id); if (!item) continue;
    const ok = angleOk(s.type, item); if (!ok.ok) return { fail: true, reason: ok.reason };
    const start = s.type === 'clip' ? lay.items.find(it => it.clip.id === item.id).start : item.start;
    out.push({ type: s.type, id: item.id, item, start });
  }
  if (out.length < MIN_ANGLES) return { fail: true, reason: 'Select 2 to 4 videos of the same moment (clips or overlays), then group them.' };
  if (out.length > MAX_ANGLES) return { fail: true, reason: 'A multi-angle clip takes at most 4 angles. Select fewer.' };
  return { angles: out };
}
/**
 * Where the angles overlap in time. `starts[k]` = the timeline second at which angle k's trimmed start (its `in`) plays when all angles are
 * lined up (from Sync, or the current positions). Returns { len, bases[k] } where bases[k] is angle k's source second at group time 0.
 */
export function planGroup(angles, starts) {
  let A = -Infinity, B = Infinity;
  angles.forEach((g, k) => { const it = g.item; A = Math.max(A, starts[k]); B = Math.min(B, starts[k] + (it.out - it.in)); });
  const len = B - A;
  if (!(len >= MIN_LEN)) return { fail: true, reason: len > 0 ? 'The angles overlap for only ' + len.toFixed(1) + ' s. Use recordings of the same moment.' : 'These recordings don’t overlap in time once lined up, so there is nothing to switch between.' };
  return { len: r3(len), offset: A, bases: angles.map((g, k) => r3(g.item.in + (A - starts[k]))) };
}

/**
 * Group the selected angles: they are replaced by one main-track clip (angle 1 to start with) where the first selected main clip was
 * (or at the end of the main track when they are all overlays), and the sound of angle `audio` goes on its own track.
 * Returns { group, clip } or { fail, reason }.
 */
export function createGroup(project, sel, starts, { audio = 0, name } = {}) {
  const r = anglesOf(project, sel); if (r.fail) return r;
  const { angles } = r; const pl = planGroup(angles, starts); if (pl.fail) return pl;
  if (!Array.isArray(project.multicams)) project.multicams = [];
  const g = uid('mc'), n = (name || 'Multi-angle ' + (project.multicams.length + 1)).slice(0, NAME_MAX);
  const group = {
    id: g, name: n, audio: Math.max(0, Math.min(angles.length - 1, audio | 0)),
    angles: angles.map((x, k) => ({ mediaId: x.item.mediaId, name: (x.item.name || 'Angle ' + (k + 1)).slice(0, NAME_MAX), base: pl.bases[k], srcDuration: x.item.srcDuration, width: x.item.width, height: x.item.height, hasAudio: x.item.hasAudio !== false })),
  };
  if (!group.angles[group.audio].hasAudio) { const k = group.angles.findIndex(a => a.hasAudio); group.audio = k >= 0 ? k : group.audio; }
  // where it goes: the first selected main clip's place (it inherits that clip's look), else the end of the main track
  const mains = angles.filter(x => x.type === 'clip').map(x => project.clips.indexOf(x.item)).sort((a, b) => a - b);
  const tpl = mains.length ? project.clips[mains[0]] : null, a0 = angles[0].item;
  const clip = normalizeClip({
    ...(tpl ? JSON.parse(JSON.stringify(tpl)) : {}), id: uid('clip'), kind: 'video', mediaId: a0.mediaId, name: n, srcDuration: a0.srcDuration,
    width: a0.width, height: a0.height, hasAudio: a0.hasAudio !== false, in: pl.bases[0], out: r3(pl.bases[0] + pl.len), speed: 1, muted: true, keyframes: {},
    mc: { g, a: 0 },
  });
  delete clip.ramp; delete clip.reverse;
  const at = mains.length ? mains[0] : project.clips.length;
  if (tpl) { clip.gap = tpl.gap || 0; clip.transition = { ...tpl.transition }; }
  // the angles leave the timeline (their files stay in the group)
  const ids = new Set(angles.map(x => x.id));
  project.overlays = (project.overlays || []).filter(o => !ids.has(o.id));
  for (const x of angles.filter(y => y.type === 'clip')) { const i = project.clips.indexOf(x.item); if (i >= 0) project.clips.splice(i, 1); }
  project.clips.splice(Math.min(at, project.clips.length), 0, clip);
  project.multicams.push(group);
  rebuildAudio(project, g);
  return { group, clip };
}

export const groupOf = (project, g) => (project.multicams || []).find(x => x.id === g) || null;
/** Main-track pieces of a group, in timeline order (layout items). */
export const piecesOf = (project, g, lay = layout(project)) => lay.items.filter(it => it.clip.mc && it.clip.mc.g === g);
/** Group seconds that a piece plays. */
export function spanOfPiece(G, c) { const b = G.angles[c.mc.a].base; return { g0: c.in - b, g1: c.out - b }; }

/** Show another angle in one piece (same place, same length). Returns { ok } or { fail, reason }. */
export function setAngle(project, clipId, a) {
  const c = project.clips.find(x => x.id === clipId); if (!c || !c.mc) return { fail: true, reason: 'Select a multi-angle clip first.' };
  const G = groupOf(project, c.mc.g); if (!G) return { fail: true, reason: 'This multi-angle clip lost its group.' };
  const A = G.angles[a]; if (!A) return { fail: true, reason: 'There is no angle ' + (a + 1) + ' in this clip.' };
  if (c.mc.a === a) return { ok: true, same: true };
  const { g0, g1 } = spanOfPiece(G, c), inA = r3(A.base + g0), outA = r3(A.base + g1);
  if (inA < -EPS || outA > A.srcDuration + EPS) return { fail: true, reason: 'Angle ' + (a + 1) + ' (' + A.name + ') has no footage for this part.' };
  Object.assign(c, { mediaId: A.mediaId, srcDuration: A.srcDuration, width: A.width, height: A.height, hasAudio: A.hasAudio, in: Math.max(0, inA), out: Math.min(A.srcDuration, outA) });
  c.mc = { g: G.id, a };
  return { ok: true };
}
/**
 * Switch angle at timeline second `t`: the piece under `t` is split there and the part after it shows angle `a` (near the start of a
 * piece the whole piece switches). Neighbouring pieces that end up showing the same angle continuously are joined again.
 * Returns { ok, clip } or { fail, reason }.
 */
export function switchAt(project, t, a) {
  const lay = layout(project), it = lay.items.find(x => t >= x.start - 1e-6 && t < x.end - 1e-6 && x.clip.mc);
  if (!it) return { fail: true, reason: 'The playhead is not on a multi-angle clip.' };
  if (it.clip.mc.a === a) return { ok: true, same: true, clip: it.clip.id };
  let target = it.clip;
  if (t - it.start >= MIN_CLIP && it.end - t >= MIN_CLIP) { const b = splitAt(project, t); if (!b) return { fail: true, reason: 'Could not split here.' }; target = b; }
  else if (it.end - t < MIN_CLIP) return { ok: true, same: true, clip: it.clip.id };
  const r = setAngle(project, target.id, a); if (r.fail) { tidy(project, it.clip.mc.g); return r; }
  tidy(project, it.clip.mc.g);
  return { ok: true, clip: target.id };
}
const sameLook = (x, y) => { const strip = (c) => { const o = { ...c }; for (const k of ['id', 'in', 'out', 'name', 'keyframes', 'gap', 'transition', 'fadeIn', 'fadeOut']) delete o[k]; return JSON.stringify(o); }; return strip(x) === strip(y); };
const noKeys = (c) => !c.keyframes || !Object.values(c.keyframes).some(v => v && v.length);
/** Join neighbouring pieces of a group that show the same angle back to back (left by switching back and forth). */
export function tidy(project, g) {
  for (let i = project.clips.length - 2; i >= 0; i--) {
    const x = project.clips[i], y = project.clips[i + 1];
    if (!x.mc || !y.mc || x.mc.g !== g || y.mc.g !== g || x.mc.a !== y.mc.a) continue;
    if ((y.gap || 0) > 1e-6 || (y.transition && y.transition.type !== 'cut') || Math.abs(y.in - x.out) > EPS || !noKeys(x) || !noKeys(y) || !sameLook(x, y)) continue;
    x.out = y.out; x.fadeOut = y.fadeOut; project.clips.splice(i + 1, 1);
  }
}

/** The sound segments the group should have: one per run of pieces that play on without a jump (timeline and group time both continuous). */
export function expectedAudio(project, g, lay = layout(project)) {
  const G = groupOf(project, g); if (!G) return [];
  const A = G.angles[G.audio]; if (!A || !A.hasAudio) return [];
  const out = [];
  for (const it of piecesOf(project, g, lay)) {
    const c = it.clip, { g0, g1 } = spanOfPiece(G, c), sp = c.speed || 1;
    let s = { start: r3(it.start), in: r3(A.base + g0), out: r3(A.base + g1), speed: sp };
    if (s.in < 0) { s.start = r3(s.start - s.in / sp); s.in = 0; }
    if (s.out > A.srcDuration) s.out = r3(A.srcDuration);
    if (s.out - s.in < 0.02) continue;
    const l = out[out.length - 1];
    if (l && l.speed === sp && Math.abs(l.out - s.in) < EPS && Math.abs(l.start + (l.out - l.in) / l.speed - s.start) < EPS) l.out = s.out; else out.push(s);
  }
  return out;
}
const segsOf = (project, g) => (project.audio || []).filter(a => a.mcAudio === g).sort((x, y) => x.start - y.start);
/** Does the group's sound still match its pieces? (false after e.g. a ripple delete moved some pieces) */
export function audioInSync(project, g) {
  const want = expectedAudio(project, g), have = segsOf(project, g), G = groupOf(project, g);
  if (want.length !== have.length) return false;
  return want.every((w, i) => { const h = have[i]; return h.mediaId === G.angles[G.audio].mediaId && Math.abs(h.start - w.start) < EPS && Math.abs(h.in - w.in) < EPS && Math.abs(h.out - w.out) < EPS && Math.abs((h.speed || 1) - w.speed) < 1e-6; });
}
/** Replace the group's sound track(s) with segments that match the pieces (keeps the volume / Clean voice settings of the old track). */
export function rebuildAudio(project, g) {
  const G = groupOf(project, g); if (!G) return 0;
  const old = segsOf(project, g), keep = old[0], A = G.angles[G.audio];
  const lane = keep && Number.isInteger(keep.lane) ? keep.lane : undefined;
  project.audio = (project.audio || []).filter(a => a.mcAudio !== g);
  const want = expectedAudio(project, g);
  for (const w of want) {
    const a = newAudio({ id: A.mediaId, duration: A.srcDuration, name: A.name }, w.start);
    Object.assign(a, {
      name: (G.name + ' · sound (' + A.name + ')').slice(0, NAME_MAX), in: w.in, out: w.out, srcDuration: A.srcDuration, speed: w.speed,
      volume: keep ? keep.volume : 1, muted: keep ? !!keep.muted : false, fadeIn: 0.02, fadeOut: 0.02, duck: false, loop: false, voice: true, keyframes: {}, mcAudio: g,
    });
    if (keep && keep.mediaId === A.mediaId) { if (keep.clean) a.clean = JSON.parse(JSON.stringify(keep.clean)); if (keep.change) a.change = JSON.parse(JSON.stringify(keep.change)); }
    if (lane !== undefined) a.lane = lane;
    project.audio.push(a);
  }
  return want.length;
}
/** Take the sound from another angle. */
export function setAudioSource(project, g, a) {
  const G = groupOf(project, g); if (!G || !G.angles[a]) return { fail: true, reason: 'There is no such angle.' };
  if (!G.angles[a].hasAudio) return { fail: true, reason: 'Angle ' + (a + 1) + ' (' + G.angles[a].name + ') has no sound.' };
  G.audio = a; rebuildAudio(project, g); return { ok: true };
}
/** Count how long each angle is on screen (seconds), for the summary line. */
export function angleTimes(project, g) {
  const G = groupOf(project, g); if (!G) return [];
  const t = G.angles.map(() => 0); for (const it of piecesOf(project, g)) t[it.clip.mc.a] += it.len; return t.map(r3);
}
/** Drop groups with no pieces left on the main track (and their sound). */
export function prune(project) {
  const live = new Set(project.clips.filter(c => c.mc).map(c => c.mc.g));
  const gone = (project.multicams || []).filter(G => !live.has(G.id)).map(G => G.id);
  if (!gone.length) return 0;
  project.multicams = project.multicams.filter(G => live.has(G.id));
  project.audio = (project.audio || []).filter(a => !gone.includes(a.mcAudio));
  return gone.length;
}
