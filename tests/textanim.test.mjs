import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIMS, newIn, newOut, loopFx, karaokeCount, hash01, setAnim, removeAnim, applyToAll, TEMPLATES, buildTemplate, groupsOf, summary, label } from '../js/textanim.js';
import { newProject, newText, migrate, cleanTextAnim, TEXT_IN_IDS, TEXT_OUT_IDS, TEXT_LOOP_IDS, splitItem } from '../js/model.js';
import { deepClone } from '../js/util.js';

test('catalogue: every library id is a valid id, grouped, labelled; the old ones are marked', () => {
  for (const a of ANIMS) assert.ok({ in: TEXT_IN_IDS, out: TEXT_OUT_IDS, loop: TEXT_LOOP_IDS }[a.kind].includes(a.id), a.kind + ':' + a.id);
  for (const k of ['in', 'out', 'loop']) { const g = groupsOf(k); assert.ok(g.length >= 2 && g.every(x => x.items.length)); }
  assert.ok(ANIMS.filter(a => a.kind === 'in').length >= 12 && ANIMS.filter(a => a.kind === 'out').length >= 10 && ANIMS.filter(a => a.kind === 'loop').length >= 4);
  for (const id of ['fade', 'typewriter', 'slideUp', 'pop', 'wordByWord']) assert.ok(ANIMS.find(a => a.kind === 'in' && a.id === id && a.old));
  assert.equal(label('in', 'blurIn'), 'Blur in'); assert.equal(label('loop', 'none'), 'None');
});

test('old projects: the saved in/out/durations come through unchanged; new fields get defaults; unknown ids become none', () => {
  const old = newProject('old'); const t = newText(1, 3, 'Hello'); t.anim = { in: 'wordByWord', out: 'slideDown', inDur: 2.2, outDur: 0.7 }; old.texts.push(t);
  const m = migrate(JSON.parse(JSON.stringify(old)));
  const a = m.texts[0].anim;
  assert.deepEqual([a.in, a.out, a.inDur, a.outDur], ['wordByWord', 'slideDown', 2.2, 0.7]);
  assert.deepEqual([a.loop, a.loopSpeed, a.hi, a.phase], ['none', 1, '#ffd24a', 0]);
  assert.equal(migrate({ ...old, texts: [{ ...t, anim: { in: 'nope', out: 'x', loop: 'y', inDur: 'q' } }] }).texts[0].anim.in, 'none');
  assert.equal(cleanTextAnim(undefined).loop, 'none');
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(m))).texts[0].anim, a);      // idempotent
});

test('new in/out motions: start hidden/moved, settle exactly at p = 1, deterministic', () => {
  for (const a of ANIMS.filter(x => !x.old && x.kind === 'in')) {
    const f0 = newIn(a.id, 0.2, 40, 1000, 0.2); assert.ok(f0, a.id);
    assert.equal(newIn(a.id, 1, 40, 1000, 0.9), null);
    assert.deepEqual(newIn(a.id, 0.2, 40, 1000, 0.2), f0);
  }
  for (const a of ANIMS.filter(x => !x.old && x.kind === 'out')) {
    assert.ok(newOut(a.id, 0.3, 40, 1000, 1.9), a.id); assert.equal(newOut(a.id, 1, 40, 1000, 1), null);
  }
  assert.ok(newIn('rise', 0, 40, 1000, 0).dy > 0 && newIn('slideLeft', 0, 40, 1000, 0).dx > 0 && newIn('slideRight', 0, 40, 1000, 0).dx < 0);
  assert.ok(newIn('bounce', 0.5, 40, 1000, 0).dy < 0 && newIn('wipe', 0.5, 40, 1000, 0).wipe < 1 && newIn('blurIn', 0, 40, 1000, 0).blur > 0 && newIn('grow', 0, 40, 1000, 0).sc < 0.3);
  assert.ok(newOut('wipe', 0.25, 40, 1000, 1).wipeOut === 0.75 && newOut('wordByWord', 0.4, 40, 1000, 1).words === 0.4);
  assert.equal(hash01(5), hash01(5)); assert.notEqual(hash01(5), hash01(6));
});

test('loops start from “no change” and stay inside small bounds', () => {
  for (const id of ['pulse', 'float', 'wobble', 'blink']) { const f = loopFx(id, 0); assert.ok(f, id); }
  assert.equal(loopFx('pulse', 0).sc, 1); assert.equal(loopFx('float', 0).dyEm, 0); assert.equal(loopFx('wobble', 0).rot, 0);
  for (let t = 0; t < 10; t += 0.13) { const p = loopFx('pulse', t).sc; assert.ok(p > 0.93 && p < 1.07); const b = loopFx('blink', t).a; assert.ok(b >= 0.39 && b <= 1.001); }
  assert.equal(loopFx('karaoke', 1), null); assert.equal(loopFx('none', 1), null);
});

test('karaoke highlights words in turn, once, across the time the text is on screen', () => {
  const an = { in: 'fade', inDur: 1, out: 'fade', outDur: 1 };
  assert.equal(karaokeCount(an, 0.5, 8, 6), 0);
  assert.equal(karaokeCount(an, 4, 8, 6), 3);
  assert.equal(karaokeCount(an, 7.9, 8, 6), 6);
  let last = 0; for (let t = 0; t <= 8; t += 0.1) { const c = karaokeCount(an, t, 8, 6); assert.ok(c >= last); last = c; }
});

test('setAnim / removeAnim / applyToAll: one kind at a time, no stacking with plain fades, empty changes report 0', () => {
  const t = newText(0, 5, 'a'); t.fadeIn = 0.3; t.fadeOut = 0.3;
  assert.equal(setAnim(t, 'in', 'blurIn'), 1); assert.equal(t.anim.in, 'blurIn'); assert.equal(t.fadeIn, 0); assert.equal(t.fadeOut, 0.3);
  assert.equal(setAnim(t, 'in', 'blurIn'), 0);
  setAnim(t, 'loop', 'pulse', 1.5); assert.deepEqual([t.anim.loop, t.anim.loopSpeed], ['pulse', 1.5]);
  setAnim(t, 'in', 'typewriter'); assert.ok(t.anim.inDur >= 1.2);
  assert.equal(removeAnim(t, 'in'), 1); assert.equal(t.anim.in, 'none'); assert.equal(t.anim.loop, 'pulse');
  const p = newProject('x'); const a = newText(0, 5, 'a'), b = newText(5, 2, 'b'), c = newText(8, 4, 'c');
  p.texts.push(a, b, c); setAnim(a, 'out', 'shrink'); a.anim.outDur = 0.8;
  assert.equal(applyToAll(p, a, ['out']), 2);
  assert.deepEqual([b.anim.out, b.anim.outDur, c.anim.out, c.anim.in], ['shrink', 0.8, 'shrink', 'none']);
  assert.equal(applyToAll(p, a, ['out']), 0);
  setAnim(a, 'in', 'wipe'); a.anim.inDur = 3.5;
  applyToAll(p, a, ['in']); assert.ok(b.anim.inDur + b.anim.outDur <= (b.end - b.start) + 1e-9, 'short layers keep both animations inside their time');
});

test('sermon text templates: seven, editable layers, valid animations, fit 9:16 and 16:9 and a short video', () => {
  assert.deepEqual(TEMPLATES.map(t => t.id), ['title', 'lower', 'scripture', 'quote', 'part', 'subscribe', 'hook']);
  for (const tp of TEMPLATES) for (const ratio of ['16:9', '9:16', '1:1']) {
    const ls = buildTemplate(tp.id, { at: 2, total: 20, ratio });
    assert.ok(ls.length >= 1, tp.id);
    for (const t of ls) {
      assert.ok(t.start >= 2 - 1e-9 && t.end > t.start && t.end <= 20 + 1e-9 && t.text && t.id && t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1, tp.id + ' ' + ratio);
      assert.ok(TEXT_IN_IDS.includes(t.anim.in) && TEXT_OUT_IDS.includes(t.anim.out) && TEXT_LOOP_IDS.includes(t.anim.loop));
      assert.ok(t.anim.in !== 'none', tp.id + ' animates in');
    }
  }
  const tall = buildTemplate('lower', { at: 0, total: 20, ratio: '9:16' }), wide = buildTemplate('lower', { at: 0, total: 20, ratio: '16:9' });
  assert.ok(tall[0].y < wide[0].y, '9:16 keeps lower thirds clear of the Shorts bottom bar');
  const short = buildTemplate('title', { at: 3, total: 5, ratio: '16:9' }); assert.ok(short[0].end <= 5 + 1e-9 && short[0].end - short[0].start >= 1.5 - 1e-9 || short[0].end - short[0].start >= 1.5);
  assert.equal(buildTemplate('nope', {}).length, 0);
  assert.notEqual(buildTemplate('hook', {})[0].id, buildTemplate('hook', {})[0].id);
  assert.match(summary(buildTemplate('subscribe', {})[0]), /In: Bounce · Out: Fade · Loop: Pulse/);
});

test('split keeps the loop going (phase) and clears the join animations', () => {
  const p = newProject('s'); const t = newText(0, 6, 'Long'); t.anim = cleanTextAnim({ in: 'pop', out: 'fade', loop: 'pulse' }); p.texts.push(t);
  const r = splitItem(p, { type: 'text', id: t.id }, 2.5);
  assert.ok(r && !r.fail); const b = r.item;
  assert.equal(t.anim.out, 'none'); assert.equal(b.anim.in, 'none'); assert.equal(t.anim.loop, 'pulse'); assert.equal(b.anim.loop, 'pulse');
  assert.ok(Math.abs(b.anim.phase - 2.5) < 1e-9);
  const d = deepClone(b); assert.deepEqual(d.anim, b.anim);       // duplicate = same animation
});
