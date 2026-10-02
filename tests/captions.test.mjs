// Unit tests for captions: data model, chunking, SRT, custom words, migration, split, ripple and the transcription helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, migrate, normalizeClip, splitItem, rippleShift } from '../js/model.js';
import {
  CAPTION_PRESETS, defaultCaptionStyle, normalizeCaptionStyle, applyPreset, newCaption, normalizeCaptions, captionWords, reconcileWords, retimeWords,
  captionAt, splitCaption, chunkWords, rechunk, srtTime, formatSrt, parseSrt, parseCustomWords, applyCustomWords,
} from '../js/captions.js';
import { trustedCount, spread, dropLoops, repoFor, MODELS } from '../js/transcribe.js';

const W = (s) => s.split(' ').map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.45 }));

test('every preset is a complete, valid style', () => {
  for (const k of Object.keys(CAPTION_PRESETS)) {
    const s = applyPreset(defaultCaptionStyle(), k);
    assert.equal(s.preset, k); assert.ok(s.size > 0 && s.size <= 0.2); assert.match(s.color, /^#[0-9a-f]{6}$/); assert.ok(s.maxWords >= 1);
  }
  assert.equal(applyPreset(defaultCaptionStyle(), 'highlight').hl, true);
  assert.equal(applyPreset({ ...defaultCaptionStyle(), show: false }, 'shorts').show, false); // choosing a look doesn't switch captions back on
});
test('normalizeCaptionStyle repairs junk', () => {
  const s = normalizeCaptionStyle({ size: 99, color: 'red', font: 'comic', position: 'left', maxWords: -3, offset: 7, box: 'yes', hl: 1 });
  assert.ok(s.size <= 0.2 && /^#/.test(s.color) && s.font === 'sans' && s.position === 'bottom' && s.maxWords === 1 && s.offset <= 0.3 && s.box === false && s.hl === false);
  assert.equal(normalizeCaptionStyle(null).preset, 'classic');
});
test('captions are normalised: ids, order of times, text, words', () => {
  const list = normalizeCaptions([{ start: 5, end: 1, text: ' hi  there ' }, null, { id: 'x', start: 2, end: 3, text: 'a b', words: [{ w: 'a', start: 2, end: 2.4 }, { w: 'b', start: 2.4, end: 3 }] }, { start: 1, end: 2, text: 7 }]);
  assert.ok(list.every(c => c.id && c.end > c.start));
  assert.equal(list.find(c => c.id === 'x').words.length, 2);
  assert.ok(list.some(c => c.text === 'hi there'));
});
test('words: kept when the text keeps its word count, dropped (even spread) otherwise', () => {
  const c = newCaption(1, 3, 'a b c', W('a b c').map(w => ({ ...w, start: w.start + 1, end: w.end + 1 })));
  c.text = 'a B c'; reconcileWords(c); assert.equal(c.words[1].w, 'B'); assert.equal(c.words[1].start, 1.5);
  c.text = 'a b c d'; reconcileWords(c); assert.equal(c.words, undefined);
  const ws = captionWords(c); assert.equal(ws.length, 4); assert.ok(ws[0].start === 1 && Math.abs(ws[3].end - 3) < 1e-9);
});
test('retimeWords carries words along when a caption is moved or stretched', () => {
  const c = newCaption(2, 4, 'x y', [{ w: 'x', start: 2, end: 3 }, { w: 'y', start: 3, end: 4 }]);
  c.start = 5; c.end = 9; retimeWords(c, 2, 4);
  assert.deepEqual(c.words.map(w => [w.start, w.end]), [[5, 7], [7, 9]]);
});
test('captionAt picks the caption on screen (the latest start wins on overlap)', () => {
  const list = [newCaption(0, 4, 'a'), newCaption(2, 3, 'b')];
  assert.equal(captionAt(list, 1).text, 'a'); assert.equal(captionAt(list, 2.5).text, 'b'); assert.equal(captionAt(list, 4), null);
});
test('splitCaption divides text and words at the playhead', () => {
  const c = newCaption(0, 4, 'one two three four', W('one two three four').map((w, i) => ({ ...w, start: i, end: i + 0.9 })));
  const [a, b] = splitCaption(c, 1.95);
  assert.equal(a.text, 'one two'); assert.equal(b.text, 'three four'); assert.equal(a.id, c.id); assert.notEqual(b.id, c.id);
  assert.equal(a.end, 1.95); assert.equal(b.start, 1.95); assert.equal(a.words.length, 2); assert.equal(b.words.length, 2);
  assert.equal(splitCaption(c, 0.05), null); assert.equal(splitCaption(c, 3.95), null);
  const one = splitCaption(newCaption(0, 4, 'single'), 2); assert.equal(one[0].text.length + one[1].text.length > 0, true);
});
test('splitItem splits a caption and ripple moves later captions with the timeline', () => {
  const p = newProject('T'); p.captions = [newCaption(1, 5, 'a b c d', W('a b c d').map((w, i) => ({ ...w, start: 1 + i, end: 1.9 + i })))];
  const r = splitItem(p, { type: 'caption', id: p.captions[0].id }, 3);
  assert.equal(r.type, 'caption'); assert.equal(p.captions.length, 2); assert.equal(p.captions[0].end, 3);
  assert.equal(splitItem(p, { type: 'caption', id: p.captions[0].id }, 9).fail, true);
  const q = newProject('Q'); q.clips = [normalizeClip({ id: 'a', mediaId: 'm', name: 'a', kind: 'video', srcDuration: 60, in: 0, out: 10 })];
  q.captions = [newCaption(12, 14, 'later', [{ w: 'later', start: 12, end: 14 }]), newCaption(1, 2, 'early')];
  rippleShift(q, 10, -4, true);
  assert.equal(q.captions[0].start, 8); assert.equal(q.captions[0].words[0].start, 8); assert.equal(q.captions[1].start, 1);
});
test('chunkWords: max words, pauses and sentence ends start new captions', () => {
  const ws = W('In the beginning God created the heavens and the earth').map(w => ({ ...w }));
  let c = chunkWords(ws, { maxWords: 4 }); assert.ok(c.every(x => x.words.length <= 4) && c.length === 3);
  assert.equal(c.map(x => x.text).join(' '), ws.map(w => w.w).join(' '));
  const gap = chunkWords([{ w: 'a', start: 0, end: 1 }, { w: 'b', start: 5, end: 6 }], { maxWords: 8 }); assert.equal(gap.length, 2);
  const sent = chunkWords([{ w: 'Hello', start: 0, end: 0.4 }, { w: 'there.', start: 0.5, end: 0.9 }, { w: 'Amen', start: 1, end: 1.4 }], { maxWords: 8 });
  assert.equal(sent.length, 2); assert.equal(sent[0].text, 'Hello there.');
  assert.ok(c.every((x, i) => i === 0 || x.start >= c[i - 1].end - 1e-9));
});
test('rechunk keeps the text and word times when the words-per-caption changes', () => {
  const big = chunkWords(W('one two three four five six seven eight nine ten'), { maxWords: 10 });
  const small = rechunk(big, { maxWords: 3 });
  assert.equal(small.map(c => c.text).join(' '), 'one two three four five six seven eight nine ten'); assert.ok(small.every(c => c.words.length <= 3));
  assert.equal(small[1].words[0].start, 1.5);
});
test('SRT: format and parse round trip, with BOM, CRLF, tags, VTT, multi-line cues and junk', () => {
  assert.equal(srtTime(3661.2504), '01:01:01,250');
  const caps = [newCaption(1, 2.5, 'Hello world'), newCaption(3661.25, 3662, 'Amen')];
  const text = formatSrt(caps);
  assert.match(text, /^1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n01:01:01,250 --> 01:01:02,000\nAmen\n$/);
  const back = parseSrt(text).captions; assert.deepEqual(back.map(c => [c.start, c.end, c.text]), [[1, 2.5, 'Hello world'], [3661.25, 3662, 'Amen']]);
  const odd = parseSrt('\uFEFF1\r\n00:00:00,500 --> 00:00:02,000\r\n<i>Grace</i> and\r\npeace\r\n\r\ngarbage block\r\n\r\n3\r\n00:00:05.000 --> 00:00:06.250\r\n{\\an8}Amen.\r\n');
  assert.deepEqual(odd.captions.map(c => c.text), ['Grace and peace', 'Amen.']); assert.equal(odd.captions[1].end, 6.25); assert.equal(odd.skipped, 1);
  const vtt = parseSrt('WEBVTT\n\n00:01.000 --> 00:02.000\nshort form\n\n00:00:03.000 --> 00:00:04.000 align:start\nlong form\n');
  assert.deepEqual(vtt.captions.map(c => c.text), ['short form', 'long form']);
  assert.equal(parseSrt('nothing here').captions.length, 0); assert.equal(parseSrt('').captions.length, 0);
});
test('custom words: parsing and the spelling snap', () => {
  assert.deepEqual(parseCustomWords('Jesus, Hallelujah;\nDeuteronomy, Jesus'), ['Jesus', 'Hallelujah', 'Deuteronomy']);
  const ws = [{ w: 'Deuteronomy,', start: 0, end: 1 }, { w: 'Deuteronimy.', start: 1, end: 2 }, { w: 'halleluia', start: 2, end: 3 }, { w: 'Genesis', start: 3, end: 4 }, { w: 'cat', start: 4, end: 5 }, { w: 'Hallelujah!', start: 5, end: 6 }];
  const n = applyCustomWords(ws, ['Deuteronomy', 'Hallelujah']);
  assert.deepEqual(ws.map(w => w.w), ['Deuteronomy,', 'Deuteronomy.', 'Hallelujah', 'Genesis', 'cat', 'Hallelujah!']); assert.equal(n, 2);
});
test('migrate gives old projects an empty caption list and repairs damaged ones', () => {
  const old = migrate({ name: 'old', clips: [] }); assert.deepEqual(old.captions, []); assert.equal(old.captionStyle.preset, 'classic');
  const bad = migrate({ name: 'b', clips: [], captions: 'nope', captionStyle: 5 }); assert.deepEqual(bad.captions, []); assert.ok(bad.captionStyle.size > 0);
  const p = newProject('x'); p.captions = [newCaption(1, 2, 'kept')]; p.captionStyle.color = '#112233';
  const again = migrate(JSON.parse(JSON.stringify(p))); assert.equal(again.captions[0].text, 'kept'); assert.equal(again.captionStyle.color, '#112233');
});
test('transcription helpers: timing collapse, spreading, loops, model choice', () => {
  const good = [{ w: 'a', start: 0, end: 0.4 }, { w: 'b', start: 0.5, end: 0.9 }, { w: 'c', start: 1, end: 1.4 }];
  assert.equal(trustedCount(good), 3);
  const collapsed = [...good, { w: 'd', start: 2, end: 2.05 }, { w: 'e', start: 2, end: 2.05 }, { w: 'f', start: 2, end: 2.05 }, { w: 'g', start: 2, end: 2.05 }];
  assert.equal(trustedCount(collapsed), 3);
  assert.equal(trustedCount([{ w: 'x', start: 5, end: 6 }, { w: 'y', start: 2, end: 3 }]), 1);
  const sp = spread(collapsed.slice(3), 10, 14); assert.ok(sp[0].start === 10 && Math.abs(sp[3].end - 14) < 1e-9 && sp.every((w, i) => i === 0 || w.start >= sp[i - 1].end - 1e-9));
  assert.equal(dropLoops(Array.from({ length: 9 }, (_, i) => ({ w: 'Thank', start: i, end: i + 1 }))).length, 3);
  assert.equal(repoFor('fast', 'english'), 'Xenova/whisper-tiny.en'); assert.equal(repoFor('better', 'spanish'), 'Xenova/whisper-base'); assert.equal(repoFor('fast', 'auto'), 'Xenova/whisper-tiny');
  assert.ok(MODELS.fast.mb < MODELS.better.mb);
});
