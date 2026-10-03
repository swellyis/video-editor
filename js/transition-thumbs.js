// Little previews for the Transitions tab: two sample pictures and a transition drawn between them with the SAME picture maths as the editor
// (transitions.js look()), so a thumbnail shows exactly what the transition does. Static (middle frame) by default, looping while hovered / focused / tapped.
import { look, typeInfo } from './transitions.js';

export const THUMB_W = 160, THUMB_H = 90;
let pics = null;
function makePics() {
  const mk = (draw) => { const c = document.createElement('canvas'); c.width = THUMB_W; c.height = THUMB_H; draw(c.getContext('2d')); return c; };
  return {
    a: mk((x) => { const g = x.createLinearGradient(0, 0, THUMB_W, THUMB_H); g.addColorStop(0, '#f6a04d'); g.addColorStop(1, '#d9455f'); x.fillStyle = g; x.fillRect(0, 0, THUMB_W, THUMB_H); x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(THUMB_W * 0.7, THUMB_H * 0.35, 15, 0, 7); x.fill(); x.fillStyle = 'rgba(80,20,40,.55)'; x.fillRect(0, THUMB_H * 0.72, THUMB_W, THUMB_H * 0.28); }),
    b: mk((x) => { const g = x.createLinearGradient(0, THUMB_H, THUMB_W, 0); g.addColorStop(0, '#0f3d5e'); g.addColorStop(1, '#2fb5a8'); x.fillStyle = g; x.fillRect(0, 0, THUMB_W, THUMB_H); x.fillStyle = 'rgba(255,255,255,.85)'; x.beginPath(); x.moveTo(THUMB_W * 0.15, THUMB_H * 0.85); x.lineTo(THUMB_W * 0.4, THUMB_H * 0.25); x.lineTo(THUMB_W * 0.65, THUMB_H * 0.85); x.fill(); x.beginPath(); x.moveTo(THUMB_W * 0.45, THUMB_H * 0.85); x.lineTo(THUMB_W * 0.7, THUMB_H * 0.45); x.lineTo(THUMB_W * 0.95, THUMB_H * 0.85); x.fill(); }),
  };
}
/** The progress to show when nothing is moving: the middle of the transition (a little before the middle for the dips, so the picture is still visible). */
export const restingP = (type) => (typeInfo(type).kind === 'dip' ? 0.3 : 0.5);

/** Draw one frame of `type` at progress p (0..1) into a canvas context of THUMB_W x THUMB_H. */
export function drawThumb(ctx, type, p) {
  if (!pics) pics = makePics();
  const W = THUMB_W, H = THUMB_H, info = typeInfo(type);
  ctx.save(); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (info.kind === 'cut') { ctx.drawImage(p < 0.5 ? pics.a : pics.b, 0, 0); }
  else if (info.kind === 'dip') {
    ctx.drawImage(p < 0.5 ? pics.a : pics.b, 0, 0);
    const veil = p < 0.5 ? p * 2 : (1 - p) * 2; // 0 at the ends, 1 in the middle
    ctx.globalAlpha = veil; ctx.fillStyle = info.color; ctx.fillRect(0, 0, W, H);
  } else {
    const L = look(type, p);
    for (const [img, l] of [[pics.a, L.out], [pics.b, L.inn]]) {
      ctx.save();
      if (l.clip) { ctx.beginPath(); ctx.rect(l.clip.x0 * W, l.clip.y0 * H, (l.clip.x1 - l.clip.x0) * W, (l.clip.y1 - l.clip.y0) * H); ctx.clip(); }
      if (l.dx || l.dy) ctx.translate(l.dx * W, l.dy * H);
      if (l.scale !== 1) { ctx.translate(W / 2, H / 2); ctx.scale(l.scale, l.scale); ctx.translate(-W / 2, -H / 2); }
      if (l.blur > 0) ctx.filter = `blur(${(l.blur * H).toFixed(1)}px)`;
      ctx.globalAlpha = l.alpha; ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Start a looping preview on a canvas; returns stop(). */
export function loopThumb(canvas, type, ms = 1400) {
  const ctx = canvas.getContext('2d'); let raf = 0, t0 = performance.now(), dead = false;
  const tick = (now) => {
    if (dead) return;
    const ph = ((now - t0) % (ms + 500)) / ms; // a short rest at the end of each loop
    drawThumb(ctx, type, Math.min(1, ph));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { dead = true; cancelAnimationFrame(raf); drawThumb(ctx, type, restingP(type)); };
}
