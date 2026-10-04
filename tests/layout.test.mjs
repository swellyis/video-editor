// Unit tests for the workspace layout state (js/layout.js): presets, clamping, persistence, grid maths.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/layout.js';

test('workspace mode only on wide, tall windows (phones / portrait tablets keep the old layout)', () => {
  assert.equal(L.isWorkspace(1920, 1080), true);
  assert.equal(L.isWorkspace(1366, 768), true);
  assert.equal(L.isWorkspace(1024, 768), true);
  assert.equal(L.isWorkspace(820, 1180), false);
  assert.equal(L.isWorkspace(390, 844), false);
  assert.equal(L.isWorkspace(932, 430), false); // phone landscape
  assert.equal(L.isWorkspace(844, 390), false);
});
test('size classes pick separate storage keys and small windows start compact', () => {
  assert.equal(L.sizeClass(1920), 'xl'); assert.equal(L.sizeClass(1366), 'lg'); assert.equal(L.sizeClass(1024), 'md');
  assert.notEqual(L.storageKey(1920), L.storageKey(1366));
  assert.equal(L.defaults(1024).preset, 'compact'); assert.equal(L.defaults(1920).preset, 'default');
});
test('every preset is valid and inside the limits', () => {
  for (const k of Object.keys(L.PRESETS)) {
    const s = L.fromPreset(k);
    assert.equal(s.preset, k);
    assert.ok(s.libW >= L.LIB_MIN && s.libW <= L.LIB_MAX && s.propW >= L.PROP_MIN && s.propW <= L.PROP_MAX && s.top >= L.TOP_MIN && s.top <= L.TOP_MAX, k);
  }
  assert.equal(L.fromPreset('editing').top < L.fromPreset('default').top, true, 'Editing gives the timeline more room');
  assert.equal(L.fromPreset('preview').propShow, false);
  assert.equal(L.fromPreset('nonsense').preset, 'default');
});
test('normalize clamps garbage and fills gaps', () => {
  const s = L.normalize({ libW: 99999, propW: -5, top: 7, libShow: 'yes', swap: 1, preset: 'zzz' });
  assert.equal(s.libW, L.LIB_MAX); assert.equal(s.propW, L.PROP_MIN); assert.equal(s.top, L.TOP_MAX);
  assert.equal(s.libShow, true); assert.equal(s.swap, false); assert.equal(s.preset, 'custom');
  assert.deepEqual(L.normalize(null).libW, L.PRESETS.default.libW);
  assert.equal(L.normalize({ libW: NaN }).libW, L.PRESETS.default.libW);
});
test('serialize / parse round trip; corrupt, oversized or other-version data is rejected', () => {
  const s = L.setWidth(L.fromPreset('editing'), 'lib', 400);
  assert.deepEqual(L.parse(L.serialize(s)), s);
  assert.equal(L.parse('{nope'), null); assert.equal(L.parse(null), null); assert.equal(L.parse('{"v":99}'), null);
  assert.equal(L.parse('{"v":1,"pad":"' + 'x'.repeat(3000) + '"}'), null);
  assert.equal(L.parse('[1,2]'), null);
});
test('manual changes make the preset "custom"; presets and reset restore it', () => {
  let s = L.fromPreset('default');
  s = L.setWidth(s, 'props', 400); assert.equal(s.preset, 'custom'); assert.equal(s.propW, 400);
  s = L.setTop(s, 0.5); assert.equal(s.top, 0.5);
  s = L.applyPreset(s, 'compact'); assert.equal(s.preset, 'compact'); assert.equal(s.libW, L.PRESETS.compact.libW);
  s = L.setWidth(s, 'lib', 5000); assert.equal(s.libW, L.LIB_MAX);
  s = L.setTop(s, 0.01); assert.equal(s.top, L.TOP_MIN);
});
test('toggle and show/hide', () => {
  let s = L.fromPreset('default');
  s = L.toggle(s, 'lib'); assert.equal(s.libOpen, false); assert.equal(s.libShow, true); // collapses to the icon rail
  s = L.toggle(s, 'lib'); assert.equal(s.libOpen, true);
  s = L.toggle(s, 'props'); assert.equal(s.propShow, false);
  s = L.toggle(s, 'props'); assert.equal(s.propShow, true);
  s = L.setShown(s, 'lib', false); assert.equal(s.libShow, false);
  s = L.toggle(s, 'lib'); assert.equal(s.libShow, true); assert.equal(s.libOpen, true);
  assert.equal(L.swapSides(s).swap, true); assert.equal(L.swapSides(L.swapSides(s)).swap, false);
});
test('double-click reset of one measure', () => {
  let s = L.setWidth(L.fromPreset('default'), 'lib', 500); s = L.setTop(s, 0.3);
  assert.equal(L.resetPart(s, 'lib').libW, L.PRESETS.default.libW);
  assert.equal(L.resetPart(s, 'top').top, L.PRESETS.default.top);
  assert.equal(L.resetPart(L.setWidth(s, 'props', 500), 'props').propW, L.PRESETS.default.propW);
});
test('keyboard nudge stays within limits', () => {
  let s = L.fromPreset('default');
  assert.equal(L.nudge(s, 'lib', 16).libW, 356); assert.equal(L.nudge(s, 'lib', -1000).libW, L.LIB_MIN);
  assert.equal(L.nudge(s, 'props', 16).propW, 356); assert.ok(Math.abs(L.nudge(s, 'top', 0.05).top - 0.65) < 1e-9);
});
test('docks shrink so the preview keeps its minimum width', () => {
  for (const vw of [960, 1024, 1280, 1366, 1600, 1920, 2560]) {
    for (const k of Object.keys(L.PRESETS)) {
      const e = L.effective(L.setWidth(L.setWidth(L.fromPreset(k), 'lib', 560), 'props', 560), vw);
      assert.ok(e.centre >= L.CENTER_MIN - 2, `${vw} ${k}: centre ${e.centre}`);
      assert.ok(e.lib === 0 || e.lib >= L.LIB_MIN - 1); assert.ok(e.prop === 0 || e.prop >= L.PROP_MIN - 1);
      assert.equal(e.libDock + e.splitL + e.centre + e.splitR + e.prop, vw);
    }
  }
});
test('hidden docks take no space; collapsed library leaves just the rail', () => {
  const vw = 1600;
  let e = L.effective(L.fromPreset('preview'), vw);
  assert.equal(e.prop, 0); assert.equal(e.splitR, 0); assert.equal(e.lib, 0); assert.equal(e.libDock, L.RAIL_W);
  e = L.effective(L.setShown(L.fromPreset('default'), 'lib', false), vw);
  assert.equal(e.libDock, 0); assert.equal(e.splitL, 0);
});
test('maxWidth leaves room for the preview', () => {
  for (const vw of [1024, 1366, 1920]) {
    const s = L.fromPreset('default');
    const m = L.maxWidth(s, 'lib', vw);
    assert.ok(m >= L.LIB_MIN && m <= L.LIB_MAX);
    const e = L.effective(L.setWidth(s, 'lib', m), vw);
    assert.ok(e.centre >= L.CENTER_MIN - 2, `${vw}: ${e.centre}`);
  }
});
test('grid templates: rows share the height, swap mirrors the columns', () => {
  const g = L.grid(L.fromPreset('default'), 1600), gs = L.grid(L.swapSides(L.fromPreset('default')), 1600);
  assert.match(g.rows, /minmax\(0,60\.00fr\) 8px minmax\(150px,40\.00fr\)/);
  const a = g.columns.split(' '), b = gs.columns.split(' ');
  assert.equal(a.length, 5); assert.deepEqual(a.slice().reverse(), b);
  assert.equal(a[0], (L.RAIL_W + 340) + 'px'); assert.equal(a[4], '340px');
});
