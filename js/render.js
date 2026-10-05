// Frame compositor shared by preview, thumbnail maker and export.
import { captionAt, captionWords } from './captions.js';
import { look as trLook } from './transitions.js';
import { activeAt, effectiveColor, colorIsNeutral, FONTS, sourceTime, animated, hasMotion, overlaysAt, EASES, blurAt, laneOf } from './model.js';
import { clamp } from './util.js';
import { BlurFX } from './blur.js';
import { FxGL } from './fx-gl.js';
import { activeFx } from './effects.js';
import { newIn, newOut, loopFx, karaokeCount } from './textanim.js';
import { applyBgRemove, bgRemoveActive } from './bgremove.js';
import { loadSegmenter, segmentPerson } from './segment.js';

const VERT = `attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.0)*0.5,1.0-(p.y+1.0)*0.5);gl_Position=vec4(p,0.0,1.0);}`;
const FRAG = `precision mediump float;varying vec2 uv;uniform sampler2D tex;
uniform float bri,con,sat,tmp,sep,fad,vig,gam,crv;uniform vec4 ts,th;uniform vec2 asp;
void main(){vec4 t0=texture2D(tex,uv);vec3 c=t0.rgb;
c+=bri;c=(c-0.5)*con+0.5;
float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,sat);
c.r+=tmp*0.09;c.g+=tmp*0.02;c.b-=tmp*0.09;
vec3 s=vec3(dot(c,vec3(.393,.769,.189)),dot(c,vec3(.349,.686,.168)),dot(c,vec3(.272,.534,.131)));c=mix(c,s,sep);
c=mix(c,vec3(0.08)+c*0.86,fad);
if(gam!=1.0)c=pow(max(c,0.0),vec3(1.0/gam));
if(crv>0.0)c=mix(c,c*c*(3.0-2.0*c),crv);
if(ts.a>0.0||th.a>0.0){float lm=dot(clamp(c,0.0,1.0),vec3(0.2126,0.7152,0.0722));
c+=(ts.rgb-vec3(dot(ts.rgb,vec3(0.3333))))*(ts.a*1.2*(1.0-smoothstep(0.0,0.6,lm)));
c+=(th.rgb-vec3(dot(th.rgb,vec3(0.3333))))*(th.a*1.2*smoothstep(0.4,1.0,lm));}
vec2 d=(uv-0.5)*asp;float r=length(d)*1.5;c*=1.0-vig*smoothstep(0.45,1.25,r);
gl_FragColor=vec4(clamp(c,0.0,1.0),t0.a);}`;

export { ColorGL };
class ColorGL {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ok = false;
    // a lost context (GPU reset, too many contexts) is rebuilt when the browser restores it
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this._init());
    this._init();
  }
  _init() {
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
      this.u = {}; for (const n of ['bri', 'con', 'sat', 'tmp', 'sep', 'fad', 'vig', 'asp', 'gam', 'crv', 'ts', 'th']) this.u[n] = gl.getUniformLocation(pr, n);
      this.gl = gl; this.ok = !gl.isContextLost();
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
    gl.uniform1f(this.u.gam, c.gamma || 1); gl.uniform1f(this.u.crv, c.curve || 0);
    const ts = c.ts || [0, 0, 0, 0], th = c.th || [0, 0, 0, 0]; gl.uniform4f(this.u.ts, ts[0], ts[1], ts[2], ts[3]); gl.uniform4f(this.u.th, th[0], th[1], th[2], th[3]);
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
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this._init());
    this._init();
  }
  _init() {
    this.ok = false;
    try {
      const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: true, antialias: false });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, KFRAG)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link failed: ' + gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.u = {}; for (const n of ['key', 'sim', 'smo', 'spill']) this.u[n] = gl.getUniformLocation(pr, n);
      this.gl = gl; this.ok = !gl.isContextLost();
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

/**
 * Approximate the WebGL grade's warmth, fade and vignette with 2D compositing (used only when WebGL is unavailable,
 * together with CSS filters for brightness/contrast/saturation/sepia). Works in place on a fully painted layer.
 */
function emulateGrade(x, W, H, col) {
  const tmp = (col.temperature || 0) / 100, fad = (col.fade || 0) / 100, vig = (col.vignette || 0) / 100;
  x.save(); x.filter = 'none'; x.globalAlpha = 1;
  const fill = (op, style) => { x.globalCompositeOperation = op; x.fillStyle = style; x.fillRect(0, 0, W, H); };
  if (Math.abs(tmp) > 0.005) {
    const k = Math.abs(tmp) * 0.09 * 255;
    if (tmp > 0) { fill('lighter', `rgb(${k.toFixed(1)},${(k * 0.22).toFixed(1)},0)`); fill('multiply', `rgb(255,255,${(255 - k).toFixed(1)})`); }
    else { fill('lighter', `rgb(0,0,${k.toFixed(1)})`); fill('multiply', `rgb(${(255 - k).toFixed(1)},${(255 - k * 0.22).toFixed(1)},255)`); }
  }
  if (fad > 0.005) { const m = 255 * (1 - 0.14 * fad); fill('multiply', `rgb(${m},${m},${m})`); const a = 255 * 0.08 * fad; fill('lighter', `rgb(${a},${a},${a})`); }
  if (vig > 0.005) {
    const r = Math.hypot(W, H) / 2, g = x.createRadialGradient(W / 2, H / 2, r * 0.45 / 1.5 * 2 * 0.707, W / 2, H / 2, r * 1.25 / 1.5 * 2 * 0.707);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vig})`);
    fill('source-atop', g);
  }
  x.restore();
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
  let a = alpha * clamp(A.opacity, 0, 1), sc = A.scale, dy = 0, dx = 0, rot = A.rotation || 0, reveal = 1, wordP = null, blur = 0, wipeIn = 1, wipeOut = 0, glitch = 0;
  switch (an.in) {
    case 'fade': a *= inP; break;
    case 'typewriter': reveal = inP; break;
    case 'wordByWord': wordP = inP; break;
    case 'slideUp': dy += (1 - EASES.easeOut(inP)) * size * 1.4; a *= EASES.easeOut(inP); break;
    case 'pop': sc *= inP >= 1 ? 1 : 0.4 + 0.6 * backOut(inP); a *= Math.min(1, inP * 3); break;
    default: { const f = newIn(an.in, inP, size, W, local); if (f) { dx += f.dx || 0; dy += f.dy || 0; sc *= f.sc ?? 1; a *= f.a ?? 1; blur = Math.max(blur, f.blur || 0); wipeIn = f.wipe ?? 1; glitch = Math.max(glitch, f.glitch || 0); } }
  }
  switch (an.out) {
    case 'fade': a *= outP; break;
    case 'typewriter': reveal = Math.min(reveal, outP); break;
    case 'slideDown': dy += (1 - outP) * (1 - outP) * size * 1.4; a *= outP; break;
    case 'pop': sc *= 0.6 + 0.4 * outP; a *= outP; break;
    default: { const f = newOut(an.out, outP, size, W, local); if (f) { dx += f.dx || 0; dy += f.dy || 0; sc *= f.sc ?? 1; a *= f.a ?? 1; blur = Math.max(blur, f.blur || 0); wipeOut = f.wipeOut || 0; glitch = Math.max(glitch, f.glitch || 0); if (f.words != null) wordP = wordP == null ? f.words : Math.min(wordP, f.words); } }
  }
  if (an.loop && an.loop !== 'none') {
    const f = loopFx(an.loop, (local + (an.phase || 0)) * (an.loopSpeed || 1));
    if (f) { sc *= f.sc ?? 1; dy += (f.dyEm || 0) * size; rot += f.rot || 0; a *= f.a ?? 1; }
  }
  ctx.save();
  ctx.globalAlpha = clamp(a, 0, 1);
  if (blur > 0.4 && canvasFilterSupported()) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  ctx.font = fontCss(tl.font, size);
  ctx.textBaseline = 'middle';
  const maxW = (tl.maxWidth || 0.86) * W;
  const lines = wrapLines(ctx, tl.text, maxW);
  const lh = size * 1.16;
  const widths = lines.map(l => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths), bh = lines.length * lh;
  const cx = A.x * W + dx, cy = A.y * H + dy;
  const padX = size * 0.45, padY = size * 0.28;
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (sc !== 1) ctx.scale(sc, sc);
  const hwBox = tl.style === 'band' ? W * 2 : bw / 2 + padX + size * 0.4;
  if (wipeIn < 1 || wipeOut > 0) { // wipe reveal / wipe away: a clip window growing from (or shrinking towards) the left edge
    ctx.beginPath(); ctx.rect(-hwBox + 2 * hwBox * wipeOut, -bh / 2 - size * 2, 2 * hwBox * (wipeIn - wipeOut), bh + size * 4); ctx.clip();
  }
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
  const kara = an.loop === 'karaoke' && wordP == null && reveal >= 1 ? karaokeCount(an, local, dur, nWords) : -1;
  let wi = 0, tint = null;
  const paint = (str, x, y, alphaMul, hiLite) => {
    if (!str) return;
    const am = alphaMul * (tint ? tint.am : 1);
    if (am !== 1) ctx.globalAlpha = clamp(a * am, 0, 1);
    if (tl.style === 'clean' && !tint) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.28; ctx.shadowOffsetY = size * 0.04;
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.strokeText(str, x, y);
      ctx.restore();
    } else if (tl.style === 'outline' && !tint) {
      ctx.lineJoin = 'round'; ctx.strokeStyle = tl.bg || '#000'; ctx.lineWidth = Math.max(3, size * 0.18);
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = tint ? tint.color : hiLite ? (an.hi || '#ffd24a') : (tl.color || '#fff');
    ctx.fillText(str, x + (tint ? tint.dx : 0), y);
    if (am !== 1) ctx.globalAlpha = clamp(a, 0, 1);
  };
  const pass = () => lines.forEach((line, i) => {
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
    } else if (kara >= 0) {
      let px = x;
      for (const wd of line.split(' ')) { paint(wd, px, y, 1, wi < kara); px += ctx.measureText(wd + ' ').width; wi++; }
    } else {
      let str = line;
      if (shown !== Infinity) { str = line.slice(0, Math.max(0, shown)); shown -= line.length; }
      paint(str, x, y, 1);
    }
  });
  if (glitch > 0.02) { // colour-split ghosts either side of the text (deterministic: same frame, same look)
    const g = glitch * size * 0.09;
    for (const [color, d] of [['#00e5ff', -g], ['#ff2d6f', g]]) { tint = { color, dx: d, am: 0.6 }; wi = 0; shown = reveal >= 1 ? Infinity : Math.floor(reveal * total + 1e-6); pass(); }
    tint = null; wi = 0; shown = reveal >= 1 ? Infinity : Math.floor(reveal * total + 1e-6);
  }
  pass();
  ctx.restore();
  const hw = (tl.style === 'band' ? W : bw + padX * 2) * sc / 2, hh = (bh + padY * 2) * sc / 2;
  return { id: tl.id, type: 'text', x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}


/**
 * Draw the caption that is on screen at time t (burned into preview, thumbnails excluded, and both export paths).
 * Words are laid out into at most style.maxLines lines inside the safe width; if they don't fit the text shrinks a little, and the
 * block is always kept inside the frame. 9:16 keeps clear of the bottom UI zone of Shorts by default.
 */
export function drawCaptions(ctx, W, H, project, t) {
  const st = project.captionStyle, list = project.captions;
  if (!st || st.show === false || !list || !list.length) return;
  const cap = captionAt(list, t); if (!cap) return;
  let words = captionWords(cap); if (!words.length) return;
  if (st.caps) words = words.map(w => ({ ...w, w: w.w.toUpperCase() }));
  const base = Math.min(W, H), tall = H / W >= 1.5, square = !tall && H >= W * 0.9;
  const maxW = W * (tall ? 0.8 : 0.86);
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  let size = Math.max(10, st.size * base), lines = [], pad = 0, avail = maxW;
  const lay = () => {
    ctx.font = fontCss(st.font, size);
    pad = st.box ? size * 0.4 : 0;
    const space = ctx.measureText(' ').width; avail = Math.max(size, maxW - pad * 2);
    lines = []; let cur = null;
    for (const w of words) {
      const ww = ctx.measureText(w.w).width;
      if (cur && cur.w + space + ww <= avail) { cur.items.push({ ...w, x: cur.w + space, ww }); cur.w += space + ww; }
      else { cur = { items: [{ ...w, x: 0, ww }], w: ww }; lines.push(cur); }
    }
  };
  for (let attempt = 0; attempt < 9; attempt++) {
    lay();
    if ((lines.length <= st.maxLines && Math.max(...lines.map(l => l.w)) <= avail + 0.5) || size <= st.size * base * 0.56) break;
    size *= 0.92;
  }
  if (Math.max(...lines.map(l => l.w)) > avail + 0.5) { // a single "word" wider than the frame (a long URL, no spaces): break it up
    words = words.flatMap(w => {
      if (ctx.measureText(w.w).width <= avail) return [w];
      const parts = []; let cur = '';
      for (const ch of w.w) { if (cur && ctx.measureText(cur + ch).width > avail) { parts.push(cur); cur = ''; } cur += ch; }
      if (cur) parts.push(cur);
      return parts.map((t, i) => ({ w: t, start: w.start + (w.end - w.start) * i / parts.length, end: w.start + (w.end - w.start) * (i + 1) / parts.length }));
    });
    lay();
  }
  const lh = size * 1.2, bh = lines.length * lh;
  const padY = st.box ? size * 0.22 : 0;
  const mB = tall ? 0.2 : square ? 0.09 : 0.07, mT = tall ? 0.12 : 0.07;
  let top;
  if (st.position === 'top') top = H * mT - st.offset * H;
  else if (st.position === 'middle') top = H * 0.5 - bh / 2 - st.offset * H;
  else top = H * (1 - mB) - bh - st.offset * H;
  top = clamp(top, H * 0.02 + padY, H * 0.98 - bh - padY);
  if (st.box) {
    ctx.fillStyle = hexA(st.boxColor, st.boxOpacity);
    lines.forEach((l, i) => { // one rounded box per line keeps ragged lines tidy
      const x0 = (W - l.w) / 2 - pad, y0 = top + i * lh + (lh - size * 1.12) / 2 - padY * 0.4;
      roundRect(ctx, x0, y0, l.w + pad * 2, size * 1.12 + padY * 0.8, size * 0.24); ctx.fill();
    });
  }
  // the highlighted word = the last one whose start has passed
  let active = -1;
  if (st.hl) { for (let i = 0; i < words.length; i++) if (words[i].start <= t + 1e-6) active = i; }
  const lw = st.outline > 0 ? Math.max(2, size * st.outline) : 0;
  let wi = 0;
  lines.forEach((l, i) => {
    const y = top + i * lh + lh / 2, x0 = (W - l.w) / 2;
    for (const it of l.items) {
      const x = x0 + it.x;
      if (lw) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = lw; ctx.strokeStyle = st.outlineColor; ctx.strokeText(it.w, x, y); }
      else if (!st.box) { ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = size * 0.2; ctx.shadowOffsetY = size * 0.04; }
      ctx.fillStyle = st.hl && wi === active ? st.highlight : st.color;
      ctx.fillText(it.w, x, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      wi++;
    }
  });
  ctx.restore();
}

/** Draw the logo / watermark with the project's placement settings (shared by preview, export and thumbnails). */
export function drawLogo(ctx, W, H, L, lg) {
  const base = Math.min(W, H);
  const lw = base * (L.size || 0.14), lh = lw * lg.h / lg.w, m = base * (L.margin ?? 0.035);
  const pos = L.position || 'tr';
  const col = { tl: 'l', bl: 'l', tr: 'r', br: 'r' }[pos] || 'c', row = { tl: 't', tr: 't', bl: 'b', br: 'b' }[pos] || 'm'; // 'center' contains an 'r'
  const x = col === 'l' ? m : col === 'r' ? W - lw - m : (W - lw) / 2;
  const y = row === 't' ? m : row === 'b' ? H - lh - m : (H - lh) / 2;
  ctx.globalAlpha = L.opacity ?? 0.85;
  ctx.drawImage(lg.img, x, y, lw, lh);
  ctx.globalAlpha = 1;
}

let blurFX = null; // one WebGL context shared by every compositor (preview, thumbnails, export)
const sharedBlurFX = () => blurFX || (blurFX = new BlurFX());
export function blurEngine() { return sharedBlurFX(); }
const fxPool = []; // the effects engines: one for whole pictures, one for overlays (different sizes), shared by every compositor
const sharedFx = (i = 0) => { const f = fxPool[i] || (fxPool[i] = new FxGL()); return f.ok ? f : null; };
export class Compositor {
  constructor() {
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');
    this.gl = null; // created lazily
    this.filterOK = canvasFilterSupported();
  }
  _gl() { if (!this.gl) this.gl = new ColorGL(); return this.gl.ok ? this.gl : null; }
  _glo() { if (!this.glo) this.glo = new ColorGL(); return this.glo.ok ? this.glo : null; }
  _fx() { return sharedBlurFX(); }
  _key() { if (!this.key) this.key = new KeyGL(); return this.key.ok ? this.key : null; }
  /** Lazy person segmenter (Selfie). Shared across frames; first call may be slow while the model loads. */
  async ensureSegmenter() {
    if (this._seg) return this._seg;
    if (!this._segP) this._segP = loadSegmenter({ kind: 'landscape' }).then(s => { this._seg = s; return s; });
    return this._segP;
  }
  /** Sync mask for src; key avoids re-running on the same preview frame. Kick off ensureSegmenter if needed. */
  personMask(src, key) {
    if (!this._seg) { this.ensureSegmenter(); return this._lastMask || null; }
    if (key && key === this._maskKey && this._lastMask) return this._lastMask;
    const m = segmentPerson(this._seg, src, { maxEdge: 640 });
    if (m) { this._lastMask = m; this._maskKey = key; }
    return m;
  }
  /** Apply bgremove to a source image/canvas; returns canvas/img to draw. bgImage optional HTMLImage/canvas. */
  withBgRemove(item, srcImg, key, bgImage) {
    const br = item && item.bgremove;
    if (!br || br.mode === 'off') return srcImg;
    const mask = this.personMask(srcImg, key || (item.id + ':' + br.mode));
    if (!mask) return srcImg; // model still loading
    if (!this._bgOut) this._bgOut = document.createElement('canvas');
    let bg = bgImage;
    if (!bg && br.mode === 'image' && br.mediaId && this._bgImageFn) {
      const im = this._bgImageFn(br.mediaId);
      bg = im && (im.img || im);
    }
    return applyBgRemove(srcImg, mask, { mode: br.mode, soft: br.soft, color: br.color, strength: br.strength, bgImage: bg, out: this._bgOut });
  }

  drawOverlay(ctx, W, H, o, src, local, opts = {}) {
    const A = animated('overlay', o, local);
    const len = Math.max(0.01, (o.out - o.in) / (o.kind === 'image' ? 1 : (o.speed || 1)));
    let a = clamp(A.opacity, 0, 1);
    if (o.fadeIn > 0) a *= clamp(local / o.fadeIn, 0, 1);
    if (o.fadeOut > 0) a *= clamp((len - local) / o.fadeOut, 0, 1);
    const bw = Math.max(4, o.w * W * A.scale), bh = bw * src.h / src.w;
    let img = src.img;
    if (bgRemoveActive(o)) {
      img = this.withBgRemove(o, img, o.id + ':' + (opts.t != null ? opts.t.toFixed(2) : local.toFixed(2)), opts.bgImage) || img;
    }
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
    const ocol = effectiveColor({}, o), gk = colorIsNeutral(ocol) ? null : this._glo();
    if (gk) { // the overlay's own filter (Looks tab): same colour pass as the clips
      const cw = Math.round(Math.min(src.w, bw * 1.25, 1920)), chh = Math.max(2, Math.round(cw * src.h / src.w));
      if (!this.ovl3) { this.ovl3 = document.createElement('canvas'); this.ovl3X = this.ovl3.getContext('2d'); }
      if (this.ovl3.width !== cw || this.ovl3.height !== chh) { this.ovl3.width = cw; this.ovl3.height = chh; }
      this.ovl3X.clearRect(0, 0, cw, chh); this.ovl3X.drawImage(img, 0, 0, cw, chh);
      img = gk.process(this.ovl3, cw, chh, ocol);
    }
    const ofx = activeFx(o.fx), fxg = ofx.length ? sharedFx(1) : null;
    if (fxg) { // effects on the overlay's own picture (before it is placed, rotated and framed)
      const cw = Math.round(Math.min(src.w, bw * 1.25, 1920)), chh = Math.max(2, Math.round(cw * src.h / src.w));
      if (!this.ovl2) { this.ovl2 = document.createElement('canvas'); this.ovl2X = this.ovl2.getContext('2d'); }
      if (this.ovl2.width !== cw || this.ovl2.height !== chh) { this.ovl2.width = cw; this.ovl2.height = chh; }
      this.ovl2X.clearRect(0, 0, cw, chh); this.ovl2X.drawImage(img, 0, 0, cw, chh);
      const r2 = fxg.process(this.ovl2, cw, chh, ofx, opts.t || 0);
      if (r2) img = r2;
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

  drawSource(ctx, src, clip, W, H, fit, progress, bg, opts = {}) {
    let { img, w: sw, h: sh } = src;
    if (!sw || !sh) return;
    if (bgRemoveActive(clip)) {
      const keyed = this.withBgRemove(clip, img, opts.maskKey || (clip.id + ':' + (opts.t || 0).toFixed(2)), opts.bgImage);
      if (keyed && keyed !== img) {
        img = keyed; sw = keyed.width; sh = keyed.height;
        // remove mode: transparent person over project bg — draw bg first then person-only already composited for blur/color/image;
        // for remove, applyBgRemove clears then draws person; drawSource still paints project bg behind.
      }
    }
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
    this._bgImageFn = opts.getBgImage || null;
    // Warm the segmenter when any clip/overlay needs it (first frame may hitch; then ~2–10 ms/frame).
    if (!this._seg && (project.clips || []).concat(project.overlays || []).some(x => x.bgremove && x.bgremove.mode && x.bgremove.mode !== 'off')) this.ensureSegmenter();
    const s = project.settings;
    const bgOf = (mode) => ({ mode: mode === 'blur' ? 'blur' : 'color', color: mode === 'white' ? '#ffffff' : mode === 'color' ? (s.bgColor || '#000') : '#000000' });
    const projBg = bgOf(s.bg);
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const act = activeAt(lay, t);
    let missing = 0, nBlur = 0;
    const boxes = [];
    // Every layer is drawn in lane order: a higher lane is on top, whatever kind of item it holds (sound lanes draw nothing).
    const steps = [];
    if (act.length) steps.push({ lane: Math.max(...act.map(x => laneOf(x.it.clip))), run: () => {
      for (const { it, alpha, black, tr } of act) {
        const src = getSource(it);
        if (!src) { missing++; continue; }
        let c = it.clip;
        const bg = c.bg && c.bg !== 'inherit' ? bgOf(c.bg) : projBg;
        let kOpacity = c.opacity ?? 1;
        if (hasMotion(c)) {
          const A = animated('clip', c, t - it.start);
          c = { ...c, transform: { ...c.transform, x: A.x, y: A.y, zoom: Math.max(0.05, A.scale), angle: A.rotation } };
          kOpacity = A.opacity;
        }
        const fit = c.fit && c.fit !== 'inherit' ? c.fit : s.fit;
        const tr0 = c.transform || {}, kb0 = tr0.kbFrom ?? 0, kb1 = tr0.kbTo ?? 1; // Ken Burns range (split clips carry a sub-range)
        const prog = kb0 + (kb1 - kb0) * (it.len > 0 ? clamp((t - it.start) / it.len, 0, 1) : 0);
        const col = effectiveColor(project, c);
        // a transition (wipe, slide, zoom, blur, dissolve) moves / clips / blurs / fades this picture while two clips overlap
        const L = tr ? trLook(tr.type, tr.p)[tr.role === 'in' ? 'inn' : 'out'] : null;
        const a = (L ? L.alpha : alpha) * black * clamp(kOpacity, 0, 1);
        if (a <= 0.001) continue;
        ctx.save();
        if (L) {
          if (L.clip) { ctx.beginPath(); ctx.rect(L.clip.x0 * W, L.clip.y0 * H, (L.clip.x1 - L.clip.x0) * W, (L.clip.y1 - L.clip.y0) * H); ctx.clip(); }
          if (L.dx || L.dy) ctx.translate(L.dx * W, L.dy * H);
          if (L.scale !== 1) { ctx.translate(W / 2, H / 2); ctx.scale(L.scale, L.scale); ctx.translate(-W / 2, -H / 2); }
        }
        const bf = L && L.blur > 0 && this.filterOK ? `blur(${(L.blur * H).toFixed(1)}px) ` : '';
        // two pictures that blend (dissolve, zoom, blur): draw this one whole, with its own background, then fade it as one piece
        // (filling its background at partial opacity would darken the other picture underneath)
        const unit = !!L && L.alpha < 0.999;
        const gl = colorIsNeutral(col) ? null : this._gl();
        const fxl = activeFx(it.clip.fx), fxg = fxl.length ? sharedFx(0) : null;
        if (!unit && !gl && !fxg && (colorIsNeutral(col) || !this.filterOK)) {
          ctx.globalAlpha = a;
          if (bf) ctx.filter = bf;
          this.drawSource(ctx, src, c, W, H, fit, prog, bg, { t, maskKey: c.id + ':' + t.toFixed(2) });
        } else {
          if (this.layer.width !== W || this.layer.height !== H) { this.layer.width = W; this.layer.height = H; }
          const l = this.lctx;
          l.globalAlpha = 1; l.filter = 'none';
          this.drawSource(l, src, c, W, H, fit, prog, bg, { t, maskKey: c.id + ':' + t.toFixed(2) });
          ctx.globalAlpha = a;
          if (fxg) { // colour first, then the clip's effects (Effects tab), then the transition's blur / fade
            let pic = this.layer;
            if (gl) pic = gl.process(this.layer, W, H, col);
            else if (!colorIsNeutral(col) && this.filterOK) {
              emulateGrade(l, W, H, col);
              if (!this.layer2) { this.layer2 = document.createElement('canvas'); this.l2ctx = this.layer2.getContext('2d'); }
              if (this.layer2.width !== W || this.layer2.height !== H) { this.layer2.width = W; this.layer2.height = H; }
              this.l2ctx.filter = `brightness(${1 + col.brightness / 200}) contrast(${1 + col.contrast / 100}) saturate(${1 + col.saturation / 100}) sepia(${col.sepia / 100})`;
              this.l2ctx.drawImage(this.layer, 0, 0); this.l2ctx.filter = 'none'; pic = this.layer2;
            }
            pic = fxg.process(pic, W, H, fxl, t) || pic;
            if (bf) ctx.filter = bf;
            ctx.drawImage(pic, 0, 0); ctx.filter = 'none';
          }
          else if (gl) { if (bf) ctx.filter = bf; ctx.drawImage(gl.process(this.layer, W, H, col), 0, 0); }
          else if (colorIsNeutral(col)) { if (bf) ctx.filter = bf; ctx.drawImage(this.layer, 0, 0); ctx.filter = 'none'; }
          else {
            emulateGrade(l, W, H, col); // warmth / fade / vignette, which CSS filters don't have
            ctx.filter = bf + `brightness(${1 + col.brightness / 200}) contrast(${1 + col.contrast / 100}) saturate(${1 + col.saturation / 100}) sepia(${col.sepia / 100})`;
            ctx.drawImage(this.layer, 0, 0);
            ctx.filter = 'none';
          }
        }
        ctx.restore();
      }
      // dip to white: a white veil over the picture (a dip to black darkens it instead, above)
      const veil = Math.max(0, ...act.map(x => x.white || 0));
      if (veil > 0.001) { ctx.save(); ctx.globalAlpha = veil; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      // Blur > whole-clip blur (Clip tab): the clip's picture, under whatever is on higher lanes
      for (const { it, alpha, black } of act) {
        const cb = it.clip.blur;
        if (cb && cb.enabled && nBlur < 12 && alpha * black > 0.002) { this._fx().apply(ctx, W, H, { shape: cb.shape, mode: cb.mode, radius: cb.radius, strength: cb.strength, feather: cb.feather, invert: !!cb.keep, x: cb.x, y: cb.y, w: cb.w, h: cb.h, amount: alpha * black, full: !cb.keep }); nBlur++; }
      }
      ctx.globalAlpha = 1;
    } });
    // picture-in-picture overlays
    for (const o of overlaysAt(project, t)) steps.push({ lane: laneOf(o), run: () => {
      const src = opts.getOverlaySource ? opts.getOverlaySource(o) : null;
      if (!src || !src.w) { missing++; return; }
      boxes.push(this.drawOverlay(ctx, W, H, o, src, t - o.start, { t }));
      ctx.globalAlpha = 1;
    } });
    // Blur / Privacy regions blur everything on the lanes below them
    for (const b of project.blurs || []) {
      const reg = blurAt(b, t); if (!reg) continue;
      steps.push({ lane: laneOf(b), run: () => { if (nBlur >= 12) return; this._fx().apply(ctx, W, H, reg); nBlur++; ctx.globalAlpha = 1; } });
    }
    // texts
    for (const tl of project.texts) {
      if (t < tl.start || t >= tl.end || !tl.text) continue;
      steps.push({ lane: laneOf(tl), run: () => {
        const a = Math.min(tl.fadeIn > 0 ? (t - tl.start) / tl.fadeIn : 1, tl.fadeOut > 0 ? (tl.end - t) / tl.fadeOut : 1);
        boxes.push(drawText(ctx, W, H, tl, clamp(a, 0, 1), t - tl.start));
      } });
    }
    // captions
    if (!opts.noCaptions) { const cap = captionAt(project.captions || [], t); steps.push({ lane: cap ? laneOf(cap) : 1e9, run: () => drawCaptions(ctx, W, H, project, t) }); }
    steps.map((st, i) => [st, i]).sort((a, b) => a[0].lane - b[0].lane || a[1] - b[1]).forEach(([st]) => st.run());
    // logo / watermark
    const lg = project.logo && opts.getLogo ? opts.getLogo() : null;
    if (lg) drawLogo(ctx, W, H, project.logo, lg);
    ctx.restore();
    return { boxes, missing, active: act };
  }
}
export { sourceTime };
