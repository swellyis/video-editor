// Frame compositor shared by preview, thumbnail maker and export.
import { activeAt, effectiveColor, colorIsNeutral, FONTS, sourceTime, animated, hasKeyframes, overlaysAt, EASES } from './model.js';
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


const KFRAG = `precision mediump float;varying vec2 uv;uniform sampler2D tex;uniform vec3 key;uniform float sim,smo,spill;
vec2 chroma(vec3 c){return vec2(-0.169*c.r-0.331*c.g+0.5*c.b,0.5*c.r-0.419*c.g-0.081*c.b);}
void main(){vec4 c=texture2D(tex,uv);float d=distance(chroma(c.rgb),chroma(key));
float a=smoothstep(sim,sim+smo,d);
float l=dot(c.rgb,vec3(0.2126,0.7152,0.0722));
float sp=1.0-smoothstep(sim,sim+smo+0.25,d);
vec3 rgb=mix(c.rgb,vec3(l),sp*spill);
gl_FragColor=vec4(rgb,a*c.a);}`;
class KeyGL {
  constructor() {
    this.canvas = document.createElement('canvas'); this.ok = false;
    try {
      const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: true, antialias: false });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, KFRAG)); gl.linkProgram(pr);
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.u = {}; for (const n of ['key', 'sim', 'smo', 'spill']) this.u[n] = gl.getUniformLocation(pr, n);
      this.gl = gl; this.ok = true;
    } catch (e) { console.warn('Chroma key unavailable', e); }
  }
  process(src, W, H, ck) {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const h = (ck.color || '#00ff00').replace('#', ''), n = parseInt(h, 16);
    gl.uniform3f(this.u.key, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    gl.uniform1f(this.u.sim, (ck.similarity ?? 0.4) * 0.35);
    gl.uniform1f(this.u.smo, Math.max(0.001, (ck.smoothness ?? 0.15) * 0.3));
    gl.uniform1f(this.u.spill, ck.spill ?? 0.5);
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

const backOut = (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
export const TEXT_ANIMS_IN = { none: 'None', fade: 'Fade', typewriter: 'Typewriter', slideUp: 'Slide up', pop: 'Pop', wordByWord: 'Word by word' };
export const TEXT_ANIMS_OUT = { none: 'None', fade: 'Fade', slideDown: 'Slide down', pop: 'Pop out', typewriter: 'Un-type' };

/** Draw a text layer at local time `local` (seconds since its start); returns its bounding box. alpha = fade. */
export function drawText(ctx, W, H, tl, alpha = 1, local = 1e6) {
  const base = Math.min(W, H);
  const size = Math.max(8, tl.size * base);
  const dur = Math.max(0.01, (tl.end ?? 1e9) - (tl.start ?? 0));
  local = Math.min(local, dur);
  const A = animated('text', tl, local);
  const an = tl.anim || {};
  const inP = an.in && an.in !== 'none' ? clamp(local / Math.max(0.05, an.inDur || 0.6), 0, 1) : 1;
  const outP = an.out && an.out !== 'none' ? clamp((dur - local) / Math.max(0.05, an.outDur || 0.4), 0, 1) : 1;
  let a = alpha * clamp(A.opacity, 0, 1), sc = A.scale, dy = 0, reveal = 1, wordP = null;
  switch (an.in) {
    case 'fade': a *= inP; break;
    case 'typewriter': reveal = inP; break;
    case 'wordByWord': wordP = inP; break;
    case 'slideUp': dy += (1 - EASES.easeOut(inP)) * size * 1.4; a *= EASES.easeOut(inP); break;
    case 'pop': sc *= inP >= 1 ? 1 : 0.4 + 0.6 * backOut(inP); a *= Math.min(1, inP * 3); break;
  }
  switch (an.out) {
    case 'fade': a *= outP; break;
    case 'typewriter': reveal = Math.min(reveal, outP); break;
    case 'slideDown': dy += (1 - outP) * (1 - outP) * size * 1.4; a *= outP; break;
    case 'pop': sc *= 0.6 + 0.4 * outP; a *= outP; break;
  }
  ctx.save();
  ctx.globalAlpha = clamp(a, 0, 1);
  ctx.font = fontCss(tl.font, size);
  ctx.textBaseline = 'middle';
  const maxW = (tl.maxWidth || 0.86) * W;
  const lines = wrapLines(ctx, tl.text, maxW);
  const lh = size * 1.16;
  const widths = lines.map(l => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths), bh = lines.length * lh;
  const cx = A.x * W, cy = A.y * H + dy;
  const padX = size * 0.45, padY = size * 0.28;
  ctx.translate(cx, cy);
  if (A.rotation) ctx.rotate(A.rotation * Math.PI / 180);
  if (sc !== 1) ctx.scale(sc, sc);
  if (tl.style === 'band') {
    ctx.fillStyle = hexA(tl.bg, tl.bgOpacity ?? 0.62);
    const ext = W * 2;
    ctx.fillRect(-ext, -bh / 2 - padY, ext * 2, bh + padY * 2);
  } else if (tl.style === 'box') {
    ctx.fillStyle = hexA(tl.bg, tl.bgOpacity ?? 0.62);
    roundRect(ctx, -bw / 2 - padX, -bh / 2 - padY, bw + padX * 2, bh + padY * 2, size * 0.22);
    ctx.fill();
  }
  ctx.textAlign = 'left';
  const total = lines.reduce((n, l) => n + l.length, 0);
  let shown = reveal >= 1 ? Infinity : Math.floor(reveal * total + 1e-6);
  const nWords = lines.reduce((n, l) => n + (l ? l.split(' ').length : 0), 0);
  let wi = 0;
  const paint = (str, x, y, alphaMul) => {
    if (!str) return;
    if (alphaMul !== 1) ctx.globalAlpha = clamp(a * alphaMul, 0, 1);
    if (tl.style === 'clean') {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.28; ctx.shadowOffsetY = size * 0.04;
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.strokeText(str, x, y);
      ctx.restore();
    } else if (tl.style === 'outline') {
      ctx.lineJoin = 'round'; ctx.strokeStyle = tl.bg || '#000'; ctx.lineWidth = Math.max(3, size * 0.18);
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = tl.color || '#fff';
    ctx.fillText(str, x, y);
    if (alphaMul !== 1) ctx.globalAlpha = clamp(a, 0, 1);
  };
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * lh;
    const w = widths[i];
    const x = tl.align === 'left' ? -bw / 2 : tl.align === 'right' ? bw / 2 - w : -w / 2;
    if (wordP != null) {
      const words = line.split(' ');
      let px = x;
      for (const wd of words) {
        // each word fades in over `d`; starts are spread so the last word is fully visible at wordP = 1
        const N = Math.max(1, nWords), d = Math.min(1, 1.6 / N);
        const start = N > 1 ? wi * (1 - d) / (N - 1) : 0;
        const wa = clamp((wordP - start) / d, 0, 1);
        if (wa > 0) paint(wd, px, y, wa);
        px += ctx.measureText(wd + ' ').width; wi++;
      }
    } else {
      let str = line;
      if (shown !== Infinity) { str = line.slice(0, Math.max(0, shown)); shown -= line.length; }
      paint(str, x, y, 1);
    }
  });
  ctx.restore();
  const hw = (tl.style === 'band' ? W : bw + padX * 2) * sc / 2, hh = (bh + padY * 2) * sc / 2;
  return { id: tl.id, type: 'text', x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

export class Compositor {
  constructor() {
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');
    this.gl = null; // created lazily
    this.filterOK = canvasFilterSupported();
  }
  _gl() { if (!this.gl) this.gl = new ColorGL(); return this.gl.ok ? this.gl : null; }
  _key() { if (!this.key) this.key = new KeyGL(); return this.key.ok ? this.key : null; }

  drawOverlay(ctx, W, H, o, src, local) {
    const A = animated('overlay', o, local);
    const len = Math.max(0.01, (o.out - o.in) / (o.kind === 'image' ? 1 : (o.speed || 1)));
    let a = clamp(A.opacity, 0, 1);
    if (o.fadeIn > 0) a *= clamp(local / o.fadeIn, 0, 1);
    if (o.fadeOut > 0) a *= clamp((len - local) / o.fadeOut, 0, 1);
    const bw = Math.max(4, o.w * W * A.scale), bh = bw * src.h / src.w;
    let img = src.img;
    if (o.chroma && o.chroma.enabled) {
      const k = this._key();
      if (k) {
        const cw = Math.round(Math.min(src.w, bw * 1.25, 1920)), chh = Math.max(2, Math.round(cw * src.h / src.w));
        if (!this.ovl) { this.ovl = document.createElement('canvas'); this.ovlX = this.ovl.getContext('2d'); }
        if (this.ovl.width !== cw || this.ovl.height !== chh) { this.ovl.width = cw; this.ovl.height = chh; }
        this.ovlX.clearRect(0, 0, cw, chh);
        this.ovlX.drawImage(src.img, 0, 0, cw, chh);
        img = k.process(this.ovl, cw, chh, o.chroma);
      }
    }
    const cx = A.x * W, cy = A.y * H;
    const r = clamp(o.radius || 0, 0, 1) * Math.min(bw, bh) / 2;
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.translate(cx, cy);
    if (A.rotation) ctx.rotate(A.rotation * Math.PI / 180);
    const keyed = o.chroma && o.chroma.enabled;
    if (o.shadow && !keyed) {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = Math.min(W, H) * 0.03; ctx.shadowOffsetY = Math.min(W, H) * 0.008;
      ctx.fillStyle = '#000'; roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r); ctx.fill(); ctx.restore();
    }
    if (r > 0.5) { roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r); ctx.clip(); }
    ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
    if (o.border > 0 && !keyed) {
      ctx.lineWidth = o.border * Math.min(W, H); ctx.strokeStyle = o.borderColor || '#fff';
      roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r); ctx.stroke();
    }
    ctx.restore();
    return { id: o.id, type: 'overlay', x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
  }

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
    return { cx: W / 2 - px * ox, cy: H / 2 - py * oy, s, rot, angle: tr.angle || 0, flipH: !!tr.flipH, flipV: !!tr.flipV, sw, sh };
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
    if (g.rot || g.angle) ctx.rotate((g.rot + g.angle) * Math.PI / 180);
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
    const bgOf = (mode) => ({ mode: mode === 'blur' ? 'blur' : 'color', color: mode === 'white' ? '#ffffff' : mode === 'color' ? (s.bgColor || '#000') : '#000000' });
    const projBg = bgOf(s.bg);
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const act = activeAt(lay, t);
    let missing = 0;
    for (const { it, alpha, black } of act) {
      const src = getSource(it);
      if (!src) { missing++; continue; }
      let c = it.clip;
      const bg = c.bg && c.bg !== 'inherit' ? bgOf(c.bg) : projBg;
      let kOpacity = c.opacity ?? 1;
      if (hasKeyframes(c)) {
        const A = animated('clip', c, t - it.start);
        c = { ...c, transform: { ...c.transform, x: A.x, y: A.y, zoom: Math.max(0.05, A.scale), angle: A.rotation } };
        kOpacity = A.opacity;
      }
      const fit = c.fit && c.fit !== 'inherit' ? c.fit : s.fit;
      const tr0 = c.transform || {}, kb0 = tr0.kbFrom ?? 0, kb1 = tr0.kbTo ?? 1; // Ken Burns range (split clips carry a sub-range)
      const prog = kb0 + (kb1 - kb0) * (it.len > 0 ? clamp((t - it.start) / it.len, 0, 1) : 0);
      const col = effectiveColor(project, c);
      const a = alpha * black * clamp(kOpacity, 0, 1);
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
    const boxes = [];
    // picture-in-picture overlays
    for (const o of overlaysAt(project, t)) {
      const src = opts.getOverlaySource ? opts.getOverlaySource(o) : null;
      if (!src || !src.w) { missing++; continue; }
      boxes.push(this.drawOverlay(ctx, W, H, o, src, t - o.start));
    }
    ctx.globalAlpha = 1;
    // texts
    for (const tl of project.texts) {
      if (t < tl.start || t >= tl.end || !tl.text) continue;
      const a = Math.min(tl.fadeIn > 0 ? (t - tl.start) / tl.fadeIn : 1, tl.fadeOut > 0 ? (tl.end - t) / tl.fadeOut : 1);
      boxes.push(drawText(ctx, W, H, tl, clamp(a, 0, 1), t - tl.start));
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
