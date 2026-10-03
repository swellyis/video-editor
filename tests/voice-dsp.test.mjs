// Unit tests for Change voice: the pitch shifter, the radio effect and the settings model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchStream, VoiceStream, SR } from '../js/voice-dsp.js';
import { normChange, changeIsOn, changePresetOf, changeKey, changeId, changeTarget, changeIdsOf, soundTargets, CHANGE_PRESETS, newProject, sanitizeProject, newClipFromMedia, splitItem, detachAudio } from '../js/model.js';

const sine = (f, n, a = 0.4) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / SR); return x; };
async function run(stream, x, chunk) {
  const outs = []; let tot = 0;
  for (let o = 0; o < x.length; o += chunk) { const y = await stream.push(x.slice(o, Math.min(x.length, o + chunk))); outs.push(y); tot += y.length; }
  const f = await stream.finish(); outs.push(f); tot += f.length;
  const y = new Float32Array(tot); let q = 0; for (const a of outs) { y.set(a, q); q += a.length; }
  return y;
}
function peakFreq(y, a, len = 16384) { // strongest frequency (Hz) in a window, scanning a DFT
  let best = 0, bf = 0;
  for (let f = 60; f < 2000; f += 1) { let re = 0, im = 0; for (let i = 0; i < len; i += 3) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len), ph = 2 * Math.PI * f * (a + i) / SR; re += y[a + i] * w * Math.cos(ph); im += y[a + i] * w * Math.sin(ph); } const m = re * re + im * im; if (m > best) { best = m; bf = f; } }
  return bf;
}

test('pitch shifter moves a tone by the asked semitones and keeps the length', async () => {
  const x = sine(200, SR * 2);
  for (const [st, want] of [[12, 400], [-12, 100], [5, 267.4], [-7, 133.5]]) {
    const y = await run(new PitchStream({ pitch: st }), x, 7001);
    assert.equal(y.length, x.length);
    const f = peakFreq(y, SR * 0.5);
    assert.ok(Math.abs(f - want) / want < 0.03, `${st} st: ${f} Hz, wanted about ${want}`);
  }
});
test('pitch 0 / tone 0 is a perfect pass-through, any chunking gives the same result', async () => {
  const x = sine(300, 30000), y = await run(new VoiceStream({}), x, 999);
  assert.equal(y.length, x.length); for (let i = 0; i < x.length; i++) assert.equal(y[i], x[i]);
  const a = await run(new PitchStream({ pitch: 3 }), sine(250, 40000), 1234), b = await run(new PitchStream({ pitch: 3 }), sine(250, 40000), 9001);
  assert.equal(a.length, b.length); let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  assert.ok(d < 1e-5, 'chunking changes the result by ' + d);
});
test('very short and silent input works', async () => {
  const y = await run(new VoiceStream({ pitch: -4, tone: -1 }), new Float32Array(100), 100); assert.equal(y.length, 100);
  const z = await run(new VoiceStream({ pitch: 4 }), new Float32Array(0), 10); assert.equal(z.length, 0);
  const s = await run(new VoiceStream({ pitch: 4 }), new Float32Array(50000), 5000); assert.ok(s.every(v => Number.isFinite(v) && Math.abs(v) < 1e-3));
});
test('level is kept close to the original (pitch and radio)', async () => {
  const x = new Float32Array(SR * 3); // a voice-like signal: 120 Hz harmonics under a formant-ish bump, slowly changing level
  for (let h = 1; h <= 40; h++) { const f = 120 * h, a = 0.05 * Math.exp(-Math.pow((f - 700) / 500, 2)) + 0.01 / h; for (let i = 0; i < x.length; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / SR); }
  for (let i = 0; i < x.length; i++) x[i] *= 0.6 + 0.4 * Math.sin(i / 9000);
  const rms = (y) => Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length);
  for (const p of [{ pitch: -4, tone: -1 }, { pitch: 4, tone: 1 }, { radio: true }]) {
    const y = await run(new VoiceStream(p), x, 8000);
    const db = 20 * Math.log10(rms(y.subarray(SR * 0.5, SR * 2.5)) / rms(x.subarray(SR * 0.5, SR * 2.5)));
    assert.ok(Math.abs(db) < 3, JSON.stringify(p) + ' level change ' + db.toFixed(1) + ' dB');
  }
});
test('radio removes lows and highs', async () => {
  const lo = sine(60, SR), hi = sine(9000, SR), mid = sine(1000, SR);
  const rms = (y) => Math.sqrt(y.subarray(20000).reduce((s, v) => s + v * v, 0) / (y.length - 20000));
  const [a, b, c] = [await run(new VoiceStream({ radio: true }), lo, 4800), await run(new VoiceStream({ radio: true }), hi, 4800), await run(new VoiceStream({ radio: true }), mid, 4800)];
  assert.ok(rms(c) > 3 * rms(a) && rms(c) > 3 * rms(b));
});

test('settings: presets, keys and ids', () => {
  assert.equal(changePresetOf(CHANGE_PRESETS.deeper), 'deeper'); assert.equal(changePresetOf({ pitch: 1.5, tone: 0 }), 'custom'); assert.equal(changePresetOf({}), 'off');
  assert.deepEqual(normChange({ pitch: 99, tone: -99, radio: 'yes' }), { pitch: 12, tone: -6, radio: false });
  assert.deepEqual(normChange({ pitch: 1.26 }), { pitch: 1.5, tone: 0, radio: false });
  assert.equal(changeIsOn({ pitch: 0, tone: 0, radio: false }), false); assert.equal(changeIsOn({ radio: true }), true);
  assert.notEqual(changeKey({ pitch: -4 }), changeKey({ pitch: 4 })); assert.match(changeKey({ pitch: -4, tone: 0.5 }), /^[\w]+$/);
  assert.notEqual(changeId('m', 'off', { pitch: 3 }), changeId('m', 'light', { pitch: 3 }));
});
test('settings: item targets, order Clean voice then Change voice, old projects, split and detach', () => {
  const vid = { id: 'm1', kind: 'video', name: 's.mp4', duration: 20, width: 1280, height: 720, hasAudio: true };
  const p = newProject('t'); p.clips.push(newClipFromMedia(vid, {}));
  const c = p.clips[0];
  assert.equal(changeTarget(c), null); assert.deepEqual(soundTargets(c), []);
  c.clean = { level: 'light' }; c.change = { pitch: -4, tone: -1, radio: false };
  assert.equal(soundTargets(c).length, 2); assert.match(soundTargets(c)[0], /^chg_m1_light_/); assert.match(soundTargets(c)[1], /^cln_m1_light_/);
  assert.equal(changeIdsOf(c).length, 3);
  const q = sanitizeProject(JSON.parse(JSON.stringify(p))); assert.deepEqual(q.clips[0].change, { pitch: -4, tone: -1, radio: false });
  q.clips[0].change = { pitch: 0, tone: 0, radio: false }; assert.equal(sanitizeProject(q).clips[0].change, undefined);
  const r = splitItem(p, { type: 'clip', id: c.id }, 5); assert.ok(!r || !r.fail);
  assert.equal(changeTarget(p.clips[0]), changeTarget(p.clips[1]));
  const d = detachAudio(p, { type: 'clip', id: p.clips[1].id }); assert.ok(!d || !d.fail);
  const v = p.audio.find(a => a.voice); assert.deepEqual(v.change, { pitch: -4, tone: -1, radio: false });
});
