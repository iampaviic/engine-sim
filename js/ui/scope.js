// Lab instruments: engine-cycle pressure trace, spectrum with engine orders,
// cylinder p–V indicator diagram and dyno sheet.

const TAU = Math.PI * 2;
const INK = 'rgba(235,227,208,';

export class Scope {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.mode = 'wave';
    this.traces = [];
    this.pv = [];
    this.cfg = null;
    this.spec = null;
    this.freq = null;
    this.water = null;
    this.dyno = [];
    this.dynoPrev = null;
    this.dynoPrevLabel = '';
    this.rpm = 0;
  }

  setEngine(compiled, spec) {
    this.cfg = compiled;
    this.spec = spec;
    this.traces = [];
    this.pv = [];
  }

  onScope(m) {
    this.traces.unshift(m.sig);
    if (this.traces.length > 7) this.traces.pop();
    this.pv.unshift({ p: m.pr, v: m.vo });
    if (this.pv.length > 5) this.pv.pop();
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(r.width * dpr));
    const h = Math.max(10, Math.round(r.height * dpr));
    if (w !== this.c.width || h !== this.c.height) {
      this.c.width = w;
      this.c.height = h;
      this.water = null;
    }
    this.dpr = dpr;
  }

  draw(analyser, tel) {
    this.resize();
    const g = this.g;
    g.clearRect(0, 0, this.c.width, this.c.height);
    if (tel) this.rpm = tel.rpm;
    if (this.mode === 'wave') this.drawWave();
    else if (this.mode === 'spec') this.drawSpectrum(analyser);
    else if (this.mode === 'pv') this.drawPV();
    else this.drawDyno();
  }

  frame(l, t, r, b) {
    const g = this.g;
    g.strokeStyle = INK + '0.12)';
    g.lineWidth = 1;
    g.strokeRect(l, t, r - l, b - t);
  }

  text(s, x, y, align = 'left', alpha = 0.55, size = 10, weight = 500) {
    const g = this.g;
    g.fillStyle = INK + alpha + ')';
    g.font = `${weight} ${Math.round(size * this.dpr)}px "B612 Mono", ui-monospace, monospace`;
    g.textAlign = align;
    g.fillText(s, x, y);
  }

  // One engine cycle of tail-pipe pressure with the firing sequence marked.
  drawWave() {
    const g = this.g, dpr = this.dpr;
    const W = this.c.width, H = this.c.height;
    const l = 36 * dpr, r = W - 12 * dpr, t = 14 * dpr, b = H - 30 * dpr;
    this.frame(l, t, r, b);
    const cfg = this.cfg;
    if (!cfg) return;
    const cyc = cfg.cycle;
    // firing markers
    const banks = this.spec.banks ?? [this.spec.firingOrder];
    const bankOf = (cyl) => banks.findIndex((bk) => bk.includes(cyl));
    const base = cfg.fireAngles[0];
    g.font = `600 ${Math.round(9 * dpr)}px "B612 Mono", monospace`;
    g.textAlign = 'center';
    for (let c = 0; c < cfg.nCyl; c++) {
      const a = (((cfg.fireAngles[c] - base) % cyc) + cyc) % cyc;
      const x = l + (a / cyc) * (r - l);
      const bi = bankOf(c + 1);
      const col = bi === 1 ? '88,174,224' : '255,181,74';
      g.strokeStyle = `rgba(${col},0.35)`;
      g.setLineDash([2 * dpr, 3 * dpr]);
      g.beginPath();
      g.moveTo(x, t);
      g.lineTo(x, b);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = `rgba(${col},0.9)`;
      g.fillText(String(c + 1), x, b + 12 * dpr);
    }
    this.text(`crank ° →  one full cycle (${cyc}°)  ·  numbers = firing sequence`, l, H - 4 * dpr, 'left', 0.4, 9);
    if (!this.traces.length) {
      this.text('start the engine to see the exhaust pressure trace', (l + r) / 2, (t + b) / 2, 'center', 0.4, 11);
      return;
    }
    let m = 1e-6;
    for (const s of this.traces) for (let i = 0; i < s.length; i++) m = Math.max(m, Math.abs(s[i]));
    this.waveScale = Math.max(m, (this.waveScale ?? m) * 0.97);
    const ys = (v) => (t + b) / 2 - (v / this.waveScale) * (b - t) * 0.46;
    this.traces.forEach((s, k) => {
      g.strokeStyle = k === 0 ? 'rgba(255,181,74,0.95)' : `rgba(255,181,74,${0.28 - k * 0.035})`;
      g.lineWidth = (k === 0 ? 1.8 : 1.2) * dpr;
      if (k === 0) {
        g.shadowColor = 'rgba(255,160,40,0.7)';
        g.shadowBlur = 6 * dpr;
      }
      g.beginPath();
      for (let i = 0; i < s.length; i++) {
        const x = l + (i / (s.length - 1)) * (r - l);
        const y = ys(s[i]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.shadowBlur = 0;
    });
    g.strokeStyle = INK + '0.15)';
    g.beginPath();
    g.moveTo(l, (t + b) / 2);
    g.lineTo(r, (t + b) / 2);
    g.stroke();
    this.text(`${this.waveScale.toFixed(2)} Pa`, l - 4 * dpr, t + 8 * dpr, 'right', 0.4, 8);
  }

  drawSpectrum(analyser) {
    const g = this.g, dpr = this.dpr;
    const W = this.c.width, H = this.c.height;
    const l = 36 * dpr, r = W - 12 * dpr, t = 14 * dpr, b = H - 30 * dpr;
    if (!analyser) {
      this.frame(l, t, r, b);
      this.text('start the engine to see the spectrum', (l + r) / 2, (t + b) / 2, 'center', 0.4, 11);
      return;
    }
    const n = analyser.frequencyBinCount;
    if (!this.freq || this.freq.length !== n) this.freq = new Float32Array(n);
    analyser.getFloatFrequencyData(this.freq);
    const fs = analyser.context.sampleRate;
    const f0 = 25, f1 = Math.min(14000, fs / 2);
    const xOf = (f) => l + (Math.log(f / f0) / Math.log(f1 / f0)) * (r - l);
    const lo = -105, hi = -20;
    const yOf = (db) => b - ((Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * (b - t);
    // waterfall behind (scrolling up)
    const ww = Math.round(r - l), wh = Math.round(b - t);
    if (!this.water || this.water.width !== ww || this.water.height !== wh) {
      this.water = document.createElement('canvas');
      this.water.width = ww;
      this.water.height = wh;
      this.wctx = this.water.getContext('2d');
      this.row = this.wctx.createImageData(ww, 1);
    }
    const wc = this.wctx;
    wc.drawImage(this.water, 0, -1);
    const row = this.row.data;
    for (let x = 0; x < ww; x++) {
      const f = f0 * Math.pow(f1 / f0, x / ww);
      const bin = Math.min(n - 1, Math.round((f / (fs / 2)) * n));
      const v = Math.max(0, Math.min(1, (this.freq[bin] - lo) / (hi - lo)));
      const c = heat(v * v);
      row[x * 4] = c[0];
      row[x * 4 + 1] = c[1];
      row[x * 4 + 2] = c[2];
      row[x * 4 + 3] = 255;
    }
    wc.putImageData(this.row, 0, wh - 1);
    g.globalAlpha = 0.55;
    g.drawImage(this.water, l, t);
    g.globalAlpha = 1;
    this.frame(l, t, r, b);
    // engine order markers
    const cfg = this.cfg;
    const rpm = this.rpm;
    if (cfg && rpm > 200) {
      const cycleRevs = cfg.cycle / 360;
      const fireOrder = cfg.nCyl / cycleRevs; // firing events per crank rev
      const o1 = rpm / 60;
      g.font = `600 ${Math.round(9 * dpr)}px "B612 Mono", monospace`;
      g.textAlign = 'center';
      for (let k = 1; k <= 60; k++) {
        const ord = k * 0.5;
        const f = o1 * ord;
        if (f < f0 || f > f1) continue;
        const isFire = Math.abs(ord / fireOrder - Math.round(ord / fireOrder)) < 1e-6;
        const x = xOf(f);
        g.strokeStyle = isFire ? 'rgba(255,95,31,0.55)' : ord % 1 === 0 ? INK + '0.12)' : INK + '0.06)';
        g.lineWidth = (isFire ? 1.5 : 1) * dpr;
        g.beginPath();
        g.moveTo(x, t);
        g.lineTo(x, b);
        g.stroke();
        if (isFire && ord / fireOrder <= 4) {
          g.fillStyle = 'rgba(255,95,31,0.9)';
          g.fillText(`${ord % 1 ? ord.toFixed(1) : ord}×`, x, t + 10 * dpr);
        }
      }
    }
    // live curve
    g.strokeStyle = 'rgba(255,181,74,0.95)';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    let first = true;
    for (let x = 0; x <= r - l; x += 2) {
      const f = f0 * Math.pow(f1 / f0, x / (r - l));
      const bin = Math.min(n - 1, Math.round((f / (fs / 2)) * n));
      const y = yOf(this.freq[bin]);
      if (first) {
        g.moveTo(l + x, y);
        first = false;
      } else g.lineTo(l + x, y);
    }
    g.stroke();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (f < f0 || f > f1) continue;
      this.text(f >= 1000 ? `${f / 1000}k` : String(f), xOf(f), b + 12 * dpr, 'center', 0.4, 8);
    }
    this.text('Hz  ·  orange lines = firing-frequency harmonics', l, H - 4 * dpr, 'left', 0.4, 9);
  }

  drawPV() {
    const g = this.g, dpr = this.dpr;
    const W = this.c.width, H = this.c.height;
    const l = 44 * dpr, r = W - 14 * dpr, t = 14 * dpr, b = H - 30 * dpr;
    this.frame(l, t, r, b);
    const cfg = this.cfg;
    if (!cfg) return;
    const vMin = cfg.vc * 0.9, vMax = (cfg.vc + cfg.vd) * 1.05;
    const pMin = 0.08, pMax = 160;
    const xOf = (v) => l + (Math.log(v / vMin) / Math.log(vMax / vMin)) * (r - l);
    const yOf = (p) => b - (Math.log(Math.max(pMin, p) / pMin) / Math.log(pMax / pMin)) * (b - t);
    for (const p of [0.1, 1, 10, 100]) {
      const y = yOf(p);
      g.strokeStyle = INK + '0.08)';
      g.beginPath();
      g.moveTo(l, y);
      g.lineTo(r, y);
      g.stroke();
      this.text(`${p} bar`, l - 4 * dpr, y + 3 * dpr, 'right', 0.4, 8);
    }
    g.strokeStyle = INK + '0.25)';
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath();
    g.moveTo(l, yOf(1.013));
    g.lineTo(r, yOf(1.013));
    g.stroke();
    g.setLineDash([]);
    if (!this.pv.length) {
      this.text('start the engine to see the cylinder 1 indicator diagram', (l + r) / 2, (t + b) / 2, 'center', 0.4, 11);
      return;
    }
    this.pv.forEach((d, k) => {
      g.strokeStyle = k === 0 ? 'rgba(255,181,74,0.95)' : `rgba(255,181,74,${0.25 - k * 0.04})`;
      g.lineWidth = (k === 0 ? 1.8 : 1) * dpr;
      if (k === 0) {
        g.shadowColor = 'rgba(255,160,40,0.7)';
        g.shadowBlur = 6 * dpr;
      }
      g.beginPath();
      for (let i = 0; i < d.p.length; i++) {
        const x = xOf(d.v[i]);
        const y = yOf(d.p[i] / 1e5);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
      g.shadowBlur = 0;
    });
    let pk = 0;
    for (const v of this.pv[0].p) pk = Math.max(pk, v);
    this.text(`peak ${(pk / 1e5).toFixed(1)} bar`, r - 6 * dpr, t + 14 * dpr, 'right', 0.7, 10, 600);
    this.text('log volume →   cylinder 1   ·   dashed = atmosphere', l, H - 4 * dpr, 'left', 0.4, 9);
  }

  drawDyno() {
    const g = this.g, dpr = this.dpr;
    const W = this.c.width, H = this.c.height;
    const l = 42 * dpr, r = W - 44 * dpr, t = 18 * dpr, b = H - 30 * dpr;
    this.frame(l, t, r, b);
    const pts = this.dyno;
    const all = [...pts, ...(this.dynoPrev ?? [])];
    const rpmMax = Math.max(this.cfg ? this.cfg.ecu.limit * 1.05 : 8000, ...all.map((p) => p.rpm));
    const tqMax = Math.max(100, ...all.map((p) => p.tq)) * 1.15;
    const hpMax = Math.max(100, ...all.map((p) => (p.tq * p.rpm) / 7121)) * 1.15;
    const xOf = (rpm) => l + (rpm / rpmMax) * (r - l);
    // grid
    const step = rpmMax > 12000 ? 2000 : 1000;
    for (let x = step; x < rpmMax; x += step) {
      g.strokeStyle = INK + '0.07)';
      g.beginPath();
      g.moveTo(xOf(x), t);
      g.lineTo(xOf(x), b);
      g.stroke();
      this.text(String(x / 1000), xOf(x), b + 12 * dpr, 'center', 0.4, 8);
    }
    const curve = (arr, fn, max, col, width, dash) => {
      if (arr.length < 2) return;
      g.strokeStyle = col;
      g.lineWidth = width * dpr;
      g.setLineDash(dash ? [4 * dpr, 4 * dpr] : []);
      g.beginPath();
      arr.forEach((p, i) => {
        const x = xOf(p.rpm);
        const y = b - (fn(p) / max) * (b - t);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
      g.setLineDash([]);
    };
    const tqF = (p) => p.tq;
    const hpF = (p) => (p.tq * p.rpm) / 7121;
    if (this.dynoPrev) {
      curve(this.dynoPrev, tqF, tqMax, 'rgba(255,181,74,0.3)', 1.2, true);
      curve(this.dynoPrev, hpF, hpMax, 'rgba(255,95,31,0.3)', 1.2, true);
    }
    curve(pts, tqF, tqMax, 'rgba(255,181,74,0.95)', 2, false);
    curve(pts, hpF, hpMax, 'rgba(255,95,31,0.95)', 2, false);
    this.text('Nm', l - 6 * dpr, b + 12 * dpr, 'right', 0.6, 9, 600);
    this.text('hp', r + 6 * dpr, b + 12 * dpr, 'left', 0.6, 9, 600);
    for (let i = 1; i <= 4; i++) {
      const y = b - (i / 4) * (b - t);
      this.text(String(Math.round((tqMax * i) / 4)), l - 6 * dpr, y + 3 * dpr, 'right', 0.35, 8);
      this.text(String(Math.round((hpMax * i) / 4)), r + 6 * dpr, y + 3 * dpr, 'left', 0.35, 8);
    }
    if (pts.length > 2) {
      let pt = pts[0], ph = pts[0];
      for (const p of pts) {
        if (p.tq > pt.tq) pt = p;
        if (hpF(p) > hpF(ph)) ph = p;
      }
      this.text(`${Math.round(pt.tq)} Nm @ ${Math.round(pt.rpm / 100) * 100}`, l + 8 * dpr, t + 14 * dpr, 'left', 0.9, 11, 700);
      this.text(`${Math.round(hpF(ph))} hp @ ${Math.round(ph.rpm / 100) * 100}`, l + 8 * dpr, t + 30 * dpr, 'left', 0.9, 11, 700);
    } else {
      this.text('press RUN DYNO: full-throttle sweep on an absorber dyno', (l + r) / 2, (t + b) / 2, 'center', 0.45, 11);
    }
    if (this.dynoPrev) this.text(`dashed: ${this.dynoPrevLabel}`, r - 4 * dpr, t + 14 * dpr, 'right', 0.4, 9);
    this.text('rpm × 1000', l, H - 4 * dpr, 'left', 0.4, 9);
  }
}

function heat(v) {
  // black -> deep red -> orange -> ivory
  const r = Math.min(255, v * 3 * 255);
  const g = Math.min(255, Math.max(0, (v - 0.33) * 2.2 * 255));
  const b = Math.min(235, Math.max(0, (v - 0.7) * 3.2 * 255));
  return [r * 0.95 + 16, g * 0.85 + 14, b * 0.8 + 12];
}
