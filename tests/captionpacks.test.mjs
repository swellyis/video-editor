import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_PRESETS, PACK_KEYS, applyPreset, normalizeCaptionStyle, defaultCaptionStyle } from '../js/captions.js';

test('8-12 general caption style packs, every one normalizes to itself', () => {
  assert.ok(PACK_KEYS.length >= 8 && PACK_KEYS.length <= 12, String(PACK_KEYS.length));
  for (const k of ['classic', 'shorts', 'highlight', 'minimal', 'pop', 'karaoke', 'lowerThird', 'boxed', 'outline', 'neon', 'typewriter']) assert.ok(PACK_KEYS.includes(k), k);
  for (const k of PACK_KEYS) {
    const st = applyPreset(defaultCaptionStyle(), k), { label, ...rest } = CAPTION_PRESETS[k];
    assert.ok(label && !/sermon|church|bible|scripture|verse|faith|worship/i.test(label), label);
    assert.equal(st.preset, k);
    for (const [f, v] of Object.entries(rest)) assert.deepEqual(st[f], v, k + '.' + f);
    assert.deepEqual(normalizeCaptionStyle(st), st, k + ' round-trips');
  }
});
test('the four original presets keep their look (saved projects and Shorts unchanged)', () => {
  const c = applyPreset(null, 'classic'); assert.equal(c.box, true); assert.equal(c.size, 0.05); assert.equal(c.anim, 'none'); assert.equal(c.align, 'center');
  const b = applyPreset(null, 'shorts'); assert.equal(b.outline, 0.2); assert.equal(b.maxWords, 3); assert.equal(b.caps, true); assert.equal(b.glow, 0);
});
test('new style fields are validated; old styles get safe defaults', () => {
  const old = normalizeCaptionStyle({ preset: 'classic', font: 'sans', size: 0.05 });
  assert.equal(old.align, 'center'); assert.equal(old.anim, 'none'); assert.equal(old.hlStyle, 'word'); assert.equal(old.glow, 0); assert.equal(old.accent, false);
  const bad = normalizeCaptionStyle({ align: 'right', anim: 'spin', hlStyle: 'x', glow: 7, accent: 'yes' });
  assert.equal(bad.align, 'center'); assert.equal(bad.anim, 'none'); assert.equal(bad.hlStyle, 'word'); assert.equal(bad.glow, 1); assert.equal(bad.accent, false);
  assert.equal(normalizeCaptionStyle({ preset: 'neon' }).preset, 'neon');
});
test('applying a pack keeps the Show switch', () => {
  assert.equal(applyPreset({ ...defaultCaptionStyle(), show: false }, 'karaoke').show, false);
});
