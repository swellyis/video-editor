// Multi-select + clipboard model (pure: no DOM). A selection list is [{ type, id }] over clips, overlays, text, blur regions, music/voice
// tracks and captions (markers are left out on purpose: they belong to the ruler). Every function edits the project in place and is meant
// to be called inside ONE app.commit(), so a whole group edit is a single undo step.
import {
  layout, spanCtx, listOf, findItem, removeClip, duplicateClip, splitItem, moveClipTo, audioSpan, overlayLen, rippleShift,
} from './model.js';
import { uid } from './util.js';

const deepClone = (o) => JSON.parse(JSON.stringify(o));
export const GROUP_TYPES = ['clip', 'overlay', 'text', 'blur', 'audio', 'caption'];
export const PREFIX = { clip: 'clip', overlay: 'ovl', text: 'txt', blur: 'blr', audio: 'aud', caption: 'cap' };
export const same = (a, b) => !!a && !!b && a.type === b.type && a.id === b.id;
export const NOUN = { clip: 'clip', overlay: 'overlay', text: 'text', blur: 'blur region', audio: 'audio track', caption: 'caption' };

/** Everything that can be selected, bottom lane first. */
export function everything(project) {
  const out = [];
  for (const k of GROUP_TYPES) for (const it of listOf(project, k) || []) out.push({ type: k, id: it.id });
  return out;
}
/** The list with entries that no longer exist removed and duplicates dropped. */
export function clean(project, list) {
  const seen = new Set(), out = [];
  for (const s of list || []) {
    if (!s || !GROUP_TYPES.includes(s.type) || seen.has(s.id)) continue;
    if (!(listOf(project, s.type) || []).some(x => x.id === s.id)) continue;
    seen.add(s.id); out.push({ type: s.type, id: s.id });
  }
  return out;
}
export const resolve = (project, list) => clean(project, list).map(s => ({ ...s, item: listOf(project, s.type).find(x => x.id === s.id) }));
/** Toggle one entry (shift/ctrl-click). */
export function toggle(list, sel) {
  const has = list.some(s => same(s, sel));
  return has ? list.filter(s => !same(s, sel)) : [...list, { type: sel.type, id: sel.id }];
}
/** Does the item have sound that Mute / Volume can change? */
export function hasSoundItem(type, item) {
  if (!item) return false;
  if (type === 'audio') return true;
  if (type === 'clip' || type === 'overlay') return item.kind === 'video' && item.hasAudio !== false;
  return false;
}
export const spanOf = (project, type, item, ctx = spanCtx(project)) => ctx.span(type, item);
/** Rectangles (client coordinates) hit by a marquee: ids of the nodes that intersect. */
export const rectsHit = (box, rects) => rects.filter(r => r.l < box.r && r.r > box.l && r.t < box.b && r.b > box.t).map(r => r.key);

// ---------------------------------------------------------------- delete / duplicate / split / mute / move
export function deleteMany(project, list, ripple) {
  let n = 0;
  for (const s of clean(project, list)) {
    if (s.type === 'clip') removeClip(project, s.id, ripple);
    else project[{ overlay: 'overlays', text: 'texts', blur: 'blurs', audio: 'audio', caption: 'captions' }[s.type]] = listOf(project, s.type).filter(x => x.id !== s.id);
    n++;
  }
  return n;
}
/** A copy of one item right after it (clips join the sequence after the original; others start where the original ends). Returns the new selection entry. */
export function duplicateOne(project, s, ripple) {
  const f = findItem(project, s.id); if (!f) return null;
  const item = f.item, total = layout(project).total;
  if (s.type === 'clip') { const b = duplicateClip(project, s.id, ripple); return b && { type: 'clip', id: b.id }; }
  const b = deepClone(item); b.id = uid(PREFIX[s.type]);
  if (s.type === 'audio') { b.start = item.start + audioSpan(item, total); project.audio.push(b); }
  else if (s.type === 'overlay') { b.start = item.start + overlayLen(item); project.overlays.push(b); }
  else {
    const len = item.end - item.start; b.start = item.end; b.end = item.end + len;
    if (s.type === 'caption' && b.words) b.words = b.words.map(w => ({ ...w, start: w.start + len, end: w.end + len }));
    if (s.type === 'text') project.texts.push(b); else if (s.type === 'blur') project.blurs.push(b); else (project.captions = project.captions || []).push(b);
  }
  return { type: s.type, id: b.id };
}
export function duplicateMany(project, list, ripple) {
  const out = [];
  for (const s of clean(project, list)) { const n = duplicateOne(project, s, ripple); if (n) out.push(n); }
  return out;
}
/** Split every selected item the playhead is inside. Returns { done: [entries now in the selection], split, skipped }. */
export function splitMany(project, list, t) {
  const done = []; let split = 0, skipped = 0;
  for (const s of clean(project, list)) {
    const r = splitItem(project, s, t);
    if (!r || r.fail) { skipped++; done.push(s); continue; }
    split++; done.push(s, { type: r.type, id: r.item.id });
  }
  return { done, split, skipped };
}
/** Mute all (when any is unmuted) or unmute all. Returns { muted: bool|null, n }. */
export function muteMany(project, list) {
  const its = resolve(project, list).filter(x => hasSoundItem(x.type, x.item));
  if (!its.length) return { muted: null, n: 0 };
  const mute = its.some(x => !x.item.muted);
  for (const x of its) x.item.muted = mute;
  return { muted: mute, n: its.length };
}
/** Earliest start on the timeline among the selected items that move freely (everything but ripple-joined clips). */
export function earliest(project, list, ripple) {
  const ctx = spanCtx(project); let m = Infinity;
  for (const x of resolve(project, list)) if (!(ripple && x.type === 'clip')) m = Math.min(m, ctx.span(x.type, x.item)[0]);
  return m;
}
/**
 * Move the group by dt seconds (everything keeps its own lane; the same dt for all, never before 0:00; commit() separates anything that
 * now overlaps into a new lane). With Ripple on the main clips stay joined and are not moved. Returns { moved, held, dt }.
 */
export function moveMany(project, list, dt, ripple) {
  const its = resolve(project, list), ctx = spanCtx(project);
  const mover = its.filter(x => !(ripple && x.type === 'clip'));
  const held = its.length - mover.length;
  if (!mover.length) return { moved: 0, held, dt: 0 };
  const min = Math.min(...mover.map(x => ctx.span(x.type, x.item)[0]));
  dt = Math.max(dt, -min);
  if (Math.abs(dt) < 1e-6) return { moved: 0, held, dt: 0 };
  for (const x of mover) if (x.type === 'audio' || x.type === 'overlay') x.item.start = Math.max(0, x.item.start + dt);
  // (text / blur / caption: shift both ends by the same amount)
  for (const x of mover) {
    if (!['text', 'blur', 'caption'].includes(x.type)) continue;
    const it = x.item, s0 = ctx.span(x.type, it)[0], e0 = ctx.span(x.type, it)[1];
    it.start = s0 + dt; it.end = e0 + dt;
    if (x.type === 'caption' && it.words) it.words = it.words.map(w => ({ ...w, start: w.start + dt, end: w.end + dt }));
  }
  // main clips (Ripple off): the clip order is kept and each stops at its neighbour; the leading one goes first
  const clips = mover.filter(x => x.type === 'clip').map(x => ({ x, s: ctx.span('clip', x.item)[0] })).sort((a, b) => dt > 0 ? b.s - a.s : a.s - b.s);
  for (const c of clips) moveClipTo(project, c.x.item.id, c.s + dt);
  return { moved: mover.length, held, dt };
}

// ---------------------------------------------------------------- clipboard
/** Copy the selection: deep clones plus each item's start relative to the earliest one. */
export function copyItems(project, list) {
  const its = resolve(project, list); if (!its.length) return null;
  const ctx = spanCtx(project), base = Math.min(...its.map(x => ctx.span(x.type, x.item)[0]));
  const items = its.map(x => ({ type: x.type, rel: ctx.span(x.type, x.item)[0] - base, data: deepClone(x.item) }));
  return { v: 1, items, copiedAt: Date.now() };
}
const shiftTimes = (it, type, dt) => {
  if (type === 'audio' || type === 'overlay') it.start += dt;
  else { it.start += dt; it.end += dt; if (type === 'caption' && it.words) it.words = it.words.map(w => ({ ...w, start: w.start + dt, end: w.end + dt })); }
};
/**
 * Paste at time t. Main clips join the sequence (where the playhead is: after the clip it is in the second half of, else before it);
 * lane items keep their lane and their spacing; anything that would overlap is moved to a new lane by ensureLanes() in the commit.
 * Returns the new selection entries.
 */
export function pasteItems(project, clip, t, ripple) {
  if (!clip || !clip.items || !clip.items.length) return [];
  const out = [];
  const clips = clip.items.filter(i => i.type === 'clip');
  if (clips.length) {
    const lay = layout(project);
    let idx = project.clips.length;
    for (const it of lay.items) if (t < (it.start + it.end) / 2) { idx = it.index; break; }
    const news = clips.map((i, k) => { const b = deepClone(i.data); b.id = uid('clip'); b.gap = 0; if (k === 0 || !b.transition) b.transition = { type: 'cut', duration: (b.transition && b.transition.duration) || 0.6 }; return b; }); // joins inside the copied group keep their transition
    project.clips.splice(idx, 0, ...news);
    if (ripple) { const grow = layout(project).total - lay.total; const at = idx < lay.items.length ? lay.items[idx].start : lay.total; rippleShift(project, at - 1e-3, grow); }
    for (const b of news) out.push({ type: 'clip', id: b.id });
  }
  for (const i of clip.items) {
    if (i.type === 'clip') continue;
    const b = deepClone(i.data); b.id = uid(PREFIX[i.type]);
    shiftTimes(b, i.type, Math.max(0, t) + i.rel - b.start);
    (i.type === 'caption' ? (project.captions = project.captions || []) : listOf(project, i.type)).push(b);
    out.push({ type: i.type, id: b.id });
  }
  return out;
}

// ---------------------------------------------------------------- paste attributes (Ctrl+Shift+V)
const VISUAL = ['color', 'fx', 'blur', 'transform', 'opacity', 'fit', 'bg', 'volume', 'muted', 'fadeIn', 'fadeOut', 'keyframes'];
export const ATTRS = {
  clip: VISUAL, overlay: VISUAL,
  text: ['color', 'bg', 'bgOpacity', 'style', 'font', 'size', 'align', 'fadeIn', 'fadeOut', 'maxWidth', 'scale', 'rotation', 'opacity', 'anim', 'keyframes'],
  audio: ['volume', 'muted', 'fadeIn', 'fadeOut', 'duck', 'duckLevel', 'duckDb', 'duckAttack', 'duckRelease', 'duckTrigger', 'keyframes'],
  blur: ['shape', 'mode', 'radius', 'strength', 'feather', 'invert', 'fadeIn', 'fadeOut'],
  caption: [],
};
const FAMILY = { clip: 'visual', overlay: 'visual', text: 'text', audio: 'audio', blur: 'blur', caption: 'caption' };
/** Copy the look (effects, filter, colour, animation, volume...) of the first matching copied item onto each selected item. Returns the number changed. */
export function pasteAttributes(project, clip, list) {
  if (!clip || !clip.items) return 0;
  let n = 0;
  for (const x of resolve(project, list)) {
    const src = clip.items.find(i => FAMILY[i.type] === FAMILY[x.type]);
    if (!src) continue;
    const keys = (ATTRS[x.type] || []).filter(k => k in src.data && (k in x.item || x.type === src.type));
    if (!keys.length) continue;
    for (const k of keys) x.item[k] = deepClone(src.data[k]);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- groups (grouped items act as one block)
// project.groups = [{ id, name, items: [{ type, id }] }]. Clicking a member selects the whole group (then the multi-select tools move,
// copy, duplicate, delete it), the timeline draws the group as one block whose ends trim every member, and Ungroup dissolves it.
// Members render exactly as before, so preview and export are unchanged by grouping.
export function tidyGroups(project) {
  const seen = new Set(), out = [];
  for (const g of project.groups || []) {
    const items = clean(project, g.items).filter(s => !seen.has(s.id));
    if (items.length < 2) continue;
    items.forEach(s => seen.add(s.id)); out.push({ ...g, items });
  }
  project.groups = out; return out;
}
export function groupOf(project, s) { return s ? (project.groups || []).find(g => g.items.some(x => x.type === s.type && x.id === s.id)) || null : null; }
/** The group whose members are exactly this list (any order), or null. */
export function groupIs(project, list) {
  const l = clean(project, list); if (l.length < 2) return null;
  const g = groupOf(project, l[0]); return g && g.items.length === l.length && l.every(s => g.items.some(x => same(x, s))) ? g : null;
}
export function makeGroup(project, list) {
  const items = clean(project, list); if (items.length < 2) return null;
  project.groups = (project.groups || []).map(g => ({ ...g, items: g.items.filter(x => !items.some(s => same(s, x))) }));
  const n = (project.groups || []).length + 1;
  const g = { id: uid('grp'), name: 'Group ' + n, items };
  project.groups.push(g); tidyGroups(project);
  return project.groups.find(x => x.id === g.id) || null;
}
export function ungroup(project, id) { const before = (project.groups || []).length; project.groups = (project.groups || []).filter(g => g.id !== id); return before !== project.groups.length; }
/** [start, end] of a group on the timeline. */
export function groupSpan(project, g) {
  const ctx = spanCtx(project); let a = Infinity, b = -Infinity;
  for (const x of resolve(project, g.items)) { const [s, e] = ctx.span(x.type, x.item); a = Math.min(a, s); b = Math.max(b, e); }
  return Number.isFinite(a) ? [a, b] : [0, 0];
}
/**
 * Trim the group block to [a, b]: members are cut at the new ends (the same split as the Split tool, so speed, keyframes and fades stay
 * right), pieces outside are removed, members wholly outside are removed. Main clips leave a gap (nothing after them moves).
 * Returns the group's new member list.
 */
export function trimGroup(project, g, a, b) {
  const MIN = 0.1; let items = clean(project, g.items);
  const span0 = groupSpan(project, { items });
  a = Math.max(span0[0], a); b = Math.min(span0[1], b); if (b - a < MIN) return items;
  const out = [];
  for (const s of items) {
    let cur = s;
    let [st, en] = spanCtx(project).span(cur.type, findItem(project, cur.id).item);
    if (en <= a + 1e-6 || st >= b - 1e-6) { deleteMany(project, [cur], false); continue; }
    if (st < a - 1e-6) { const r = splitItem(project, cur, a); if (r && !r.fail) { deleteMany(project, [cur], false); cur = { type: r.type, id: r.item.id }; } }
    en = spanCtx(project).span(cur.type, findItem(project, cur.id).item)[1];
    if (en > b + 1e-6) { const r = splitItem(project, cur, b); if (r && !r.fail) deleteMany(project, [{ type: r.type, id: r.item.id }], false); }
    out.push(cur);
  }
  g.items = out; tidyGroups(project);
  return out;
}
