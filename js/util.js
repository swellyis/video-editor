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
export function safeName(n) {
  return (n || 'video').replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video';
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
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMac = () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
export async function dataURLToBlob(url) { return (await fetch(url)).blob(); }
export function nextFrame() { return new Promise(r => requestAnimationFrame(() => r())); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Small inline SVG icons (no dependency on symbol fonts, which vary by device). */
const ICONS = {
  pip: '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="8" width="5" height="4" rx="1" fill="currentColor"/>',
  key: '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 11l2.5-3.5L9.5 10l1.5-2L13 11z" fill="currentColor"/><circle cx="5.5" cy="6" r="1.3" fill="currentColor"/>',
  crosshair: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  crossfade: '<path d="M2 3l6 5-6 5zM14 3l-6 5 6 5z" fill="currentColor" opacity=".9"/>',
};
export function icon(name, cls = 'ico') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}
