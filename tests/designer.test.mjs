import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LAYERS, DESIGN_FORMATS, SIZES, SAFE, TEMPLATES, templateDesign, legacyDesign, normDesign, normLayer, newText, newShape, newSticker, newImage,
  layerBox, hitLayer, aabb, snapBox, cloneDesign,
} from '../js/designer.js';
import { migrate, newProject, FONTS } from '../js/model.js';

// a tiny canvas context that measures text as 0.5 * font px per character
const ctx = { save() { }, restore() { }, set font(v) { this._f = v; }, get font() { return this._f; }, measureText(t) { const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this._f || '10px')[1]); return { width: t.length * px * 0.5 }; } };

test('every template is valid in every format', () => {
  for (const fk of DESIGN_FORMATS) for (const t of TEMPLATES) {
    const d = templateDesign(t.id, fk);
    assert.ok(d.layers.length >= 2 && d.layers.length <= MAX_LAYERS, `${t.id} ${fk}`);
    assert.deepEqual(normDesign(d), d, `${t.id} ${fk} survives normalisation`);
    const ids = new Set(d.layers.map(l => l.id)); assert.equal(ids.size, d.layers.length, 'unique layer ids');
    for (const l of d.layers) assert.ok(l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1);
  }
  assert.equal(TEMPLATES.length, 6);
});
test('sizes and safe areas match the formats', () => {
  assert.deepEqual(SIZES, { '16:9': [1280, 720], '9:16': [1080, 1920], '1:1': [1080, 1080] });
  for (const fk of DESIGN_FORMATS) { const s = SAFE[fk], [w, h] = SIZES[fk]; assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= w && s.y + s.h <= h); }
});
test('normLayer / normDesign clamp junk and drop bad layers', () => {
  assert.equal(normLayer(null), null); assert.equal(normLayer({ type: 'weird' }), null); assert.equal(normLayer(7), null);
  const l = normLayer({ type: 'text', text: 5, size: 'x', x: 'NaN', w: 99, rot: 9999, opacity: -2, font: 'nope', color: 'red', stroke: 7, align: 'up' });
  assert.equal(l.text, ''); assert.equal(l.size, 0.1); assert.equal(l.x, 0.5); assert.equal(l.w, 3); assert.equal(l.rot, 360); assert.equal(l.opacity, 0);
  assert.ok(FONTS[l.font]); assert.equal(l.color, '#ffffff'); assert.equal(l.align, 'center'); assert.equal(l.stroke.on, false);
  const d = normDesign({ bg: { type: 'zzz', color: 'x', angle: 1e9 }, adjust: { brightness: 1e6, darken: 5, preset: 12 }, layers: new Array(100).fill(newText()) });
  assert.equal(d.bg.type, 'frame'); assert.equal(d.bg.angle, 360); assert.equal(d.adjust.brightness, 100); assert.equal(d.adjust.darken, 0.8);
  assert.equal(d.layers.length, MAX_LAYERS);
  assert.equal(normDesign(null).layers.length, 0);
  assert.equal(normLayer({ ...newText(), text: 'x'.repeat(1000) }).text.length, 300);
});
test('cloneDesign is deep', () => {
  const d = templateDesign('title', '16:9'); const c = cloneDesign(d); c.layers[0].x = 0.9; assert.notEqual(d.layers[0].x, 0.9);
});
test('legacy headline + small line become two text layers', () => {
  const d = legacyDesign({ text: 'HELLO', sub: 'sub', position: 'right', color: '#ff0000', accent: '#00ff00', font: 'serif' }, '16:9');
  assert.equal(d.layers.length, 2); assert.equal(d.layers[0].text, 'HELLO'); assert.equal(d.layers[0].color, '#ff0000'); assert.equal(d.layers[0].align, 'right');
  assert.equal(d.layers[1].text, 'SUB'); assert.equal(d.layers[1].box.color, '#00ff00');
  assert.equal(legacyDesign({ text: '', sub: '' }, '9:16').layers.length, 0);
  assert.equal(legacyDesign({ text: 'x', font: 'bogus' }, '1:1').layers[0].font, 'sans');
});
test('geometry: hit test, rotated bounds, snapping', () => {
  const box = { cx: 100, cy: 100, w: 80, h: 20, rot: 0 };
  assert.ok(hitLayer(box, 130, 105)); assert.ok(!hitLayer(box, 150, 100)); assert.ok(hitLayer(box, 142, 100, 5));
  const r = { ...box, rot: 90 }; assert.ok(hitLayer(r, 100, 135)); assert.ok(!hitLayer(r, 135, 100));
  const b = aabb(r); assert.ok(Math.abs(b.r - b.l - 20) < 1e-9 && Math.abs(b.b - b.t - 80) < 1e-9);
  const s = snapBox({ l: 590, r: 680, t: 100, b: 140, cx: 635, cy: 120 }, [], 1280, 720, SAFE['16:9'], 9);
  assert.equal(s.dx, 5); assert.deepEqual(s.v, [640]); assert.equal(s.dy, 0); assert.deepEqual(s.h, []);
  const s2 = snapBox({ l: 300, r: 380, t: 300, b: 340, cx: 340, cy: 320 }, [{ l: 500, r: 600, t: 304, b: 344, cx: 550, cy: 324 }], 1280, 720, SAFE['16:9'], 9);
  assert.equal(s2.dy, 4);
  const s3 = snapBox({ l: 300, r: 380, t: 300, b: 340, cx: 340, cy: 320 }, [], 1280, 720, SAFE['16:9'], 9);
  assert.equal(s3.dx, 0); assert.equal(s3.dy, 0);
});
test('layerBox: text height follows the text, others use fractions', () => {
  const t = newText({ text: 'ONE\nTWO', size: 0.1, w: 0.5, x: 0.5, y: 0.5 });
  const b = layerBox(ctx, t, 1000, 500); assert.equal(b.cx, 500); assert.equal(b.w, 500); assert.ok(b.h > 100 && b.h < 400);
  const t2 = layerBox(ctx, { ...t, text: 'ONE\nTWO\nTHREE' }, 1000, 500); assert.ok(t2.h > b.h);
  const s = layerBox(ctx, newShape({ x: 0.25, y: 0.5, w: 0.2, h: 0.4 }), 1000, 500); assert.deepEqual([s.cx, s.cy, s.w, s.h], [250, 250, 200, 200]);
});
test('projects keep designs; junk is dropped', () => {
  const p = migrate({ ...newProject('x'), thumb: { designs: { '16:9': { layers: [{ ...newImage({ mediaId: 'med_img1' }) }], bg: { type: 'image', mediaId: 'med_bg1' } }, '4:3': { layers: [] }, '1:1': 'no' } } });
  assert.deepEqual(Object.keys(p.thumb.designs), ['16:9']);
  assert.equal(p.thumb.designs['16:9'].layers[0].mediaId, 'med_img1'); // (db.js mediaIdsOf reads these ids; checked in e2e43 via the .vedit file)
  assert.deepEqual(migrate(newProject('y')).thumb.designs, {});
  assert.deepEqual(migrate({ ...newProject('z'), thumb: { designs: [1, 2] } }).thumb.designs, {});
  const big = { layers: [{ type: 'text', text: 'x'.repeat(500000) }] };
  assert.deepEqual(migrate({ ...newProject('z'), thumb: { designs: { '16:9': big } } }).thumb.designs, {});
});
test('new layer helpers produce distinct ids', () => {
  const ids = new Set([newText().id, newShape().id, newSticker().id, newImage().id, newText().id]); assert.equal(ids.size, 5);
});
