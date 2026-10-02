// Classic ivory-faced tachometer with a spring-damped needle, redline band,
// shift lights and a gear/speed read-out.

const START = (135 * Math.PI) / 180; // lower-left
const SWEEP = (270 * Math.PI) / 180;

export class Tach {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.max = 10000;
    this.limit = 8000;
    this.idle = 900;
    this.pos = 0;
    this.vel = 0;
    this.target = 0;
    this.face = null;
    this.size = 0;
    this.gear = 'N';
    this.speed = 0;
    this.unit = 'km/h';
    this.lim = false;
    this.camHi = false;
    this.knock = 0;
    this.float = 0;
    this.camSwitch = 0;
    this.label = '';
    this.blink = 0;
    this.running = false;
    this.fonts = false;
  }

  configure({ limit, idle, label, camSwitch }) {
    this.limit = limit;
    this.idle = idle;
    this.label = label ?? '';
    this.camSwitch = camSwitch ?? 0;
    const step = limit > 12000 ? 2000 : 1000;
    this.step = step;
    this.max = Math.ceil((limit + step * 0.6) / step) * step;
    this.face = null;
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(10, Math.round(r.width * dpr));
    const h = Math.max(10, Math.round(r.height * dpr));
    if (w !== this.c.width || h !== this.c.height) {
      this.c.width = w;
      this.c.height = h;
      this.face = null;
    }
  }

  angleFor(rpm) {
    return START + (Math.min(Math.max(rpm, 0), this.max * 1.02) / this.max) * SWEEP;
  }

  geometry() {
    const W = this.c.width, H = this.c.height;
    const R = Math.min(W / 2, H / 2.08) * 0.94;
    const cx = W / 2;
    const cy = H / 2 + R * 0.04;
    return { W, H, R, cx, cy };
  }

  drawFace() {
    const { W, H, R, cx, cy } = this.geometry();
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const g = off.getContext('2d');
    // bezel
    let grd = g.createRadialGradient(cx, cy - R * 0.2, R * 0.2, cx, cy, R * 1.05);
    grd.addColorStop(0, '#3a3530');
    grd.addColorStop(0.85, '#1c1a17');
    grd.addColorStop(1, '#0b0a09');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    // chrome lip
    g.lineWidth = R * 0.018;
    grd = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    grd.addColorStop(0, '#8d857a');
    grd.addColorStop(0.45, '#2b2824');
    grd.addColorStop(0.55, '#4a453f');
    grd.addColorStop(1, '#11100e');
    g.strokeStyle = grd;
    g.beginPath();
    g.arc(cx, cy, R * 0.905, 0, Math.PI * 2);
    g.stroke();
    // ivory face
    const fr = R * 0.89;
    grd = g.createRadialGradient(cx - fr * 0.25, cy - fr * 0.35, fr * 0.1, cx, cy, fr);
    grd.addColorStop(0, '#f3ecdc');
    grd.addColorStop(0.7, '#e7ddc6');
    grd.addColorStop(1, '#cfc2a6');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, fr, 0, Math.PI * 2);
    g.fill();

    // warning + red bands
    const band = (from, to, color, w) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      g.arc(cx, cy, fr * 0.905, this.angleFor(from), this.angleFor(to));
      g.stroke();
    };
    band(this.limit - this.step * 0.8, this.limit, '#e9a23b', fr * 0.05);
    band(this.limit, this.max, '#d62f27', fr * 0.07);
    if (this.camSwitch) {
      const a = this.angleFor(this.camSwitch);
      g.strokeStyle = '#1f6fb2';
      g.lineWidth = fr * 0.012;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * fr * 0.86, cy + Math.sin(a) * fr * 0.86);
      g.lineTo(cx + Math.cos(a) * fr * 0.95, cy + Math.sin(a) * fr * 0.95);
      g.stroke();
    }

    // ticks
    const minor = this.step / 4;
    g.strokeStyle = '#17140f';
    for (let r = 0; r <= this.max + 1; r += minor) {
      const a = this.angleFor(r);
      const major = Math.abs(r % this.step) < 1;
      const half = Math.abs(r % (this.step / 2)) < 1;
      const r0 = major ? fr * 0.78 : half ? fr * 0.83 : fr * 0.86;
      g.lineWidth = major ? fr * 0.018 : fr * 0.008;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * fr * 0.95, cy + Math.sin(a) * fr * 0.95);
      g.stroke();
    }
    // numerals
    g.fillStyle = '#17140f';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `600 ${Math.round(fr * 0.14)}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
    for (let r = 0; r <= this.max + 1; r += this.step) {
      const a = this.angleFor(r);
      const rr = fr * 0.64;
      g.fillText(String(r / 1000), cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.font = `500 ${Math.round(fr * 0.055)}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
    g.fillStyle = '#5b5346';
    g.fillText('RPM × 1000', cx, cy - fr * 0.36);
    g.font = `italic 600 ${Math.round(fr * 0.05)}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
    g.fillStyle = '#8a7f6c';
    g.fillText(this.label, cx, cy + fr * 0.74);
    this.face = off;
  }

  update(dt) {
    // second-order needle: quick with a hint of overshoot
    const k = 900, c = 48;
    const acc = k * (this.target - this.pos) - c * this.vel;
    this.vel += acc * dt;
    this.pos += this.vel * dt;
    this.blink += dt;
  }

  draw() {
    this.resize();
    if (!this.face) this.drawFace();
    const g = this.ctx;
    const { W, H, R, cx, cy } = this.geometry();
    g.clearRect(0, 0, W, H);
    g.drawImage(this.face, 0, 0);
    const fr = R * 0.89;

    // shift lights across the top of the bezel
    const n = 11;
    const frac = (this.pos - (this.limit - this.step * 2.2)) / (this.step * 2.2);
    const lit = Math.floor(Math.max(0, Math.min(1, frac)) * n + 0.0001);
    const flash = this.lim || frac > 0.985;
    const on = flash ? Math.floor(this.blink * 14) % 2 === 0 : true;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.085;
      const x = cx + Math.cos(a) * R * 0.955;
      const y = cy + Math.sin(a) * R * 0.955;
      let col = i < 4 ? '#62d27a' : i < 8 ? '#f1b53c' : '#ef3b2f';
      if (flash) col = '#5aa9ff';
      const active = flash ? on : i < lit;
      g.beginPath();
      g.arc(x, y, R * 0.022, 0, Math.PI * 2);
      g.fillStyle = active ? col : '#2a2622';
      if (active) {
        g.shadowColor = col;
        g.shadowBlur = R * 0.05;
      }
      g.fill();
      g.shadowBlur = 0;
    }

    // gear + speed
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#17140f';
    g.font = `800 ${Math.round(fr * 0.34)}px "Big Shoulders Display", "Arial Narrow", sans-serif`;
    g.fillText(this.gear, cx, cy + fr * 0.33);
    g.font = `500 ${Math.round(fr * 0.075)}px "B612 Mono", ui-monospace, monospace`;
    g.fillStyle = '#3d372e';
    g.fillText(this.speedText ?? '', cx, cy + fr * 0.56);
    // warning lamp: valve float beats knock beats the cam badge
    const warn = this.float > 0.02 ? ['VALVE FLOAT', '#d62f27'] : this.knock > 0.05 ? ['KNOCK', '#d9822b'] : this.camHi ? ['HIGH CAM', '#1f6fb2'] : this.onPipe ? ['ON THE PIPE', '#1f6fb2'] : null;
    if (warn) {
      const lit = warn[1] === '#1f6fb2' || Math.floor(this.blink * 8) % 2 === 0 || this.float > 0.5;
      g.font = `700 ${Math.round(fr * 0.05)}px "Barlow Semi Condensed", sans-serif`;
      const tw = g.measureText(warn[0]).width + fr * 0.06;
      const y = cy - fr * 0.23;
      if (warn[1] !== '#1f6fb2') {
        g.fillStyle = lit ? warn[1] : 'rgba(0,0,0,0.12)';
        g.beginPath();
        g.roundRect?.(cx - tw / 2, y - fr * 0.04, tw, fr * 0.08, fr * 0.04);
        g.fill();
        g.fillStyle = lit ? '#fff6e6' : '#6b6255';
      } else g.fillStyle = warn[1];
      g.fillText(warn[0], cx, y + fr * 0.002);
    }
    this.knock *= 0.92;

    // needle
    const a = this.angleFor(this.pos);
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = R * 0.03;
    g.shadowOffsetY = R * 0.012;
    g.fillStyle = '#ff5f1f';
    g.beginPath();
    g.moveTo(-fr * 0.2, -fr * 0.022);
    g.lineTo(fr * 0.9, -fr * 0.006);
    g.lineTo(fr * 0.9, fr * 0.006);
    g.lineTo(-fr * 0.2, fr * 0.022);
    g.closePath();
    g.fill();
    g.restore();
    // hub
    let grd = g.createRadialGradient(cx - fr * 0.03, cy - fr * 0.03, 1, cx, cy, fr * 0.1);
    grd.addColorStop(0, '#4c4640');
    grd.addColorStop(1, '#0d0c0b');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, fr * 0.085, 0, Math.PI * 2);
    g.fill();
    // glass glare
    grd = g.createLinearGradient(cx - fr, cy - fr, cx + fr * 0.3, cy + fr * 0.4);
    grd.addColorStop(0, 'rgba(255,255,255,0.10)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.03)');
    grd.addColorStop(0.46, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, fr, 0, Math.PI * 2);
    g.fill();
  }
}
