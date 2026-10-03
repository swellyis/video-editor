// Picture maths for the Effects library: a short chain of WebGL passes (one per effect, up to 3) over the clip's picture.
// ONE implementation shared by the live preview, the thumbnail maker, MP4 streaming export, WebM export and the small previews in the Effects tab
// (they all go through Compositor.render / FxGL.process). Animated effects only depend on the sequence time `t`, never on the wall clock,
// so a frame looks the same in the preview and in the exported file.
import { fxInfo, activeFx } from './effects.js';

const VERT = `attribute vec2 p;varying vec2 uw;void main(){uw=(p+1.0)*0.5;gl_Position=vec4(p,0.0,1.0);}`;
const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uw;
uniform sampler2D tex;uniform sampler2D b1;uniform sampler2D b2;
uniform float flip;uniform float mode;uniform float amt;uniform float t;uniform vec2 res;
vec4 S(vec2 q){return texture2D(tex,flip>0.5?vec2(q.x,1.0-q.y):q);}
float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}
vec3 soft(sampler2D s,vec2 q,float r){vec2 d=r/res;vec3 a=texture2D(s,q).rgb*0.28;
a+=(texture2D(s,q+vec2(d.x,0.0)).rgb+texture2D(s,q-vec2(d.x,0.0)).rgb+texture2D(s,q+vec2(0.0,d.y)).rgb+texture2D(s,q-vec2(0.0,d.y)).rgb)*0.14;
a+=(texture2D(s,q+d).rgb+texture2D(s,q-d).rgb+texture2D(s,q+vec2(d.x,-d.y)).rgb+texture2D(s,q-vec2(d.x,-d.y)).rgb)*0.04;return a;}
vec3 scr(vec3 c,vec3 l){return 1.0-(1.0-c)*(1.0-clamp(l,0.0,1.0));}
void main(){
  vec2 q=uw;vec4 o=S(q);vec3 c=o.rgb;
  if(mode<0.5){gl_FragColor=vec4(c,1.0);return;}                      // 0: plain copy (used to build the blurred copies)
  if(mode<1.5){                                                         // 1 blur
    vec3 a=soft(b1,q,1.5),b=soft(b2,q,1.5);
    c=mix(c,mix(a,b,smoothstep(0.25,0.95,amt)),smoothstep(0.0,0.3,amt));
  }else if(mode<2.5){                                                   // 2 soft focus
    vec3 b=soft(b1,q,1.5);c=mix(c,b,0.55*amt)+b*0.22*amt;
  }else if(mode<3.5){                                                   // 3 sharpen
    vec2 d=1.0/res;
    vec3 n=(S(q+vec2(d.x,0.0)).rgb+S(q-vec2(d.x,0.0)).rgb+S(q+vec2(0.0,d.y)).rgb+S(q-vec2(0.0,d.y)).rgb)*0.25;
    c=c+(c-n)*amt*3.0;
  }else if(mode<4.5){                                                   // 4 glow / bloom
    vec3 b=soft(b1,q,1.5)*0.55+soft(b2,q,1.5)*0.45;
    c=scr(c,max(b-0.38,0.0)*2.2*amt*1.6+b*0.12*amt);
  }else if(mode<5.5){                                                   // 5 light leak (warm light drifting in from the edge)
    float ph=0.5+0.5*sin(t*0.5);
    vec2 a=vec2(-0.05+ph*0.55,0.95),b=vec2(1.05-ph*0.4,0.1);
    float l1=exp(-dot(q-a,q-a)*3.2),l2=exp(-dot(q-b,q-b)*4.5);
    vec3 leak=l1*vec3(1.0,0.5,0.12)+l2*vec3(0.95,0.2,0.35)*0.75;
    c=scr(c,leak*amt*0.95);
  }else if(mode<6.5){                                                   // 6 sun rays (soft beams of light from the top left)
    vec2 s=vec2(0.12,1.08),d=q-s;float ang=atan(d.y,d.x),len=length(d);
    float r=pow(0.5+0.5*sin(ang*17.0+sin(t*0.45)*1.4),2.5)*(0.55+0.45*sin(ang*6.0-t*0.35+1.3));
    float f=exp(-len*1.5);
    vec3 ray=vec3(1.0,0.9,0.65)*(r*f*1.1+exp(-len*3.2)*0.35);
    c=scr(c,ray*amt*0.85);
  }else if(mode<7.5){                                                   // 7 flash (a quick white pop every 2 s)
    float ph=fract(t/2.0);float fl=exp(-ph*9.0)*amt;
    c=mix(c,vec3(1.0),clamp(fl,0.0,1.0)*0.9);
  }else if(mode<8.5){                                                   // 8 shake
    float k=t*23.0;
    vec2 off=vec2(sin(k*1.7)+0.6*sin(k*4.1+1.0),cos(k*1.3)+0.6*sin(k*3.7+2.0))*0.012*amt;
    vec2 qq=0.5+(q-0.5)*(1.0-0.05*amt)+off;
    o=S(qq);c=o.rgb;
  }else if(mode<9.5){                                                   // 9 zoom pulse (a gentle beat twice a second)
    float ph=fract(t*2.0);float pu=exp(-ph*5.5);
    float z=1.0+amt*0.14*pu;
    o=S(0.5+(q-0.5)/z);c=o.rgb;
  }else if(mode<10.5){                                                  // 10 film grain
    float n=hash(q*res+floor(t*24.0)*7.31)-0.5;
    float lum=dot(c,vec3(0.299,0.587,0.114));
    c+=n*amt*0.42*(1.0-0.5*abs(lum-0.5));
  }else if(mode<11.5){                                                  // 11 glitch (bursts of sliced, split-colour rows)
    float step_=floor(t*10.0);
    float burst=step(0.45,hash(vec2(step_,3.0)));
    float band=floor(q.y*18.0);
    float hit=step(1.0-0.5*amt,hash(vec2(band,step_)))*burst;
    float off=(hash(vec2(band,step_+9.0))-0.5)*0.22*amt*hit;
    float sp=0.004+0.02*amt*hit;
    c=vec3(S(q+vec2(off+sp,0.0)).r,S(q+vec2(off,0.0)).g,S(q+vec2(off-sp,0.0)).b);
  }else if(mode<12.5){                                                  // 12 chromatic aberration (colour fringes toward the edges)
    vec2 d=(q-0.5);float k=amt*0.03;
    c=vec3(S(q+d*k).r,S(q).g,S(q-d*k).b);
  }else if(mode<13.5){                                                  // 13 pixelate
    float blk=max(1.0,amt*0.06*res.y);
    vec2 g=(floor(q*res/blk)+0.5)*blk/res;
    o=S(g);c=o.rgb;
  }else if(mode<14.5){                                                  // 14 mirror (the left half is reflected onto the right)
    o=S(vec2(q.x<0.5?q.x:1.0-q.x,q.y));c=o.rgb;
  }else{                                                                // 15 cinematic bars
    float h=0.25*amt;if(q.y<h||q.y>1.0-h)c=vec3(0.0);
  }
  gl_FragColor=vec4(clamp(c,0.0,1.0),o.a);
}`;

export class FxGL {
  constructor() {
    this.canvas = document.createElement('canvas'); this.ok = false; this.W = 0; this.H = 0;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this._init());
    this._init();
  }
  _init() {
    this.ok = false; this.rt = null; this.W = 0; this.H = 0;
    try {
      const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link failed: ' + gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {}; for (const n of ['tex', 'b1', 'b2', 'flip', 'mode', 'amt', 't', 'res']) this.u[n] = gl.getUniformLocation(pr, n);
      gl.uniform1i(this.u.tex, 0); gl.uniform1i(this.u.b1, 1); gl.uniform1i(this.u.b2, 2);
      this.units = [0, 1, 2].map(() => { const tx = gl.createTexture(); return tx; });
      this.units.forEach((tx, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tx); this._par(gl); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); });
      this.gl = gl; this.ok = !gl.isContextLost();
    } catch (e) { console.warn('Effects unavailable', e); this.ok = false; }
  }
  _par(gl) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  _target(w, h) { // a texture + framebuffer to draw into
    const gl = this.gl, tx = gl.createTexture(), fb = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tx); this._par(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
    return { tx, fb, w, h };
  }
  _targets(W, H) {
    const gl = this.gl;
    if (this.rt && this.W === W && this.H === H) return this.rt;
    if (this.rt) for (const r of this.rt) { gl.deleteTexture(r.tx); gl.deleteFramebuffer(r.fb); }
    const sm = (d) => [Math.max(2, Math.ceil(W / d)), Math.max(2, Math.ceil(H / d))];
    this.rt = [this._target(W, H), this._target(W, H), this._target(...sm(4)), this._target(...sm(16))];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.W = W; this.H = H; return this.rt;
  }
  _pass(target, mode, amt, t, flip, res, W, H) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : W, target ? target.h : H);
    gl.uniform1f(this.u.mode, mode); gl.uniform1f(this.u.amt, amt); gl.uniform1f(this.u.t, t); gl.uniform1f(this.u.flip, flip);
    gl.uniform2f(this.u.res, res[0], res[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** Draw the effects of `list` over `src` (a canvas) at sequence time t. Returns this.canvas (valid until the next call), or null when nothing to do. */
  process(src, W, H, list, t) {
    const fx = activeFx(list);
    if (!fx.length || !this.ok) return null;
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const rt = this._targets(W, H), tt = ((t % 1000) + 1000) % 1000;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.units[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    let cur = null, flip = 1; // cur: the target holding the picture so far (null = the uploaded canvas)
    const bind = (r) => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r ? r.tx : this.units[0]); };
    fx.forEach((f, i) => {
      const info = fxInfo(f.type), last = i === fx.length - 1;
      if (info.blurs) { // copies of the picture at 1/4 and 1/16 size: the blurred versions that blur, soft focus and glow look up
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.units[1]); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.units[2]); // not the ones being drawn into
        bind(cur); this._pass(rt[2], 0, 0, tt, flip, [W, H], W, H);
        bind(rt[2]); this._pass(rt[3], 0, 0, tt, 0, [rt[2].w, rt[2].h], W, H);
        bind(cur);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rt[2].tx);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, rt[3].tx);
      }
      bind(cur);
      const out = last ? null : rt[i % 2];
      // the blur copies are textures 1/2 of the unit table; resolution of the small ones differs, so pass the full size and let `soft` scale by 1 texel of the small copy
      this._pass(out, info.mode, f.amount, tt, flip, info.blurs ? [rt[3].w, rt[3].h] : [W, H], W, H);
      cur = out; flip = 0;
    });
    return this.canvas;
  }
}
