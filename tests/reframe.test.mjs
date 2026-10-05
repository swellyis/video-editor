import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget, coverSize, panForPoint, zoomForFace, pickFace,
  sampleToPose, smoothPose, posesToKeyframes, buildReframe, applyReframeToClip, DEFAULTS,
} from '../js/reframe.js';
import { defaultTransform } from '../js/model.js';

describe('resolveTarget', () => {
  it('maps known keys', () => {
    assert.equal(resolveTarget('9:16').ratio, 9 / 16);
    assert.equal(resolveTarget('1:1').key, '1:1');
    assert.equal(resolveTarget('4:5').ratio, 4 / 5);
  });
  it('project falls back to 9:16 when unknown', () => {
    assert.equal(resolveTarget('project', '16:9').key, '16:9');
    assert.equal(resolveTarget('project', 'weird').key, '9:16');
  });
});

describe('panForPoint', () => {
  it('centre stays at 0', () => {
    const p = panForPoint(0.5, 0.5, 1920, 1080, 9 / 16, 1);
    assert.equal(p.x, 0); assert.equal(p.y, 0);
  });
  it('right-side face pans positive x for 16:9→9:16', () => {
    const p = panForPoint(0.8, 0.5, 1920, 1080, 9 / 16, 1);
    assert.ok(p.x > 0.3, 'x=' + p.x);
    assert.ok(Math.abs(p.y) < 0.05);
  });
  it('left-side face pans negative', () => {
    const p = panForPoint(0.2, 0.5, 1920, 1080, 9 / 16, 1);
    assert.ok(p.x < -0.3);
  });
});

describe('zoomForFace', () => {
  it('small face asks for more zoom', () => {
    const big = zoomForFace({ w: 0.4, h: 0.5 }, 1920, 1080, 9 / 16);
    const small = zoomForFace({ w: 0.08, h: 0.1 }, 1920, 1080, 9 / 16);
    assert.ok(small >= big, `${small} >= ${big}`);
    assert.ok(small <= DEFAULTS.maxZoom);
  });
});

describe('pickFace', () => {
  it('returns null when empty', () => assert.equal(pickFace([]), null));
  it('prefers larger higher-scoring face', () => {
    const f = pickFace([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1, score: 0.9 },
      { x: 0.4, y: 0.3, w: 0.25, h: 0.3, score: 0.8 },
    ]);
    assert.ok(f.w > 0.2);
  });
  it('drops low confidence', () => {
    assert.equal(pickFace([{ x: 0, y: 0, w: 0.2, h: 0.2, score: 0.1 }]), null);
  });
});

describe('smoothPose + dead zone', () => {
  it('ignores tiny moves', () => {
    const a = { x: 0.2, y: 0, zoom: 1 };
    const b = smoothPose(a, { x: 0.22, y: 0.01, zoom: 1.01 }, { deadZone: 0.06, zoomDead: 0.03, maxStep: 0.35 });
    assert.equal(b.x, 0.2);
    assert.equal(b.y, 0);
  });
  it('clamps big jumps', () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = smoothPose(a, { x: 1, y: 0, zoom: 1 }, { deadZone: 0.06, maxStep: 0.35, zoomDead: 0.03 });
    assert.ok(b.x <= 0.35 + 1e-6);
  });
});

describe('sampleToPose hold / fallback', () => {
  it('holds last face for a few misses', () => {
    const last = { x: 0.4, y: 0, zoom: 1.2 };
    const h = sampleToPose(null, 1920, 1080, 9 / 16, { holdMiss: 3 }, last, 1);
    assert.equal(h.x, 0.4);
    assert.ok(h.held);
  });
  it('falls back to centre after holdMiss', () => {
    const last = { x: 0.4, y: 0, zoom: 1.2 };
    const f = sampleToPose(null, 1920, 1080, 9 / 16, { holdMiss: 2 }, last, 2);
    assert.equal(f.x, 0);
    assert.ok(f.fallback);
  });
});

describe('posesToKeyframes + buildReframe', () => {
  it('keeps first and last and sparsifies', () => {
    const poses = [
      { t: 0, x: 0, y: 0, zoom: 1 },
      { t: 0.4, x: 0.01, y: 0, zoom: 1 },
      { t: 0.8, x: 0.5, y: 0, zoom: 1.2 },
      { t: 1.2, x: 0.5, y: 0, zoom: 1.2 },
    ];
    const kf = posesToKeyframes(poses, { minDelta: 0.04 });
    assert.ok(kf.x.length >= 2 && kf.x.length <= 4);
    assert.equal(kf.x[0].t, 0);
    assert.equal(kf.x[kf.x.length - 1].ease, 'ease-in-out');
  });
  it('buildReframe tracks a moving face into x keys', () => {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ t: i * 0.4, faces: [{ x: 0.2 + i * 0.05, y: 0.3, w: 0.15, h: 0.2, score: 0.9 }] });
    }
    const r = buildReframe(samples, 1920, 1080, '9:16');
    assert.ok(r.faces === 10);
    assert.ok(r.keyframes.x.length >= 2);
    assert.ok(r.keyframes.x[r.keyframes.x.length - 1].v > r.keyframes.x[0].v);
  });
  it('no faces → centre keyframes', () => {
    const samples = [{ t: 0, faces: [] }, { t: 1, faces: [] }, { t: 2, faces: [] }];
    const r = buildReframe(samples, 1920, 1080, '1:1');
    assert.ok(r.fallbacks >= 1);
    assert.ok(r.keyframes.x.every(k => Math.abs(k.v) < 0.05));
  });
});

describe('applyReframeToClip', () => {
  it('writes keyframes and cover fit', () => {
    const clip = { transform: defaultTransform(), keyframes: {}, fit: 'inherit' };
    const info = applyReframeToClip(clip, {
      x: [{ t: 0, v: 0.2, ease: 'ease-in-out' }, { t: 2, v: -0.1, ease: 'ease-in-out' }],
      y: [{ t: 0, v: 0, ease: 'ease-in-out' }],
      scale: [{ t: 0, v: 1.1, ease: 'ease-in-out' }],
    });
    assert.equal(info.keys, 2);
    assert.equal(clip.fit, 'cover');
    assert.equal(clip.transform.x, 0.2);
    assert.equal(clip.transform.kenBurns, 'none');
    assert.equal(clip.keyframes.x.length, 2);
  });
});

describe('coverSize', () => {
  it('16:9 source into 9:16 has horizontal overflow', () => {
    const c = coverSize(1920, 1080, 9 / 16, 1);
    assert.ok(c.ox > 0);
    assert.ok(c.oy < 1e-6);
  });
});
