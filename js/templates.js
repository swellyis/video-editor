// Starter templates for faith / devotional videos and Shorts.
// Each template produces background image "clips" (generated on a canvas), text layers with
// animation presets, optional keyframes and chapter markers — everything stays editable.
import { newText } from './model.js';

const rnd = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/** Paint a background and return a JPEG Blob. */
export function paintBackground(W, H, style) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const r = rnd(style.seed || 7);
  const g = x.createLinearGradient(0, 0, W * 0.35, H);
  style.colors.forEach((col, i) => g.addColorStop(i / (style.colors.length - 1), col));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const m = Math.min(W, H);
  if (style.rays) {
    // soft light rays from the top
    x.save(); x.globalCompositeOperation = 'lighter';
    const ox = W * (style.rayX ?? 0.72), oy = -H * 0.12;
    for (let i = 0; i < 9; i++) {
      const a = Math.PI / 2 + (r() - 0.5) * 1.1, w = 0.04 + r() * 0.09, len = Math.hypot(W, H) * 1.2;
      x.beginPath(); x.moveTo(ox, oy);
      x.lineTo(ox + Math.cos(a - w) * len, oy + Math.sin(a - w) * len);
      x.lineTo(ox + Math.cos(a + w) * len, oy + Math.sin(a + w) * len); x.closePath();
      const rg = x.createRadialGradient(ox, oy, 0, ox, oy, len * 0.8);
      rg.addColorStop(0, `rgba(255,236,190,${0.10 + r() * 0.08})`); rg.addColorStop(1, 'rgba(255,236,190,0)');
      x.fillStyle = rg; x.fill();
    }
    x.restore();
  }
  if (style.bokeh) {
    x.save(); x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 26; i++) {
      const bx = r() * W, by = r() * H, br = m * (0.015 + r() * 0.07);
      const rg = x.createRadialGradient(bx, by, 0, bx, by, br);
      rg.addColorStop(0, `rgba(255,220,160,${0.06 + r() * 0.12})`); rg.addColorStop(1, 'rgba(255,220,160,0)');
      x.fillStyle = rg; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
    }
    x.restore();
  }
  if (style.cross) {
    // a subtle cross silhouette
    x.save(); x.globalAlpha = style.cross; x.fillStyle = '#fff';
    const cx = W * (style.crossX ?? 0.5), cy = H * (style.crossY ?? 0.5), s = m * 0.5;
    x.fillRect(cx - s * 0.035, cy - s * 0.5, s * 0.07, s);
    x.fillRect(cx - s * 0.25, cy - s * 0.24, s * 0.5, s * 0.07);
    x.restore();
  }
  if (style.accentBar) {
    x.fillStyle = style.accentBar; x.fillRect(W * 0.08, H * 0.5 + m * 0.11, m * 0.12, Math.max(4, m * 0.008));
  }
  // vignette
  const vg = x.createRadialGradient(W / 2, H / 2, m * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${style.vignette ?? 0.45})`);
  x.fillStyle = vg; x.fillRect(0, 0, W, H);
  // fine grain so gradients don't band after video compression
  const id = x.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 6; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
}

const T = (start, dur, text, o = {}) => Object.assign(newText(start, dur, text), { fadeIn: 0, fadeOut: 0 }, o, { anim: Object.assign({ in: 'none', out: 'none', inDur: 0.6, outDur: 0.4 }, o.anim || {}) });

export const TEMPLATES = [
  {
    id: 'verse', name: 'Scripture verse card', icon: '📖', ratio: '16:9',
    desc: 'A calm verse reveal with reference — word by word, then the reference slides up.',
    build: () => ({
      sections: [{ name: 'Verse', dur: 9, bg: { colors: ['#2b1d12', '#5a3b22', '#1a120b'], rays: true, seed: 11 }, zoom: [1, 1.08] }],
      texts: [
        T(0.4, 8.2, 'The Lord is my shepherd; I shall not want.', { y: 0.44, size: 0.085, font: 'serif', style: 'clean', maxWidth: 0.78, anim: { in: 'wordByWord', out: 'fade', inDur: 2.6, outDur: 0.6 } }),
        T(3.2, 5.4, 'PSALM 23:1', { y: 0.66, size: 0.042, font: 'mono', style: 'clean', color: '#f3d9a4', anim: { in: 'slideUp', out: 'fade', inDur: 0.7, outDur: 0.6 } }),
      ],
      markers: [{ t: 0, name: 'Verse' }],
    }),
  },
  {
    id: 'intro', name: 'Channel intro', icon: '✨', ratio: '16:9',
    desc: 'A 5-second branded opener: your channel name pops in over warm bokeh.',
    build: () => ({
      sections: [{ name: 'Intro', dur: 5, bg: { colors: ['#0e1a2b', '#1d3557', '#0b0f17'], bokeh: true, seed: 5 }, zoom: [1.12, 1] }],
      texts: [
        T(0.3, 4.4, 'Your Channel Name', { y: 0.46, size: 0.11, font: 'sans', style: 'clean', anim: { in: 'pop', out: 'fade', inDur: 0.6, outDur: 0.5 } }),
        T(1.1, 3.6, 'Daily devotionals · Encouragement · Prayer', { y: 0.6, size: 0.04, font: 'condensed', style: 'clean', color: '#ffd89a', anim: { in: 'slideUp', out: 'fade', inDur: 0.6, outDur: 0.5 } }),
      ],
      markers: [{ t: 0, name: 'Intro' }],
    }),
  },
  {
    id: 'shortsQuote', name: 'Shorts quote', icon: '📱', ratio: '9:16',
    desc: 'Vertical 9:16 quote for Shorts / Reels with a follow prompt at the end.',
    build: () => ({
      settings: { ratio: '9:16', bg: 'blur' },
      sections: [{ name: 'Quote', dur: 10, bg: { colors: ['#2a1438', '#6b2f4f', '#1a0f24'], rays: true, rayX: 0.5, seed: 3, cross: 0.06, crossY: 0.2 }, zoom: [1, 1.1] }],
      texts: [
        T(0.3, 9.4, 'Be still, and know that I am God.', { y: 0.42, size: 0.1, font: 'serif', style: 'clean', maxWidth: 0.84, anim: { in: 'wordByWord', out: 'fade', inDur: 2.2, outDur: 0.5 } }),
        T(2.6, 7.1, 'Psalm 46:10', { y: 0.56, size: 0.05, font: 'serifItalic', style: 'clean', color: '#f7c9d8', anim: { in: 'slideUp', out: 'fade', inDur: 0.6, outDur: 0.5 } }),
        T(6.2, 3.5, 'Follow for daily encouragement', { y: 0.84, size: 0.045, font: 'sans', style: 'box', bg: '#df3f34', bgOpacity: 0.9, anim: { in: 'pop', out: 'none', inDur: 0.5, outDur: 0.3 } }),
      ],
      markers: [],
    }),
  },
  {
    id: 'lowerThird', name: 'Lower-third name', icon: '🏷️', ratio: null, insertOnly: true,
    desc: 'Adds a name + title lower third at the playhead over your existing footage.',
    build: () => ({
      sections: [],
      texts: [
        T(0, 5, 'Pastor John Smith', { x: 0.3, y: 0.78, size: 0.055, font: 'sans', style: 'box', align: 'left', bg: '#111111', bgOpacity: 0.78, maxWidth: 0.5, anim: { in: 'slideUp', out: 'fade', inDur: 0.5, outDur: 0.4 } }),
        T(0.25, 4.75, 'Grace Community Church', { x: 0.3, y: 0.865, size: 0.034, font: 'condensed', style: 'box', align: 'left', color: '#111111', bg: '#f0b429', bgOpacity: 0.95, maxWidth: 0.5, anim: { in: 'slideUp', out: 'fade', inDur: 0.5, outDur: 0.4 } }),
      ],
      markers: [],
    }),
  },
  {
    id: 'sermon', name: 'Sermon / devotional outline', icon: '🎙️', ratio: '16:9',
    desc: 'Title card, three points and a closing prayer — with YouTube chapter markers.',
    build: () => {
      const bg = (seed, c) => ({ colors: c, rays: seed % 2 === 1, bokeh: seed % 2 === 0, seed });
      const secs = [
        { name: 'Welcome', dur: 10, bg: bg(21, ['#1f2a1c', '#3f5a36', '#141a12']), zoom: [1, 1.06] },
        { name: 'Point 1', dur: 12, bg: bg(22, ['#1b1f2e', '#34406b', '#10131c']), zoom: [1.06, 1] },
        { name: 'Point 2', dur: 12, bg: bg(23, ['#2e1f1b', '#6b4434', '#1c1310']), zoom: [1, 1.06] },
        { name: 'Point 3', dur: 12, bg: bg(24, ['#1b2a2e', '#346166', '#101a1c']), zoom: [1.06, 1] },
        { name: 'Closing prayer', dur: 10, bg: bg(25, ['#241b2e', '#4f3a6b', '#150f1c']), zoom: [1, 1.08] },
      ];
      const at = (i) => secs.slice(0, i).reduce((a, b) => a + b.dur, 0);
      const texts = [
        T(0.3, 9.2, 'Finding Peace in Anxious Times', { y: 0.44, size: 0.09, font: 'serif', anim: { in: 'pop', out: 'fade', inDur: 0.6, outDur: 0.4 } }),
        T(1.0, 8.5, 'Philippians 4:6–7', { y: 0.6, size: 0.042, font: 'mono', color: '#e6f0c8', anim: { in: 'slideUp', out: 'fade' } }),
      ];
      const pts = ['Pray about everything', 'Give thanks in all things', 'Receive the peace of God'];
      pts.forEach((p, i) => {
        const s = at(i + 1);
        texts.push(T(s + 0.3, 11.2, 'Point ' + (i + 1), { y: 0.36, size: 0.045, font: 'condensed', color: '#f0b429', anim: { in: 'slideUp', out: 'fade' } }));
        texts.push(T(s + 0.6, 10.9, p, { y: 0.5, size: 0.08, font: 'sans', anim: { in: 'typewriter', out: 'fade', inDur: 1.2 } }));
      });
      texts.push(T(at(4) + 0.4, 9.2, 'Let’s pray together', { y: 0.46, size: 0.085, font: 'serifItalic', anim: { in: 'wordByWord', out: 'fade', inDur: 1.4, outDur: 0.8 } }));
      return { sections: secs, texts, markers: secs.map((s, i) => ({ t: at(i), name: s.name })) };
    },
  },
];
