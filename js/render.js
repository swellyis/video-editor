// Frame compositor shared by preview, thumbnail maker and export.
import { activeAt, effectiveColor, colorIsNeutral, FONTS, sourceTime } from './model.js';
import { clamp } from './util.js';

const VERT = `attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.0)*0.5,1.0-(p.y+1.0)*0.5);gl_Position=vec4(p,0.0,1.0);}`;
const FRAG = `precision mediump float;varying vec2 uv;uniform sampler2D tex;
uniform float bri,con,sat,tmp,sep,fad,vig;uniform vec2 asp;
void main(){vec3 c=texture2D(tex,uv).rgb;
c+=bri;c=(c-0.5)*con+0.5;
float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,sat);
c.r+=tmp*0.09;c.g+=tmp*0.02;c.b-=tmp*0.09;
vec3 s=vec3(dot(c,vec3(.393,.769,.189)),dot(c,vec3(.349,.686,.168)),dot(c,vec3(.272,.534,.131)));c=mix(c,s,sep);
c=mix(c,vec3(0.08)+c*0.86,fad);
vec2 d=(uv-0.5)*asp;float r=length(d)*1.5;c*=1.0-vig*smoothstep(0.45,1.25,r);
gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}`;

class ColorGL {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ok = false;
    try {
      const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link failed');
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.u = {}; for (const n of ['bri', 'con', 'sat', 'tmp', 'sep', 'fad', 'vig', 'asp']) this.u[n] = gl.getUniformLocation(pr, n);
      this.gl = gl; this.ok = true;
      this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    } catch (e) { console.warn('WebGL color pipeline unavailable', e); this.ok = false; }
  }
  process(src, W, H, c) {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1f(this.u.bri, c.brightness / 250);
    gl.uniform1f(this.u.con, 1 + c.contrast / 100);
    gl.uniform1f(this.u.sat, 1 + c.saturation / 100);
    gl.uniform1f(this.u.tmp, c.temperature / 100);
    gl.uniform1f(this.u.sep, c.sepia / 100);
    gl.uniform1f(this.u.fad, c.fade / 100);
    gl.uniform1f(this.u.vig, c.vignette / 100);
    const m = Math.max(W, H); gl.uniform2f(this.u.asp, W / m, H / m);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let filterSupport = null;
export function canvasFilterSupported() {
  if (filterSupport !== null) return filterSupport;
  try {
    const c = document.createElement('canvas'); c.width = 5; c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.filter = 'blur(1px)'; x.fillStyle = '#fff'; x.fillRect(2, 0, 1, 1);
    filterSupport = x.getImageData(0, 0, 1, 1).data[3] > 0 || x.getImageData(1, 0, 1, 1).data[3] > 0;
  } catch { filterSupport = false; }
  return filterSupport;
}

export async function ensureFonts() {
  if (!document.fonts) return;
  await Promise.all(Object.values(FONTS).map(f => document.fonts.load(f.css.replace('{s}', '40')).catch(() => { })));
}

export function fontCss(key, size) { return (FONTS[key] || FONTS.sans).css.replace('{s}', Math.round(size)); }

export function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out.slice(0, 10);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}
function hexA(hex, a) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Draw a text layer; returns its bounding box. alpha = fade. */
export function drawText(ctx, W, H, tl, alpha = 1) {
  const base = Math.min(W, H);
  const size = Math.max(8, tl.size * base);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = fontCss(tl.font, size);
  ctx.textBaseline = 'middle';
  const maxW = (tl.maxWidth || 0.86) * W;
  const lines = wrapLines(ctx, tl.text, maxW);
  const lh = size * 1.16;
  const widths = lines.map(l => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths), bh = lines.length * lh;
  const cx = tl.x * W, cy = tl.y * H;
  const x0 = tl.align === 'left' ? cx - bw / 2 : tl.align === 'right' ? cx - bw / 2 : cx - bw / 2;
  const padX = size * 0.45, padY = size * 0.28;
  if (tl.style === 'band') {
    ctx.fillStyle = hexA(tl.bg, tl.bgOpacity ?? 0.62);
    ctx.fillRect(0, cy - bh / 2 - padY, W, bh + padY * 2);
  } else if (tl.style === 'box') {
    ctx.fillStyle = hexA(tl.bg, tl.bgOpacity ?? 0.62);
    roundRect(ctx, x0 - padX, cy - bh / 2 - padY, bw + padX * 2, bh + padY * 2, size * 0.22);
    ctx.fill();
  }
  ctx.textAlign = tl.align || 'center';
  const ax = tl.align === 'left' ? x0 : tl.align === 'right' ? x0 + bw : cx;
  lines.forEach((line, i) => {
    const y = cy + (i - (lines.length - 1) / 2) * lh;
    if (tl.style === 'clean') {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.28; ctx.shadowOffsetY = size * 0.04;
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.strokeText(line, ax, y);
      ctx.restore();
    } else if (tl.style === 'outline') {
      ctx.lineJoin = 'round'; ctx.strokeStyle = tl.bg || '#000'; ctx.lineWidth = Math.max(3, size * 0.18);
      ctx.strokeText(line, ax, y);
    }
    ctx.fillStyle = tl.color || '#fff';
    ctx.fillText(line, ax, y);
  });
  ctx.restore();
  const bx0 = tl.style === 'band' ? 0 : x0 - padX, bx1 = tl.style === 'band' ? W : x0 + bw + padX;
  return { id: tl.id, x0: bx0, y0: cy - bh / 2 - padY, x1: bx1, y1: cy + bh / 2 + padY };
}

export class Compositor {
  constructor() {
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');
    this.gl = null; // created lazily
    this.filterOK = canvasFilterSupported();
  }
  _gl() { if (!this.gl) this.gl = new ColorGL(); return this.gl.ok ? this.gl : null; }

  /** geometry for a clip source */
  static placement(clip, sw, sh, W, H, fit, progress) {
    const tr = clip.transform || {};
    const rot = ((tr.rotate || 0) % 360 + 360) % 360;
    const swapped = rot === 90 || rot === 270;
    const rw = swapped ? sh : sw, rh = swapped ? sw : sh;
    const base = fit === 'cover' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
    let z = tr.zoom || 1, px = tr.x || 0, py = tr.y || 0;
    const p = clamp(progress || 0, 0, 1);
    switch (tr.kenBurns) {
      case 'in': z *= 1 + 0.16 * p; break;
      case 'out': z *= 1.16 - 0.16 * p; break;
      case 'left': z *= 1.14; px = clamp(px + 0.9 - 1.8 * p, -1, 1); break;
      case 'right': z *= 1.14; px = clamp(px - 0.9 + 1.8 * p, -1, 1); break;
    }
    const s = base * z;
    const dw = rw * s, dh = rh * s;
    const ox = Math.max(0, (dw - W) / 2), oy = Math.max(0, (dh - H) / 2);
    return { cx: W / 2 - px * ox, cy: H / 2 - py * oy, s, rot, flipH: !!tr.flipH, flipV: !!tr.flipV, sw, sh };
  }

  drawSource(ctx, src, clip, W, H, fit, progress, bg) {
    const { img, w: sw, h: sh } = src;
    if (!sw || !sh) return;
    // background
    if (bg.mode === 'blur') {
      // Cheap, cross-browser blur: render a tiny cover-scaled copy, then upscale with smoothing.
      if (!this.blurC) { this.blurC = document.createElement('canvas'); this.blurX = this.blurC.getContext('2d'); }
      const bw = Math.max(8, Math.round(W / 24)), bh = Math.max(8, Math.round(H / 24));
      if (this.blurC.width !== bw || this.blurC.height !== bh) { this.blurC.width = bw; this.blurC.height = bh; }
      const s = Math.max(bw / sw, bh / sh) * 1.1;
      this.blurX.imageSmoothingEnabled = true; this.blurX.imageSmoothingQuality = 'high';
      this.blurX.drawImage(img, (bw - sw * s) / 2, (bh - sh * s) / 2, sw * s, sh * s);
      ctx.save();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      if (!this.blurM) { this.blurM = document.createElement('canvas'); this.blurMX = this.blurM.getContext('2d'); }
      const mw = bw * 4, mh = bh * 4;
      if (this.blurM.width !== mw || this.blurM.height !== mh) { this.blurM.width = mw; this.blurM.height = mh; }
      this.blurMX.imageSmoothingEnabled = true; this.blurMX.imageSmoothingQuality = 'high';
      this.blurMX.drawImage(this.blurC, 0, 0, mw, mh);
      ctx.drawImage(this.blurM, -W * 0.02, -H * 0.02, W * 1.04, H * 1.04);
      ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
    const g = Compositor.placement(clip, sw, sh, W, H, fit, progress);
    ctx.save();
    ctx.translate(g.cx, g.cy);
    if (g.rot) ctx.rotate(g.rot * Math.PI / 180);
    ctx.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -sw * g.s / 2, -sh * g.s / 2, sw * g.s, sh * g.s);
    ctx.restore();
  }

  /**
   * Render sequence time t.
   * getSource(item) -> {img,w,h} | null ; getLogo() -> {img,w,h} | null
   */
  render(ctx, W, H, project, lay, t, getSource, opts = {}) {
    const s = project.settings;
    const bg = { mode: s.bg === 'blur' ? 'blur' : 'color', color: s.bg === 'white' ? '#ffffff' : s.bg === 'color' ? (s.bgColor || '#000') : '#000000' };
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const act = activeAt(lay, t);
    let missing = 0;
    for (const { it, alpha, black } of act) {
      const src = getSource(it);
      if (!src) { missing++; continue; }
      const c = it.clip;
      const fit = c.fit && c.fit !== 'inherit' ? c.fit : s.fit;
      const prog = it.len > 0 ? (t - it.start) / it.len : 0;
      const col = effectiveColor(project, c);
      const a = alpha * black;
      if (a <= 0.001) continue;
      const gl = colorIsNeutral(col) ? null : this._gl();
      if (!gl && (colorIsNeutral(col) || !this.filterOK)) {
        ctx.globalAlpha = a;
        this.drawSource(ctx, src, c, W, H, fit, prog, bg);
      } else {
        if (this.layer.width !== W || this.layer.height !== H) { this.layer.width = W; this.layer.height = H; }
        const l = this.lctx;
        l.globalAlpha = 1; l.filter = 'none';
        this.drawSource(l, src, c, W, H, fit, prog, bg);
        ctx.globalAlpha = a;
        if (gl) ctx.drawImage(gl.process(this.layer, W, H, col), 0, 0);
        else {
          ctx.filter = `brightness(${1 + col.brightness / 200}) contrast(${1 + col.contrast / 100}) saturate(${1 + col.saturation / 100}) sepia(${col.sepia / 100})`;
          ctx.drawImage(this.layer, 0, 0);
          ctx.filter = 'none';
        }
      }
    }
    ctx.globalAlpha = 1;
    // texts
    const boxes = [];
    for (const tl of project.texts) {
      if (t < tl.start || t >= tl.end || !tl.text) continue;
      const a = Math.min(tl.fadeIn > 0 ? (t - tl.start) / tl.fadeIn : 1, tl.fadeOut > 0 ? (tl.end - t) / tl.fadeOut : 1);
      boxes.push(drawText(ctx, W, H, tl, clamp(a, 0, 1)));
    }
    // logo / watermark
    const lg = project.logo && opts.getLogo ? opts.getLogo() : null;
    if (lg) {
      const L = project.logo, base = Math.min(W, H);
      const lw = base * (L.size || 0.14), lh = lw * lg.h / lg.w, m = base * (L.margin ?? 0.035);
      const pos = L.position || 'tr';
      const x = pos.includes('l') ? m : pos.includes('r') ? W - lw - m : (W - lw) / 2;
      const y = pos.startsWith('t') ? m : pos.startsWith('b') ? H - lh - m : (H - lh) / 2;
      ctx.globalAlpha = L.opacity ?? 0.85;
      ctx.drawImage(lg.img, x, y, lw, lh);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return { boxes, missing, active: act };
  }
}
export { sourceTime };
