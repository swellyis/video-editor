// A small sequential job queue (pure, no DOM) used by Batch Shorts export: runs one item at a time, reports per-item state and
// overall progress, and stops cleanly on cancel (the running item and everything still waiting become 'cancelled').

/** States an item goes through: waiting → running → done | failed | skipped | cancelled. */
export const STATES = ['waiting', 'running', 'done', 'failed', 'skipped', 'cancelled'];

export class Skip extends Error { constructor(msg) { super(msg); this.name = 'Skip'; } }

const isAbort = (e, signal) => (signal && signal.aborted) || (e && (e.name === 'AbortError' || e.name === 'ExportCancelled'));

/**
 * Run `worker(item, { signal, progress(frac, stage) })` for each item in order.
 * Returns the list of rows { item, state, frac, stage, result, error }. onUpdate(rows, overallFrac) is called on every change.
 * A worker that throws Skip marks the item 'skipped' (with the message) and the queue goes on; any other error marks it 'failed'
 * and the queue goes on too; cancel (signal) stops the queue.
 */
export async function runQueue(items, worker, { signal, onUpdate } = {}) {
  const rows = items.map(item => ({ item, state: 'waiting', frac: 0, stage: '', result: null, error: '' }));
  const overall = () => rows.length ? rows.reduce((s, r) => s + (r.state === 'running' ? r.frac : r.state === 'waiting' ? 0 : 1), 0) / rows.length : 1;
  const emit = () => { if (onUpdate) onUpdate(rows, overall()); };
  emit();
  for (const row of rows) {
    if (signal && signal.aborted) break;
    row.state = 'running'; row.stage = 'Starting…'; emit();
    try {
      row.result = await worker(row.item, { signal, progress: (f, stage) => { row.frac = Math.max(0, Math.min(1, +f || 0)); if (stage) row.stage = stage; emit(); } });
      if (signal && signal.aborted) { row.state = 'cancelled'; break; }
      row.state = 'done'; row.frac = 1;
    } catch (e) {
      if (isAbort(e, signal)) { row.state = 'cancelled'; row.error = 'Cancelled'; break; }
      row.state = e instanceof Skip || (e && e.name === 'Skip') ? 'skipped' : 'failed';
      row.error = String(e && e.message || e);
    }
    emit();
  }
  for (const r of rows) if (r.state === 'waiting' || r.state === 'running') { r.state = 'cancelled'; r.error = r.error || 'Cancelled'; }
  emit();
  return rows;
}

/** Plain-language summary of a finished queue: "3 exported · 1 failed · 1 cancelled". */
export function summarize(rows) {
  const n = (s) => rows.filter(r => r.state === s).length, parts = [];
  if (n('done')) parts.push(n('done') + ' exported');
  if (n('skipped')) parts.push(n('skipped') + ' skipped');
  if (n('failed')) parts.push(n('failed') + ' failed');
  if (n('cancelled')) parts.push(n('cancelled') + ' cancelled');
  return parts.join(' · ') || 'Nothing to export';
}
