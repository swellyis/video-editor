// Cut to beat (pure maths, no DOM): re-time or cut the chosen main-track clips so their joins land on the beats of a music item, and
// optionally put a short transition on each join that lands on a beat. The music and the other lanes never move. Every change is made
// on the project object; the caller commits once, so one Undo reverses the whole thing.
import { layout, clipLen, MIN_CLIP, splitAt, setItemStart, rebaseKeyframes, hasKeyframes, overlayLen } from './model.js';
import * as RAMP from './ramp.js';
import { isOverlap, isDip, MAX_DUR, MIN_DUR } from './transitions.js';
import { timelineBeats } from './beat.js';

export const EVERY = [
  { id: 1, label: 'Every beat' }, { id: 2, label: 'Every 2 beats' }, { id: 4, label: 'Every bar (4 beats)' }, { id: 16, label: 'Every 4 bars' },
];
export const LENGTHS = [
  { id: 'q', label: '¼ beat', beats: 0.25 }, { id: 'h', label: '½ beat', beats: 0.5 }, { id: 'b', label: '1 beat', beats: 1 },
  { id: 's25', label: '0.25 s', sec: 0.25 }, { id: 's5', label: '0.5 s', sec: 0.5 }, { id: 's1', label: '1 s', sec: 1 },
];
export const MODES = ['retime', 'cut', 'transitions'];
export const TOL = 0.03;          // a join this close to a beat counts as "on the beat" (about one frame at 30 fps)
const EPS = 1e-4, MIN_X = 0.05;   // shortest transition worth adding
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Median gap between neighbouring beats (seconds); 0.5 when there are too few. */
export function beatPeriod(beats) {
  if (!beats || beats.length < 2) return 0.5;
  const d = []; for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
  d.sort((a, b) => a - b); return d[d.length >> 1] || 0.5;
}
/** Every `every`-th beat, counted from the first beat at or after `from` (timeline seconds). */
export function beatGrid(beats, every = 1, from = 0) {
  const n = Math.max(1, Math.round(every) || 1), out = [];
  let i0 = 0; while (i0 < beats.length && beats[i0] < from - TOL) i0++;
  for (let i = i0; i < beats.length; i += n) out.push(beats[i]);
  return out;
}
/** Transition length in seconds for a LENGTHS id at a beat period. */
export function transitionLength(id, period) {
  const L = LENGTHS.find(l => l.id === id) || LENGTHS[1];
  return clamp(L.sec != null ? L.sec : L.beats * period, MIN_DUR, MAX_DUR);
}
/** The beats (timeline seconds) of an audio item that has been analysed; [] otherwise. */
export const musicBeats = (item) => timelineBeats(item);
const nearest = (grid, t) => { let best = null, bd = Infinity; for (const g of grid) { const d = Math.abs(g - t); if (d < bd) { bd = d; best = g; } } return { g: best, d: bd }; };

// ---------------------------------------------------------------- clip lengths and handles
const isImg = (c) => c.kind === 'image';
const srcEnd = (c) => (c.srcDuration > 0 ? c.srcDuration : isImg(c) ? 3600 : c.out);
/** Longest the clip can play on the timeline from where it starts now (a speed curve can only get shorter). */
export function maxLenOf(c) {
  if (isImg(c)) return srcEnd(c) - c.in;
  if (c.ramp) return clipLen(c);
  const sp = c.speed || 1; return c.reverse ? c.out / sp : (srcEnd(c) - c.in) / sp;
}
/** Spare footage after the clip's end / before its start, in timeline seconds. */
export function tailRoom(c) { if (isImg(c)) return srcEnd(c) - c.out; if (c.ramp) return 0; const sp = c.speed || 1; return Math.max(0, c.reverse ? c.in / sp : (srcEnd(c) - c.out) / sp); }
export function headRoom(c) { if (isImg(c)) return Infinity; if (c.ramp) return 0; const sp = c.speed || 1; return Math.max(0, c.reverse ? (srcEnd(c) - c.out) / sp : c.in / sp); }
/** Set how long the clip plays, keeping its start (the end moves). */
export function setLen(c, len) {
  len = Math.max(MIN_CLIP, len);
  if (isImg(c)) { c.out = r3(Math.min(srcEnd(c), c.in + len)); return; }
  if (c.ramp) { const s = RAMP.sourceAtOffset(c, len), mn = MIN_CLIP * RAMP.meanSpeed(c); if (c.reverse) c.in = clamp(s, 0, c.out - mn); else c.out = clamp(s, c.in + mn, srcEnd(c)); return; }
  const sp = c.speed || 1;
  if (c.reverse) c.in = Math.max(0, c.out - len * sp); else c.out = Math.min(srcEnd(c), c.in + len * sp);
}
/** Start the clip `d` seconds earlier (d < 0: later) showing the same picture after its old start; keyframes stay on their moments. */
export function moveHead(c, d) {
  if (Math.abs(d) < 1e-9) return;
  if (isImg(c)) c.out = Math.max(c.in + MIN_CLIP, c.out + d);
  else { const sp = c.speed || 1; if (c.reverse) c.out = clamp(c.out + d * sp, c.in + MIN_CLIP * sp, srcEnd(c)); else c.in = clamp(c.in - d * sp, 0, c.out - MIN_CLIP * sp); }
  if (hasKeyframes(c)) c.keyframes = rebaseKeyframes(c.keyframes, -d);
}
const snap = (c) => ({ in: c.in, out: c.out, transition: { ...c.transition }, keyframes: c.keyframes });
const restore = (c, s) => { c.in = s.in; c.out = s.out; c.transition = s.transition; c.keyframes = s.keyframes; };

/** Where the join after main item i sits: the middle of an overlap transition, otherwise the clip's end. */
export function cutOf(lay, i) {
  const it = lay.items[i], nx = lay.items[i + 1];
  return nx && nx.xIn > 0 ? it.end - nx.xIn / 2 : it.end;
}
const inCutOf = (lay, i) => (i > 0 && !(lay.items[i].clip.gap > 1e-6) ? cutOf(lay, i - 1) : lay.items[i].start);

/** Move the join after clip `idx` to `target` by changing that clip's length (iterative, overlap caps included). */
function solveEnd(project, idx, target, maxLen) {
  const c = project.clips[idx];
  for (let k = 0; k < 10; k++) {
    const lay = layout(project), it = lay.items[idx], err = target - cutOf(lay, idx);
    if (Math.abs(err) < EPS) return true;
    const len = it.len + err;
    if (len < MIN_CLIP - 1e-9 || len > maxLen + 1e-6) return false;
    setLen(c, len);
  }
  return Math.abs(target - cutOf(layout(project), idx)) < 0.002;
}

/**
 * Cut to beat. `list` = [{ type, id }] (empty: every main clip), `music` = the audio item whose beats are used, `opts` =
 * { mode: 'retime' | 'cut' | 'transitions', every: 1 | 2 | 4 | 16, fitPhotos, transition: { type, length (LENGTHS id) } | null }.
 * Changes the project in place and returns a report: { ok, reason?, grid, period, retimed, splits, transitions, onBeat, joins, skipped: [{ name, reason }] }.
 */
export function cutToBeat(project, list, music, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : 'retime', every = EVERY.some(e => e.id === +opts.every) ? +opts.every : 1;
  const rep = { ok: false, mode, every, grid: 0, period: 0, retimed: 0, photos: 0, splits: 0, transitions: 0, onBeat: 0, joins: 0, overlays: 0, skipped: [] };
  const beats = music ? musicBeats(music) : [];
  if (beats.length < 2) { rep.reason = 'nobeats'; return rep; }
  const sel = Array.isArray(list) ? list : [];
  let ids = new Set(sel.filter(s => s.type === 'clip').map(s => s.id));
  if (!ids.size) ids = new Set(project.clips.map(c => c.id));
  const chosen = project.clips.filter(c => ids.has(c.id));
  if (!chosen.length && !sel.some(s => s.type === 'overlay')) { rep.reason = 'noclips'; return rep; }
  const lay0 = layout(project), first = lay0.items.find(it => ids.has(it.clip.id));
  const period = beatPeriod(beats), step = period * every;
  const grid = beatGrid(beats, every, first ? first.start : 0);
  rep.grid = grid.length; rep.period = period;
  if (!grid.length) { rep.reason = 'nogrid'; return rep; }
  const name = (c) => c.name || (isImg(c) ? 'Photo' : 'Clip');
  const skip = (c, reason) => rep.skipped.push({ id: c.id, name: name(c), reason });

  // 1. re-time (photos are always fitted in cut mode when asked) / cut at the beats
  if (mode !== 'transitions') {
    for (let idx = 0; idx < project.clips.length; idx++) {
      const c = project.clips[idx]; if (!ids.has(c.id)) continue;
      const lay = layout(project), it = lay.items[idx], inCut = inCutOf(lay, idx);
      const photoFit = isImg(c) && opts.fitPhotos;
      if (mode === 'cut' && !photoFit) {
        const lo = it.start + it.xIn + Math.max(MIN_CLIP * 2, 0.2), hi = it.end - it.xOut - Math.max(MIN_CLIP * 2, 0.2);
        const at = grid.filter(g => g > lo && g < hi).reverse();
        let n = 0; for (const g of at) { const piece = splitAt(project, g); if (piece) { ids.add(piece.id); rep.splits++; n++; } }
        idx += n; // the new pieces follow this clip and already start on beats
        continue;
      }
      const cands = grid.filter(g => g >= inCut + Math.max(MIN_CLIP, step * 0.5) - 1e-6);
      if (!cands.length) { skip(c, 'past the last beat of the music'); continue; }
      const cur = cutOf(lay, idx), ml = maxLenOf(c), s0 = snap(c);
      const order = photoFit ? [cands[0]] : cands.slice().sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur)).slice(0, 8);
      let done = false;
      for (const g of order) {
        if (Math.abs(g - cur) < EPS) { done = true; break; }
        if (solveEnd(project, idx, g, ml)) { done = true; rep.retimed++; if (isImg(c)) rep.photos++; break; }
        restore(c, s0);
      }
      if (!done) skip(c, isImg(c) ? 'could not be fitted' : c.ramp ? 'has a speed curve and is too short to reach a beat (curves can only be shortened)' : 'too short to reach the next beat');
    }
  }
  // 2. joins on the beat (both sides chosen)
  const onBeatJoins = () => {
    const lay = layout(project), out = [];
    for (let i = 1; i < lay.items.length; i++) {
      const P = lay.items[i - 1], N = lay.items[i];
      if (!ids.has(P.clip.id) || !ids.has(N.clip.id)) continue;
      rep.joins++;
      if (N.clip.gap > 1e-6) continue;
      const n = nearest(grid, cutOf(lay, i - 1)); if (n.d <= TOL + 1e-6) out.push({ id: N.clip.id, beat: n.g });
    }
    return out;
  };
  let joins = onBeatJoins(); rep.onBeat = joins.length;
  // 3. beat-aware transitions: the overlap is centred on the beat by using spare footage on both sides, so nothing after it moves
  const tr = opts.transition && opts.transition.type && opts.transition.type !== 'cut' ? opts.transition : null;
  if (tr) {
    { const lay = layout(project); lay.items.forEach((it) => { if (it.xIn > 0 && it.clip.transition.duration > it.xIn + 1e-9) it.clip.transition.duration = r3(it.xIn); }); } // freeze capped lengths (no visual change)
    const want = transitionLength(tr.length, period), overlap = isOverlap(tr.type), dip = isDip(tr.type);
    for (const j of joins) {
      const lay = layout(project), i = lay.items.findIndex(it => it.clip.id === j.id); if (i < 1) continue;
      const P = lay.items[i - 1], N = lay.items[i], B = j.beat, pc = P.clip, nc = N.clip, endN = N.end, total = lay.total;
      const coreP = B - (P.start + P.xIn), coreN = (N.end - N.xOut) - B;
      let a = 0, b = 0;
      if (overlap) {
        const x = Math.min(want, coreP, coreN, MAX_DUR), roomP = (P.end - B) + tailRoom(pc), roomN = (B - N.start) + headRoom(nc);
        b = Math.max(0, Math.min(x / 2, roomP)); a = Math.max(0, Math.min(x / 2, roomN));
        if (b < x / 2) a = Math.max(0, Math.min(x - b, roomN, coreP));
        if (a < x / 2) b = Math.max(0, Math.min(x - a, roomP, coreN));
        if (a + b < MIN_X) { skip(nc, roomP + roomN < MIN_X ? 'no spare footage around the cut for a transition' : 'too short for a transition'); continue; }
      }
      const sP = snap(pc), sN = snap(nc);
      setLen(pc, P.len + (B + b - P.end));
      moveHead(nc, N.start - (B - a));
      const keepAudio = nc.transition && nc.transition.audio === 'cut' ? { audio: 'cut' } : {};
      if (overlap) nc.transition = { type: tr.type, duration: r3(a + b), ...keepAudio };
      else if (dip) nc.transition = { type: tr.type, duration: r3(Math.min(want, coreP * 2, coreN * 2, MAX_DUR)) };
      const l2 = layout(project), N2 = l2.items[i];
      const fine = Math.abs(N2.end - endN) < 0.002 && Math.abs(l2.total - total) < 0.002 && Math.abs(l2.items[i - 1].end - (B + b)) < 0.002 && Math.abs(N2.start - (B - a)) < 0.002 && (!overlap || N2.xIn > MIN_X - 1e-6);
      if (!fine) { restore(pc, sP); restore(nc, sN); skip(nc, 'the transition would not fit here'); continue; }
      rep.transitions++;
    }
  }
  // 4. overlays in the selection: start on the nearest beat; photos last one beat step when "fit photos" is on
  for (const s of sel) {
    if (s.type !== 'overlay') continue;
    const o = project.overlays.find(x => x.id === s.id); if (!o) continue;
    const n = nearest(beats, o.start); if (n.g == null) continue;
    setItemStart('overlay', o, n.g); rep.overlays++;
    if (o.kind === 'image' && opts.fitPhotos) o.out = r3(o.in + step);
    else if (o.kind !== 'image') {
      const sp = o.speed || 1, maxEnd = o.start + ((o.srcDuration || o.out) - o.in) / sp, end = o.start + overlayLen(o);
      const e = beats.filter(g => g >= o.start + Math.min(step, overlayLen(o)) * 0.5 && g <= maxEnd + 1e-6);
      if (e.length) { const g = nearest(e, end).g; o.out = r3(o.in + (g - o.start) * sp); }
    }
  }
  rep.ok = true;
  return rep;
}

/** Plain-language summary of a report (the dialog's preview line and the toast after Apply). */
export function describe(rep) {
  if (!rep.ok) return rep.reason === 'nobeats' ? 'Find the beats of the music first.' : rep.reason === 'noclips' ? 'Select clips or photos on the main track first.' : 'No beats after the first clip.';
  const bits = [];
  if (rep.mode === 'retime') bits.push(rep.retimed + ' clip' + (rep.retimed === 1 ? '' : 's') + ' re-timed' + (rep.photos ? ' (' + rep.photos + ' photo' + (rep.photos === 1 ? '' : 's') + ')' : ''));
  if (rep.mode === 'cut') bits.push(rep.splits + ' cut' + (rep.splits === 1 ? '' : 's') + ' on the beat' + (rep.photos ? ', ' + rep.photos + ' photo' + (rep.photos === 1 ? '' : 's') + ' fitted' : ''));
  bits.push(rep.onBeat + ' join' + (rep.onBeat === 1 ? '' : 's') + ' on a beat');
  if (rep.transitions) bits.push(rep.transitions + ' transition' + (rep.transitions === 1 ? '' : 's'));
  if (rep.overlays) bits.push(rep.overlays + ' overlay' + (rep.overlays === 1 ? '' : 's') + ' snapped');
  let s = bits.join(' · ') + '.';
  if (rep.skipped.length) s += ' Left as is: ' + rep.skipped.slice(0, 3).map(k => k.name + ' (' + k.reason + ')').join('; ') + (rep.skipped.length > 3 ? ' and ' + (rep.skipped.length - 3) + ' more' : '') + '.';
  return s;
}
