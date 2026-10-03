// Effects library: the list of effects and how a clip's / overlay's `fx` list is kept tidy. Pure data (no DOM), so the model, the UI and the
// unit tests can all import it. The picture maths lives in fx-gl.js and is used by the one shared compositor (preview, MP4, WebM, thumbnails).
export const MAX_FX = 3;
export const GROUPS = ['Focus', 'Light', 'Motion', 'Retro', 'Frame'];
// mode = the number the shader switches on; amount = default strength (0..1); fixed = no strength slider (the effect is on or off)
export const EFFECTS = [
  { id: 'blur', label: 'Blur', group: 'Focus', mode: 1, amount: 0.5, blurs: true },
  { id: 'soft', label: 'Soft focus', group: 'Focus', mode: 2, amount: 0.5, blurs: true },
  { id: 'sharpen', label: 'Sharpen', group: 'Focus', mode: 3, amount: 0.5 },
  { id: 'glow', label: 'Glow', group: 'Light', mode: 4, amount: 0.5, blurs: true },
  { id: 'leak', label: 'Light leak', group: 'Light', mode: 5, amount: 0.6 },
  { id: 'rays', label: 'Sun rays', group: 'Light', mode: 6, amount: 0.6 },
  { id: 'flash', label: 'Flash', group: 'Light', mode: 7, amount: 0.6 },
  { id: 'shake', label: 'Shake', group: 'Motion', mode: 8, amount: 0.5 },
  { id: 'pulse', label: 'Zoom pulse', group: 'Motion', mode: 9, amount: 0.5 },
  { id: 'grain', label: 'Film grain', group: 'Retro', mode: 10, amount: 0.5 },
  { id: 'glitch', label: 'Glitch', group: 'Retro', mode: 11, amount: 0.5 },
  { id: 'chroma', label: 'Chromatic', group: 'Retro', mode: 12, amount: 0.5 },
  { id: 'pixel', label: 'Pixelate', group: 'Retro', mode: 13, amount: 0.4 },
  { id: 'mirror', label: 'Mirror', group: 'Frame', mode: 14, amount: 1, fixed: true },
  { id: 'bars', label: 'Cinema bars', group: 'Frame', mode: 15, amount: 0.52 },
];
const BY_ID = new Map(EFFECTS.map(e => [e.id, e]));
export const fxInfo = (id) => BY_ID.get(id) || null;
export const fxLabel = (id) => (BY_ID.get(id) ? BY_ID.get(id).label : String(id));
export const newFx = (id) => ({ type: id, amount: fxInfo(id).amount });
/** A clean fx list: known effects only, strength 0..1, at most MAX_FX, never the same effect twice. */
export function normFx(list) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const f of list) {
    if (!f || typeof f !== 'object' || !BY_ID.has(f.type) || seen.has(f.type)) continue;
    const a = Number(f.amount);
    out.push({ type: f.type, amount: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : BY_ID.get(f.type).amount });
    seen.add(f.type);
    if (out.length >= MAX_FX) break;
  }
  return out;
}
/** Effects that actually change the picture (strength above 0, or a fixed effect). */
export const activeFx = (list) => (Array.isArray(list) ? list.filter(f => f && fxInfo(f.type) && (fxInfo(f.type).fixed || f.amount > 0.001)) : []);
export function addFx(list, id) {
  if (!fxInfo(id)) return { list, why: 'unknown' };
  if (list.some(f => f.type === id)) return { list, why: 'have' };
  if (list.length >= MAX_FX) return { list, why: 'full' };
  return { list: [...list, newFx(id)], why: null };
}
export function moveFx(list, i, d) {
  const j = i + d; if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const o = list.slice(); [o[i], o[j]] = [o[j], o[i]]; return o;
}
