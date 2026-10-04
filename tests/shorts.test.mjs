import test from 'node:test';
import assert from 'node:assert/strict';
import { findScripture, buildSentences, findCandidates, padRange, snapToWords, nudge, captionsInRange, cutRange, makeShortProject, wordsOf, scoreRun, speechLevel, cropOffset } from '../js/shorts.js';
import { newProject, newClipFromMedia, layout } from '../js/model.js';
import { newCaption } from '../js/captions.js';

// a transcript: [text, pause after] pairs -> one caption per sentence with word timings (0.35 s / word)
function transcript(spec, t0 = 0, wps = 0.35) {
  const caps = []; let t = t0;
  for (const [text, pause = 0.3] of spec) {
    const ws = text.split(' '), words = ws.map((w, i) => ({ w, start: t + i * wps, end: t + (i + 1) * wps - 0.04 }));
    caps.push(newCaption(t, t + ws.length * wps, text, words)); t += ws.length * wps + pause;
  }
  return caps;
}
const filler = (n, tag = 'x') => Array.from({ length: n }, (_, i) => [`and then we went on to the next little thing number ${i} ${tag} in the story today.`, 0.3]);

test('scripture references: books, numbered books, chapter/verse words, ranges', () => {
  assert.deepEqual(findScripture('Turn to John 3:16 today'), ['John 3:16']);
  assert.deepEqual(findScripture('In Romans chapter 8 verse 28 we read'), ['Romans chapter 8 verse 28']);
  assert.deepEqual(findScripture('First Corinthians 13:4-7 says love is patient'), ['First Corinthians 13:4-7']);
  assert.deepEqual(findScripture('see 1 Peter 2:9 and Psalm 23'), ['1 Peter 2:9', 'Psalm 23']);
  assert.deepEqual(findScripture('John said hello and Mark went home'), []);
  assert.deepEqual(findScripture('about 30 people'), []);
});

test('sentences split at . ? ! and at long pauses, not at abbreviations', () => {
  const caps = transcript([['Dr. Smith asked why we pray.', 0.2], ['Because God listens! Do you believe that?', 0.2], ['yes we believe it all the time', 1.5], ['and so on', 0.1]]);
  const S = buildSentences(caps);
  assert.equal(S.length, 5);
  assert.equal(S[0].text, 'Dr. Smith asked why we pray.');
  assert.equal(S[0].terminal, '.'); assert.equal(S[1].terminal, '!'); assert.equal(S[2].terminal, '?');
  assert.equal(S[3].terminal, ''); assert.ok(S[3].pauseAfter >= 1.4);
});

test('sentences: runaway text without punctuation is cut after 60 words', () => {
  const caps = transcript(Array.from({ length: 13 }, (_, k) => [Array.from({ length: 10 }, (_, i) => 'w' + (k * 10 + i)).join(' '), 0]));
  const S = buildSentences(caps);
  assert.ok(S.length >= 3 && S.every(s => s.words.length <= 60));
});

test('candidates are 20-60 s, ranked best first, never overlap, and a scripture + question hook wins', () => {
  const good = [['Have you ever wondered why God loves you?', 0.4], ['Look at John 3:16.', 0.3], ['For God so loved the world that he gave his only son so that whoever believes in him shall not perish.', 0.3], ['That is the gospel and it is not about what you do, but about what he has done!', 0.3], ['It changes everything about how we live every single day of our lives together.', 0.3], ['Amen.', 1.2]];
  const spec = [...filler(25, 'a'), ...good, ...filler(25, 'b')];
  const caps = transcript(spec);
  const c = findCandidates(caps, { count: 6 });
  assert.ok(c.length >= 3);
  for (const x of c) assert.ok(x.len >= 19 && x.len <= 61, 'length ' + x.len);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].score >= c[i].score);
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) assert.ok(Math.min(c[i].end, c[j].end) - Math.max(c[i].start, c[j].start) < 0.2 * 60);
  const top = c[0];
  assert.ok(top.scripture.includes('John 3:16'), JSON.stringify(top.reasons));
  assert.match(top.text, /wondered why God loves you/);
  assert.ok(top.reasons.some(r => /question/i.test(r.label)));
  assert.ok(top.reasons.every(r => typeof r.label === 'string' && Number.isFinite(r.pts)));
});

test('a clip that starts mid-thought and ends mid-sentence scores lower than a clean one', () => {
  const caps = transcript([['But that is why it matters so much to all of us here today in this house.', 0.2], ['So we keep going further and further into the long story of grace and truth together.', 0.2], ['And then the next part comes along and it keeps on going for a good while and', 0.2]]);
  const S = buildSentences(caps), F = S.map(s => ({ refs: [], q: 0, bang: 0, contrast: false, payoff: false, punch: false, faith: 0, nw: s.words.length }));
  const bad = scoreRun(S, F, 0, 2);
  const caps2 = transcript([['Why does God let us wait for so long in the middle of the storm?', 0.6], ['Because he is shaping something in you that comfort never could.', 0.6], ['Trust him today.', 1.0]]);
  const S2 = buildSentences(caps2), F2 = S2.map(s => ({ refs: [], q: s.text.includes('?') ? 1 : 0, bang: 0, contrast: false, payoff: false, punch: false, faith: 1, nw: s.words.length }));
  const good = scoreRun(S2, F2, 0, 2);
  assert.ok(good.score > bad.score + 15, good.score + ' vs ' + bad.score);
  assert.ok(bad.reasons.some(r => /mid-thought/.test(r.label)) && bad.reasons.some(r => /mid-sentence/.test(r.label)));
});

test('voice energy raises the score of the emphatic moment; silence inside lowers it', () => {
  const spec = [...filler(20, 'a'), ['Why does it matter that you stand up and speak the truth out loud today?', 0.5], ['Because the world is waiting for people who will not be afraid of the Lord.', 0.5], ['Stand firm in the faith and never let go of the hope you have received in Christ.', 1.0], ...filler(20, 'b')];
  const caps = transcript(spec);
  const base = findCandidates(caps, { count: 1 })[0];
  const step = 0.5, n = 400, v = new Float32Array(n).fill(0.1);
  for (let i = Math.floor(base.start / step); i < Math.ceil(base.end / step); i++) v[i] = 0.25;
  const withEnv = findCandidates(caps, { count: 1, env: { step, values: v } })[0];
  assert.ok(withEnv.score > base.score);
  assert.ok(withEnv.reasons.some(r => /delivery/i.test(r.label)));
  assert.ok(speechLevel({ step, values: v }) > 0);
  const gaps = transcript([['Why does it matter so much that we stand up and speak out about it?', 3.5], ['Because the world is waiting for people who are not afraid of anything at all.', 3.5], ['Stand firm in the faith and never let go of the hope you have received in Christ.', 1]]);
  const S = buildSentences(gaps), F = S.map(s => ({ refs: [], q: 0, bang: 0, contrast: false, payoff: false, punch: false, faith: 0, nw: s.words.length }));
  assert.ok(scoreRun(S, F, 0, 2).reasons.some(r => /silence/i.test(r.label)));
});

test('padRange keeps clear of neighbouring words and never starts before 0', () => {
  const ws = [{ w: 'a', start: 0.1, end: 0.4 }, { w: 'b', start: 0.5, end: 0.9 }, { w: 'c', start: 1.0, end: 1.4 }, { w: 'd', start: 1.5, end: 1.9 }];
  const r = padRange(ws, 1, 2, {});
  assert.ok(r.start >= 0.4 && r.start <= 0.5 && r.end >= 1.4 && r.end <= 1.5, JSON.stringify(r));
  assert.equal(padRange(ws, 0, 0, {}).start, 0);
});

test('snapToWords moves a cut out of the middle of a word; nudge clamps length and total', () => {
  const ws = [{ w: 'hello', start: 10, end: 10.5 }, { w: 'world', start: 10.6, end: 11.2 }];
  assert.equal(snapToWords(ws, 10.3, 'start'), 9.92);
  assert.equal(snapToWords(ws, 10.3, 'end'), 10.58);
  assert.equal(snapToWords(ws, 10.55, 'end'), 10.55);
  const words = wordsOf(transcript(filler(40)));
  const r = { start: 20, end: 50 };
  assert.ok(nudge(r, 'end', -100, words, 600).end >= 25);          // at least 5 s
  assert.ok(nudge(r, 'end', 500, words, 600).end - 20 <= 90.2);    // at most 90 s
  assert.ok(nudge(r, 'start', -500, words, 600).start >= 0);
  assert.ok(nudge({ start: 580, end: 595 }, 'end', 30, [], 600).end <= 600);
  assert.ok(nudge(r, 'start', 1, words, 600).start > 20);
});

test('captionsInRange shifts to 0 and trims a caption cut in half by its words', () => {
  const caps = transcript([['one two three four five six', 0.3], ['seven eight nine ten', 0.3]]);   // words every 0.35 s
  const a = caps[0].start + 3 * 0.35, b = caps[1].start + 2 * 0.35;                                       // starts at "four", ends before "nine"
  const out = captionsInRange(caps, a - 0.01, b);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'four five six'); assert.ok(out[0].start >= 0 && out[0].start < 0.05);
  assert.equal(out[1].text, 'seven eight');
  assert.ok(out.every(c => c.words.length === c.text.split(' ').length));
  assert.equal(captionsInRange(caps, 500, 600).length, 0);
});

const media = (id, dur) => ({ id, name: id + '.mp4', kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: true });
test('cutRange: speed changes map timeline time to source time; several clips; gap; missing media', () => {
  const p = newProject('x');
  const c1 = newClipFromMedia(media('m1', 100), p.settings); c1.in = 10; c1.out = 70; c1.speed = 2;      // 30 s on the timeline (0-30), source 10-70
  const c2 = newClipFromMedia(media('m2', 100), p.settings); c2.in = 0; c2.out = 40; c2.gap = 5;          // 35-75
  p.clips = [c1, c2];
  const lay = layout(p); assert.equal(lay.total, 75);
  const cut = cutRange(p, 20, 50, id => id !== 'm2');
  assert.equal(cut.clips.length, 2);
  assert.equal(cut.clips[0].in, 50); assert.equal(cut.clips[0].out, 70);           // timeline 20-30 at 2x = source 50-70
  assert.equal(cut.clips[0].speed, 2);
  assert.equal(cut.clips[1].in, 0); assert.equal(cut.clips[1].out, 15);             // timeline 35-50
  assert.equal(cut.clips[1].gap, 5);
  assert.deepEqual(cut.missing, ['m2']);
  assert.notEqual(cut.clips[0].id, c1.id);
  assert.equal(c1.in, 10);                                                          // original untouched
});

test('cutRange: a photo keeps its length, cross-fades become cuts, voice audio is trimmed, music is not copied', () => {
  const p = newProject('x');
  const v = newClipFromMedia(media('m1', 60), p.settings); v.in = 0; v.out = 30;
  const w = newClipFromMedia(media('m1', 60), p.settings); w.in = 30; w.out = 60; w.transition = { type: 'fade', duration: 2 };
  p.clips = [v, w];
  p.audio = [{ id: 'a1', mediaId: 'm9', voice: true, start: 10, in: 0, out: 40, speed: 1, volume: 1, loop: false, name: 'v', srcDuration: 40 }, { id: 'a2', mediaId: 'm8', voice: false, start: 0, in: 0, out: 60, speed: 1, volume: 0.5, loop: false, name: 'm', srcDuration: 60 }];
  const cut = cutRange(p, 20, 45);
  assert.ok(cut.clips.every(c => c.transition.type === 'cut'));
  assert.ok(cut.clips.reduce((n, c) => n + (c.out - c.in), 0) <= 25.01);
  assert.equal(cut.audio.length, 1);
  assert.equal(cut.audio[0].start, 0); assert.equal(cut.audio[0].in, 10); assert.equal(cut.audio[0].out, 35);
});

test('makeShortProject: 9:16 fill-crop with offset, Bold Shorts captions shifted into range, source project untouched', () => {
  const p = newProject('Sunday sermon');
  const c = newClipFromMedia(media('m1', 600), p.settings); c.out = 600; p.clips = [c];
  p.captions = transcript(filler(60));
  const before = JSON.stringify(p);
  const a = 100, b = 140;
  const r = makeShortProject(p, a, b, { name: 'Sunday sermon · Short 1', offset: 0.4 });
  assert.equal(JSON.stringify(p), before);
  const s = r.project;
  assert.notEqual(s.id, p.id);
  assert.equal(s.name, 'Sunday sermon · Short 1');
  assert.equal(s.settings.ratio, '9:16'); assert.equal(s.settings.fit, 'cover'); assert.equal(s.settings.res, 1080);
  assert.equal(s.clips.length, 1); assert.equal(s.clips[0].in, 100); assert.equal(s.clips[0].out, 140); assert.equal(s.clips[0].transform.x, 0.4);
  assert.equal(s.captionStyle.preset, 'shorts'); assert.equal(s.captionStyle.caps, true); assert.equal(s.captionStyle.maxWords, 3);
  assert.ok(s.captions.length > 10);
  assert.ok(s.captions.every(x => x.start >= 0 && x.end <= 40.5 && x.text.split(' ').length <= 3));
  assert.equal(layout(s).total, 40);
  assert.equal(cropOffset(5), 1); assert.equal(cropOffset('x'), 0);
});
