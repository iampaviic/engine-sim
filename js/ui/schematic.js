// Engine + exhaust schematic. Pipes are coloured by the instantaneous acoustic
// pressure along them (sampled from the waveguides in the worklet), captured
// stroboscopically so the pulses crawl through the pipes in slow motion.

const TAU = Math.PI * 2;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// diverging map: rarefaction blue <- dark -> compression orange/white
function pressureColor(v, alpha = 1) {
  const a = Math.min(1, Math.abs(v));
  let r, g, b;
  if (v >= 0) {
    if (a < 0.6) {
      const t = a / 0.6;
      r = lerp(52, 255, t);
      g = lerp(47, 96, t);
      b = lerp(42, 31, t);
    } else {
      const t = (a - 0.6) / 0.4;
      r = 255;
      g = lerp(96, 236, t);
      b = lerp(31, 190, t);
    }
  } else {
    const t = Math.min(1, a / 0.7);
    r = lerp(52, 88, t);
    g = lerp(47, 174, t);
    b = lerp(42, 224, t);
  }
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}

export class Schematic {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.net = null;
    this.cfg = null;
    this.snap = null;
    this.scale = 20000;
    this.rings = [];
    this.flames = [];
    this.puffs = []; // nitrous purge cloud
    this.purging = false;
    this.turboRpm = 0;
    this.virtCrank = 0;
    this.virtRate = 0;
    this.lastSnapT = 0;
    this.egt = 500;
    this.valve = 0;
  }

  setEngine(compiled, spec) {
    this.cfg = compiled;
    this.spec = spec;
    this.net = compiled.exNet;
    this.lay = compiled.exNet.layout;
    this.snap = null;
    this.prepare();
  }

  prepare() {
    // cumulative lengths of each segment polyline for sample placement
    this.segGeom = this.net.segs.map((s) => {
      const pts = s.pts ?? [
        [this.net.nodes[s.a].x, this.net.nodes[s.a].y],
        [this.net.nodes[s.b].x, this.net.nodes[s.b].y],
      ];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { pts, cum, total: cum[cum.length - 1] || 1e-6 };
    });
  }

  pointAt(k, f) {
    const { pts, cum, total } = this.segGeom[k];
    const d = f * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
  }

  onSnap(data, t) {
    const prev = this.snap;
    this.snap = data;
    const crank = data[0];
    if (prev) {
      const dtc = Math.max(1e-3, t - this.lastSnapT);
      let d = crank - prev[0];
      const cyc = this.cfg.cycle;
      if (d < 0) d += cyc;
      if (d > cyc / 2) d = 0;
      this.virtRate = lerp(this.virtRate, d / dtc, 0.3);
    }
    this.virtCrank = crank;
    this.lastSnapT = t;
    this.egt = data[2];
    this.valve = data[5];
    // auto-scale pressure colours on a robust (90th percentile) level
    const n = this.cfg.nCyl;
    const vals = [];
    for (let i = 8 + n * 4; i < data.length; i++) vals.push(Math.abs(data[i]));
    vals.sort((a, b) => a - b);
    const m = vals.length ? vals[Math.floor(vals.length * 0.9)] : 0;
    this.scale = Math.max(1500, lerp(this.scale, m * 1.1, m > this.scale ? 0.25 : 0.04));
  }

  // false while the panel is hidden (phones show one lab panel at a time)
  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(r.width * dpr));
    const h = Math.max(10, Math.round(r.height * dpr));
    if (w !== this.c.width || h !== this.c.height) {
      this.c.width = w;
      this.c.height = h;
    }
    this.dpr = dpr;
  }

  map(x, y) {
    const W = this.c.width, H = this.c.height;
    const px = W * 0.04, py = H * 0.09;
    return [px + x * (W - 2 * px), py + y * (H - 2 * py)];
  }

  draw(now, tel) {
    if (this.resize() === false) {
      this.pendingFlame = 0;
      return;
    }
    const g = this.g;
    const W = this.c.width, H = this.c.height;
    g.clearRect(0, 0, W, H);
    if (!this.net) return;
    const dpr = this.dpr;
    const snap = this.snap;
    const n = this.cfg.nCyl;
    const segOff = 8 + n * 4;
    const P = 10;

    // blueprint grid
    g.strokeStyle = 'rgba(235,227,208,0.045)';
    g.lineWidth = 1;
    const step = 24 * dpr;
    g.beginPath();
    for (let x = (W % step) / 2; x < W; x += step) {
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    for (let y = (H % step) / 2; y < H; y += step) {
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();

    const pipeScale = Math.min(W, H * 1.6) * 0.17;
    const egtGlow = Math.max(0, Math.min(1, (this.egt - 650) / 500));

    // silencer / cat boxes
    for (const b of this.net.boxes ?? []) {
      const [x0, y0] = this.map(b.x0, b.y - 0.07);
      const [x1, y1] = this.map(b.x1, b.y + 0.07);
      g.fillStyle = 'rgba(36,33,29,0.9)';
      g.strokeStyle = 'rgba(235,227,208,0.18)';
      g.lineWidth = 1 * dpr;
      roundRect(g, x0, y0, x1 - x0, y1 - y0, 6 * dpr);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(235,227,208,0.42)';
      g.font = `600 ${Math.round(9 * dpr)}px "Barlow Semi Condensed", sans-serif`;
      g.textAlign = 'center';
      const label = b.kind === 'cat' ? 'CAT' : b.kind === 'valved' ? (this.valve > 0.5 ? 'VALVE OPEN' : 'VALVE SHUT') : b.kind.toUpperCase();
      g.fillText(label, (x0 + x1) / 2, y0 - 4 * dpr);
    }

    // pipes: steel base, then pressure overlay
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // a two-stroke's expansion chamber is the whole show: draw it fatter
    const fat = this.cfg.kind === 'twostroke' ? 2.2 : 1;
    this.net.segs.forEach((s, k) => {
      const geo = this.segGeom[k];
      const w = Math.max(1.5 * dpr, Math.min(16 * fat * dpr, s.dia * pipeScale * fat));
      const glow = s.label === 'primary' ? egtGlow : s.label === 'secondary' ? egtGlow * 0.7 : 0;
      g.strokeStyle = glow > 0.05 ? `rgb(${60 + 90 * glow | 0},${40 + 10 * glow | 0},${34})` : '#3b3631';
      g.lineWidth = w + 2 * dpr;
      g.beginPath();
      geo.pts.forEach(([x, y], i) => {
        const [X, Y] = this.map(x, y);
        if (i === 0) g.moveTo(X, Y);
        else g.lineTo(X, Y);
      });
      g.stroke();
      if (!snap) return;
      const base = segOff + k * P;
      for (let i = 0; i < P; i++) {
        const v = snap[base + i] / this.scale;
        const f0 = i / P, f1 = (i + 1) / P;
        const [xa, ya] = this.pointAt(k, f0);
        const [xb, yb] = this.pointAt(k, f1);
        const [Xa, Ya] = this.map(xa, ya);
        const [Xb, Yb] = this.map(xb, yb);
        g.strokeStyle = pressureColor(v, 0.25 + 0.75 * Math.min(1, Math.abs(v) * 1.4));
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(Xa, Ya);
        g.lineTo(Xb, Yb);
        g.stroke();
      }
    });

    // turbos (a sequential second stage spins on its own)
    const turbos = this.net.nodes.filter((nd) => nd.turbo != null && nd.type === 0);
    const half = tel?.turbo2 != null ? turbos.length / 2 : Infinity;
    this.turboAngles ??= [];
    for (const [i, nd] of turbos.entries()) {
      const [X, Y] = this.map(nd.x, nd.y);
      const r = 13 * dpr;
      const rpm = nd.turbo >= half ? tel.turbo2 : tel?.turbo ?? 0;
      const ang = (this.turboAngles[i] = ((this.turboAngles[i] ?? 0) + rpm * 0.0000012 * turbos.length) % TAU);
      g.fillStyle = '#2b2723';
      g.strokeStyle = '#8a8174';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.arc(X, Y, r, 0, TAU);
      g.fill();
      g.stroke();
      g.strokeStyle = '#d8cdb5';
      for (let k = 0; k < 7; k++) {
        const a = ang + (k * TAU) / 7;
        g.beginPath();
        g.moveTo(X + Math.cos(a) * r * 0.2, Y + Math.sin(a) * r * 0.2);
        g.quadraticCurveTo(X + Math.cos(a + 0.5) * r * 0.6, Y + Math.sin(a + 0.5) * r * 0.6, X + Math.cos(a + 0.9) * r * 0.85, Y + Math.sin(a + 0.9) * r * 0.85);
        g.stroke();
      }
    }

    // tail pipe exits: sound rings + flames
    const tails = this.net.nodes.filter((nd) => nd.type === 2);
    const spl = tel?.spl ?? 0;
    const dirA = (t) => (t.dir === 'up' ? -Math.PI / 2 : t.dir === 'down' ? Math.PI / 2 : 0);
    if (tails.length && Math.random() < 0.5) {
      for (const t of tails) this.rings.push({ x: t.x, y: t.y, r: 0, a: Math.min(1, spl / 8), d: dirA(t) });
    }
    if (this.pendingFlame > 0) {
      for (const t of tails) if (t.ch !== 6) this.flames.push({ x: t.x, y: t.y, life: 1, size: this.pendingFlame, d: dirA(t) });
      this.pendingFlame = 0;
    }
    g.lineWidth = 1.5 * dpr;
    this.rings = this.rings.filter((ring) => {
      ring.r += 2.2 * dpr;
      const [X, Y] = this.map(ring.x, ring.y);
      const al = ring.a * (1 - ring.r / (60 * dpr));
      if (al <= 0.01) return false;
      g.strokeStyle = `rgba(235,227,208,${al * 0.5})`;
      g.beginPath();
      g.arc(X, Y, ring.r, ring.d - 0.9, ring.d + 0.9);
      g.stroke();
      return true;
    });
    this.flames = this.flames.filter((f) => {
      f.life -= 0.09;
      if (f.life <= 0) return false;
      const [X, Y] = this.map(f.x, f.y);
      const len = (8 + 26 * f.size) * dpr * (0.6 + 0.4 * f.life);
      const cx = Math.cos(f.d), sy = Math.sin(f.d);
      const grd = g.createRadialGradient(X, Y, 0, X + len * 0.4 * cx, Y + len * 0.4 * sy, len);
      grd.addColorStop(0, `rgba(255,245,210,${f.life})`);
      grd.addColorStop(0.35, `rgba(255,140,40,${0.8 * f.life})`);
      grd.addColorStop(1, 'rgba(255,60,20,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(X + len * 0.45 * cx, Y + len * 0.45 * sy, len * 0.55, len * 0.22 * (0.7 + Math.random() * 0.5), f.d, 0, TAU);
      g.fill();
      return true;
    });
    for (const t of tails) {
      const [X, Y] = this.map(t.x, t.y);
      g.fillStyle = '#1a1816';
      g.strokeStyle = '#9b9180';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.ellipse(X, Y, 3 * dpr, 6 * dpr, dirA(t), 0, TAU);
      g.fill();
      g.stroke();
    }

    // cylinders
    this.drawCylinders(now);
    this.drawPurge();

    // legend
    g.font = `500 ${Math.round(10 * dpr)}px "B612 Mono", ui-monospace, monospace`;
    g.textAlign = 'left';
    g.fillStyle = 'rgba(235,227,208,0.55)';
    const kpa = (this.scale / 1000).toFixed(0);
    const lx = W * 0.62, ly = H - 12 * dpr;
    const lw = W * 0.22;
    for (let i = 0; i < 40; i++) {
      g.fillStyle = pressureColor((i / 39) * 2 - 1);
      g.fillRect(lx + (i / 40) * lw, ly - 6 * dpr, lw / 40 + 1, 5 * dpr);
    }
    g.fillStyle = 'rgba(235,227,208,0.55)';
    g.fillText(`−${kpa}`, lx - 30 * dpr, ly);
    g.fillText(`+${kpa} kPa`, lx + lw + 6 * dpr, ly);
  }

  drawCylinders(now) {
    const g = this.g;
    const dpr = this.dpr;
    const snap = this.snap;
    const cfg = this.cfg;
    const lay = this.lay;
    const n = cfg.nCyl;
    const W = this.c.width, H = this.c.height;
    // extrapolate crank between strobe captures
    let crank = this.virtCrank;
    if (snap) crank += this.virtRate * Math.min(0.25, now - this.lastSnapT);
    const rotary = cfg.kind === 'rotary';
    if (rotary) {
      this.drawRotors(crank);
      return;
    }
    const pitchPx = (lay.pitch ?? 0.06) * (W - W * 0.08);
    const cw = Math.min(pitchPx * 0.78, 46 * dpr);
    const ch = Math.min(H * 0.2, cw * 1.6);
    g.font = `600 ${Math.round(9 * dpr)}px "B612 Mono", monospace`;
    g.textAlign = 'center';
    for (let c = 0; c < n; c++) {
      const p = lay.pos[c];
      if (!p) continue;
      const [X, Yc] = this.map(p.x, p.y);
      const up = p.up; // head faces down (toward exhaust) for top bank
      const x0 = X - cw / 2;
      const y0 = Yc - ch / 2;
      const ca = (((crank + cfg.cylOffset[c]) % cfg.cycle) + cfg.cycle) % cfg.cycle;
      const th = (ca * Math.PI) / 180;
      const travel = (1 - Math.cos(th)) / 2; // 0 at TDC
      const bar = snap ? snap[8 + c * 4] : 1;
      const exL = snap ? snap[8 + c * 4 + 1] : 0;
      const inL = snap ? snap[8 + c * 4 + 2] : 0;
      const burn = snap ? snap[8 + c * 4 + 3] : 0;
      // bore
      g.fillStyle = '#1b1916';
      g.strokeStyle = 'rgba(235,227,208,0.35)';
      g.lineWidth = 1.2 * dpr;
      roundRect(g, x0, y0, cw, ch, 4 * dpr);
      g.fill();
      g.stroke();
      // The head faces the exhaust side: bottom of the bore for the top bank,
      // top of the bore for the bottom bank. Piston surface moves away from
      // the head as the crank turns from TDC to BDC.
      const pistonH = ch * 0.18;
      const surf = up ? y0 + ch * (0.86 - 0.6 * travel) : y0 + ch * (0.14 + 0.6 * travel);
      const gas0 = up ? surf : y0;
      const gas1 = up ? y0 + ch : surf;
      const heat = Math.min(1, Math.log10(Math.max(1, bar)) / 1.8);
      g.fillStyle =
        burn > 0
          ? `rgba(255,${(150 + 90 * (1 - Math.min(1, burn))) | 0},${(60 + 80 * (1 - Math.min(1, burn))) | 0},0.9)`
          : `rgba(${(60 + 190 * heat) | 0},${(50 + 60 * heat) | 0},${(45 + 10 * heat) | 0},0.9)`;
      g.fillRect(x0 + 2 * dpr, gas0, cw - 4 * dpr, Math.max(0, gas1 - gas0));
      // piston
      g.fillStyle = '#a79e8f';
      roundRect(g, x0 + 2 * dpr, up ? surf - pistonH : surf, cw - 4 * dpr, pistonH, 2 * dpr);
      g.fill();
      // valves: intake (cold) and exhaust (hot) lift bars at the head
      const vh = 7 * dpr;
      const vIn = vh * Math.max(0.12, inL), vEx = vh * Math.max(0.12, exL);
      const vy = up ? y0 + ch + 2 * dpr : y0 - 2 * dpr;
      g.fillStyle = `rgba(88,174,224,${0.25 + 0.75 * inL})`;
      g.fillRect(x0 + cw * 0.1, up ? vy : vy - vIn, cw * 0.32, vIn);
      g.fillStyle = `rgba(255,95,31,${0.25 + 0.75 * exL})`;
      g.fillRect(x0 + cw * 0.58, up ? vy : vy - vEx, cw * 0.32, vEx);
      // number
      g.fillStyle = 'rgba(235,227,208,0.6)';
      g.fillText(String(c + 1), X, up ? y0 - 5 * dpr : y0 + ch + 12 * dpr);
    }
  }

  drawRotors(crank) {
    const g = this.g;
    const dpr = this.dpr;
    const snap = this.snap;
    const nr = Math.round(this.cfg.nCyl / 3);
    const pitch = Math.min(0.14, 0.3 / Math.max(1, nr - 1));
    for (let r = 0; r < nr; r++) {
      const [X, Y] = this.map(0.12 + r * pitch, 0.14);
      const R = Math.min(this.c.height * 0.12, (nr > 2 ? 26 : 34) * dpr);
      // housing (epitrochoid-ish)
      g.strokeStyle = 'rgba(235,227,208,0.4)';
      g.fillStyle = '#1b1916';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * TAU;
        const rr = R * (1 + 0.14 * Math.cos(2 * a));
        const x = X + Math.cos(a) * rr * 1.1;
        const y = Y + Math.sin(a) * rr * 0.8;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.fill();
      g.stroke();
      // rotor: turns at 1/3 shaft speed, orbiting eccentrically
      const shaft = ((crank + (r * 360) / nr) * Math.PI) / 180;
      const rot = shaft / 3;
      const ex = X + Math.cos(shaft) * R * 0.12;
      const ey = Y + Math.sin(shaft) * R * 0.12;
      let heat = 0;
      if (snap) for (let k = 0; k < 3; k++) heat = Math.max(heat, snap[8 + (r * 3 + k) * 4 + 3] > 0 ? 1 : 0);
      g.fillStyle = heat ? '#ff8a3a' : '#a79e8f';
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const a0 = rot + (i * TAU) / 3;
        const a1 = rot + ((i + 1) * TAU) / 3;
        const x0 = ex + Math.cos(a0) * R * 0.78, y0 = ey + Math.sin(a0) * R * 0.62;
        const x1 = ex + Math.cos(a1) * R * 0.78, y1 = ey + Math.sin(a1) * R * 0.62;
        const am = (a0 + a1) / 2;
        const cx = ex + Math.cos(am) * R * 0.55, cy = ey + Math.sin(am) * R * 0.44;
        if (i === 0) g.moveTo(x0, y0);
        g.quadraticCurveTo(cx, cy, x1, y1);
      }
      g.closePath();
      g.fill();
    }
  }

  flame(intensity) {
    this.pendingFlame = Math.max(this.pendingFlame || 0, Math.min(1.2, intensity));
  }

  purge(on) {
    this.purging = on;
  }

  // Nitrous purge: a white plume blown up out of the engine bay
  drawPurge() {
    if (this.purging) {
      for (let k = 0; k < 2; k++) this.puffs.push({ x: 0.01, y: 0.02, vx: 0.006 + Math.random() * 0.012, vy: -0.001 + Math.random() * 0.004, r: 0.006, life: 1 });
    }
    if (!this.puffs.length) return;
    const g = this.g;
    const W = this.c.width;
    this.puffs = this.puffs.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.r += 0.004;
      p.life -= 0.025;
      if (p.life <= 0) return false;
      const [X, Y] = this.map(p.x, p.y);
      const R = p.r * W;
      const grd = g.createRadialGradient(X, Y, 0, X, Y, R);
      grd.addColorStop(0, `rgba(245,248,252,${0.16 * p.life})`);
      grd.addColorStop(1, 'rgba(245,248,252,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(X, Y, R, 0, Math.PI * 2);
      g.fill();
      return true;
    });
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
