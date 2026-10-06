// Auto Shorts: pick strong 20-60 s moments from a long sermon's captions and turn each one into a 9:16 project.
// Everything here is a pure function (no DOM, no storage) so the scoring and the cutting rules are unit-tested.
// The scoring is a transparent HEURISTIC: every point comes with a plain-language reason that the dialog shows.
// It reads words and their timings, not meaning: it can pick a moment that is not the best one, so the person decides.
import { captionWords, rechunk, applyPreset, defaultCaptionStyle, normalizeCaption } from './captions.js';
import { layout, newProject, migrate, audioSpeed, normalizeClip } from './model.js';
import { uid } from './util.js';
import * as RAMP from './ramp.js';

export const DEFAULTS = { minLen: 20, maxLen: 60, idealMin: 30, idealMax: 50, minWords: 30, minRate: 0.8, count: 8, lead: 0.25, tail: 0.45, minGap: 0.05 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- scripture references
const BOOKS = ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', 'Samuel', 'Kings', 'Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms?', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Song of Songs', 'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', 'Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', 'Thessalonians', 'Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', 'Peter', 'Jude', 'Revelation'];
const ORD = '(?:(?:[1-3]|i{1,3}|first|second|third)\\s+)?';
const NUMBERED = new Set(['Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Thessalonians', 'Timothy', 'Peter', 'John']);
const REF = new RegExp('\\b' + ORD + '(?:' + BOOKS.join('|') + ')\\s+(?:chapter\\s+)?\\d{1,3}(?:\\s*(?::|,|verses?)\\s*\\d{1,3}(?:\\s*[-–]\\s*\\d{1,3})?)?', 'gi');
/** Scripture references spoken in a text: "John 3:16", "Romans chapter 8 verse 28", "1 Corinthians 13:4-7". */
export function findScripture(text) {
  const out = [];
  for (const m of String(text || '').matchAll(REF)) {
    let s = m[0].replace(/\s+/g, ' ').trim();
    if (/^(john|peter|samuel|kings)$/i.test(s.split(' ')[0]) && !NUMBERED.has(s.split(' ')[0])) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- sentences
const ABBR = /^(mr|mrs|ms|dr|st|vs|etc|jr|sr|no|ch|vv?)\.$/i;
const TERMINAL = /[.?!…]["'”’)\]]*$/;
/** Words of the captions in time order: [{ w, start, end }] (timeline seconds). */
export function wordsOf(captions) {
  const ws = [];
  for (const c of [...(captions || [])].sort((a, b) => a.start - b.start)) for (const w of captionWords(c)) if (w.w) ws.push({ w: w.w, start: w.start, end: Math.max(w.end, w.start + 0.01) });
  return ws.sort((a, b) => a.start - b.start);
}
/**
 * Split the words into sentences: after . ? ! …, or at a pause of 0.9 s or more, or (runaway text without punctuation) after 60 words.
 * Each: { start, end, text, i0, i1 (word index range), terminal: '.'|'?'|'!'|'' , pauseAfter (seconds of silence before the next word), words }
 */
export function buildSentences(captions, { pause = 0.9, maxWords = 60 } = {}) {
  const ws = wordsOf(captions), out = [];
  let a = 0;
  const push = (b) => { // words a..b inclusive
    const seg = ws.slice(a, b + 1), last = seg[seg.length - 1];
    const m = last.w.match(/[.?!…]/g);
    out.push({ start: seg[0].start, end: last.end, text: seg.map(x => x.w).join(' '), i0: a, i1: b, terminal: TERMINAL.test(last.w) && !ABBR.test(last.w) ? (m ? m[m.length - 1].replace('…', '.') : '.') : '', pauseAfter: b + 1 < ws.length ? Math.max(0, ws[b + 1].start - last.end) : 99, words: seg });
    a = b + 1;
  };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], next = ws[i + 1];
    const endsSentence = TERMINAL.test(w.w) && !ABBR.test(w.w);
    if (!next || endsSentence || next.start - w.end >= pause || i - a + 1 >= maxWords) push(i);
  }
  return out;
}

// ---------------------------------------------------------------- text signals
const HOOK_START = /^(what if|imagine|have you ever|did you know|do you|are you|here'?s (the|a|what|why)|let me (tell|ask|say|show)|listen|look at|the truth|the (good|bad) news|god (is|says|has|loves|wants|will|can)|jesus (said|is|says|christ|died|rose)|you (need|are|were|can|must|don'?t|have|will)|never|stop|don'?t|why|how|who|when you|if you|there'?s a|one day|today|i want you|i'?m going to tell)\b/i;
const DEPENDENT_START = /^(and|but|so|because|then|which|that|this|these|those|it|he|she|they|him|her|them|also|or|yet|however|therefore|well|anyway|amen|right|okay|ok|now|as|for|with|to)\b/i;
const TRAIL_CONJ = /\b(and|but|so|because|or|that|which|the|a|of|to|in|for|with|if)[.,;:]?$/i;
const PAYOFF = /\b(amen|in jesus'? name|that'?s the (gospel|good news|truth)|praise god|hallelujah|thank you jesus|it is finished|he is risen|the end of the story|that'?s it|that'?s all)\b/i;
const CONTRAST = /\b(not|isn'?t|aren'?t|don'?t|doesn'?t|never|no)\b[^.?!]{3,70}\b(but|it'?s|he'?s|she'?s|you'?re|instead|rather)\b/i;
const FAITH = /\b(god|jesus|christ|lord|holy spirit|spirit|grace|faith|gospel|cross|sin|saved?|salvation|love|prayer|pray|forgive|forgiven|forgiveness|heaven|hope|mercy|truth|bible|scripture|blessed?|redeem|redeemed|resurrection|worship)\b/gi;
const PUNCH = /\b(here'?s the thing|the truth is|listen to me|let me say that again|i promise you|i'?m telling you|remember this|write this down|this is (the|where)|that'?s (the|what)|what if i told you|the point is|the problem is|the answer is)\b/i;

/** Per-sentence features, computed once. `env` = { step, values } optional loudness per `step` seconds (timeline time). */
function sentenceFeatures(s) {
  const text = s.text, nw = s.words.length;
  return {
    refs: findScripture(text), q: (text.match(/\?/g) || []).length, bang: (text.match(/!/g) || []).length,
    contrast: CONTRAST.test(text), payoff: PAYOFF.test(text), punch: PUNCH.test(text),
    faith: (text.match(FAITH) || []).length, nw,
  };
}
function envSlice(env, a, b) {
  if (!env || !env.values || !env.values.length) return null;
  const i0 = clamp(Math.floor(a / env.step), 0, env.values.length), i1 = clamp(Math.ceil(b / env.step), i0, env.values.length);
  return i1 - i0 > 0 ? env.values.subarray ? env.values.subarray(i0, i1) : env.values.slice(i0, i1) : null;
}
export function median(arr) {
  const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}
const pct = (arr, p) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
/** Reference loudness of the speech in the whole recording (median of the louder-than-silence blocks). */
export function speechLevel(env) {
  if (!env || !env.values) return 0;
  const v = Array.from(env.values).filter(x => x > 0), floor = pct(v, 0.2) * 1.2;
  return median(v.filter(x => x >= floor));
}

/**
 * Score a run of sentences S[i..j] as a Short. Returns { score 0-100, reasons: [{ label, pts }], len, scripture: [..] }.
 * Points (max 100): hook 22, clean end 14 (+pause), scripture 14, question/punchline 12, voice energy 14, length 8, pace 4, faith words 4, + 8 for a pause before.
 * Penalties: starts with "and/but/this…" (needs earlier context), ends on a dangling word, dead air inside.
 */
export function scoreRun(S, F, i, j, o = {}) {
  const opt = { ...DEFAULTS, ...o }, first = S[i], last = S[j];
  const len = last.end - first.start, reasons = [];
  let pts = 0;
  const add = (label, p) => { if (p) { reasons.push({ label, pts: Math.round(p * 10) / 10 }); pts += p; } };
  // hook
  const t0 = first.text.replace(/^["'“‘(\s]+/, '');
  if (first.terminal === '?' || /^(why|how|what|who|do you|are you|have you|did you)\b/i.test(t0)) add('Opens with a question', 22);
  else if (HOOK_START.test(t0)) add('Strong opening line', 17);
  else if (!DEPENDENT_START.test(t0) && first.words.length >= 5) add('Starts a fresh thought', 8);
  if (DEPENDENT_START.test(t0) && !HOOK_START.test(t0)) add('Starts mid-thought (“' + t0.split(/\s+/)[0] + '…”)', -9);
  if (first.words.length < 4) add('Very short first sentence', -4);
  // clean boundaries
  if (last.terminal) add('Ends on a finished sentence', 8); else add('Ends mid-sentence', -12);
  const prevPause = i > 0 ? first.start - S[i - 1].end : 99;
  if (prevPause >= 0.5) add('Pause before it begins', 4);
  if (last.pauseAfter >= 0.7) add('Pause after the last word', 6); else if (last.pauseAfter >= 0.4) add('Short pause after the last word', 3);
  if (TRAIL_CONJ.test(last.text) && !last.terminal) add('Ends on a dangling word', -6);
  // content
  let refs = [], q = 0, bang = 0, contrast = false, payoff = false, punch = false, faith = 0, nw = 0;
  for (let k = i; k <= j; k++) { const f = F[k]; refs = refs.concat(f.refs); q += f.q; bang += f.bang; contrast ||= f.contrast; payoff ||= f.payoff; punch ||= f.punch; faith += f.faith; nw += f.nw; }
  if (refs.length) add('Scripture: ' + [...new Set(refs)].slice(0, 2).join(', '), refs.length > 1 ? 14 : 10);
  if (q) add(q > 1 ? 'Asks questions' : 'Asks a question', Math.min(7, 4 + q));
  if (contrast) add('“Not this, but that” line', 4);
  if (punch) add('Emphasis phrase (“here’s the thing…”)', 4);
  if (payoff || bang) add(payoff ? 'Closing line (Amen / gospel / praise)' : 'Exclamation', payoff ? 5 : 3);
  const faithRate = faith / Math.max(1, nw);
  if (faithRate > 0.03) add('Faith-centred wording', clamp(faithRate * 60, 1, 4));
  // length (20-60 s allowed; 30-50 s best)
  const lp = len >= opt.idealMin && len <= opt.idealMax ? 8 : len < opt.idealMin ? 8 * (len - opt.minLen) / Math.max(1, opt.idealMin - opt.minLen) : 8 * (opt.maxLen - len) / Math.max(1, opt.maxLen - opt.idealMax);
  add(len >= opt.idealMin && len <= opt.idealMax ? 'Ideal length (' + Math.round(len) + ' s)' : 'Length ' + Math.round(len) + ' s', clamp(lp, 0, 8));
  // pace and dead air
  const rate = nw / Math.max(1, len);
  if (rate >= 1.8 && rate <= 3.6) add('Steady speaking pace', 4); else if (rate < 1.2) add('Slow, sparse speech', -5);
  let dead = 0; for (let k = i; k < j; k++) if (S[k].pauseAfter > 2.5) dead++;
  if (dead) add('Long silence inside (' + dead + '×)', -6 * dead);
  // voice energy
  if (o.env && o.level > 0) {
    const sl = envSlice(o.env, first.start, last.end);
    if (sl && sl.length >= 4) {
      const p90 = pct(sl, 0.9) / o.level, mean = Array.from(sl).reduce((a, b) => a + b, 0) / sl.length / o.level;
      const e = clamp((p90 - 1.0) / 0.9, 0, 1) * 9 + clamp((mean - 0.85) / 0.5, 0, 1) * 5;
      if (e >= 1) add(p90 > 1.6 ? 'Energetic, emphatic delivery' : 'Lively delivery', e);
      else if (mean < 0.6) add('Quiet delivery', -4);
    }
  }
  return { score: clamp(Math.round(pts), 0, 100), reasons, len, scripture: [...new Set(refs)] };
}

// ---------------------------------------------------------------- candidates
/** Pad a sentence-aligned range slightly, never into the neighbouring words. Times rounded to 0.1 s (never inside a word). */
export function padRange(words, i0, i1, o = {}) {
  const opt = { ...DEFAULTS, ...o };
  const a = words[i0], b = words[i1], pw = words[i0 - 1], nw = words[i1 + 1];
  let s = a.start - opt.lead, e = b.end + opt.tail;
  if (pw) s = Math.max(s, (pw.end + a.start) / 2);
  if (nw) e = Math.min(e, (b.end + nw.start) / 2);
  s = Math.max(0, Math.floor(s * 10) / 10); e = Math.ceil(e * 10) / 10;
  if (s > a.start) s = a.start; if (e < b.end) e = b.end;
  return { start: r3(s), end: r3(e) };
}
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * Rank candidate Shorts. captions: timeline captions. opts: { env, count, minLen, maxLen, total }.
 * Returns [{ id, start, end, len, score, reasons, text (snippet), scripture, first, last (word indexes) }] best first, no two overlapping by more than 20 %.
 */
export function findCandidates(captions, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, S = buildSentences(captions);
  if (!S.length) return [];
  const F = S.map(sentenceFeatures), words = wordsOf(captions), level = speechLevel(o.env);
  const all = [];
  for (let i = 0; i < S.length; i++) {
    for (let j = i; j < S.length; j++) {
      const len = S[j].end - S[i].start;
      if (len > o.maxLen) break;
      if (len < o.minLen) continue;
      const nw = S[j].i1 - S[i].i0 + 1; // too little speech (a few stray words over a long stretch) is never a Short
      if (nw < o.minWords || nw / len < o.minRate) continue;
      const r = scoreRun(S, F, i, j, { ...o, env: o.env, level });
      all.push({ i, j, r });
    }
  }
  all.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  const out = [];
  for (const c of all) {
    const rng = padRange(words, S[c.i].i0, S[c.j].i1, o);
    if (o.total && rng.end > o.total) rng.end = r3(o.total);
    if (rng.end - rng.start < o.minLen - 1) continue;
    const cand = { start: rng.start, end: rng.end };
    if (out.some(x => overlap(x, cand) > 0.2 * Math.min(x.end - x.start, cand.end - cand.start))) continue;
    out.push({
      id: 'sh' + out.length + '_' + Math.round(rng.start * 10), start: rng.start, end: rng.end, len: r3(rng.end - rng.start), score: c.r.score, reasons: c.r.reasons,
      scripture: c.r.scripture, text: snippet(S, c.i, c.j), first: S[c.i].i0, last: S[c.j].i1,
    });
    if (out.length >= o.count) break;
  }
  return out;
}
/** A short readable excerpt: the first sentence(s) and the last words. */
export function snippet(S, i, j, max = 170) {
  const head = S[i].text;
  if (head.length >= max) return head.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  let t = head;
  for (let k = i + 1; k <= j && t.length < max * 0.55; k++) t += ' ' + S[k].text;
  const tail = S[j].text;
  if (!t.endsWith(tail) && t.length + tail.length + 5 < max + 60) t += ' … ' + tail.slice(-Math.min(tail.length, 70)).replace(/^\S*\s/, '');
  return t.length > max + 60 ? t.slice(0, max + 59).replace(/\s+\S*$/, '') + '…' : t;
}

// ---------------------------------------------------------------- nudging the cut
/** Move a time out of the middle of a word: a start snaps to the word's start (minus a breath), an end to its end (plus a breath). */
export function snapToWords(words, t, which, breath = 0.08) {
  for (const w of words) {
    if (w.start - 1e-6 < t && t < w.end - 1e-6 && t > w.start + 1e-6) return r3(which === 'start' ? Math.max(0, w.start - breath) : w.end + breath);
    if (w.start > t) break;
  }
  return r3(t);
}
/** Nudge one edge by delta seconds (clamped: 5-90 s long, inside [0, total]) and keep it out of the middle of a word. */
export function nudge(range, which, delta, words, total, { minLen = 5, maxLen = 90 } = {}) {
  let { start, end } = range;
  if (which === 'start') start = clamp(start + delta, Math.max(0, end - maxLen), end - minLen);
  else end = clamp(end + delta, start + minLen, Math.min(total, start + maxLen));
  if (which === 'start') start = Math.min(snapToWords(words, start, 'start'), end - minLen); else end = Math.max(snapToWords(words, end, 'end'), start + minLen);
  start = Math.max(0, start); if (total) end = Math.min(end, total);
  return { start: r3(start), end: r3(end) };
}

// ---------------------------------------------------------------- cutting a range out of a project
/** Captions that fall in [a, b], re-timed to start at 0. Words are kept whole by their midpoint; text is rebuilt when a caption is cut. */
export function captionsInRange(captions, a, b) {
  const out = [];
  for (const c of [...(captions || [])].sort((x, y) => x.start - y.start)) {
    if (c.end <= a || c.start >= b) continue;
    const ws = captionWords(c), keep = ws.filter(w => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < b);
    if (!keep.length) continue;
    const text = keep.length === ws.length ? c.text : keep.map(w => w.w).join(' ');
    const n = normalizeCaption({ id: uid('cap'), start: Math.max(a, keep[0].start) - a, end: Math.min(b, keep[keep.length - 1].end) - a, text, words: keep.map(w => ({ w: w.w, start: Math.max(a, w.start) - a, end: Math.min(b, w.end) - a })) });
    if (n) out.push(n);
  }
  return out;
}

/**
 * The part of a project between timeline times a and b as new main-track clips and voice tracks (starting at 0).
 * Handles several clips, speed changes (source range = timeline range × speed), gaps, photos, and cross-fades (cut to hard cuts).
 * Returns { clips, audio, missing: [mediaId...] } where `has(mediaId)` tells which media exists on this device.
 */
export function cutRange(project, a, b, has = () => true) {
  const lay = layout(project), clips = [], missing = new Set();
  let t = 0; // end of the previous new clip (timeline seconds, relative to a)
  for (const it of lay.items) {
    const c = it.clip, s0 = Math.max(a, it.start, a + t), s1 = Math.min(b, it.end);
    if (s1 - s0 < 0.05) continue;
    const sp = c.kind === 'image' ? 1 : (c.speed || 1), curved = c.kind !== 'image' && !!(c.ramp || c.reverse);
    // reversed / speed-ramped clips: the section that plays comes from the clip's own curve (a reversed clip starts at its out point)
    const cs0 = curved ? RAMP.sourceAtOffset(c, s0 - it.start) : 0, cs1 = curved ? RAMP.sourceAtOffset(c, s1 - it.start) : 0;
    const n = normalizeClip({
      ...JSON.parse(JSON.stringify(c)), id: uid('clip'), gap: Math.max(0, r3(s0 - a - t)),
      in: c.kind === 'image' ? 0 : curved ? r3(Math.max(c.in, Math.min(cs0, cs1))) : r3(c.in + (s0 - it.start) * sp),
      out: c.kind === 'image' ? r3(s1 - s0) : curved ? r3(Math.min(c.out, Math.max(cs0, cs1))) : r3(Math.min(c.out, c.in + (s1 - it.start) * sp)),
      transition: { type: 'cut', duration: 0.6 }, keyframes: {}, fadeIn: 0, fadeOut: 0,
    });
    if (c.kind !== 'image' && n.out - n.in < 0.05) continue;
    if (c.mediaId && !has(c.mediaId)) missing.add(c.mediaId);
    clips.push(n); t = s1 - a;
  }
  const audio = [];
  for (const x of project.audio || []) {
    if (!x.voice || x.loop) continue;
    const sp = audioSpeed(x), len = (x.out - x.in) / sp, s0 = Math.max(a, x.start), s1 = Math.min(b, x.start + len);
    if (s1 - s0 < 0.05) continue;
    audio.push({ ...JSON.parse(JSON.stringify(x)), id: uid('aud'), start: r3(s0 - a), in: r3(x.in + (s0 - x.start) * sp), out: r3(Math.min(x.out, x.in + (s1 - x.start) * sp)), fadeIn: 0, fadeOut: 0, keyframes: {} });
    if (x.mediaId && !has(x.mediaId)) missing.add(x.mediaId);
  }
  return { clips, audio, missing: [...missing] };
}

/** Horizontal crop position −1 (left edge) … 0 (centre) … +1 (right edge) for a source filling a 9:16 frame. */
export const cropOffset = (v) => clamp(Number.isFinite(+v) ? +v : 0, -1, 1);

/**
 * A new 9:16 project holding just [a, b] of `project`. The source project is not modified.
 * opts: { name, offset (-1..1), captionPreset ('shorts') }
 */
export function makeShortProject(project, a, b, { name, offset = 0, has } = {}) {
  const cut = cutRange(project, a, b, has);
  const p = newProject(name);
  p.settings = { ...p.settings, ratio: '9:16', res: 1080, fit: 'cover', bg: 'black' };
  p.clips = cut.clips.map(c => { c.transform = { ...c.transform, x: cropOffset(offset) }; c.fit = 'inherit'; return c; });
  p.audio = cut.audio;
  p.captionStyle = applyPreset(defaultCaptionStyle(), 'shorts');
  p.captions = rechunk(captionsInRange(project.captions, a, b), { maxWords: p.captionStyle.maxWords });
  return { project: migrate(p), missing: cut.missing, clips: p.clips.length };
}
