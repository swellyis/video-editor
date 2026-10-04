// Match dialog: pick what the selected item should match (another item's length, start / end, loudness), see the result in plain words, apply as ONE undo step.
// The planning is in match.js (pure); this file wires the dialog and measures loudness on this device (silence-scan.js reads the sound in pieces, cancelable).
import { $, fmt } from './util.js';
import { soundTargets } from './model.js';
import { describe, targetsFor, defaultTarget, available, applyMatch, levelOf, pictureRun, say } from './match.js';

const WINDOW = 180; // seconds of sound measured per item (a minute or two is plenty for a level)
const refKey = (r) => r.type + ':' + (r.id || '');
const parseKey = (k) => { const i = k.indexOf(':'); return { type: k.slice(0, i), id: k.slice(i + 1) || undefined }; };

export function initMatch({ app, media, toast, openDialog, closeDialog }) {
  if (!$('matchDialog') || !$('mtApply')) return { open() { toast('This copy of the page is out of date. Reload it to use Match.', 5000); }, state: {} };
  const S = { sel: null, tgt: null, levels: new Map(), job: null, epoch: 0, list: [], align: 'start', busy: false };
  const clone = () => JSON.parse(JSON.stringify(app.project));

  const selection = () => { const s = app.selection; return s && ['clip', 'overlay', 'audio'].includes(s.type) && describe(app.project, { type: s.type, id: s.id }) ? { type: s.type, id: s.id } : null; };

  // ------------------------------------------------------------ loudness (measured when ticked, cached)
  async function levelFor(ref, signal, onProgress) {
    const d = describe(app.project, ref), item = d && d.item; if (!item || !d.sound) return null;
    let id = null;
    for (const t of soundTargets(item)) if (!id && await media.get(t).catch(() => null)) id = t;
    id = id || item.mediaId;
    const rec = await media.get(id); if (!rec || !rec.blob) return null;
    const from = item.in || 0, to = Math.min(item.out > from ? item.out : from + WINDOW, from + WINDOW, rec.duration || 1e9);
    const key = id + ':' + from.toFixed(2) + ':' + to.toFixed(2);
    if (S.levels.has(key)) return S.levels.get(key);
    const { scanLoudness } = await import('./silence-scan.js');
    const r = await scanLoudness(rec.blob, rec.name, rec.duration, from, to, { signal, onProgress });
    const lv = levelOf(r.db); S.levels.set(key, lv); return lv;
  }
  async function measure() {
    const my = ++S.epoch;
    if (!$('mtLoud').checked || !available(app.project, S.sel, S.tgt).loud.ok) { S.measured = null; refresh(); return; }
    const ac = new AbortController(); if (S.job) S.job.abort(); S.job = ac; S.measured = null;
    $('mtMeasure').hidden = false; $('mtBar').style.width = '0%'; $('mtStatus').textContent = 'Listening to both sounds…'; refresh();
    try {
      const prog = (lab) => (m) => { $('mtBar').style.width = Math.round((m.frac || 0) * 100) + '%'; $('mtStatus').textContent = 'Listening to ' + lab + '…'; };
      const a = await levelFor(S.sel, ac.signal, prog('the selected sound')), b = await levelFor(S.tgt, ac.signal, prog('the other sound'));
      if (my !== S.epoch) return;
      S.measured = a && b ? { selDb: a.db, tgtDb: b.db } : { fail: !a ? 'The selected sound is silent or could not be read.' : 'The other sound is silent or could not be read.' };
    } catch (e) {
      if (my !== S.epoch) return;
      S.measured = { fail: e && e.name === 'Cancelled' ? 'Measuring was cancelled.' : 'Could not measure the sound: ' + (e && e.message || e) };
      if (e && e.name === 'Cancelled') $('mtLoud').checked = false;
    } finally { if (my === S.epoch) { S.job = null; $('mtMeasure').hidden = true; refresh(); } }
  }

  // ------------------------------------------------------------ request, preview
  function request() {
    const req = { length: $('mtLen').checked, align: $('mtAlign').checked ? S.align : null, spread: $('mtSpread').checked && !$('mtSpreadRow').hidden, loop: $('mtLoop').checked, ripple: !!app.rippleEnabled, loudness: null };
    if ($('mtLoud').checked && S.measured && !S.measured.fail) req.loudness = { selDb: S.measured.selDb, tgtDb: S.measured.tgtDb, offsetDb: +$('mtOffset').value };
    return req;
  }
  function refresh() {
    const p = app.project, me = describe(p, S.sel), t = describe(p, S.tgt), box = $('mtPreview');
    if (!me || !t) { box.textContent = 'That item is not on the timeline any more.'; $('mtApply').disabled = true; return; }
    const av = available(p, S.sel, S.tgt);
    for (const [k, id, note] of [['length', 'mtLen', 'mtLenNote'], ['align', 'mtAlign', 'mtAlignNote'], ['loud', 'mtLoud', 'mtLoudNote']]) {
      $(id).disabled = !av[k].ok; if (!av[k].ok) $(id).checked = false;
      $(note).textContent = av[k].ok ? ({ length: lengthNote(me, t), align: 'Move it so it starts or ends together with ' + t.name, loud: 'Set its volume relative to ' + t.name })[k] : av[k].why;
    }
    // sub-options
    const run = S.sel.type === 'clip' && me.image ? pictureRun(p, S.sel.id) : null;
    $('mtSpreadRow').hidden = !(run && run[1] > run[0] && $('mtLen').checked);
    if (run) $('mtSpreadText').textContent = 'Share the length evenly between the ' + (run[1] - run[0] + 1) + ' pictures in a row (same order)';
    $('mtLoopRow').hidden = !(me.audio && $('mtLen').checked);
    $('mtAlignWhich').hidden = !$('mtAlign').checked;
    for (const b of $('mtAlignWhich').children) { b.classList.toggle('selected', b.dataset.which === S.align); b.setAttribute('aria-pressed', b.dataset.which === S.align ? 'true' : 'false'); }
    $('mtOffRow').hidden = !$('mtLoud').checked;
    $('mtSel').textContent = 'Selected: ' + me.name + ' (' + (me.audio ? (me.voice ? 'voice' : 'music') : me.image ? 'picture' : me.type === 'overlay' ? 'overlay' : 'clip') + ', ' + say(me.start) + '–' + say(me.end) + ').';
    // preview in plain words: run the match on a copy
    const req = request();
    const none = !req.length && !req.align && !$('mtLoud').checked;
    const lines = []; let bad = false;
    if (none) lines.push('Tick what to match: its length, its start / end, or its loudness.');
    else if ($('mtLoud').checked && !req.loudness) {
      if (S.measured && S.measured.fail) { lines.push(S.measured.fail); bad = true; } else lines.push('Measuring the loudness of both sounds…');
      if (req.length || req.align) { const r = applyMatch(clone(), S.sel, S.tgt, { ...req, loudness: null }); lines.push(...r.lines); }
    } else {
      const r = applyMatch(clone(), S.sel, S.tgt, req);
      if (!r.ok) { lines.push(r.fail); bad = true; } else lines.push(...r.lines);
    }
    box.replaceChildren(...lines.map(l => { const e = document.createElement('p'); e.textContent = l; if (bad) e.className = 'bad'; return e; }));
    $('mtApply').disabled = none || bad || S.busy || ($('mtLoud').checked && !req.loudness);
    S.lines = lines;
  }
  function lengthNote(me, t) {
    if (me.audio) return 'Trim it (with a fade-out) or loop it to ' + say(t.len);
    if (me.image) return 'Make the picture ' + say(t.len) + ' long, like ' + t.name;
    return 'Shorten it to ' + say(t.len) + ' (a video is never stretched)';
  }

  // ------------------------------------------------------------ open / apply
  function fillTargets(keep) {
    S.list = targetsFor(app.project, S.sel);
    const sel = $('mtTarget'); sel.replaceChildren(...S.list.map(x => { const o = document.createElement('option'); o.value = refKey(x.ref); o.textContent = x.label; return o; }));
    const d = (keep && S.list.find(x => refKey(x.ref) === keep)) || defaultTarget(app.project, S.sel, S.list);
    if (d) { sel.value = refKey(d.ref); S.tgt = d.ref; }
  }
  function defaultsFor() {
    const me = describe(app.project, S.sel), t = describe(app.project, S.tgt), av = available(app.project, S.sel, S.tgt);
    $('mtLen').checked = av.length.ok; $('mtAlign').checked = false; $('mtLoud').checked = false; $('mtSpread').checked = false;
    $('mtLoop').checked = !!(me.audio && !me.voice);
    $('mtOffset').value = me.audio && !me.voice && t && (t.voice || t.video) ? '-12' : '0';
    S.align = 'start'; S.measured = null;
  }
  function open() {
    const sel = selection();
    if (!sel) return toast('Select a clip, picture, overlay or audio track on the timeline first, then tap Match… to make it fit another item.', 5000);
    S.sel = sel; fillTargets();
    if (!S.list.length) return toast('There is nothing else on the timeline to match it to yet. Add some audio or another clip.', 5000);
    defaultsFor(); refresh(); openDialog('matchDialog');
  }
  async function apply() {
    if (S.busy) return;
    const req = request();
    if ($('mtLoud').checked && !req.loudness) return;
    S.busy = true; $('mtApply').disabled = true;
    try {
      const r = applyMatch(app.project, S.sel, S.tgt, req);
      if (!r.ok) { toast(r.fail, 6000); return; }
      closeDialog('matchDialog');
      if (!r.changed) { toast(r.lines[0], 4500); return; }
      app.commit('Match');
      toast(r.lines.slice(0, 2).join(' ') + ' Undo (Ctrl+Z) puts it back.', 7000);
    } finally { S.busy = false; }
  }
  $('mtTarget').onchange = () => { S.tgt = parseKey($('mtTarget').value); defaultsFor(); refresh(); };
  for (const id of ['mtLen', 'mtSpread', 'mtLoop', 'mtAlign', 'mtOffset']) $(id).addEventListener('change', () => { if (id === 'mtOffset') { refresh(); return; } refresh(); });
  $('mtLoud').addEventListener('change', () => { measure(); });
  $('mtAlignWhich').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.align = b.dataset.which; refresh(); });
  $('mtStop').onclick = () => { if (S.job) S.job.abort(); };
  $('mtApply').onclick = apply;
  $('mtCancel').onclick = () => closeDialog('matchDialog');
  $('matchDialog').addEventListener('close', () => { S.epoch++; if (S.job) S.job.abort(); S.job = null; $('mtMeasure').hidden = true; });
  void fmt;
  return { open, state: S, refresh };
}
