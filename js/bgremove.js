// Background remove / blur / replace using a person confidence mask. Pure canvas ops (preview = export).
export const BG_MODES = ['off', 'remove', 'blur', 'color', 'image'];
export const defaultBgRemove = () => ({ mode: 'off', soft: 0.35, color: '#1a7a3a', mediaId: null, strength: 0.85 });

export function normalizeBgRemove(b) {
  const d = defaultBgRemove();
  if (!b || typeof b !== 'object') return { ...d };
  const mode = BG_MODES.includes(b.mode) ? b.mode : 'off';
  return {
    mode,
    soft: clamp(+b.soft, 0, 1, d.soft),
    color: typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : d.color,
    mediaId: typeof b.mediaId === 'string' ? b.mediaId : null,
    strength: clamp(+b.strength, 0, 1, d.strength),
  };
}

const clamp = (v, lo, hi, fb) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;

/** Soften a Float32 mask in-place-ish → new Float32Array via box blur + contrast around 0.5. soft 0..1 */
export function softenMask(data, w, h, soft = 0.35) {
  if (!soft || soft < 0.02) return data;
  const r = Math.max(1, Math.round(soft * Math.min(w, h) * 0.04));
  const tmp = new Float32Array(data.length), out = new Float32Array(data.length);
  // separable box blur
  const pass = (src, dst, horiz) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      if (horiz) {
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
      } else {
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += src[yy * w + x]; n++; } }
      }
      dst[y * w + x] = s / n;
    }
  };
  pass(data, tmp, true); pass(tmp, out, false);
  // slight contrast so edges stay defined after blur
  const lo = 0.35 - soft * 0.2, hi = 0.65 + soft * 0.15;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
  }
  return out;
}

/**
 * Composite person cut-out onto an output canvas the same size as `src`.
 * mask: { width, height, data: Float32Array } person confidence.
 * opts: { mode, soft, color, bgImage (canvas/img|null), strength (blur amount) }
 * Returns the output canvas (reuses opts.out if given).
 */
export function applyBgRemove(src, mask, opts = {}) {
  const mode = opts.mode || 'off';
  if (mode === 'off' || !mask || !mask.data) return src;
  const W = src.width || src.videoWidth || src.naturalWidth;
  const H = src.height || src.videoHeight || src.naturalHeight;
  const out = opts.out || (applyBgRemove._out = applyBgRemove._out || document.createElement('canvas'));
  if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);

  // Build alpha mask canvas at source size
  if (!applyBgRemove._m) { applyBgRemove._m = document.createElement('canvas'); applyBgRemove._mx = applyBgRemove._m.getContext('2d'); }
  const mw = mask.width, mh = mask.height;
  if (applyBgRemove._m.width !== mw || applyBgRemove._m.height !== mh) { applyBgRemove._m.width = mw; applyBgRemove._m.height = mh; }
  const soft = softenMask(mask.data, mw, mh, opts.soft ?? 0.35);
  const imgData = applyBgRemove._mx.createImageData(mw, mh);
  for (let i = 0; i < soft.length; i++) {
    const a = Math.max(0, Math.min(255, Math.round(soft[i] * 255)));
    imgData.data[i * 4] = 255; imgData.data[i * 4 + 1] = 255; imgData.data[i * 4 + 2] = 255; imgData.data[i * 4 + 3] = a;
  }
  applyBgRemove._mx.putImageData(imgData, 0, 0);

  if (mode === 'blur') {
    // blurred full frame as background
    if (!applyBgRemove._b) { applyBgRemove._b = document.createElement('canvas'); applyBgRemove._bx = applyBgRemove._b.getContext('2d'); }
    const bw = Math.max(8, Math.round(W / (8 + (1 - (opts.strength ?? 0.85)) * 24)));
    const bh = Math.max(8, Math.round(H * bw / W));
    if (applyBgRemove._b.width !== bw || applyBgRemove._b.height !== bh) { applyBgRemove._b.width = bw; applyBgRemove._b.height = bh; }
    applyBgRemove._bx.drawImage(src, 0, 0, bw, bh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(applyBgRemove._b, 0, 0, W, H);
  } else if (mode === 'color') {
    ctx.fillStyle = opts.color || '#1a7a3a';
    ctx.fillRect(0, 0, W, H);
  } else if (mode === 'image' && opts.bgImage) {
    const im = opts.bgImage;
    const iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight;
    const s = Math.max(W / iw, H / ih);
    ctx.drawImage(im, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  } else {
    // remove → transparent (caller composites over project bg)
    ctx.clearRect(0, 0, W, H);
  }

  // Draw person: use mask as destination-in on a copy of src, then draw over bg
  if (!applyBgRemove._p) { applyBgRemove._p = document.createElement('canvas'); applyBgRemove._px = applyBgRemove._p.getContext('2d'); }
  if (applyBgRemove._p.width !== W || applyBgRemove._p.height !== H) { applyBgRemove._p.width = W; applyBgRemove._p.height = H; }
  const px = applyBgRemove._px;
  px.clearRect(0, 0, W, H);
  px.drawImage(src, 0, 0, W, H);
  px.globalCompositeOperation = 'destination-in';
  px.drawImage(applyBgRemove._m, 0, 0, W, H);
  px.globalCompositeOperation = 'source-over';
  ctx.drawImage(applyBgRemove._p, 0, 0);
  return out;
}

export function bgRemoveActive(item) {
  const b = item && item.bgremove;
  return !!(b && b.mode && b.mode !== 'off');
}
