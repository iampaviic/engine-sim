// The listener: per-source delay lines read by two ears, each with a direct
// and a ground-reflected tap. The taps' delays, gains and filters are set
// from the camera geometry in camera.js; EngineSim.listen() renders through
// them every sample.

import { N_SRC, SRC_BUF, SRC_MASK } from './constants.js';
import { ftanh, lpCoef } from './dsp.js';

export class Listener {
  constructor(fs) {
    this.fs = fs;
    this.buf = new Float32Array(N_SRC * SRC_BUF);
    this.w = 0;
    const T = N_SRC * 4; // src x ear x (direct, ground)
    this.dCur = new Float64Array(T);
    this.dInc = new Float64Array(T);
    this.gCur = new Float64Array(T);
    this.gInc = new Float64Array(T);
    // per tap: low-pass, its leak (a shelf floor; 0 = plain low-pass), a
    // second low-pass, a high shelf (corner coefficient and the gain above
    // it; 1 = none) and a high-pass (0 = none)
    this.al = new Float64Array(T);
    this.lk = new Float64Array(T);
    this.al2 = new Float64Array(T);
    this.ash = new Float64Array(T);
    this.shg = new Float64Array(T).fill(1);
    this.hp = new Float64Array(T);
    this.z1 = new Float64Array(T);
    this.z2 = new Float64Array(T);
    this.z3 = new Float64Array(T);
    this.z4 = new Float64Array(T);
    this.active = new Uint8Array(N_SRC);
    this.cabin = 0;
    this.moving = false;
    this.boomA = lpCoef(92, fs);
    this.boom1 = 0;
    this.boom2 = 0;
    this.first = true;
  }
}

function softclip(x) {
  const a = x < 0 ? -x : x;
  if (a < 0.75) return x;
  const y = 0.75 + 0.25 * ftanh((a - 0.75) * 4);
  return x < 0 ? -y : y;
}

export class ListenMethods {
  // Render all sources for both ears; returns [L, R] (normalised).
  listen(L) {
    const buf = L.buf;
    const w = (L.w - 1) & SRC_MASK;
    let l = 0, r = 0;
    const dC = L.dCur, dI = L.dInc, gC = L.gCur, gI = L.gInc, al = L.al, lk = L.lk, al2 = L.al2, ash = L.ash, shg = L.shg, hp = L.hp;
    const z1 = L.z1, z2 = L.z2, z3 = L.z3, z4 = L.z4;
    for (let s = 0; s < N_SRC; s++) {
      if (!L.active[s]) continue;
      const base = s * SRC_BUF;
      for (let k = 0; k < 4; k++) {
        const t = s * 4 + k;
        const g = gC[t];
        gC[t] = g + gI[t];
        const d = dC[t];
        dC[t] = d + dI[t];
        if (g === 0) continue;
        const pos = w - d;
        const fl = Math.floor(pos);
        const f = pos - fl;
        const i1 = fl & SRC_MASK;
        const y1 = buf[base + i1];
        const y2 = buf[base + ((i1 + 1) & SRC_MASK)];
        let x;
        if (L.moving) {
          // cubic Hermite for clean Doppler
          const y0 = buf[base + ((i1 - 1) & SRC_MASK)];
          const y3 = buf[base + ((i1 + 2) & SRC_MASK)];
          const c1 = 0.5 * (y2 - y0);
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
          x = ((c3 * f + c2) * f + c1) * f + y1;
        } else x = y1 + (y2 - y1) * f;
        let y = z1[t] + al[t] * (x - z1[t]);
        z1[t] = y;
        if (lk[t] !== 0) y += lk[t] * (x - y);
        y = z2[t] + al2[t] * (y - z2[t]);
        z2[t] = y;
        if (shg[t] !== 1) {
          const lo = (z4[t] += ash[t] * (y - z4[t]));
          y = lo + shg[t] * (y - lo);
        } else z4[t] = y;
        if (hp[t] !== 0) {
          z3[t] += hp[t] * (y - z3[t]);
          y -= z3[t];
        }
        if (k & 1) r += y * g;
        else l += y * g;
      }
    }
    if (this.aeroMic && (this.aAh > 1e-6 || this.aAt > 1e-6 || this.aAr > 0.05)) {
      const a = this.aero();
      const m5 = this.mix[5];
      l += a[0] * m5;
      r += a[1] * m5;
    }
    if (L.cabin) {
      // body boom resonance
      const m = (l + r) * 0.5;
      L.boom1 += L.boomA * (m - L.boom1);
      L.boom2 += L.boomA * (L.boom1 - L.boom2);
      const b = (L.boom1 - L.boom2) * 2.2;
      l += b;
      r += b;
    }
    const k = 0.02 * this.snd.trim * this.fade;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + 1 / 2400);
    this.telSpl += l * l + r * r;
    this.telSplN++;
    const o = this._o || (this._o = [0, 0]);
    o[0] = softclip(l * k);
    o[1] = softclip(r * k);
    return o;
  }
}
