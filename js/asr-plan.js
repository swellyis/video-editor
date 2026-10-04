// Planning for the speech engine (pure): cut the loud parts of the audio into jobs of at most ~29 s, so quiet stretches are never
// transcribed and the 30 s Whisper window is filled with speech instead of silence. Words come back in job time and are mapped to the
// timeline. Nothing here touches the browser.
export const JOB_MAX = 29;   // Whisper's window is 30 s
export const JOB_PAD = 0.4;  // silence put between two pieces glued into one job

/** Split any region longer than `max` at its quietest frame (between 55 % and 95 % of the way), so words are not cut in half. */
export function splitLong(regs, db, frameSec, max = JOB_MAX - 1) {
  const out = [];
  const rec = (r) => {
    if (r.b - r.a <= max) { out.push(r); return; }
    const lo = Math.round((r.a + (max * 0.55)) / frameSec), hi = Math.round((r.a + max * 0.95) / frameSec);
    let best = lo, bv = Infinity;
    for (let f = lo; f <= hi && f < db.length; f++) { const v = db[f] + (f > lo + 2 && f < hi - 2 ? 0 : 3); if (v < bv) { bv = v; best = f; } }
    const cut = Math.min(r.b - 0.3, Math.max(r.a + 0.3, best * frameSec));
    rec({ ...r, b: cut }); rec({ ...r, a: cut });
  };
  for (const r of regs) rec(r);
  return out;
}

/** Glue regions into jobs: { segs: [{ a, b, off, data? }], len }. `off` is where the piece starts inside the job's audio. */
export class Packer {
  constructor(max = JOB_MAX, pad = JOB_PAD) { this.max = max; this.pad = pad; this.cur = null; }
  /** Add a region (any extra fields, e.g. its audio `data`, are kept); returns the jobs that are now full. */
  add(r) {
    const done = [], len = r.b - r.a;
    if (this.cur && this.cur.len + this.pad + len > this.max) { done.push(this.cur); this.cur = null; }
    if (!this.cur) this.cur = { segs: [], len: 0 };
    const off = this.cur.segs.length ? this.cur.len + this.pad : 0;
    this.cur.segs.push({ ...r, off }); this.cur.len = off + len;
    return done;
  }
  flush() { const j = this.cur; this.cur = null; return j; }
}
/** The job's samples: its pieces (seg.data) with `pad` seconds of silence between them. */
export function jobAudio(job, sr) {
  const out = new Float32Array(Math.ceil(job.len * sr) + 1);
  for (const s of job.segs) if (s.data) out.set(s.data, Math.round(s.off * sr));
  return out;
}
/** Job time → source time (the seconds the pieces were cut from). Times in a pad snap to the nearest piece. */
export function toSource(job, t) {
  let best = job.segs[0], bd = Infinity;
  for (const s of job.segs) {
    const len = s.b - s.a;
    if (t >= s.off && t <= s.off + len) return s.a + (t - s.off);
    const d = t < s.off ? s.off - t : t - (s.off + len);
    if (d < bd) { bd = d; best = s; }
  }
  return t < best.off ? best.a : best.b;
}
/** Words in job time → words in source time. A word that runs into a pad ends where its piece ends. */
export function mapWords(job, words) {
  return words.map(w => {
    const s = toSource(job, w.start); let e = toSource(job, Math.max(w.end, w.start + 0.05));
    if (e < s) e = s + 0.05;
    const seg = job.segs.find(x => s >= x.a - 1e-9 && s <= x.b + 1e-9);
    if (seg && e > seg.b + 0.12) e = seg.b + 0.12;
    return { ...w, start: s, end: Math.max(e, s + 0.05) };
  });
}
/** The rest of a job from job time `t` on (used when the engine's word times collapse part-way). */
export function jobTail(job, t, sr) {
  const segs = []; let off = 0;
  for (const s of job.segs) {
    const len = s.b - s.a;
    if (s.off + len <= t + 1e-6) continue;
    const skip = Math.max(0, t - s.off), a = s.a + skip;
    const piece = { ...s, a, off: segs.length ? off : 0 };
    if (s.data) piece.data = s.data.subarray(Math.min(s.data.length, Math.round(skip * sr)));
    segs.push(piece); off = piece.off + (s.b - a) + JOB_PAD;
  }
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  return { segs, len: last.off + (last.b - last.a), tries: (job.tries || 0) + 1 };
}
/** Spread the words of a job evenly over `a`..`b` (weighted by length) when their own times are unusable. */
export const spreadWords = (ws, a, b) => {
  const tot = ws.reduce((n, w) => n + w.w.length + 1, 0), span = Math.max(0.2, b - a); let at = a;
  return ws.map(w => { const d = span * (w.w.length + 1) / tot; const o = { ...w, start: at, end: at + d }; at += d; return o; });
};
