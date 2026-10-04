// Match: make the selected item fit another one on the timeline: its LENGTH, its START / END, or its LOUDNESS.
// Pure functions on the project (no DOM, no audio): the dialog (match-ui.js) picks the pair and measures loudness, this file plans and applies
// the change, so it is unit-tested. applyMatch edits the project it is given; the caller commits ONE undo step (or runs it on a copy to preview).
//   ref = { type: 'clip' | 'overlay' | 'audio' | 'whole', id }  ('whole' = the whole video, only as a target)
import { layout, clipLen, overlayLen, audioLen, audioSpan, audioSpeed, rippleShift, placeItem, moveClipTo, laneOf, MIN_CLIP, planMatchAudio } from './model.js';

export const MAX_VOLUME = 2;       // the Volume control goes to 200 % (+6 dB)
export const DB_FLOOR = -60;
const EPS = 0.02;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const volToDb = (v) => (v > 1e-6 ? 20 * Math.log10(v) : -120);
export const dbToVol = (db) => Math.pow(10, db / 20);
/** "12.5 s" under a minute, "1:05" above. */
export function say(sec) {
  sec = Math.max(0, sec);
  if (sec < 60) return (Math.round(sec * 100) / 100) + ' s';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s === 60 ? (m + 1) + ':00' : m + ':' + String(s).padStart(2, '0');
}

// ---------------------------------------------------------------- what is where
/** Facts about one item or the whole video, or null when it is gone. */
export function describe(project, ref) {
  if (!ref) return null;
  const lay = layout(project);
  if (ref.type === 'whole') return { ref, type: 'whole', name: 'The whole video', start: 0, len: lay.total, end: lay.total, sound: false, whole: true };
  if (ref.type === 'clip') {
    const it = lay.items.find(i => i.clip.id === ref.id); if (!it) return null;
    const c = it.clip;
    return { ref, type: 'clip', item: c, name: c.name || 'Clip', start: it.start, len: it.len, end: it.end, image: c.kind === 'image', video: c.kind === 'video', sound: c.kind === 'video' && c.hasAudio !== false && !!c.mediaId, speed: c.speed || 1, main: true };
  }
  if (ref.type === 'overlay') {
    const o = (project.overlays || []).find(x => x.id === ref.id); if (!o) return null;
    const len = overlayLen(o);
    return { ref, type: 'overlay', item: o, name: o.name || 'Overlay', start: o.start, len, end: o.start + len, image: o.kind === 'image', video: o.kind !== 'image', sound: o.kind !== 'image' && !!o.hasAudio && !!o.mediaId, speed: o.speed || 1 };
  }
  if (ref.type === 'audio') {
    const a = (project.audio || []).find(x => x.id === ref.id); if (!a) return null;
    const len = a.loop ? audioSpan(a, lay.total) : audioLen(a);
    return { ref, type: 'audio', item: a, name: a.name || (a.voice ? 'Voice' : 'Music'), start: a.start, len, end: a.start + len, sound: !!a.mediaId, voice: !!a.voice, loop: !!a.loop, openLoop: !!a.loop && !(a.loopLen > 0), speed: audioSpeed(a), audio: true };
  }
  return null;
}
const typeWord = (d) => d.whole ? 'Video' : d.type === 'audio' ? (d.voice ? 'Voice' : 'Music') : d.image ? 'Image' : d.type === 'overlay' ? 'Overlay' : 'Clip';

/** The other things the selected item can be matched to: [{ ref, info, label, overlap }], the ones sharing time with it first, then the whole video. */
export function targetsFor(project, sel) {
  const me = describe(project, sel); if (!me || me.whole) return [];
  const out = [];
  const lay = layout(project);
  for (const it of lay.items) if (it.clip.id !== sel.id || sel.type !== 'clip') out.push(describe(project, { type: 'clip', id: it.clip.id }));
  for (const o of project.overlays || []) if (!(sel.type === 'overlay' && sel.id === o.id)) out.push(describe(project, { type: 'overlay', id: o.id }));
  for (const a of project.audio || []) if (!(sel.type === 'audio' && sel.id === a.id)) out.push(describe(project, { type: 'audio', id: a.id }));
  const list = out.filter(Boolean).map(info => ({
    ref: info.ref, info, overlap: Math.max(0, Math.min(info.end, me.end) - Math.max(info.start, me.start)),
    label: typeWord(info) + ' · ' + info.name + ' · ' + say(info.start) + '–' + say(info.end),
  }));
  list.sort((a, b) => b.overlap - a.overlap || Math.abs(a.info.start - me.start) - Math.abs(b.info.start - me.start));
  if (lay.total > 0) { const w = describe(project, { type: 'whole' }); list.push({ ref: w.ref, info: w, overlap: 0, label: 'The whole video · ' + say(0) + '–' + say(w.end) }); }
  return list;
}
/** The target to suggest: for a picture, the audio it belongs with (what “Match audio” used to choose); for a sound, the picture under its start. */
export function defaultTarget(project, sel, list = targetsFor(project, sel)) {
  const me = describe(project, sel); if (!me || !list.length) return null;
  if (me.type !== 'audio') {
    if (sel.type === 'clip' && me.image) { const r = planMatchAudio(project, sel); if (!r.fail) { const t = list.find(x => x.ref.type === 'audio' && x.ref.id === r.audio.id); if (t) return t; } }
    return list.find(x => x.ref.type === 'audio' && x.overlap > 0) || list.find(x => x.ref.type === 'audio') || list[0];
  }
  return list.find(x => x.ref.type === 'clip' && x.info.start <= me.start + 0.05 && x.info.end > me.start + 0.05) || list.find(x => x.ref.type === 'clip' && x.overlap > 0) || list[list.length - 1];
}

/** Which of the three can be done for this pair, and why not. */
export function available(project, sel, tgt) {
  const me = describe(project, sel), t = describe(project, tgt), no = (why) => ({ ok: false, why });
  if (!me || !t) { const w = 'Pick another item first.'; return { length: no(w), align: no(w), loud: no(w) }; }
  const out = { length: { ok: true }, align: { ok: true }, loud: { ok: true } };
  if (me.video && !me.audio && t.len >= me.len - EPS && me.type !== 'overlay' && me.type !== 'clip') out.length = no('This cannot be lengthened.');
  else if (me.video && t.len >= me.len - EPS) out.length = no('A video cannot be stretched, only shortened: it is already ' + (t.len > me.len + EPS ? 'shorter' : 'the same length') + '. Change its Speed in the Clip tab to make it fit.');
  if (me.audio && me.openLoop && t.whole) out.length = { ok: true };
  if (!me.sound) out.loud = no(me.image ? 'A picture has no sound.' : 'This has no sound to measure.');
  else if (!t.sound) out.loud = no(t.whole ? 'Pick one sound to compare with (the whole video has no single level).' : 'The other item has no sound to compare with.');
  return out;
}

// ---------------------------------------------------------------- loudness of a recording
/**
 * Level of speech / music in dB from a loudness curve (dB per 20 ms window, as made by silence-scan.js): the average power of the windows
 * that are not quiet gaps (more than `gate` dB below the loud part), so pauses between words do not drag the level down.
 * Returns { db, loud: fraction of windows used } or null when it is silent.
 */
export function levelOf(db, { gate = 22 } = {}) {
  const v = Array.from(db).filter(x => Number.isFinite(x) && x > -90);
  if (v.length < 5) return null;
  const s = [...v].sort((a, b) => a - b), p90 = s[Math.floor(0.9 * (s.length - 1))];
  const keep = v.filter(x => x >= p90 - gate);
  if (!keep.length) return null;
  let sum = 0; for (const x of keep) sum += Math.pow(10, x / 10);
  return { db: 10 * Math.log10(sum / keep.length), loud: keep.length / v.length };
}
/** The volume that puts `sel` at `offsetDb` relative to `tgt` (0 = equal, −12 = twelve dB quieter). Levels are source levels in dB; volumes are the current multipliers. */
export function gainPlan({ selDb, tgtDb, selVol = 1, tgtVol = 1, offsetDb = 0 }) {
  const want = tgtDb + volToDb(tgtVol) + offsetDb - selDb;     // dB gain relative to the unprocessed source
  const raw = dbToVol(want), vol = clamp(raw, 0, MAX_VOLUME);
  return { vol: r3(vol), capped: raw > MAX_VOLUME + 1e-6, changeDb: volToDb(vol) - volToDb(selVol), wasDb: selDb + volToDb(selVol), nowDb: selDb + volToDb(vol), tgtNowDb: tgtDb + volToDb(tgtVol) };
}

// ---------------------------------------------------------------- applying
const frame = (p) => 1 / (p.settings?.fps || 30);
const roundUp = (p, v) => Math.max(MIN_CLIP, Math.ceil(v / frame(p) - 1e-3) * frame(p));

/** Set a main-track picture's length: keyframes keep their place (scaled), Ken Burns follows. Returns the length really set. */
function setImageLen(c, len) {
  const old = (c.out - c.in), cap = Math.max(MIN_CLIP, (c.srcDuration || 3600) - (c.in || 0));
  len = Math.min(len, cap);
  if (Math.abs(len - old) < 1e-4) return { len, capped: false, changed: false };
  const k = len / old;
  for (const tr of Object.values(c.keyframes || {})) for (const key of tr) key.t = Math.round(key.t * k * 1e6) / 1e6;
  c.out = c.in + len;
  return { len, capped: len >= cap - 1e-6, changed: true };
}
/** The run of picture clips on the main track around clip index i: [first, last]. */
export function pictureRun(project, id) {
  const cl = project.clips, i = cl.findIndex(c => c.id === id); if (i < 0 || cl[i].kind !== 'image') return null;
  let a = i, b = i; while (a > 0 && cl[a - 1].kind === 'image') a--; while (b < cl.length - 1 && cl[b + 1].kind === 'image') b++;
  return [a, b];
}

/**
 * Do the match on `project` (edited in place). req: { length, align: null|'start'|'end', loudness: null|{ selDb, tgtDb, offsetDb },
 * spread, loop, ripple }. Returns { ok, lines: [plain-words result, one per change], changed, fail? }. Nothing is half-done on failure.
 */
export function applyMatch(project, sel, tgt, req) {
  const me = describe(project, sel), t = describe(project, tgt);
  if (!me || !t) return { ok: false, fail: 'That item is not on the timeline any more.', lines: [] };
  if (me.whole || (sel.type === tgt.type && sel.id === tgt.id)) return { ok: false, fail: 'Pick a different item to match to.', lines: [] };
  const av = available(project, sel, tgt), lines = [];
  if (!req.length && !req.align && !req.loudness) return { ok: false, fail: 'Tick at least one thing to match.', lines };
  if (req.length && !av.length.ok) return { ok: false, fail: av.length.why, lines };
  if (req.loudness && !av.loud.ok) return { ok: false, fail: av.loud.why, lines };
  let changed = false;
  const it = me.item;

  // ---- length
  if (req.length) {
    const T = t.len;
    if (me.audio) {
      const a = it, sp = audioSpeed(a), fade = clamp(T * 0.08, 0.4, 3);
      const cur = me.len;
      if (a.loop) {
        if (Math.abs(a.loopLen - T) > EPS || !(a.loopLen > 0)) { a.loopLen = r3(T); a.fadeOut = Math.max(a.fadeOut || 0, r3(fade)); changed = true; lines.push('Its loop now fills ' + say(T) + ' (was ' + (me.openLoop ? 'until the end of the video' : say(cur)) + '), ending with a ' + say(Math.max(a.fadeOut, fade)) + ' fade-out.'); }
        else lines.push('Its loop already fills ' + say(T) + '.');
      } else if (cur > T + EPS) {
        a.out = r3(a.in + T * sp); a.fadeOut = Math.max(a.fadeOut || 0, r3(fade)); changed = true;
        lines.push('Trimmed from ' + say(cur) + ' to ' + say(T) + ' to match ' + t.name + ', with a ' + say(Math.max(a.fadeOut, fade)) + ' fade-out at the end.');
      } else if (cur < T - EPS) {
        if (req.loop) { a.loop = true; a.loopLen = r3(T); a.phase = 0; a.fadeOut = Math.max(a.fadeOut || 0, r3(fade)); changed = true; lines.push('Looped to fill ' + say(T) + ' (it was ' + say(cur) + '), ending with a ' + say(Math.max(a.fadeOut, fade)) + ' fade-out.'); }
        else lines.push('It is ' + say(T - cur) + ' shorter than ' + t.name + ' (' + say(cur) + ' against ' + say(T) + '), so it ends early. Tick “Loop to fill” to repeat it.');
      } else lines.push('Already the same length as ' + t.name + ' (' + say(T) + ').');
    } else if (me.image) {
      if (me.main) {
        const run = req.spread && sel.type === 'clip' ? pictureRun(project, sel.id) : null;
        const before = layout(project).total, lay0 = layout(project);
        if (run && run[1] > run[0]) {
          const n = run[1] - run[0] + 1, each = roundUp(project, T / n);
          if (T / n < MIN_CLIP) return { ok: false, fail: 'Too short to share between ' + n + ' pictures: ' + say(T) + ' is under ' + say(MIN_CLIP * n) + '.', lines };
          const firstIt = lay0.items[run[0]], lastEnd = lay0.items[run[1]].end;
          let used = 0, capped = false;
          for (let k = 0; k < n; k++) {
            const c = project.clips[run[0] + k], want = k === n - 1 ? Math.max(MIN_CLIP, roundUp(project, T - used)) : each;
            const r = setImageLen(c, want); used += r.len; capped ||= r.capped; changed ||= r.changed;
          }
          const delta = layout(project).total - before;
          if (req.ripple && delta) rippleShift(project, lastEnd - 1e-3, delta);
          void firstIt;
          lines.push(n + ' pictures now share ' + say(T) + ' (about ' + say(T / n) + ' each, in the same order) to fit ' + t.name + (capped ? '. One could not be longer than its source allows' : '') + '.');
        } else {
          const c = it, want = roundUp(project, T), r = setImageLen(c, want);
          if (r.changed) {
            changed = true; const delta = layout(project).total - before;
            if (req.ripple && delta) rippleShift(project, me.end - 1e-3, delta);
            lines.push('Image now ' + say(r.len) + ', matching ' + t.name + (r.capped ? ' (the longest an image can be here)' : '') + ' (was ' + say(me.len) + ').');
          } else lines.push('Image is already ' + say(me.len) + ', matching ' + t.name + '.');
        }
      } else { // picture overlay
        const o = it, want = roundUp(project, T), cap = Math.max(MIN_CLIP, (o.srcDuration || 3600) - (o.in || 0)), len = Math.min(want, cap);
        if (Math.abs(len - (o.out - o.in)) > 1e-4) { o.out = o.in + len; changed = true; lines.push('Overlay picture now ' + say(len) + ', matching ' + t.name + '.'); } else lines.push('Overlay picture is already ' + say(len) + '.');
      }
    } else { // video clip / overlay: shorten only
      const cur = me.len;
      if (cur > T + EPS) {
        const before = layout(project).total, newOut = r3(it.in + T * me.speed);
        it.out = Math.max(it.in + MIN_CLIP * me.speed, newOut); changed = true;
        if (me.main && req.ripple) { const delta = layout(project).total - before; if (delta) rippleShift(project, me.end - 1e-3, delta); }
        lines.push('Video trimmed from ' + say(cur) + ' to ' + say(T) + ' (the end is cut, nothing is stretched).');
      } else lines.push('Video is already ' + (cur < T - EPS ? 'shorter than ' + t.name : 'the same length as ' + t.name) + '.');
    }
  }

  // ---- start / end
  if (req.align) {
    const m2 = describe(project, sel), want = req.align === 'start' ? t.start : t.end - m2.len;
    const target = Math.max(0, want);
    if (Math.abs(m2.start - target) < 0.005) lines.push((req.align === 'start' ? 'Already starts' : 'Already ends') + ' with ' + t.name + '.');
    else {
      let got;
      if (sel.type === 'clip') got = moveClipTo(project, sel.id, target);
      else { const plan = placeItem(project, sel.type, it, target, laneOf(it)); got = plan.start; }
      changed = true;
      const note = got != null && Math.abs(got - target) > 0.01 ? ' (the nearest free place; something else is in the way)' : '';
      lines.push(req.align === 'start' ? 'Starts with ' + t.name + ' at ' + say(got ?? target) + note + '.' : 'Ends with ' + t.name + ' at ' + say((got ?? target) + m2.len) + note + '.');
    }
  }

  // ---- loudness
  if (req.loudness) {
    const L = req.loudness, selVol = it.volume ?? 1, tgtVol = t.item.volume ?? 1;
    const g = gainPlan({ selDb: L.selDb, tgtDb: L.tgtDb, selVol, tgtVol, offsetDb: L.offsetDb || 0 });
    if (Math.abs(g.vol - selVol) < 0.005) lines.push('Loudness already ' + offsetWords(L.offsetDb || 0) + ' ' + t.name + '.');
    else {
      it.volume = g.vol; changed = true;
      lines.push('Volume ' + Math.round(selVol * 100) + '% → ' + Math.round(g.vol * 100) + '% (' + (g.changeDb >= 0 ? '+' : '') + (Math.round(g.changeDb * 10) / 10) + ' dB), so it plays ' + offsetWords(L.offsetDb || 0) + ' ' + t.name + (g.capped ? '. It cannot go louder than 200%, so it falls short' : '') + '.');
    }
  }
  return { ok: true, lines, changed };
}
export function offsetWords(db) {
  if (Math.abs(db) < 0.05) return 'as loud as';
  return Math.abs(Math.round(db * 10) / 10) + ' dB ' + (db < 0 ? 'quieter than' : 'louder than');
}
