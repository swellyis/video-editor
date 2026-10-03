// Unit tests for the Filters library: the list, the colour numbers, the seven old presets staying identical, and how the model keeps the filter (old projects, split, duplicate, overlays).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, GROUPS, PRESETS, filterInfo, filterParams, amountOf, normFilter } from '../js/filters.js';
import { newProject, newClipFromMedia, normalizeClip, normalizeOverlay, migrate, splitAt, duplicateClip, clipToOverlay, effectiveColor, colorIsNeutral, defaultColor } from '../js/model.js';

const media = (id, d) => ({ id, name: id, kind: 'video', duration: d, width: 1280, height: 720, hasAudio: true });
const proj = () => { const p = newProject('T'); p.clips = [Object.assign(newClipFromMedia(media('m', 10)), { id: 'c0' })]; return p; };
// the 7 presets exactly as released before the Filters library (v bfb705bf89)
const OLD = {
  warm: { temperature: 30, saturation: 8, brightness: 2 }, cool: { temperature: -30, saturation: -4 }, bw: { saturation: -100, contrast: 12 },
  vintage: { sepia: 38, contrast: -8, fade: 14, saturation: -12, vignette: 30 }, vivid: { saturation: 38, contrast: 14 },
  dramatic: { contrast: 28, saturation: -22, vignette: 40, brightness: -4 }, golden: { temperature: 42, sepia: 12, saturation: 14, vignette: 18 },
};
const KEYS = ['brightness', 'contrast', 'saturation', 'temperature', 'vignette', 'sepia', 'fade'];
const oldEffective = (g, c) => { // the old effectiveColor
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), out = {};
  for (const k of KEYS) out[k] = (g[k] || 0) + (c[k] || 0) + ((OLD[g.preset] || {})[k] || 0) + ((OLD[c.preset] || {})[k] || 0);
  out.saturation = clamp(out.saturation, -100, 150); out.vignette = clamp(out.vignette, 0, 100); out.sepia = clamp(out.sepia, 0, 100); out.fade = clamp(out.fade, 0, 100);
  out.brightness = clamp(out.brightness, -100, 100); out.contrast = clamp(out.contrast, -100, 100); out.temperature = clamp(out.temperature, -100, 100);
  return out;
};

test('the library: 30 filters in 5 groups with unique ids', () => {
  assert.equal(FILTERS.length, 30);
  assert.deepEqual(GROUPS, ['Natural', 'Cinematic', 'Vivid', 'Retro', 'Mono']);
  assert.equal(new Set(FILTERS.map(f => f.id)).size, 30);
  for (const g of GROUPS) assert.ok(FILTERS.filter(f => f.group === g).length >= 4, g);
  assert.ok(FILTERS.every(f => f.label && filterInfo(f.id) === f));
  for (const id of ['natural', 'skin', 'clean', 'tealorange', 'fadedfilm', 'hicontrast', 'sunrise']) assert.ok(filterInfo(id), id);
});

test('the seven old presets are library entries with the same numbers', () => {
  for (const [id, nums] of Object.entries(OLD)) {
    const p = filterParams(id, 1);
    for (const k of KEYS) assert.equal(p[k], nums[k] || 0, id + ' ' + k);
    assert.equal(p.gamma, 1); assert.equal(p.curve, 0); assert.equal(p.ts[3], 0); assert.equal(p.th[3], 0);
    assert.equal(PRESETS[id].label, filterInfo(id).label);
  }
});

test('a project that used an old preset renders with exactly the old colour numbers (with sliders and a project-wide preset too)', () => {
  for (const id of Object.keys(OLD)) for (const gid of ['none', 'warm', 'bw']) {
    const g = { ...defaultColor(), preset: gid, saturation: 7, vignette: 5 }, c = { ...defaultColor(), preset: id, brightness: -9, temperature: 11 };
    delete g.filterAmount; delete c.filterAmount; // saved by an older version
    const e = effectiveColor({ color: g }, { color: c }), o = oldEffective(g, c);
    for (const k of KEYS) assert.equal(e[k], o[k], id + '/' + gid + ' ' + k);
    assert.equal(e.gamma, 1); assert.equal(e.curve, 0);
  }
});

test('intensity scales a filter: 0 is neutral, 0.5 is half, 1 is full', () => {
  for (const f of FILTERS) {
    const z = filterParams(f.id, 0), h = filterParams(f.id, 0.5), a = filterParams(f.id, 1);
    assert.ok(colorIsNeutral({ ...z }), f.id + ' neutral at 0');
    for (const k of KEYS) assert.ok(Math.abs(h[k] - a[k] / 2) < 1e-9, f.id + ' ' + k);
    if (f.p.gamma) assert.ok(Math.abs(h.gamma - (1 + (f.p.gamma - 1) / 2)) < 1e-9);
    if (f.p.curve) assert.ok(Math.abs(h.curve - f.p.curve / 2) < 1e-9);
    if (f.p.th) assert.ok(Math.abs(h.th[3] - f.p.th[3] / 2) < 1e-9);
  }
  assert.equal(filterParams('nope', 1).saturation, 0);
  assert.ok(colorIsNeutral(effectiveColor({ color: defaultColor() }, { color: defaultColor() })));
});

test('the new looks use the new maths (curve, gamma, split toning) and the colour reaches the shader values', () => {
  const t = effectiveColor({ color: defaultColor() }, { color: { ...defaultColor(), preset: 'tealorange' } });
  assert.ok(t.ts[3] > 0 && t.th[3] > 0 && t.curve > 0 && !colorIsNeutral(t));
  assert.ok(t.ts[2] > t.ts[0] && t.th[0] > t.th[2], 'teal in shadows, orange in highlights');
  const c = effectiveColor({ color: defaultColor() }, { color: { ...defaultColor(), preset: 'clean' } });
  assert.ok(c.gamma > 1);
  const clipTint = effectiveColor({ color: { ...defaultColor(), preset: 'sunrise' } }, { color: { ...defaultColor(), preset: 'tealorange' } });
  assert.deepEqual(clipTint.ts.slice(0, 3), [0, 0.45, 0.5], 'the clip’s own tint wins over the project’s');
});

test('amount and ids are tidied; old projects get 100% and unknown ids become none', () => {
  assert.equal(amountOf({}), 1); assert.equal(amountOf({ filterAmount: 0 }), 0); assert.equal(amountOf({ filterAmount: 5 }), 1); assert.equal(amountOf({ filterAmount: -2 }), 0); assert.equal(amountOf({ filterAmount: 'x' }), 1);
  const c = { preset: 'bogus', filterAmount: 9 }; normFilter(c); assert.deepEqual(c, { preset: 'none', filterAmount: 1 });
  const clip = normalizeClip({ id: 'a', name: 'a', mediaId: 'm', in: 0, out: 3, color: { preset: 'vintage', contrast: 4 } });
  assert.equal(clip.color.preset, 'vintage'); assert.equal(clip.color.filterAmount, 1); assert.equal(clip.color.contrast, 4);
  assert.equal(normalizeClip({ id: 'b', name: 'b', mediaId: 'm', in: 0, out: 3, color: { preset: 'zzz' } }).color.preset, 'none');
  assert.equal(normalizeClip({ id: 'b', name: 'b', mediaId: 'm', in: 0, out: 3 }).color.preset, 'none');
  const p = migrate({ ...proj(), color: { preset: 'dramatic', vignette: 3 } });
  assert.equal(p.color.preset, 'dramatic'); assert.equal(p.color.filterAmount, 1);
  assert.equal(migrate({ ...proj(), color: { preset: 'nonsense' } }).color.preset, 'none');
});

test('split and duplicate keep the filter, as separate copies', () => {
  const p = proj(); p.clips[0].color.preset = 'moody'; p.clips[0].color.filterAmount = 0.6;
  splitAt(p, 4);
  assert.equal(p.clips.length, 2);
  for (const c of p.clips) { assert.equal(c.color.preset, 'moody'); assert.equal(c.color.filterAmount, 0.6); }
  assert.notEqual(p.clips[0].color, p.clips[1].color);
  p.clips[1].color.filterAmount = 0.2; assert.equal(p.clips[0].color.filterAmount, 0.6);
  const id = p.clips[0].id; duplicateClip(p, id, true);
  const d = p.clips[1]; assert.equal(d.color.preset, 'moody'); assert.equal(d.color.filterAmount, 0.6);
  d.color.preset = 'none'; assert.equal(p.clips[0].color.preset, 'moody');
});

test('overlays carry a filter; a clip moved to PiP keeps it; old overlays have none', () => {
  const o = normalizeOverlay({ id: 'o', name: 'o', kind: 'image', mediaId: 'm', start: 0, in: 0, out: 2 });
  assert.equal(o.color.preset, 'none'); assert.equal(o.color.filterAmount, 1);
  const o2 = normalizeOverlay({ ...o, color: { preset: 'sepia', filterAmount: 0.4 } });
  assert.equal(o2.color.preset, 'sepia'); assert.equal(o2.color.filterAmount, 0.4);
  assert.equal(normalizeOverlay({ ...o, color: { preset: 'zzz' } }).color.preset, 'none');
  const p = proj(); p.clips.push(Object.assign(newClipFromMedia(media('m2', 5)), { id: 'c1' })); p.clips[1].color.preset = 'noir';
  clipToOverlay(p, 'c1', true, 0);
  assert.equal(p.overlays.length, 1); assert.equal(p.overlays[0].color.preset, 'noir');
});
