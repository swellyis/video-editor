// Filler-word detection from timed transcript words (pure). English-first.
// Whisper often drops um/uh/er/ah (it "cleans" them up), so a transcript with none is common and honest —
// this only finds what the transcript actually contains, plus repeated words / short stutters.
import { captionWords } from './captions.js';

/** Single-token fillers (matched on the word with punctuation stripped). */
export const FILLERS = ['um', 'uh', 'er', 'ah', 'uhm', 'hmm', 'mm', 'mhm', 'eh', 'huh'];
/** Optional multi-word fillers (matched as consecutive tokens). */
export const PHRASES = [['you', 'know'], ['sort', 'of'], ['kind', 'of'], ['i', 'mean']];
/** Optional single-word fillers that are also everyday words — only flagged when the option is on. */
export const OPTIONAL = ['like', 'basically', 'literally', 'actually'];

const strip = (w) => String(w || '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Flatten every caption's words into one timeline list [{ w, start, end, ci, wi }]. */
export function allWords(captions) {
  const out = [];
  const list = [...(captions || [])].sort((a, b) => a.start - b.start);
  list.forEach((c, ci) => captionWords(c).forEach((w, wi) => out.push({ w: w.w, start: w.start, end: Math.max(w.end, w.start + 0.05), ci, wi })));
  return out;
}

/**
 * Find fillers in `words` (from allWords or a flat list).
 * opts.phrases: also flag "you know" / "sort of" / …
 * opts.optional: also flag "like" / "basically" / …
 * opts.stutters: flag a word repeated right after itself (with ≤ 0.45 s between)
 * opts.minPause: unused here (kept for the UI's "short pause" filter if added later)
 * Returns [{ kind, label, a, b, idx: [i,…], text }] sorted by time; overlapping hits are kept (the review list can filter).
 */
export function findFillers(words, { phrases = true, optional = false, stutters = true } = {}) {
  const out = [], used = new Set();
  const push = (hit) => { if (hit.idx.some(i => used.has(i))) return; hit.idx.forEach(i => used.add(i)); out.push(hit); };
  // multi-word phrases first (longer matches win)
  if (phrases) {
    for (let i = 0; i < words.length; i++) {
      for (const ph of PHRASES) {
        if (i + ph.length > words.length) continue;
        let ok = true; for (let k = 0; k < ph.length; k++) if (strip(words[i + k].w) !== ph[k]) { ok = false; break; }
        if (!ok) continue;
        const idx = [...Array(ph.length)].map((_, k) => i + k);
        push({ kind: 'phrase', label: ph.join(' '), a: words[i].start, b: words[i + ph.length - 1].end, idx, text: idx.map(j => words[j].w).join(' ') });
      }
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const t = strip(words[i].w); if (!t) continue;
    if (FILLERS.includes(t)) { push({ kind: 'filler', label: t, a: words[i].start, b: words[i].end, idx: [i], text: words[i].w }); continue; }
    if (optional && OPTIONAL.includes(t)) { push({ kind: 'optional', label: t, a: words[i].start, b: words[i].end, idx: [i], text: words[i].w }); continue; }
    if (stutters && i + 1 < words.length && !used.has(i + 1)) {
      const n = strip(words[i + 1].w);
      if (t && t === n && words[i + 1].start - words[i].end <= 0.45) {
        push({ kind: 'stutter', label: t + '…', a: words[i].start, b: words[i + 1].end, idx: [i, i + 1], text: words[i].w + ' ' + words[i + 1].w });
      }
    }
  }
  out.sort((x, y) => x.a - y.a);
  return out;
}

/** Counts by label (for the review header). */
export function countsOf(hits) {
  const m = new Map();
  for (const h of hits) m.set(h.label, (m.get(h.label) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Indexes of hit words to cut, honouring a Set of dismissed hit keys (key = a.toFixed(3)+':'+label). */
export const hitKey = (h) => h.a.toFixed(3) + ':' + h.label;
export function indexesToCut(hits, dismissed) {
  const idx = new Set();
  for (const h of hits) if (!(dismissed && dismissed.has(hitKey(h)))) h.idx.forEach(i => idx.add(i));
  return [...idx].sort((a, b) => a - b);
}
