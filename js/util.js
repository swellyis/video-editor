// Small shared helpers
export const $ = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** mm:ss (or h:mm:ss) */
export function fmt(v) {
  v = Number.isFinite(v) ? Math.max(0, v) : 0;
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = Math.floor(v % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
}
/** mm:ss.t precise */
export function fmtPrecise(v, fps = 30) {
  v = Number.isFinite(v) ? Math.max(0, v) : 0;
  const m = Math.floor(v / 60), s = Math.floor(v % 60), f = Math.floor((v % 1) * fps + 1e-6);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ':' + String(f).padStart(2, '0');
}
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return Math.ceil(sec) + 's';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + 'm ' + String(s).padStart(2, '0') + 's';
}
export function fmtBytes(b) {
  if (!Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
}
/**
 * File-name-safe version of a title: keeps letters and digits in any script (Día, 사랑), dots inside the name
 * ("Romans 8.28"), '_' and '-'; everything else (spaces, / \\ : * ? " < > | and control chars) becomes '-'.
 * Titles are not file names, so nothing after a dot is treated as an extension.
 */
export function safeName(n, fallback = 'video') {
  const s = String(n == null ? '' : n).normalize('NFC').trim()
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-').replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  let out = Array.from(s).slice(0, 80).join('').replace(/[-.]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out; // reserved device names on Windows
  return out || fallback;
}
export function stripExt(n) { return (n || '').replace(/\.[^/.]+$/, ''); }

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
export function debounce(fn, ms) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMac = () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
/** Decode a base64 data: URL without fetch() (never touches the network, works under a strict CSP). */
export function dataURLToBlob(url) {
  const m = /^data:([\w.+/-]*)(;[\w=.+-]+)*?(;base64)?,/i.exec(String(url || ''));
  if (!m || !m[3]) throw new Error('Not an embedded (base64) media file');
  const bin = atob(url.slice(m[0].length));
  const CH = 1 << 20, parts = [];
  for (let i = 0; i < bin.length; i += CH) {
    const n = Math.min(CH, bin.length - i), u = new Uint8Array(n);
    for (let j = 0; j < n; j++) u[j] = bin.charCodeAt(i + j);
    parts.push(u);
  }
  return new Blob(parts, { type: m[1] || 'application/octet-stream' });
}

// ---------- tar (ustar) container: project file with raw media, assembled from Blob parts (no copies in memory) ----------
const te = new TextEncoder(), td = new TextDecoder();
/** Largest size the classic 11-digit octal field holds (8 GiB - 1). Bigger entries use the GNU base-256 form, which GNU tar, bsdtar and 7-Zip read. */
export const TAR_OCTAL_MAX = 0o77777777777;
export function tarHeader(name, size, mtime = Date.now()) {
  const h = new Uint8Array(512);
  const put = (str, off, len) => { const b = te.encode(str); h.set(b.subarray(0, len), off); };
  const oct = (v, len) => v.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  if (size <= TAR_OCTAL_MAX) put(oct(size, 12), 124, 12);
  else { h[124] = 0x80; let v = size; for (let i = 135; i > 124; i--) { h[i] = v % 256; v = Math.floor(v / 256); } } // GNU base-256: entries of 8 GiB and more
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  h.fill(32, 148, 156); h[156] = 48; // typeflag '0' (file); checksum field = spaces while summing
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
/** Build a tar Blob from [{ name, data: Blob|string }]. Media Blobs are referenced, not read. */
export function tarBlob(entries) {
  const parts = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? new Blob([e.data]) : e.data;
    parts.push(tarHeader(e.name, data.size), data);
    const pad = (512 - (data.size % 512)) % 512; if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}
export async function isTar(blob) {
  if (blob.size < 1024) return false;
  return td.decode(new Uint8Array(await blob.slice(257, 262).arrayBuffer())) === 'ustar';
}
/** Size field of a tar header: octal, or GNU base-256 (high bit set) for entries of 8 GiB and more. */
export function tarSize(h) {
  if (h[124] & 0x80) { let v = h[124] & 0x7f; for (let i = 125; i < 136; i++) v = v * 256 + h[i]; return v; }
  return parseInt(td.decode(h.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
}
/** Bytes a tarBlob() of these entry sizes takes (headers, padding and the end marker). */
export function tarBytes(sizes) { let n = 1024; for (const s of sizes) n += 512 + Math.ceil(s / 512) * 512; return n; }
/** Read a tar Blob: returns Map name -> Blob slice (no copies). */
export async function readTar(blob) {
  const out = new Map(); let off = 0;
  while (off + 512 <= blob.size) {
    const h = new Uint8Array(await blob.slice(off, off + 512).arrayBuffer());
    if (h.every(b => b === 0)) break;
    const str = (a, b) => td.decode(h.subarray(a, b)).replace(/\0.*$/s, '');
    const name = str(0, 100), size = tarSize(h);
    if (!Number.isFinite(size) || size < 0) throw new Error('Damaged project file');
    out.set(name, blob.slice(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
export function nextFrame() { return new Promise(r => requestAnimationFrame(() => r())); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Small inline SVG icons (no dependency on symbol fonts, which vary by device). */
const ICONS = {
  pip: '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="8" width="5" height="4" rx="1" fill="currentColor"/>',
  key: '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 11l2.5-3.5L9.5 10l1.5-2L13 11z" fill="currentColor"/><circle cx="5.5" cy="6" r="1.3" fill="currentColor"/>',
  crosshair: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  crossfade: '<path d="M2 3l6 5-6 5zM14 3l-6 5 6 5z" fill="currentColor" opacity=".9"/>',
  blur: '<rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 1.6"/><circle cx="6" cy="7" r="1.6" fill="currentColor" opacity=".9"/><circle cx="10" cy="9.4" r="2.1" fill="currentColor" opacity=".55"/>',
  spk: '<path d="M1.5 6h3L8.5 2.5v11L4.5 10h-3z" fill="currentColor"/><path d="M11 5.2a3.6 3.6 0 010 5.6M13 3.4a6.2 6.2 0 010 9.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  spkOff: '<path d="M1.5 6h3L8.5 2.5v11L4.5 10h-3z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
export function icon(name, cls = 'ico') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/**
 * Give the browser a turn (input, paint) before a heavy job continues. Uses scheduler.yield() where there is one; otherwise a
 * MessageChannel hop (no 4 ms timer clamping), and a real timer when the tab is hidden (message hops still run there).
 */
export function yieldToMain() {
  if (typeof scheduler !== 'undefined' && scheduler.yield) return scheduler.yield();
  return new Promise((res) => {
    if (typeof document !== 'undefined' && document.hidden) return setTimeout(res, 0);
    const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); res(); }; ch.port2.postMessage(0);
  });
}
/** Main-thread health: how long the page has been blocked by long tasks (>50 ms), for the safeguards and for tests. */
export const perf = { longTasks: 0, longest: 0, lastLong: 0, blockedMs: 0, over1s: 0 };
export function startLongTaskMonitor() {
  try {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes || !PerformanceObserver.supportedEntryTypes.includes('longtask')) return false;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perf.longTasks++; perf.blockedMs += e.duration; perf.longest = Math.max(perf.longest, e.duration); perf.lastLong = performance.now();
        if (e.duration > 1000) { perf.over1s++; console.info('[perf] the page was blocked for ' + Math.round(e.duration) + ' ms'); }
      }
    }).observe({ type: 'longtask', buffered: true });
    return true;
  } catch { return false; }
}
/**
 * A "polite" loop helper for heavy background work: call `await slice()` inside the loop. It yields to the browser after ~10 ms of
 * work, and backs off (sleeps longer) while the page has recently been blocked by long tasks, so a slow phone stays usable.
 */
export function politeSlicer(budgetMs = 10) {
  let t0 = performance.now();
  return async function slice() {
    const now = performance.now();
    if (now - t0 < budgetMs) return;
    await yieldToMain();
    if (performance.now() - perf.lastLong < 400) await new Promise(r => setTimeout(r, 30)); // recently janky: leave room for input
    t0 = performance.now();
  };
}
