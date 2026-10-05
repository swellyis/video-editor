import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBgRemove, softenMask, defaultBgRemove, BG_MODES } from '../js/bgremove.js';

describe('normalizeBgRemove', () => {
  it('defaults', () => {
    const d = normalizeBgRemove(null);
    assert.equal(d.mode, 'off');
    assert.ok(d.soft > 0);
  });
  it('keeps valid mode', () => {
    assert.equal(normalizeBgRemove({ mode: 'blur', soft: 0.5 }).mode, 'blur');
    assert.equal(normalizeBgRemove({ mode: 'nope' }).mode, 'off');
  });
  it('lists modes', () => assert.deepEqual(BG_MODES, ['off', 'remove', 'blur', 'color', 'image']));
});

describe('softenMask', () => {
  it('soft=0 returns same reference-ish values', () => {
    const d = new Float32Array([0, 1, 0, 1]);
    const o = softenMask(d, 2, 2, 0);
    assert.equal(o, d);
  });
  it('soft>0 blurs a hard edge', () => {
    const d = new Float32Array(16);
    for (let i = 8; i < 16; i++) d[i] = 1;
    const o = softenMask(d, 4, 4, 0.5);
    assert.ok(o[5] > 0 && o[5] < 1, 'edge softens: ' + o[5]);
  });
});

describe('defaultBgRemove', () => {
  it('stable shape', () => {
    const a = defaultBgRemove(), b = defaultBgRemove();
    assert.notEqual(a, b);
    assert.equal(a.mode, 'off');
  });
});
