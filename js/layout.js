// Workspace layout state: pure logic (no DOM) so it can be unit tested. js/layout-ui.js draws it.
// One state object describes the whole wide-screen workspace: a LIBRARY dock (icon rail + panel), the centre PREVIEW,
// a PROPERTIES dock and the TIMELINE row. Everything is clamped to sane min/max sizes for the current window.

export const VERSION = 1;
export const RAIL_W = 68;          // icon rail (px), always shown while the library dock is shown
export const SPLIT_W = 8;          // splitter hit width (px)
export const LIB_MIN = 220, LIB_MAX = 560;
export const PROP_MIN = 260, PROP_MAX = 560;
export const CENTER_MIN = 380;     // the preview never gets narrower than this
export const TOP_MIN = 0.25, TOP_MAX = 0.85; // share of the workspace height used by the top row (preview + docks)
export const WS_MIN_W = 960, WS_MIN_H = 560; // below this the original single-column / phone layout stays

export const PRESETS = {
  default: { libShow: true, libOpen: true, libW: 340, propShow: true, propW: 340, top: 0.6, swap: false },
  editing: { libShow: true, libOpen: true, libW: 280, propShow: true, propW: 300, top: 0.42, swap: false },
  preview: { libShow: true, libOpen: false, libW: 300, propShow: false, propW: 320, top: 0.78, swap: false },
  compact: { libShow: true, libOpen: true, libW: 240, propShow: true, propW: 270, top: 0.56, swap: false },
};
export const PRESET_LABELS = { default: 'Default', editing: 'Editing (large timeline)', preview: 'Preview focus', compact: 'Compact' };

/** Is the workspace (Filmora-style) layout used at this window size? Phones and narrow/portrait windows keep the original layout. */
export const isWorkspace = (w, h) => w >= WS_MIN_W && h >= WS_MIN_H;
/** Size class used for the stored layout, so a laptop and a big monitor can each remember their own arrangement. */
export const sizeClass = (w) => (w >= 1700 ? 'xl' : w >= 1280 ? 'lg' : 'md');
export const storageKey = (w) => 've.layout.v' + VERSION + '.' + sizeClass(w);
/** The preset a window of this size starts with when nothing is stored (small windows and tablets go compact). */
export const autoPreset = (w) => (sizeClass(w) === 'md' ? 'compact' : 'default');

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** A complete, valid state from any (possibly partial or untrusted) object. */
export function normalize(o, base = PRESETS.default) {
  o = o && typeof o === 'object' ? o : {};
  const name = typeof o.preset === 'string' && (o.preset in PRESETS || o.preset === 'custom') ? o.preset : 'custom';
  return {
    v: VERSION, preset: name,
    libShow: bool(o.libShow, base.libShow), libOpen: bool(o.libOpen, base.libOpen), libW: Math.round(num(o.libW, LIB_MIN, LIB_MAX, base.libW)),
    propShow: bool(o.propShow, base.propShow), propW: Math.round(num(o.propW, PROP_MIN, PROP_MAX, base.propW)),
    top: Math.round(num(o.top, TOP_MIN, TOP_MAX, base.top) * 1000) / 1000, swap: bool(o.swap, base.swap),
  };
}
export const fromPreset = (name) => normalize({ ...(PRESETS[name] || PRESETS.default), preset: PRESETS[name] ? name : 'default' });
export const defaults = (w) => fromPreset(autoPreset(w));
/** Parse what was stored (JSON text). Returns null when it is missing, corrupt or from another version. */
export function parse(text) {
  if (typeof text !== 'string' || text.length > 2000) return null;
  let o; try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== VERSION) return null;
  return normalize(o);
}
export const serialize = (s) => JSON.stringify(normalize(s));

const custom = (s, patch) => normalize({ ...s, ...patch, preset: 'custom' });
export const applyPreset = (s, name) => (PRESETS[name] ? fromPreset(name) : s);
export const toggle = (s, which) => {
  if (which === 'lib') return custom(s, s.libShow && s.libOpen ? { libOpen: false } : { libShow: true, libOpen: true });
  if (which === 'props') return custom(s, { propShow: !s.propShow });
  return s;
};
/** Show/hide a whole dock from the Layout menu (the library dock includes the icon rail). */
export const setShown = (s, which, on) => (which === 'lib' ? custom(s, { libShow: !!on, libOpen: on ? true : s.libOpen }) : which === 'props' ? custom(s, { propShow: !!on }) : s);
export const setWidth = (s, which, px) => (which === 'lib' ? custom(s, { libW: px, libOpen: true, libShow: true }) : custom(s, { propW: px, propShow: true }));
export const setTop = (s, f) => custom(s, { top: f });
export const swapSides = (s) => custom(s, { swap: !s.swap });
/** Double-click on a splitter: put that one measure back to its Default value. */
export function resetPart(s, part) {
  const d = PRESETS.default;
  if (part === 'lib') return custom(s, { libW: d.libW, libOpen: true });
  if (part === 'props') return custom(s, { propW: d.propW });
  if (part === 'top') return custom(s, { top: d.top });
  return s;
}
/** Keyboard resize of a splitter: delta in px for the docks (or a fraction for the timeline split). */
export function nudge(s, part, delta) {
  if (part === 'lib') return setWidth(s, 'lib', s.libW + delta);
  if (part === 'props') return setWidth(s, 'props', s.propW + delta);
  return setTop(s, s.top + delta);
}

/** Widths actually used at this window width: docks shrink (never below their minimum) so the preview keeps CENTER_MIN. */
export function effective(s, vw) {
  s = normalize(s);
  const rail = s.libShow ? RAIL_W : 0;
  const splitL = s.libShow && s.libOpen ? SPLIT_W : 0, splitR = s.propShow ? SPLIT_W : 0;
  let lib = s.libShow && s.libOpen ? s.libW : 0, prop = s.propShow ? s.propW : 0;
  const room = vw - CENTER_MIN - rail - splitL - splitR;
  if (lib + prop > room) {
    const over = lib + prop - room;
    const canL = lib ? lib - LIB_MIN : 0, canP = prop ? prop - PROP_MIN : 0, can = canL + canP;
    if (can > 0) { const k = Math.min(1, over / can); lib -= canL * k; prop -= canP * k; }
    lib = Math.floor(lib); prop = Math.floor(prop);
  }
  return { rail, lib, prop, splitL, splitR, libDock: rail + lib, centre: vw - rail - lib - prop - splitL - splitR };
}
/** Largest width a dock may be dragged to at this window width (keeps the preview at CENTER_MIN). */
export function maxWidth(s, which, vw) {
  s = normalize(s);
  const rail = s.libShow ? RAIL_W : 0, other = which === 'lib' ? (s.propShow ? s.propW : 0) : (s.libShow && s.libOpen ? s.libW : 0);
  const cap = which === 'lib' ? LIB_MAX : PROP_MAX, min = which === 'lib' ? LIB_MIN : PROP_MIN;
  const room = vw - CENTER_MIN - rail - 2 * SPLIT_W - Math.max(other, which === 'lib' ? PROP_MIN * (s.propShow ? 1 : 0) : LIB_MIN * (s.libShow && s.libOpen ? 1 : 0));
  return Math.max(min, Math.min(cap, room));
}
/** CSS grid templates for the workspace. Areas: dockL splL stage splR dockR (a swap moves the docks, not the preview). */
export function grid(s, vw) {
  s = normalize(s);
  const e = effective(s, vw);
  const L = e.libDock, R = e.prop;
  const cols = s.swap
    ? [R + 'px', e.splitR + 'px', 'minmax(0,1fr)', e.splitL + 'px', L + 'px']
    : [L + 'px', e.splitL + 'px', 'minmax(0,1fr)', e.splitR + 'px', R + 'px'];
  const t = s.top;
  return { columns: cols.join(' '), rows: `minmax(0,${(t * 100).toFixed(2)}fr) ${SPLIT_W}px minmax(150px,${((1 - t) * 100).toFixed(2)}fr)`, effective: e };
}
