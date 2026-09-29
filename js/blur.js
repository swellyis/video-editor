// Blur / Privacy effect (blur or pixelate a shaped region, or everything outside it).
// One implementation shared by live preview, thumbnail maker and both export engines (they all call Compositor.render).
// WebGL path: the frame is downscaled in halving passes, blurred with a small separable Gaussian at the reduced size, then one
// full-size pass mixes original and effect through an analytic shape mask (rounded rectangle / ellipse, feathered).
// Nothing is allocated per frame: textures, framebuffers and weight tables are created once and reused.
// A plain 2D canvas fallback (no WebGL) draws the same regions with a cheaper approximation.
import { clamp } from './util.js';

const VERT = `attribute vec2 p;varying vec2 uv;varying vec2 uw;void main(){uv=vec2((p.x+1.0)*0.5,1.0-(p.y+1.0)*0.5);uw=(p+1.0)*0.5;gl_Position=vec4(p,0.0,1.0);}`;
const HEAD = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;varying vec2 uw;`;
// plain copy / half-size pass: uImg=1 reads an uploaded image (top-down rows), 0 reads a framebuffer texture
const F_COPY = HEAD + `uniform sampler2D tex;uniform float uImg;void main(){gl_FragColor=vec4(texture2D(tex,uImg>0.5?uv:uw).rgb,1.0);}`;
// separable Gaussian, up to 13 taps per side
const F_GAUSS = HEAD + `uniform sampler2D tex;uniform float uImg;uniform vec2 stp;uniform float wt[13];uniform int n;
void main(){vec2 c=uImg>0.5?uv:uw;vec3 a=texture2D(tex,c).rgb*wt[0];
for(int i=1;i<13;i++){if(i>n)break;vec2 o=stp*float(i);a+=(texture2D(tex,c+o).rgb+texture2D(tex,c-o).rgb)*wt[i];}
gl_FragColor=vec4(a,1.0);}`;
const F_MIX = HEAD + `uniform sampler2D orig;uniform sampler2D blurred;
uniform vec2 res;uniform vec2 ctr;uniform vec2 half_;uniform float rad;uniform float fea;uniform float inv;uniform float amount;uniform float shape;uniform float full;uniform float mode;uniform float cell;
void main(){
  vec3 o=texture2D(orig,uv).rgb;
  vec2 px=(uv-ctr)*res;
  float mh=min(half_.x,half_.y);
  float m=1.0;
  if(full<0.5){
    float d;
    if(shape>0.5){d=(length(px/half_)-1.0)*mh;}
    else{float r=rad*mh;vec2 q=abs(px)-half_+r;d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;}
    float e=fea*mh+1.0;
    float inside=1.0-smoothstep(-e,0.0,d);m=inv>0.5?1.0-inside:inside;
  }
  m*=amount;
  if(m<=0.0){gl_FragColor=vec4(o,1.0);return;}
  vec3 fx;
  if(mode>0.5){
    vec2 fp=uv*res;vec2 c0=(floor(fp/cell)+0.5)*cell;vec3 s=vec3(0.0);
    for(int i=0;i<4;i++)for(int j=0;j<4;j++){vec2 off=(vec2(float(i),float(j))+0.5)/4.0-0.5;s+=texture2D(orig,(c0+off*cell)/res).rgb;}
    fx=s/16.0;
  }else fx=texture2D(blurred,uw).rgb;
  gl_FragColor=vec4(mix(o,fx,m),1.0);
}`;

export const MAX_BLUR_LEVEL = 6;
/** Blur radius (sigma, in output pixels) for strength 0..1: scales with the frame so preview and export look alike. */
export const blurSigma = (strength, W, H) => Math.max(0.6, clamp(strength, 0, 1) * 0.045 * Math.max(W, H));
/** Pixelate cell size in output pixels. */
export const pixelCell = (strength, W, H) => Math.max(2, Math.round(clamp(strength, 0, 1) * 0.04 * Math.max(W, H)));

export class BlurFX {
  constructor() {
    this.canvas = document.createElement('canvas'); this.ok = false; this.force2d = false;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this._init());
    this.wcache = new Map(); this.wbuf = new Float32Array(13);
    this._init();
  }
  _init() {
    this.ok = false; this.fb = []; this.tmp = [];
    try {
      const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false, antialias: false });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const vs = sh(gl.VERTEX_SHADER, VERT);
      const prog = (frag, names) => {
        const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, frag)); gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
        if (!gl.getProgramParameter(pr, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('blur shader link failed: ' + gl.getProgramInfoLog(pr));
        const u = {}; for (const n of names) u[n] = gl.getUniformLocation(pr, n);
        return { pr, u };
      };
      this.pCopy = prog(F_COPY, ['tex', 'uImg']);
      this.pGauss = prog(F_GAUSS, ['tex', 'uImg', 'stp', 'wt[0]', 'n']);
      this.pMix = prog(F_MIX, ['orig', 'blurred', 'res', 'ctr', 'half_', 'rad', 'fea', 'inv', 'amount', 'shape', 'full', 'mode', 'cell']);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.src = this._tex(gl);
      this.gl = gl; this.sw = 0; this.sh = 0; this.ok = !gl.isContextLost();
    } catch (e) { console.warn('WebGL blur unavailable, using the 2D fallback', e); this.ok = false; }
  }
  _tex(gl) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** framebuffer + texture of size (W>>k, H>>k), created on first use and reused */
  _target(list, k, W, H) {
    const gl = this.gl, w = Math.max(1, W >> k), h = Math.max(1, H >> k);
    let t = list[k];
    if (!t) { t = list[k] = { tex: this._tex(gl), fbo: gl.createFramebuffer(), w: 0, h: 0 }; }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w; t.h = h;
    }
    return t;
  }
  _weights(sigma) {
    const key = Math.round(sigma * 20);
    let w = this.wcache.get(key);
    if (!w) {
      const s = Math.max(0.3, key / 20), R = Math.min(12, Math.max(1, Math.ceil(s * 3))), arr = new Float32Array(13);
      let sum = 0; for (let i = 0; i <= R; i++) { arr[i] = Math.exp(-(i * i) / (2 * s * s)); sum += i === 0 ? arr[i] : 2 * arr[i]; }
      for (let i = 0; i <= R; i++) arr[i] /= sum;
      w = { arr, R }; if (this.wcache.size > 64) this.wcache.clear(); this.wcache.set(key, w);
    }
    return w;
  }
  _pass(pg, target, w, h, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h); gl.useProgram(pg.pr); setup(gl, pg.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Apply one region to the 2D context (the frame so far). reg: see model.blurAt (+ `full` for a whole-frame blur). */
  apply(ctx, W, H, reg) {
    if (!(reg.amount > 0.002) || !(reg.strength > 0)) return false;
    if (this.ok && !this.force2d) { try { return this._applyGL(ctx, W, H, reg); } catch (e) { console.warn('Blur pass failed, using the 2D fallback', e); this.ok = false; } }
    return this._apply2d(ctx, W, H, reg);
  }
  bounds(W, H, reg) {
    if (reg.full || reg.invert) return [0, 0, W, H];
    const x0 = Math.floor((reg.x - reg.w / 2) * W) - 2, y0 = Math.floor((reg.y - reg.h / 2) * H) - 2, x1 = Math.ceil((reg.x + reg.w / 2) * W) + 2, y1 = Math.ceil((reg.y + reg.h / 2) * H) + 2;
    const cx0 = clamp(x0, 0, W), cy0 = clamp(y0, 0, H), cx1 = clamp(x1, 0, W), cy1 = clamp(y1, 0, H);
    return [cx0, cy0, cx1 - cx0, cy1 - cy0];
  }
  _applyGL(ctx, W, H, reg) {
    const gl = this.gl;
    const [bx, by, bw, bh] = this.bounds(W, H, reg);
    if (bw <= 0 || bh <= 0) return false;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    // upload the frame
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
    const pix = reg.mode === 'pixelate';
    let blurTex = this.src;
    if (!pix) {
      const sigma = blurSigma(reg.strength, W, H);
      const n = clamp(Math.ceil(Math.log2(Math.max(1, sigma / 3))), 0, MAX_BLUR_LEVEL), sr = sigma / Math.pow(2, n), wgt = this._weights(sr);
      let from = this.src, fromImg = 1;
      for (let k = 1; k <= n; k++) {
        const t = this._target(this.fb, k, W, H);
        this._pass(this.pCopy, t, t.w, t.h, (g, u) => { g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, from); g.uniform1i(u.tex, 0); g.uniform1f(u.uImg, fromImg); });
        from = t.tex; fromImg = 0;
      }
      const A = this._target(this.fb, n, W, H), B = this._target(this.tmp, n, W, H);
      const run = (srcTex, img, dst, sx, sy) => this._pass(this.pGauss, dst, dst.w, dst.h, (g, u) => {
        g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, srcTex); g.uniform1i(u.tex, 0); g.uniform1f(u.uImg, img);
        g.uniform2f(u.stp, sx / dst.w, sy / dst.h); g.uniform1fv(u['wt[0]'], wgt.arr); g.uniform1i(u.n, wgt.R);
      });
      run(from, fromImg, B, 1, 0);
      run(B.tex, 0, A, 0, 1);
      blurTex = A.tex;
    }
    // final mix at full size (only the region's bounding box when the effect is limited to the inside)
    const hx = reg.w * W / 2, hy = reg.h * H / 2;
    gl.enable(gl.SCISSOR_TEST); gl.scissor(bx, H - (by + bh), bw, bh);
    this._pass(this.pMix, null, W, H, (g, u) => {
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, this.src); g.uniform1i(u.orig, 0);
      g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, blurTex); g.uniform1i(u.blurred, 1);
      g.uniform2f(u.res, W, H); g.uniform2f(u.ctr, reg.x, reg.y); g.uniform2f(u.half_, Math.max(0.5, hx), Math.max(0.5, hy));
      g.uniform1f(u.rad, clamp(reg.radius || 0, 0, 1)); g.uniform1f(u.fea, clamp(reg.feather || 0, 0, 1)); g.uniform1f(u.inv, reg.invert ? 1 : 0);
      g.uniform1f(u.amount, clamp(reg.amount, 0, 1)); g.uniform1f(u.shape, reg.shape === 'ellipse' ? 1 : 0); g.uniform1f(u.full, reg.full ? 1 : 0);
      g.uniform1f(u.mode, pix ? 1 : 0); g.uniform1f(u.cell, pixelCell(reg.strength, W, H));
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.SCISSOR_TEST);
    ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.drawImage(this.canvas, bx, by, bw, bh, bx, by, bw, bh);
    ctx.restore();
    return true;
  }

  // ---------- 2D fallback ----------
  _c2(name, w, h) {
    let c = this[name];
    if (!c) { const cv = document.createElement('canvas'); c = this[name] = { cv, x: cv.getContext('2d') }; }
    if (c.cv.width !== w || c.cv.height !== h) { c.cv.width = w; c.cv.height = h; }
    return c;
  }
  _apply2d(ctx, W, H, reg) {
    const fx = this._c2('fx', W, H), mk = this._c2('mk', W, H);
    const pix = reg.mode === 'pixelate';
    fx.x.globalCompositeOperation = 'source-over'; fx.x.globalAlpha = 1; fx.x.filter = 'none';
    if (pix) {
      const cell = pixelCell(reg.strength, W, H), sw = Math.max(1, Math.round(W / cell)), sh = Math.max(1, Math.round(H / cell));
      const s = this._c2('small', sw, sh); s.x.imageSmoothingEnabled = true; s.x.imageSmoothingQuality = 'high'; s.x.drawImage(ctx.canvas, 0, 0, sw, sh);
      fx.x.imageSmoothingEnabled = false; fx.x.drawImage(s.cv, 0, 0, W, H);
    } else {
      const sigma = blurSigma(reg.strength, W, H), k = Math.max(1, Math.round(sigma / 1.6));
      const sw = Math.max(2, Math.round(W / k)), sh = Math.max(2, Math.round(H / k));
      const s = this._c2('small', sw, sh); s.x.imageSmoothingEnabled = true; s.x.imageSmoothingQuality = 'high'; s.x.drawImage(ctx.canvas, 0, 0, sw, sh);
      const s2 = this._c2('small2', Math.max(2, Math.round(sw / 2)), Math.max(2, Math.round(sh / 2)));
      s2.x.imageSmoothingEnabled = true; s2.x.imageSmoothingQuality = 'high'; s2.x.drawImage(s.cv, 0, 0, s2.cv.width, s2.cv.height);
      fx.x.imageSmoothingEnabled = true; fx.x.imageSmoothingQuality = 'high'; fx.x.drawImage(s2.cv, 0, 0, W, H);
    }
    // mask (white where the effect applies)
    const m = mk.x; m.globalCompositeOperation = 'source-over'; m.clearRect(0, 0, W, H); m.filter = 'none'; m.fillStyle = '#fff';
    if (reg.full) m.fillRect(0, 0, W, H);
    else {
      const hx = reg.w * W / 2, hy = reg.h * H / 2, mh = Math.min(hx, hy), cx = reg.x * W, cy = reg.y * H;
      const shape = () => {
        m.beginPath();
        if (reg.shape === 'ellipse') m.ellipse(cx, cy, Math.max(0.5, hx), Math.max(0.5, hy), 0, 0, Math.PI * 2);
        else if (m.roundRect) m.roundRect(cx - hx, cy - hy, hx * 2, hy * 2, (reg.radius || 0) * mh); else m.rect(cx - hx, cy - hy, hx * 2, hy * 2);
      };
      const fe = (reg.feather || 0) * mh * 0.5;
      if (reg.invert) {
        m.fillRect(0, 0, W, H); m.globalCompositeOperation = 'destination-out';
        if (fe > 0.5) try { m.filter = `blur(${fe}px)`; } catch { /* no canvas filter: hard edge */ }
        shape(); m.fill();
      } else {
        if (fe > 0.5) try { m.filter = `blur(${fe}px)`; } catch { /* no canvas filter: hard edge */ }
        shape(); m.fill();
      }
      m.filter = 'none';
    }
    fx.x.globalCompositeOperation = 'destination-in'; fx.x.drawImage(mk.cv, 0, 0); fx.x.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.globalAlpha = clamp(reg.amount, 0, 1); ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.drawImage(fx.cv, 0, 0); ctx.restore();
    return true;
  }
}
