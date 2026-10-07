// Remove silences: the one control (a block under Change voice) for the selected sound, plus the marks it puts on the timeline.
// Detection is in silence.js (settings -> ranges, instantly from the stored loudness curve) and silence-scan.js (reads the sound in pieces);
// the cut is silence.js cutSilences(), applied as ONE project change so it is one undo step.
import { soundTargets, cleanLevelOf } from './model.js';
import { DEFAULTS, MIN_REMOVE, normSettings, autoThreshold, findSilences, spanOf, srcToTimeline, cuttable, curvedClip, cutSilences, alignedWith, tightenRanges, BREATHS, MICRO_FADE } from './silence.js';
import { etaText } from './clean-ui.js';

const LS = 've.silence', LS_BREATH = 've.silence.breath';
const fmtT = (t) => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0');
const fmtS = (s) => (s >= 60 ? Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s' : (Math.round(s * 10) / 10).toFixed(1) + ' s');
const key = (r) => Math.round(r.a * 100);

export function initSilenceUI(ctx) {
  const { $, app, media, player, toast, commit, current, redraw, timeline } = ctx;
  const box = $('silBox'); if (!box) return { render() { } };
  const voiceBox = $('voiceBox');
  let set = DEFAULTS; try { set = normSettings(JSON.parse(localStorage.getItem(LS) || 'null')); } catch { set = normSettings(null); }
  const cache = new Map(); // mediaId -> { srcId, label, from, to, db, auto, dismissed:Set, review:-1 }
  let job = null, err = null, lastId = null, memo = null, preview = null;
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(set)); } catch { /* private mode */ } };
  // Tighten pauses: long pauses shrink to `breath` seconds instead of going away
  let breath = 0.3; try { const b = Number(localStorage.getItem(LS_BREATH)); if (BREATHS.includes(b)) breath = b; } catch { /* default */ }
  let tightOpen = false, afterScan = null, tightCur = -1, tmemo = null;
  const tightOff = new Set(); // keys of pauses unticked in the review list

  /** The sound the item plays: the changed / cleaned copy when it is stored here, else the original. */
  function sourceOf(item) {
    const id = soundTargets(item).find(t => media.has(t));
    return { id: id || item.mediaId, label: id ? (id.startsWith('chg_') ? 'the changed voice' : 'the cleaned sound') : 'the original sound' };
  }
  function analysisFor(item) {
    const a = cache.get(item.mediaId); if (!a) return null;
    if (a.srcId !== sourceOf(item).id) return null;
    if (item.in < a.from - 0.03 || item.out > a.to + 0.03) return null;
    return a;
  }
  /** All quiet stretches of the recording (source seconds). Pause and gap are what you hear, so at 2× speed they are twice as long in the file. */
  function rangesAll(a, speed = 1) {
    const k = [set.auto, set.thr, set.minPause, set.pad, speed].join('|');
    if (memo && memo.k === k && memo.db === a.db) return memo.r;
    if (a.auto == null) a.auto = autoThreshold(a.db);
    const thr = set.auto ? a.auto.thr : set.thr;
    const r = findSilences(a.db, { thr, minPause: set.minPause * speed, pad: set.pad * speed, t0: a.from }).map(x => ({ ...x }));
    memo = { k, db: a.db, r, thr }; return r;
  }
  /** The silences still to deal with, clipped to what the family of the selected item plays (the pieces of this recording on this kind of track). */
  function family(type, item) {
    const p = app.project, list = type === 'clip' ? p.clips : type === 'overlay' ? p.overlays || [] : p.audio;
    return list.filter(x => x.mediaId === item.mediaId && cuttable(type, x));
  }
  function visible(cur) {
    const a = analysisFor(cur.item); if (!a) return null;
    return onFamily(cur, rangesAll(a, spanOf(app.project, cur.type, cur.item.id)?.sp || 1).filter(r => !a.dismissed.has(key(r))));
  }
  /** The pauses Tighten would shorten (all of them, ticked or not), on the family of the selected item. */
  function tightVisible(cur) {
    const a = analysisFor(cur.item); if (!a) return null;
    const speed = spanOf(app.project, cur.type, cur.item.id)?.sp || 1;
    if (a.auto == null) a.auto = autoThreshold(a.db);
    const thr = set.auto ? a.auto.thr : set.thr, k = [thr, breath, speed].join('|');
    if (!tmemo || tmemo.k !== k || tmemo.db !== a.db) tmemo = { k, db: a.db, r: tightenRanges(a.db, { thr, breath: breath * speed, t0: a.from }) };
    return onFamily(cur, tmemo.r).map(e => ({ ...e, pause: e.len + breath }));
  }
  function onFamily(cur, all) {
    const out = [], by = new Map();
    for (const it of family(cur.type, cur.item)) {
      const sp = spanOf(app.project, cur.type, it.id); if (!sp) continue;
      for (const r of all) {
        const x0 = Math.max(r.a, sp.in), x1 = Math.min(r.b, sp.out);
        if (x1 - x0 < MIN_REMOVE) continue;
        const k = key(r);
        let e = by.get(k);
        if (!e) { e = { key: k, a: x0, b: x1, items: [], len: 0 }; by.set(k, e); out.push(e); }
        e.items.push({ type: cur.type, id: it.id, t0: srcToTimeline(sp, x0), t1: srcToTimeline(sp, x1) });
        e.len = Math.max(e.len, (x1 - x0) / sp.sp);
      }
    }
    out.sort((x, y) => x.a - y.a);
    return out;
  }
  /** Marks for the timeline. */
  app.silence = {
    marks() {
      const cur = current(); if (!cur || !cuttable(cur.type, cur.item)) return [];
      if (tightOpen) { const tv = tightVisible(cur); if (!tv) return []; const out = []; tv.forEach((e, i) => { if (!tightOff.has(e.key)) for (const it of e.items) out.push({ type: it.type, id: it.id, t0: it.t0, t1: it.t1, cur: tightCur === i }); }); return out; }
      const v = visible(cur); if (!v) return [];
      const a = analysisFor(cur.item), out = [];
      v.forEach((e, i) => { for (const it of e.items) out.push({ type: it.type, id: it.id, t0: it.t0, t1: it.t1, cur: a.review === i }); });
      return out;
    },
  };
  /** Linked tracks: other kinds of track that play the same recording at the same moment (e.g. a detached sound with its picture). */
  function linkedOthers(cur, v) {
    if (!v || !v.length) return [];
    const base = spanOf(app.project, cur.type, cur.item.id), res = [];
    for (const type of ['clip', 'overlay', 'audio']) {
      if (type === cur.type) continue;
      const list = type === 'clip' ? app.project.clips : type === 'overlay' ? app.project.overlays || [] : app.project.audio;
      for (const it of list) if (it.mediaId === cur.item.mediaId && cuttable(type, it)) { const sp = spanOf(app.project, type, it.id); if (sp && alignedWith(base, sp, [{ a: v[0].a, b: v[0].b }])) res.push({ type, id: it.id }); }
    }
    return res;
  }

  function stopPreview() { if (preview) { clearInterval(preview.timer); preview = null; if (player.playing) player.pause(); } }
  function summary(v) {
    const total = v.reduce((s, e) => s + e.len, 0);
    return { n: v.length, total };
  }

  function render() {
    const cur = current();
    if (cur && curvedClip(cur.type, cur.item) && cur.item.mediaId && cur.item.hasAudio !== false) { // explain instead of hiding
      if (voiceBox && voiceBox.nextElementSibling !== box) voiceBox.after(box);
      box.hidden = false; if (lastId) { lastId = null; stopPreview(); }
      $('silFind').hidden = true; $('silTune').hidden = true; $('silTight').hidden = true; $('silProg').classList.remove('show'); $('silState').textContent = '';
      const h = $('silHint'); h.hidden = false; h.classList.remove('warn');
      h.textContent = 'Remove silences works on clips that play forwards at a steady speed. Turn off Reverse and the speed curve first (you can turn them back on after).';
      return;
    }
    if (!cur || !cuttable(cur.type, cur.item)) { box.hidden = true; if (lastId) { lastId = null; stopPreview(); } return; }
    const { item, type } = cur;
    if (voiceBox && voiceBox.nextElementSibling !== box) voiceBox.after(box);
    box.hidden = false;
    if (lastId !== item.id) { lastId = item.id; err = null; tightOpen = false; tightOff.clear(); tightCur = -1; afterScan = null; }
    const here = !!job && job.mediaId === item.mediaId;
    const a = here ? null : analysisFor(item), v = a ? visible(cur) : null;
    $('silThr').value = set.thr; $('silMin').value = set.minPause; $('silPad').value = set.pad; $('silAuto').checked = set.auto;
    const st = $('silState'); st.className = 'clean-state';
    $('silFind').hidden = !!a || here;
    $('silTune').hidden = !a;
    $('silProg').classList.toggle('show', here);
    let hint = '', warn = false;
    if (err && !here) { hint = err; warn = true; st.textContent = ''; }
    else if (here) { st.textContent = 'Scanning'; }
    else if (a) {
      const { n, total } = summary(v);
      st.textContent = n ? n + (n === 1 ? ' pause' : ' pauses') : 'None found';
      $('silSum').textContent = n ? `${n} ${n === 1 ? 'silence' : 'silences'} · ${fmtS(total)} to remove` : 'No silences at these settings';
      const eff = set.auto ? a.auto.thr : set.thr;
      $('silThr').disabled = set.auto;
      $('silThrOut').textContent = set.auto ? 'Auto ' + Math.round(eff) + ' dB' : set.thr + ' dB';
      $('silMinOut').textContent = set.minPause.toFixed(1) + ' s';
      $('silPadOut').textContent = set.pad.toFixed(2) + ' s';
      const lk = linkedOthers(cur, v);
      $('silLinkedRow').hidden = !lk.length;
      $('silCut').disabled = !n; $('silReviewBtn').disabled = !n;
      if (a.review >= v.length) a.review = v.length - 1;
      if (!n) a.review = -1;
      const rv = a.review >= 0 && n > 0;
      $('silReview').hidden = !rv; $('silReviewBtn').hidden = rv;
      if (rv) {
        const e = v[a.review];
        $('silPos').textContent = `Pause ${a.review + 1} of ${n} · ${fmtS(e.len)}`;
        $('silPrev').disabled = a.review <= 0; $('silNext').disabled = a.review >= n - 1;
      }
      hint = n ? `Analysed ${a.label}. Some pauses are part of good speaking, so only quiet stretches of ${set.minPause.toFixed(1)} s or more are marked and ${set.pad.toFixed(2)} s is kept on each side. Review them first, or cut them all (one Undo brings them back).`
        : `Analysed ${a.label}. Try a shorter pause or a higher quiet level.`;
      if (!app.rippleEnabled && n) hint += ' Ripple is off: the pieces are joined, but what comes after stays where it is.';
    } else {
      st.textContent = '';
      hint = 'Finds long pauses in this sound, on this device (nothing is uploaded). It uses ' + sourceOf(item).label + ' and nothing is cut until you say so.';
    }
    const h = $('silHint'); h.textContent = hint; h.hidden = !hint; h.classList.toggle('warn', warn);
    renderTight(cur, a, here);
    if (here) renderProgress();
    void type;
  }
  function renderTight(cur, a, here) {
    const tb = $('silTight'); if (!tb) return;
    tb.hidden = here || (!!err && !a);
    $('silBreath').value = String(breath);
    const tv = a ? tightVisible(cur) : null, on = tv ? tv.filter(e => !tightOff.has(e.key)) : [];
    const saved = on.reduce((s, e) => s + e.len, 0);
    $('silTightSum').textContent = !tv ? '' : tv.length ? `${tv.length} long ${tv.length === 1 ? 'pause' : 'pauses'} → ${breath} s · ${fmtS(saved)} shorter` : 'No pause longer than ' + (breath + 0.15).toFixed(2).replace(/0$/, '') + ' s';
    $('silTighten').disabled = !!tv && !tv.length;
    $('silTighten').textContent = !tv ? 'Find and tighten pauses' : 'Tighten pauses';
    $('silTightReview').hidden = !tv || !tv.length || tightOpen;
    const list = $('silTightList'), show = tightOpen && !!tv && tv.length > 0;
    list.hidden = !show; $('silTightListRow').hidden = !show;
    if (show) {
      list.innerHTML = tv.map((e, i) => `<li data-i="${i}" class="${i === tightCur ? 'cur' : ''}"><label><input type="checkbox" data-k="${e.key}" ${tightOff.has(e.key) ? '' : 'checked'} /> <span class="t">${fmtT(e.items[0].t0)}</span> <span>${fmtS(e.pause)} → ${breath} s</span></label><button class="btn ghost small" type="button" data-play="${i}" aria-label="Play pause ${i + 1}">▶</button></li>`).join('');
      $('silTightApply').disabled = !on.length; $('silTightApply').textContent = on.length ? `Tighten ${on.length} ticked` : 'Nothing ticked';
    }
    $('silTightTip').hidden = cleanLevelOf(cur.item) !== 'off' || !$('cleanBox') || $('cleanBox').hidden;
  }
  function renderProgress() {
    if (!job) return;
    $('silBar').style.width = Math.round(job.frac * 100) + '%';
    const e = etaText(job.eta);
    $('silProgText').textContent = (job.frac > 0 ? 'Listening ' + Math.round(job.frac * 100) + '%' : 'Starting…') + (e ? ' · ' + e : '');
  }

  async function scan(cur) {
    if (job) return;
    const { item } = cur, src = sourceOf(item), ctl = new AbortController();
    job = { mediaId: item.mediaId, frac: 0, eta: null, ctl }; err = null; render();
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    try {
      const rec = await media.get(src.id) || await media.get(item.mediaId);
      if (!rec) throw new Error('The sound of this file isn’t available.');
      const S = await import('./silence-scan.js');
      const from = Math.max(0, item.in), to = Math.max(from + 0.1, item.out);
      const r = await S.scanLoudness(rec.blob, rec.name, rec.duration, from, to, { signal: ctl.signal, onProgress: (p) => { job.frac = p.frac; job.eta = p.etaSec; renderProgress(); } });
      cache.set(item.mediaId, { srcId: src.id, label: src.label, from, to, db: r.db, auto: autoThreshold(r.db), dismissed: new Set(), review: -1 });
      while (cache.size > 4) cache.delete(cache.keys().next().value);
    } catch (e) {
      if (e && e.name === 'ScanCancelled') toast('Cancelled. Nothing was changed.');
      else { err = e && e.noAudio ? 'This file has no sound.' : 'Could not read the sound: ' + ((e && e.message) || 'unknown error'); toast(err, 6000); }
    } finally {
      try { wake && wake.release(); } catch { /* ignore */ }
      job = null; render(); redraw();
      if (afterScan === 'tighten') { afterScan = null; const c2 = current(); if (c2 && analysisFor(c2.item)) tighten(c2, false); }
    }
  }
  /** Tighten every (ticked) long pause of the selected sound. */
  function tighten(cur, onlyTicked) {
    const tv = tightVisible(cur); if (!tv) { afterScan = 'tighten'; return void scan(cur); }
    const list = onlyTicked ? tv.filter(e => !tightOff.has(e.key)) : tv;
    if (!list.length) return toast('No pause long enough to tighten at ' + breath + ' s.');
    tightOpen = false; tightCur = -1;
    doCut(cur, list, 'Tighten pauses', (r) => `Tightened ${list.length} ${list.length === 1 ? 'pause' : 'pauses'} to ${breath} s (${fmtS(r.removed)} shorter).`, { fade: MICRO_FADE });
    tightOff.clear(); render(); redraw();
  }

  function doCut(cur, ranges, label, doneMsg, { fade = 0 } = {}) {
    stopPreview();
    const sel = { type: cur.type, id: cur.item.id };
    const linked = !$('silLinkedRow').hidden && $('silLinked').checked;
    const r = cutSilences(app.project, sel, ranges.map(e => ({ a: e.a, b: e.b })), { ripple: !!app.rippleEnabled, linked, fade });
    if (!r) return toast('Nothing to cut here.');
    commit(label);
    player.invalidate();
    toast(doneMsg(r) + (app.rippleEnabled ? '' : ' Ripple is off, so later items stayed in place.') + ' Undo brings it back.', 5000);
  }
  function preview1(e) {
    stopPreview();
    const it = e.items[0]; if (!it) return;
    const lead = 1.0, tail = 1.0, from = Math.max(0, it.t0 - lead);
    timeline.reveal && timeline.reveal(it.t0);
    player.setTime(from); player.play(1);
    preview = { phase: 0, timer: 0 };
    preview.timer = setInterval(() => {
      if (!player.playing) { stopPreview(); return; }
      if (preview.phase === 0 && player.t >= it.t0) { preview.phase = 1; player.setTime(it.t1); if (!player.playing) player.play(1); }
      else if (preview.phase === 1 && player.t >= it.t1 + tail) stopPreview();
    }, 40);
  }
  function goto(i, play = true) {
    const cur = current(); if (!cur) return;
    const v = visible(cur), a = analysisFor(cur.item); if (!v || !a || !v.length) return;
    a.review = Math.max(0, Math.min(v.length - 1, i));
    const e = v[a.review];
    stopPreview();
    player.setTime(e.items[0].t0); timeline.reveal && timeline.reveal(e.items[0].t0);
    render(); redraw();
    if (play) preview1(e);
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = current(); if (!cur) return;
    const a = analysisFor(cur.item), v = a ? visible(cur) : null;
    switch (b.id) {
      case 'silFind': return void scan(cur);
      case 'silTighten': return void tighten(cur, false);
      case 'silTightReview': tightOpen = true; tightCur = -1; render(); redraw(); return;
      case 'silTightClose': tightOpen = false; tightCur = -1; render(); redraw(); return;
      case 'silTightApply': return void tighten(cur, true);
      case 'silTightClean': { const cb = $('cleanBox'); if (cb) { cb.scrollIntoView({ block: 'center', behavior: 'smooth' }); cb.classList.add('flash'); setTimeout(() => cb.classList.remove('flash'), 1200); } return; }
      case 'silCancel': if (job) job.ctl.abort(); return;
      case 'silClear': stopPreview(); cache.delete(cur.item.mediaId); render(); redraw(); return;
      case 'silRescan': stopPreview(); cache.delete(cur.item.mediaId); render(); redraw(); return void scan(cur);
      case 'silCut': if (v && v.length) doCut(cur, v, 'Remove silences', (r) => `Removed ${v.length} ${v.length === 1 ? 'silence' : 'silences'} (${fmtS(r.removed)}).`); return;
      case 'silReviewBtn': if (v && v.length) goto(0); return;
      case 'silPrev': if (a) goto(a.review - 1); return;
      case 'silNext': if (a) goto(a.review + 1); return;
      case 'silPlay': if (v && a && v[a.review]) preview1(v[a.review]); return;
      case 'silKeep': if (v && a && v[a.review]) { a.dismissed.add(v[a.review].key); const i = a.review; render(); redraw(); const v2 = visible(cur); if (v2 && v2.length) goto(Math.min(i, v2.length - 1)); else { a.review = -1; render(); redraw(); } } return;
      case 'silDelete': if (v && a && v[a.review]) { const e1 = v[a.review], i = a.review; doCut(cur, [e1], 'Delete silence', (r) => `Removed a ${fmtS(r.removed)} silence.`); const v2 = visible(cur); if (v2 && v2.length) goto(Math.min(i, v2.length - 1), false); else { a.review = -1; render(); redraw(); } } return;
      default:
        if (b.dataset.play != null) { const tv = tightVisible(cur), e1 = tv && tv[+b.dataset.play]; if (e1) { tightCur = +b.dataset.play; render(); redraw(); preview1(e1); } }
    }
  });
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'silBreath') { const v = Number(t.value); if (BREATHS.includes(v)) { breath = v; try { localStorage.setItem(LS_BREATH, String(v)); } catch { /* private mode */ } } tightOff.clear(); render(); redraw(); return; }
    if (t.dataset && t.dataset.k != null) { const k = Number(t.dataset.k); if (t.checked) tightOff.delete(k); else tightOff.add(k); render(); redraw(); }
  });
  let raf = 0;
  const slide = () => {
    const cur = current(); if (!cur) return;
    set = normSettings({ auto: $('silAuto').checked, thr: Number($('silThr').value), minPause: Number($('silMin').value), pad: Number($('silPad').value) });
    save();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { render(); redraw(); });
  };
  for (const id of ['silThr', 'silMin', 'silPad', 'silAuto']) { $(id).addEventListener('input', slide); $(id).addEventListener('change', slide); }
  return { render, get job() { return job; }, stop: stopPreview };
}
