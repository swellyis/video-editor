// Captions: data model helpers, styles, word timing, chunking into lines, SRT import / export, custom-word correction.
// Pure functions (no DOM) so they run in unit tests. Times are TIMELINE seconds.
import { uid, clamp } from './util.js';

export const MAX_CAPTIONS = 20000;
export const MAX_CAPTION_CHARS = 300;
export const FONT_KEYS = ['sans', 'condensed', 'serif', 'serifItalic', 'mono', 'system'];

/** Style packs. Picking one copies every field into project.captionStyle (applies to every caption; any control can still be tweaked).
 * Fields beyond the basics: align ('center' | 'left'), anim ('none' | 'pop' | 'type'), hlStyle ('word' | 'sung' | 'box'), glow 0–1, accent (bar). */
const BASE = { font: 'sans', size: 0.05, color: '#ffffff', outline: 0, outlineColor: '#000000', box: false, boxColor: '#000000', boxOpacity: 0.62, hl: false, highlight: '#ffd400', hlStyle: 'word', position: 'bottom', offset: 0, maxWords: 8, maxLines: 2, caps: false, align: 'center', anim: 'none', glow: 0, accent: false };
export const CAPTION_PRESETS = {
  classic: { ...BASE, label: 'Classic', box: true },
  shorts: { ...BASE, label: 'Bold', size: 0.085, outline: 0.2, maxWords: 3, caps: true },
  highlight: { ...BASE, label: 'Word highlight', size: 0.08, outline: 0.2, hl: true, maxWords: 3, caps: true },
  minimal: { ...BASE, label: 'Minimal', font: 'system', size: 0.04, outline: 0.07, maxWords: 10 },
  pop: { ...BASE, label: 'Bold pop', size: 0.09, outline: 0.22, hl: true, highlight: '#ffd400', maxWords: 3, caps: true, anim: 'pop' },
  karaoke: { ...BASE, label: 'Karaoke', size: 0.07, outline: 0.16, hl: true, hlStyle: 'sung', highlight: '#22d3ee', maxWords: 6 },
  lowerThird: { ...BASE, label: 'Lower third', size: 0.045, box: true, boxColor: '#111827', boxOpacity: 0.86, highlight: '#ef4444', align: 'left', accent: true, maxWords: 8 },
  boxed: { ...BASE, label: 'Boxed', font: 'condensed', size: 0.065, color: '#111111', box: true, boxColor: '#ffd400', boxOpacity: 1, maxWords: 4, caps: true },
  outline: { ...BASE, label: 'Outline', size: 0.075, color: '#ffe14d', outline: 0.28, maxWords: 4 },
  neon: { ...BASE, label: 'Neon', font: 'condensed', size: 0.075, color: '#fff7fe', glow: 1, highlight: '#ff2bd6', maxWords: 4, caps: true },
  typewriter: { ...BASE, label: 'Typewriter', font: 'mono', size: 0.048, box: true, boxColor: '#000000', boxOpacity: 0.75, anim: 'type', maxWords: 8 },
  wordBox: { ...BASE, label: 'Word box', size: 0.08, hl: true, hlStyle: 'box', highlight: '#7c3aed', maxWords: 3, caps: true },
};
export const PACK_KEYS = Object.keys(CAPTION_PRESETS);

const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? clamp(v, lo, hi) : d; };

export function defaultCaptionStyle() { return normalizeCaptionStyle({ ...CAPTION_PRESETS.classic, preset: 'classic', show: true }); }
/** A style object with every field present and in range (from a saved project or an import). */
export function normalizeCaptionStyle(s) {
  const d = CAPTION_PRESETS.classic, o = s && typeof s === 'object' ? s : {};
  return {
    preset: o.preset in CAPTION_PRESETS || o.preset === 'custom' ? o.preset : 'classic',
    show: o.show !== false,
    font: FONT_KEYS.includes(o.font) ? o.font : d.font,
    size: num(o.size, 0.02, 0.2, d.size),
    color: hex(o.color, d.color),
    outline: num(o.outline, 0, 0.4, d.outline),
    outlineColor: hex(o.outlineColor, d.outlineColor),
    box: o.box === undefined ? d.box : o.box === true,
    boxColor: hex(o.boxColor, d.boxColor),
    boxOpacity: num(o.boxOpacity, 0, 1, d.boxOpacity),
    hl: o.hl === true,
    highlight: hex(o.highlight, d.highlight),
    position: ['bottom', 'middle', 'top'].includes(o.position) ? o.position : 'bottom',
    offset: num(o.offset, -0.3, 0.3, 0),
    maxWords: Math.round(num(o.maxWords, 1, 20, d.maxWords)),
    maxLines: Math.round(num(o.maxLines, 1, 3, d.maxLines)),
    caps: o.caps === true,
    align: o.align === 'left' ? 'left' : 'center',
    anim: ['pop', 'type'].includes(o.anim) ? o.anim : 'none',
    hlStyle: ['sung', 'box'].includes(o.hlStyle) ? o.hlStyle : 'word',
    glow: num(o.glow, 0, 1, 0),
    accent: o.accent === true,
  };
}
export function applyPreset(style, key) {
  const p = CAPTION_PRESETS[key]; if (!p) return style;
  const { label, ...rest } = p; void label;
  return normalizeCaptionStyle({ ...rest, preset: key, show: style ? style.show !== false : true });
}

// ---------------------------------------------------------------- caption items
const round3 = (v) => Math.round(v * 1000) / 1000;
export const tokens = (text) => String(text || '').split(/\s+/).filter(Boolean);

export function newCaption(start, end, text, words) {
  const c = { id: uid('cap'), start: round3(Math.max(0, start)), end: round3(Math.max(start + 0.2, end)), text: String(text || '').slice(0, MAX_CAPTION_CHARS) };
  if (words && words.length) c.words = words.map(w => ({ w: w.w, start: round3(w.start), end: round3(w.end) }));
  return c;
}
/** One saved/imported caption → a clean one (or null when unusable). */
export function normalizeCaption(c) {
  if (!c || typeof c !== 'object') return null;
  const start = +c.start, end = +c.end;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.max(0, start), e = Math.max(s + 0.05, end);
  const text = String(c.text == null ? '' : c.text).replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION_CHARS);
  const out = { id: typeof c.id === 'string' && c.id ? c.id.slice(0, 40) : uid('cap'), start: round3(s), end: round3(e), text };
  if (Number.isInteger(c.lane) && c.lane >= 0 && c.lane < 1000) out.lane = c.lane;
  if (Array.isArray(c.words) && c.words.length && c.words.length <= 120) {
    const ws = [];
    for (const w of c.words) {
      if (!w || typeof w.w !== 'string' || !Number.isFinite(+w.start) || !Number.isFinite(+w.end)) { ws.length = 0; break; }
      ws.push({ w: w.w.slice(0, 60), start: round3(Math.max(0, +w.start)), end: round3(Math.max(+w.start, +w.end)) });
    }
    if (ws.length) out.words = ws;
  }
  return out;
}
export function normalizeCaptions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CAPTIONS)) { const n = normalizeCaption(c); if (n) out.push(n); }
  return out;
}

/** Word timings of a caption: the stored ones when they still match the text, otherwise spread evenly (by letters) over the caption. */
export function captionWords(c) {
  const toks = tokens(c.text);
  if (!toks.length) return [];
  if (c.words && c.words.length === toks.length) return c.words.map((w, i) => ({ w: toks[i], start: w.start, end: w.end }));
  const total = toks.reduce((n, t) => n + t.length + 1, 0), span = Math.max(0.05, c.end - c.start);
  let at = c.start;
  return toks.map((t) => { const d = span * (t.length + 1) / total; const w = { w: t, start: at, end: at + d }; at += d; return w; });
}
/** After the text was edited: keep the word timings if the word count is unchanged (a spelling fix), else drop them (timed evenly). */
export function reconcileWords(c) {
  const toks = tokens(c.text);
  if (c.words && c.words.length === toks.length) c.words = c.words.map((w, i) => ({ ...w, w: toks[i] }));
  else delete c.words;
}
/** Move / stretch the words together with their caption: old range → current [start, end]. */
export function retimeWords(c, oldStart, oldEnd) {
  if (!c.words || !c.words.length) return;
  const k = (c.end - c.start) / Math.max(0.05, oldEnd - oldStart);
  c.words = c.words.map(w => ({ ...w, start: round3(c.start + (w.start - oldStart) * k), end: round3(c.start + (w.end - oldStart) * k) }));
}
export function shiftWords(c, dt) { if (c.words) c.words = c.words.map(w => ({ ...w, start: round3(w.start + dt), end: round3(w.end + dt) })); }

/** Caption shown at time t (the one that started last when they overlap). */
export function captionAt(list, t) {
  let best = null;
  for (const c of list) if (t >= c.start && t < c.end && (!best || c.start >= best.start)) best = c;
  return best;
}

/** Split a caption at time t into two (words are divided too). Returns [a, b] or null. */
export function splitCaption(c, t) {
  if (t <= c.start + 0.1 || t >= c.end - 0.1) return null;
  const ws = captionWords(c);
  let k = ws.findIndex(w => w.start >= t - 1e-6); if (k < 0) k = ws.length;
  if (ws.length >= 2) k = clamp(k, 1, ws.length - 1);
  const left = ws.slice(0, k), right = ws.slice(k);
  const mk = (arr, s, e, id) => ({ id, start: round3(s), end: round3(e), text: arr.map(w => w.w).join(' '), ...(c.words ? { words: arr.map(w => ({ w: w.w, start: round3(w.start), end: round3(w.end) })) } : {}) });
  const out = [mk(left, c.start, t, c.id), mk(right, t, c.end, uid('cap'))];
  if (c.lane !== undefined) for (const x of out) x.lane = c.lane;
  return out;
}

// ---------------------------------------------------------------- chunking
/**
 * Turn timed words into caption lines. A new caption starts after `maxWords` words, after a pause (> gap seconds), or after
 * sentence-ending punctuation once the line has at least 2 words. Word times are kept; the caption spans first.start .. last.end.
 */
export function chunkWords(words, { maxWords = 8, gap = 0.7, maxChars = 60 } = {}) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push(newCaption(cur[0].start, cur[cur.length - 1].end, cur.map(w => w.w).join(' '), cur)); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > gap || cur.length >= maxWords || cur.map(x => x.w).join(' ').length + w.w.length + 1 > maxChars)) flush();
    cur.push(w);
    if (/[.!?…]["')\]]*$/.test(w.w) && cur.length >= 2) flush();
    else if (/[,;:]$/.test(w.w) && cur.length >= Math.max(3, maxWords - 1)) flush();
  }
  flush();
  // a caption never ends after the next one starts, and lasts at least a moment
  for (let i = 0; i < out.length; i++) {
    const nx = out[i + 1];
    if (nx && out[i].end > nx.start) out[i].end = Math.max(out[i].start + 0.05, nx.start);
    if (out[i].end - out[i].start < 0.3) out[i].end = round3(Math.min(nx ? nx.start : Infinity, out[i].start + 0.3));
  }
  return out;
}
/** Re-split existing captions into lines of at most `maxWords` words (timed words are kept; text edits are kept; captions with a long gap stay apart). */
export function rechunk(captions, opts) {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const words = [];
  for (const c of sorted) for (const w of captionWords(c)) words.push(w);
  return chunkWords(words, opts);
}

// ---------------------------------------------------------------- SRT
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(ms / 3600000)}:${pad((ms % 3600000) / 60000)}:${pad((ms % 60000) / 1000)},${pad(ms % 1000, 3)}`;
}
export function formatSrt(captions) {
  const list = [...captions].filter(c => tokens(c.text).length).sort((a, b) => a.start - b.start);
  return list.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.replace(/\n{2,}/g, '\n').trim()}\n`).join('\n');
}
const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const toSec = (h, m, s, ms) => (+(h || 0)) * 3600 + (+m) * 60 + (+s) + (+String(ms).padEnd(3, '0')) / 1000;
/** Parse SubRip (also tolerates WebVTT headers, BOM, CRLF, missing numbers, <i> tags). Returns { captions, skipped }. */
export function parseSrt(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/);
  const captions = []; let skipped = 0;
  for (const b of blocks) {
    const lines = b.split('\n').filter((l, i) => !(i === 0 && /^WEBVTT/.test(l)));
    const ti = lines.findIndex(l => TIME.test(l));
    if (ti < 0) { if (b.trim() && !/^WEBVTT|^NOTE/.test(b.trim()) && !/^\d+$/.test(b.trim())) skipped++; continue; }
    const m = TIME.exec(lines[ti]);
    const start = toSec(m[1], m[2], m[3], m[4]), end = toSec(m[5], m[6], m[7], m[8]);
    const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (!body || !(end > start)) { skipped++; continue; }
    const c = normalizeCaption({ start, end, text: body });
    if (c) captions.push(c); else skipped++;
    if (captions.length >= MAX_CAPTIONS) break;
  }
  return { captions, skipped };
}

// ---------------------------------------------------------------- custom words (spelling hints)
const lev = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
};
/** Comma / line separated hint words → a clean list. */
export const parseCustomWords = (s) => [...new Set(String(s || '').split(/[,\n;]+/).map(x => x.trim()).filter(x => x && x.length <= 40))].slice(0, 100);
/**
 * Snap near-miss words to the user's custom words (brand names, people, places): a word within a small spelling distance of a custom word
 * (1 edit for 4-7 letters, 2 for longer) is replaced, keeping punctuation. Returns how many words changed.
 */
export function applyCustomWords(words, custom) {
  const list = custom.map(w => ({ w, k: w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '') })).filter(x => x.k.length >= 4);
  let n = 0;
  for (const wd of words) {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(wd.w); if (!m || !m[2]) continue;
    const key = m[2].toLowerCase();
    let best = null, bd = 99;
    for (const c of list) { const lim = c.k.length >= 8 ? 2 : 1; const d = key === c.k ? 0 : lev(key, c.k); if (d <= lim && d < bd) { bd = d; best = c; } }
    if (best && m[2] !== best.w) { wd.w = m[1] + best.w + m[3]; n++; }
  }
  return n;
}
