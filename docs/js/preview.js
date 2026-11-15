/* ==========================================================================
   Kyro — procedural canvas preview engine
   One shared requestAnimationFrame drives every visible preview. Canvases
   idle at a frozen "posed" frame; hovering a card ramps its animation via an
   eased intensity value, so a full grid costs ~0 CPU until you touch it.
   Renderer signature: (ctx, w, h, t, k, seed, entry)
     t = animation time (seconds, hover-accelerated)
     k = hover intensity 0..1 (motion boost / glow strength)
   ========================================================================== */
window.Preview = (function () {
  'use strict';

  const CYAN = '#E4E6EC', MAG = '#8E8E98', GREEN = '#A1A1AA', VIOLET = '#C4C6CE';
  const entries = new Map();          // canvas -> entry
  let rafId = null, running = false, last = 0;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- tiny helpers ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const hash = (i, seed) => { const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); };

  function rr(g, x, y, w, h, r) {
    g.beginPath();
    // Animated rects can collapse or invert for a frame — a non-positive box
    // has nothing to draw, and a negative radius throws in arcTo.
    if (!(w > 0) || !(h > 0)) return;
    r = clamp(r, 0, Math.min(w, h) / 2);
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* Faint studio backdrop shared by most renderers */
  function stageBg(g, w, h) {
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, '#08090D'); lg.addColorStop(1, '#0C0E13');
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.045)';
    const step = Math.max(22, w / 18);
    for (let y = step; y < h; y += step)
      for (let x = step; x < w; x += step) g.fillRect(x, y, 1.2, 1.2);
  }

  /* =========================================================================
     Renderers
     ========================================================================= */
  const RENDERERS = {

    /* Bento grid visualizer — oscillating columns/rows, travelling accent cell */
    grid(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const m = w * 0.06, gap = w * 0.022;
      const cols = 3, rows = 2;
      const cw = [], ch = [];
      let tw = 0, th = 0;
      for (let i = 0; i < cols; i++) { const v = 1 + 0.5 * Math.sin(t * 1.25 + i * 2.4 + seed * 0.13); cw.push(v); tw += v; }
      for (let j = 0; j < rows; j++) { const v = 1 + 0.4 * Math.sin(t * 0.9 + j * 2.1 + seed * 0.31); ch.push(v); th += v; }
      const usableW = w - 2 * m - gap * (cols - 1), usableH = h - 2 * m - gap * (rows - 1);
      const accent = Math.floor((t * 0.55) % (cols * rows));
      let ai = 0;
      for (let j = 0; j < rows; j++) {
        let acc = 0;
        for (let q = 0; q < j; q++) acc += usableH * ch[q] / th;
        const y = m + acc + gap * j;
        const hh = usableH * ch[j] / th;
        let x = m;
        for (let i = 0; i < cols; i++) {
          let accW = 0;
          for (let q = 0; q < i; q++) accW += usableW * cw[q] / tw;
          x = m + accW + gap * i;
          const ww = usableW * cw[i] / tw;
          const isAccent = ai === accent;
          rr(g, x, y, ww, hh, w * 0.016);
          g.fillStyle = isAccent ? 'rgba(228,230,236,0.10)' : 'rgba(255,255,255,0.05)';
          if (isAccent) { g.shadowColor = 'rgba(228,230,236,0.55)'; g.shadowBlur = 8 + 18 * k; }
          g.fill(); g.shadowBlur = 0;
          g.strokeStyle = isAccent ? 'rgba(228,230,236,' + (0.55 + 0.35 * k) + ')' : 'rgba(255,255,255,0.10)';
          g.lineWidth = 1; g.stroke();
          if (ww > 40 && hh > 26) {
            g.fillStyle = 'rgba(255,255,255,' + (isAccent ? 0.3 : 0.12) + ')';
            g.fillRect(x + 8, y + 8, ww * 0.5, 3);
            g.fillRect(x + 8, y + 16, ww * 0.3, 3);
          }
          ai++;
        }
      }
    },

    /* Bezier speed-graph editor — morphing curve, travelling dot, handles */
    graph(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const px = w * 0.14, py = h * 0.16;
      const x0 = px, y0 = h - py, x1 = w - px, y1 = py;
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
      g.strokeRect(x0, y1, x1 - x0, y0 - y1);
      g.setLineDash([4, 5]);
      g.strokeStyle = 'rgba(255,255,255,0.13)';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.setLineDash([]);
      // morphing cubic ease
      const span = (x1 - x0) * (0.24 + 0.18 * Math.sin(t * 1.35 + seed));
      const cx1 = x0 + span, cy1 = y0;
      const cx2 = x1 - span, cy2 = y1;
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, 'rgba(228,230,236,0.25)'); grad.addColorStop(1, CYAN);
      g.strokeStyle = grad; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(cx1, cy1, cx2, cy2, x1, y1); g.stroke();
      // influence handles
      g.strokeStyle = 'rgba(228,230,236,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(cx1, cy1); g.moveTo(x1, y1); g.lineTo(cx2, cy2); g.stroke();
      g.fillStyle = 'rgba(228,230,236,0.85)';
      [[cx1, cy1], [cx2, cy2]].forEach(p => g.fillRect(p[0] - 3, p[1] - 3, 6, 6));
      // travelling dot on the curve + its playhead
      const s = (Math.sin(t * 1.15 + seed * 0.7) + 1) / 2;
      const u = 1 - s;
      const bx = u * u * u * x0 + 3 * u * u * s * cx1 + 3 * u * s * s * cx2 + s * s * s * x1;
      const by = u * u * u * y0 + 3 * u * u * s * cy1 + 3 * u * s * s * cy2 + s * s * s * y1;
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.beginPath(); g.moveTo(bx, y1); g.lineTo(bx, y0); g.stroke();
      g.shadowColor = 'rgba(228,230,236,0.9)'; g.shadowBlur = 10 + 14 * k;
      g.fillStyle = '#FFFFFF';
      g.beginPath(); g.arc(bx, by, 4.2 + 1.8 * k, 0, 7); g.fill();
      g.shadowBlur = 0;
    },

    /* Damped-spring settle curve + bouncing ball with ghosts */
    spring(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const px = w * 0.12, top = h * 0.24, bot = h * 0.82;
      g.setLineDash([5, 5]);
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      g.beginPath(); g.moveTo(px, top); g.lineTo(w - px, top); g.stroke();
      g.setLineDash([]);
      const settle = (u) => 1 - Math.exp(-5.2 * u) * Math.cos(8.5 * u); // overshoot → rest at 1
      g.strokeStyle = 'rgba(228,230,236,0.65)'; g.lineWidth = 1.8; g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const uu = i / 64;
        const y = lerp(bot, top, clamp(settle(uu), -0.25, 1.4));
        const x = lerp(px, w - px, uu);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      const cyc = ((t * 0.55 + seed * 0.1) % 1);
      for (let gi = 5; gi >= 0; gi--) {
        const uu = clamp(cyc - gi * 0.045, 0, 1);
        const x = lerp(px, w - px, uu);
        const y = lerp(bot, top, clamp(settle(uu), -0.25, 1.4));
        g.globalAlpha = gi ? 0.09 * (5 - gi) / 5 : 1;
        const r = gi ? 5.5 : 7 + 2.5 * k;
        if (!gi) { g.shadowColor = 'rgba(142,142,152,0.8)'; g.shadowBlur = 12 + 16 * k; }
        const bgrad = g.createRadialGradient(x - 2, y - 2, 1, x, y, r);
        bgrad.addColorStop(0, '#E4E6EC'); bgrad.addColorStop(1, MAG);
        g.fillStyle = bgrad;
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
        g.shadowBlur = 0;
      }
      g.globalAlpha = 1;
    },

    /* Rotating 3D camera frustum wireframe + focus reticle */
    camera(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const cx = w / 2, cy = h / 2, f = w * 0.9;
      const yaw = 0.55 + t * (0.35 + k * 0.5);
      const pitch = -0.32 + Math.sin(t * 0.4) * 0.05;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      void seed;
      function project(p) {
        const x1 = p[0] * cosY + p[2] * sinY;
        const z1 = -p[0] * sinY + p[2] * cosY;
        const y1 = p[1] * cosP - z1 * sinP;
        const z2 = p[1] * sinP + z1 * cosP;
        const d = f / (z2 + 4.4);
        return [cx + x1 * d, cy + y1 * d];
      }
      const A = project([0, 0, -2.0]);
      const far = [[-1.05, -0.62, 1.15], [1.05, -0.62, 1.15], [1.05, 0.62, 1.15], [-1.05, 0.62, 1.15]].map(project);
      g.beginPath(); g.moveTo(far[0][0], far[0][1]); far.forEach(p => g.lineTo(p[0], p[1])); g.closePath();
      g.fillStyle = 'rgba(228,230,236,0.05)'; g.fill();
      g.strokeStyle = 'rgba(228,230,236,0.75)'; g.lineWidth = 1.4; g.stroke();
      g.strokeStyle = 'rgba(228,230,236,0.35)'; g.lineWidth = 1;
      far.forEach(p => { g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(p[0], p[1]); g.stroke(); });
      // subject wireframe box beyond the far plane
      const s = 0.32, zs = 2.6;
      const box = [[-s, -s, zs], [s, -s, zs], [s, s, zs], [-s, s, zs],
                   [-s, -s, zs + s * 2], [s, -s, zs + s * 2], [s, s, zs + s * 2], [-s, s, zs + s * 2]].map(project);
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
        .forEach(e => { g.beginPath(); g.moveTo(box[e[0]][0], box[e[0]][1]); g.lineTo(box[e[1]][0], box[e[1]][1]); g.stroke(); });
      // focus reticle
      const rt = 26 + 5 * Math.sin(t * 3);
      g.strokeStyle = 'rgba(228,230,236,' + (0.45 + 0.4 * k) + ')'; g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(cx - rt / 2, cy - rt / 2 + 5); g.lineTo(cx - rt / 2, cy - rt / 2); g.lineTo(cx - rt / 2 + 5, cy - rt / 2);
      g.moveTo(cx + rt / 2 - 5, cy - rt / 2); g.lineTo(cx + rt / 2, cy - rt / 2); g.lineTo(cx + rt / 2, cy - rt / 2 + 5);
      g.moveTo(cx + rt / 2, cy + rt / 2 - 5); g.lineTo(cx + rt / 2, cy + rt / 2); g.lineTo(cx + rt / 2 - 5, cy + rt / 2);
      g.moveTo(cx - rt / 2 + 5, cy + rt / 2); g.lineTo(cx - rt / 2, cy + rt / 2); g.lineTo(cx - rt / 2, cy + rt / 2 - 5);
      g.stroke();
      g.shadowColor = 'rgba(228,230,236,0.9)'; g.shadowBlur = 8 + 10 * k;
      g.fillStyle = '#FFFFFF';
      g.beginPath(); g.arc(A[0], A[1], 3, 0, 7); g.fill();
      g.shadowBlur = 0;
    },

    /* Flow-field particles with fading trails */
    flow(g, w, h, t, k, seed, e) {
      const live = (e.locked || e.k > 0.04) && !reduceMotion;
      const s = e.s;
      if (!s.parts || s.pw !== w) {
        const rnd = mulberry32(seed | 0);
        s.pw = w;
        s.parts = Array.from({ length: 46 }, () => ({ x: rnd(), y: rnd(), c: rnd() }));
      }
      if (live) { g.fillStyle = 'rgba(13,13,15,0.17)'; g.fillRect(0, 0, w, h); }
      else stageBg(g, w, h);
      const P = s.parts;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        const a = Math.sin(p.y * 10.2 + t * 1.1) + Math.cos(p.x * 8.4 - t * 0.85) + Math.sin((p.x + p.y) * 5 + seed * 0.1);
        if (live) {
          const v = 0.0030 + 0.0075 * k;
          p.x += Math.cos(a) * v; p.y += Math.sin(a) * v * 0.8;
          if (p.x < -0.03 || p.x > 1.03 || p.y < -0.03 || p.y > 1.03) {
            const rnd = mulberry32((seed + i + Math.floor(t * 13)) | 0);
            p.x = rnd(); p.y = rnd();
          }
        }
        const mix = (Math.sin(a) + 1) / 2;
        g.fillStyle = mix > 0.62 ? MAG : (mix > 0.3 ? CYAN : VIOLET);
        g.globalAlpha = live ? 0.75 : 0.55;
        const r = (i % 9 === 0 ? 2.2 : 1.3) + k * 0.8;
        g.beginPath(); g.arc(p.x * w, p.y * h, r, 0, 7); g.fill();
      }
      g.globalAlpha = 1;
    },

    /* File cards streaming into a vault slot */
    vault(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const vx = w * 0.64, vy = h * 0.18, vw = w * 0.26, vh = h * 0.64;
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      for (let i = 3; i >= 1; i--) {
        rr(g, vx + 8 + i * 4, vy + 10 + i * 5, vw - 22, vh * 0.32, 6);
        g.fillStyle = 'rgba(255,255,255,0.04)'; g.fill(); g.stroke();
      }
      rr(g, vx, vy, vw, vh, 10);
      g.fillStyle = 'rgba(228,230,236,0.045)'; g.fill();
      g.strokeStyle = 'rgba(228,230,236,0.55)'; g.lineWidth = 1.5;
      g.shadowColor = 'rgba(228,230,236,0.35)'; g.shadowBlur = 6 + 14 * k;
      g.stroke(); g.shadowBlur = 0;
      // lock glyph
      const lx = vx + vw / 2, ly = vy + vh * 0.62;
      g.strokeStyle = 'rgba(228,230,236,0.8)'; g.lineWidth = 1.6;
      g.beginPath(); g.arc(lx, ly - 5, 5, Math.PI, 0); g.stroke();
      rr(g, lx - 7, ly - 5, 14, 10, 2.5); g.fillStyle = 'rgba(228,230,236,0.75)'; g.fill();
      // flying files
      const N = 5, cw = w * 0.16, chh = cw * 0.66;
      for (let i = 0; i < N; i++) {
        const p = (((t * (0.26 + k * 0.28)) + i * 0.21 + seed * 0.01) % 1.25);
        const u = clamp(p / 1.08, 0, 1);
        const eased = 1 - Math.pow(1 - u, 2.4);
        const x = lerp(-cw * 0.8, vx + 14, eased);
        const y = lerp(h * (0.2 + 0.15 * hash(i, seed)), vy + 16 + i * 3, eased);
        const alpha = p < 0.92 ? 1 : clamp(1 - (p - 0.92) / 0.16, 0, 1);
        if (alpha <= 0.02) continue;
        g.save();
        g.globalAlpha = alpha;
        g.translate(x + cw / 2, y + chh / 2);
        g.rotate(lerp(-0.16, 0, eased) + Math.sin(t + i) * 0.02 * k);
        rr(g, -cw / 2, -chh / 2, cw, chh, 5);
        g.fillStyle = i === 2 ? 'rgba(228,230,236,0.10)' : 'rgba(255,255,255,0.07)';
        g.fill();
        g.strokeStyle = i === 2 ? 'rgba(228,230,236,0.5)' : 'rgba(255,255,255,0.16)';
        g.lineWidth = 1; g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.22)';
        g.fillRect(-cw / 2 + 6, -chh / 2 + 6, cw * 0.55, 2.5);
        g.fillRect(-cw / 2 + 6, -chh / 2 + 12, cw * 0.35, 2.5);
        g.restore();
      }
    },

    /* Kinetic per-character type build with overshoot easing */
    text(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const word = 'KYRO';
      const size = Math.min(h * 0.34, (w * 0.9 / word.length) * 1.55);
      g.font = '700 ' + size + 'px "JetBrains Mono", monospace';
      g.textBaseline = 'middle';
      const widths = [...word].map(c => g.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0);
      const baseY = h * 0.46;
      let x = (w - total) / 2;
      for (let i = 0; i < word.length; i++) {
        const T = (t * 0.9 + i * 0.075 + seed * 0.02) % 1.8;
        const u = clamp(T, 0, 1);
        const sv = 1 - Math.exp(-4.4 * u) * Math.cos(8.2 * u); // spring overshoot
        const y = baseY + (1 - sv) * -h * 0.3;
        g.globalAlpha = clamp(u * 2.2, 0, 1);
        g.fillStyle = i % 3 === 1 ? CYAN : '#F8FAFC';
        g.save();
        g.translate(x, y);
        const scl = 0.86 + 0.14 * clamp(sv, 0, 1.2);
        g.scale(scl, scl);
        g.fillText(word[i], 0, 0);
        g.restore();
        x += widths[i];
      }
      g.globalAlpha = 1;
      const sweep = ((t * 0.45) % 1.4) / 1.4;
      g.fillStyle = 'rgba(228,230,236,' + (0.35 + 0.5 * k) + ')';
      g.fillRect((w - total) / 2, baseY + size * 0.72, clamp(sweep, 0, 1) * total, 2.5);
    },

    /* Liquid glass panel: drifting orbs, lens refraction, specular sweep */
    glass(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const orbs = [
        { c: 'rgba(228,230,236,0.5)',   r: w * 0.16, x: w * (0.30 + 0.13 * Math.sin(t * 0.5 + seed)), y: h * (0.40 + 0.16 * Math.cos(t * 0.42)) },
        { c: 'rgba(142,142,152,0.42)',   r: w * 0.13, x: w * (0.68 + 0.11 * Math.cos(t * 0.55)),       y: h * (0.55 + 0.14 * Math.sin(t * 0.47 + seed * 0.2)) },
        { c: 'rgba(196,198,206,0.4)', r: w * 0.11, x: w * (0.50 + 0.15 * Math.sin(t * 0.38 + 2)),   y: h * (0.35 + 0.18 * Math.sin(t * 0.52)) }
      ];
      const px = w * 0.2, py = h * 0.2, pw = w * 0.6, ph = h * 0.6;
      function paintOrbs(scale, ox, oy) {
        orbs.forEach(o => {
          const rad = o.r * scale;
          const x = ox + (o.x - ox) * scale, y = oy + (o.y - oy) * scale;
          const grd = g.createRadialGradient(x, y, 1, x, y, rad);
          grd.addColorStop(0, o.c); grd.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
        });
      }
      paintOrbs(1, 0, 0);
      // glass panel
      g.save();
      rr(g, px, py, pw, ph, 16); g.clip();
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(px, py, pw, ph);
      paintOrbs(1.08, px + pw / 2, py + ph / 2); // refraction pull toward centre
      const sweep = ((t * 0.34 + k * 0.2) % 1.4) - 0.2;
      const sx = px + sweep * pw;
      const band = g.createLinearGradient(sx - pw * 0.18, py, sx + pw * 0.18, py + ph);
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.5, 'rgba(255,255,255,' + (0.10 + 0.14 * k) + ')');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = band; g.fillRect(px, py, pw, ph);
      g.restore();
      // chromatic frame
      g.lineWidth = 1.3;
      g.strokeStyle = 'rgba(228,230,236,0.55)'; rr(g, px - 1, py - 1, pw + 2, ph + 2, 17); g.stroke();
      g.strokeStyle = 'rgba(142,142,152,0.4)'; rr(g, px + 1, py + 1, pw - 2, ph - 2, 15); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.22)'; rr(g, px, py, pw, ph, 16); g.stroke();
      // magnifier lens
      const lr = Math.min(w, h) * 0.20;
      const lx = px + pw * 0.28 + Math.sin(t * 0.5) * pw * 0.06, ly = py + ph * 0.45;
      g.save();
      g.beginPath(); g.arc(lx, ly, lr, 0, 7); g.clip();
      g.fillStyle = 'rgba(13,13,15,0.9)'; g.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
      paintOrbs(1.5, lx, ly);
      g.restore();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(228,230,236,' + (0.6 + 0.3 * k) + ')';
      g.shadowColor = 'rgba(228,230,236,0.6)'; g.shadowBlur = 6 + 16 * k;
      g.beginPath(); g.arc(lx, ly, lr, 0, 7); g.stroke();
      g.shadowBlur = 0;
    },

    /* Tool panel tiles with a travelling activation glow */
    suite(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      void seed;
      const n = 6;
      const s0 = Math.min(w / (n * 1.6), h * 0.34);
      const gap = s0 * 0.55;
      const total = n * s0 + (n - 1) * gap;
      const x0 = (w - total) / 2, y0 = h * 0.38;
      const active = Math.floor((t * 1.05) % n);
      const colors = [CYAN, MAG, VIOLET, GREEN, CYAN, MAG];
      for (let i = 0; i < n; i++) {
        const dy = Math.sin(t * 2.1 + i * 0.7) * (1.5 + 6 * k);
        const x = x0 + i * (s0 + gap), y = y0 + dy;
        const isActive = i === active;
        rr(g, x, y, s0, s0, s0 * 0.22);
        g.fillStyle = isActive ? 'rgba(228,230,236,0.10)' : 'rgba(255,255,255,0.05)';
        if (isActive) { g.shadowColor = 'rgba(228,230,236,0.5)'; g.shadowBlur = 10 + 16 * k; }
        g.fill(); g.shadowBlur = 0;
        g.strokeStyle = isActive ? 'rgba(228,230,236,0.7)' : 'rgba(255,255,255,0.10)';
        g.lineWidth = 1; g.stroke();
        const cxx = x + s0 / 2, cyy = y + s0 / 2, r = s0 * 0.24;
        g.strokeStyle = colors[i]; g.lineWidth = 1.6;
        g.globalAlpha = isActive ? 1 : 0.65;
        g.beginPath();
        if (i === 0) g.arc(cxx, cyy, r, 0, 7);
        else if (i === 1) { g.moveTo(cxx, cyy - r); g.lineTo(cxx + r, cyy + r); g.lineTo(cxx - r, cyy + r); g.closePath(); }
        else if (i === 2) g.rect(cxx - r * 0.85, cyy - r * 0.85, r * 1.7, r * 1.7);
        else if (i === 3) { g.moveTo(cxx - r, cyy + r); g.bezierCurveTo(cxx - r, cyy - r, cxx + r, cyy - r, cxx + r, cyy + r); }
        else if (i === 4) { g.moveTo(cxx - r, cyy); for (let q = 0; q <= 8; q++) g.lineTo(cxx - r + (q / 8) * 2 * r, cyy + Math.sin(q * 1.3 + t * 4) * r * 0.6); }
        else { g.moveTo(cxx - r, cyy); g.lineTo(cxx + r, cyy); g.moveTo(cxx, cyy - r); g.lineTo(cxx, cyy + r); }
        g.stroke(); g.globalAlpha = 1;
        if (isActive) { g.fillStyle = 'rgba(228,230,236,0.9)'; g.fillRect(x + s0 * 0.2, y + s0 + 6, s0 * 0.6, 2); }
      }
    },

    /* Waveform bars + playhead */
    audio(g, w, h, t, k, seed) {
      stageBg(g, w, h);
      const n = Math.max(28, Math.floor(w / 10));
      const bw = (w * 0.88) / n;
      const mid = h / 2;
      const grad = g.createLinearGradient(0, mid - h * 0.34, 0, mid + h * 0.34);
      grad.addColorStop(0, CYAN); grad.addColorStop(1, '#43434C');
      const playX = ((t * 0.24) % 1) * w;
      for (let i = 0; i < n; i++) {
        const env = Math.abs(Math.sin(i * 0.4 + t * 2.2 + seed * 0.2)) *
          (0.30 + 0.70 * Math.abs(Math.sin(i * 0.13 - t * 0.9)));
        const bh = (0.08 + env * 0.86) * h * 0.62;
        const x = w * 0.06 + i * bw;
        const near = 1 - clamp(Math.abs(x + bw / 2 - playX) / (w * 0.05), 0, 1);
        g.globalAlpha = clamp(0.5 + 0.5 * near + 0.15 * k, 0, 1);
        g.fillStyle = near > 0.5 ? '#FFFFFF' : grad;
        rr(g, x, mid - bh / 2, Math.max(1.5, bw * 0.55), bh, 1.5); g.fill();
      }
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(playX, h * 0.1); g.lineTo(playX, h * 0.9); g.stroke();
      g.fillStyle = 'rgba(228,230,236,' + (0.5 + 0.4 * k) + ')';
      g.beginPath(); g.arc(playX, h * 0.1, 2.6, 0, 7); g.fill();
    }
  };

  /* ---------- engine core ---------- */
  function sizeCanvas(e) {
    const rect = e.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    e.settled = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    e.dpr = dpr; e.w = rect.width; e.h = rect.height;
    const pw = Math.round(rect.width * dpr), ph = Math.round(rect.height * dpr);
    if (e.canvas.width !== pw || e.canvas.height !== ph) {
      e.canvas.width = pw; e.canvas.height = ph;
    }
    // Paint the static "posed" frame immediately — never wait on rAF for first paint
    render(e);
    start();
  }

  function makeEntry(canvas, type, seed, locked) {
    disposeNode(canvas);
    const e = {
      canvas, ctx: canvas.getContext('2d'), type: RENDERERS[type] ? type : 'grid',
      seed: seed || 7, w: 0, h: 0, dpr: 1,
      t: 0.42, k: 0, target: 0, locked: !!locked, dirty: true, s: {}, ro: null,
      settled: false, retries: 0
    };
    entries.set(canvas, e);
    e.ro = new ResizeObserver(() => sizeCanvas(e));
    e.ro.observe(canvas);
    sizeCanvas(e);
    // Re-measure after the current layout settles — elements can be measured
    // mid-layout (e.g. a modal stage whose aspect-ratio hasn't applied yet)
    setTimeout(() => sizeCanvas(e), 0);
    setTimeout(() => sizeCanvas(e), 160);
    return e;
  }

  function render(e) {
    const g = e.ctx;
    // clear the full backing store at identity scale, then apply DPR transform
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, e.canvas.width, e.canvas.height);
    g.setTransform(e.dpr, 0, 0, e.dpr, 0, 0);
    (RENDERERS[e.type] || RENDERERS.grid)(g, e.w, e.h, e.t, reduceMotion ? 0 : e.k, e.seed, e);
    e.dirty = false;
  }

  function tick(now) {
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    let keep = false;
    entries.forEach(e => {
      // Elements can be measured before their final layout resolves (a modal
      // stage revealed in the same frame). Retry until the box is real.
      if (!e.settled && e.retries < 30) {
        e.retries++;
        sizeCanvas(e);
      }
      const prev = e.k;
      e.k += (e.target - e.k) * clamp(dt * 8, 0, 1);
      if (Math.abs(e.target - e.k) < 0.012) e.k = e.target;
      const animating = e.locked || e.k > 0.01 || prev !== e.k;
      if (animating) {
        keep = true;
        e.t += dt * (0.45 + e.k * 1.9 + (e.locked ? 0.75 : 0));
        render(e);
      }
    });
    // one final pass for canvases that just settled or resized, then park
    entries.forEach(e => { if (e.dirty) render(e); });
    if (keep) rafId = requestAnimationFrame(tick);
    else running = false;
  }

  function start() {
    if (!running) { running = true; last = performance.now(); rafId = requestAnimationFrame(tick); }
  }

  function disposeNode(canvas) {
    const e = entries.get(canvas);
    if (!e) return;
    entries.delete(canvas);
    if (e.ro) e.ro.disconnect();
  }

  /* Drop entries whose canvases left the DOM (called before list re-renders) */
  function gc() {
    entries.forEach((e, canvas) => { if (!canvas.isConnected) disposeNode(canvas); });
  }

  return {
    /* Card preview: static until hovered */
    attach(canvas, type, seed) { makeEntry(canvas, type, seed, false); },
    hover(canvas, on) {
      const e = entries.get(canvas);
      if (!e) return;
      e.target = on ? 1 : 0;
      start();
    },
    /* Pinned preview (detail modal stage): animates while open */
    pin(canvas, type, seed) { makeEntry(canvas, type, seed, true); },
    unpin(canvas) { disposeNode(canvas); },
    gc,
    types: Object.keys(RENDERERS)
  };
})();
