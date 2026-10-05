import test from 'node:test';
import assert from 'node:assert/strict';
import { FILLERS, findFillers, countsOf, allWords, indexesToCut, hitKey } from '../js/fillers.js';
import { newCaption } from '../js/captions.js';

const W = (pairs) => pairs.map(([w, s, e]) => ({ w, start: s, end: e }));

test('finds um/uh/er/ah/hmm (case/punct insensitive)', () => {
  const h = findFillers(W([['Hello', 0, 0.4], ['Um,', 0.5, 0.7], ['uh', 0.9, 1.0], ['world', 1.2, 1.6], ['HMM', 2, 2.2]]));
  assert.deepEqual(h.map(x => x.label), ['um', 'uh', 'hmm']);
  assert.ok(FILLERS.includes('um') && FILLERS.includes('er') && FILLERS.includes('ah'));
});
test('optional phrases and "like" only when asked', () => {
  const ws = W([['Well', 0, 0.3], ['you', 0.4, 0.5], ['know', 0.5, 0.7], ['I', 0.8, 0.9], ['like', 1.0, 1.2], ['really', 1.3, 1.6]]);
  assert.equal(findFillers(ws, { phrases: false, optional: false }).length, 0);
  const withP = findFillers(ws, { phrases: true, optional: false });
  assert.equal(withP.length, 1); assert.equal(withP[0].label, 'you know');
  const withO = findFillers(ws, { phrases: true, optional: true });
  assert.ok(withO.some(h => h.label === 'like') && withO.some(h => h.label === 'you know'));
});
test('stutters: a word said twice in a row within 0.45 s', () => {
  const h = findFillers(W([['I', 0, 0.2], ['I', 0.25, 0.4], ['think', 0.5, 0.9], ['the', 1, 1.2], ['the', 2.0, 2.2], ['plan', 2.3, 2.6]]), { stutters: true });
  assert.equal(h.filter(x => x.kind === 'stutter').length, 1, JSON.stringify(h)); // only the close "I I"
  assert.equal(findFillers(W([['I', 0, 0.2], ['I', 0.25, 0.4]]), { stutters: false }).length, 0);
});
test('countsOf groups by label; indexesToCut respects dismissals', () => {
  const h = findFillers(W([['um', 0, 0.2], ['uh', 1, 1.2], ['um', 2, 2.2]]));
  assert.deepEqual(countsOf(h), [['um', 2], ['uh', 1]]);
  const d = new Set([hitKey(h[0])]);
  assert.deepEqual(indexesToCut(h, d), [1, 2]);
});
test('allWords flattens caption word timings in order', () => {
  const caps = [
    newCaption(0, 1, 'And so', [{ w: 'And', start: 0, end: 0.4 }, { w: 'so', start: 0.4, end: 0.7 }]),
    newCaption(1, 2, 'um hello', [{ w: 'um', start: 1, end: 1.2 }, { w: 'hello', start: 1.3, end: 1.8 }]),
  ];
  const w = allWords(caps);
  assert.equal(w.length, 4); assert.equal(w[2].w, 'um'); assert.equal(w[2].ci, 1);
});
test('honest empty: a clean transcript yields no fillers', () => {
  assert.equal(findFillers(W([['Ask', 0, 0.3], ['not', 0.4, 0.6], ['what', 0.7, 1.0]])).length, 0);
});
