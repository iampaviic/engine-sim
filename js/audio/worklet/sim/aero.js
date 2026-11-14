// Wind at a mic that rides on the car, and road joints.

import { TAU } from '../constants.js';
import { clamp, lpCoef } from '../dsp.js';

export class AeroMethods {
  // The wind's own random stream (xorshift), centred on zero.
  arnd() {
    let s = this.aRs;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.aRs = s;
    return (s >>> 0) * 2.3283064365386963e-10 - 0.5;
  }

  // Wind, control rate: gusts, the filters' tuning and the levels.
  //
  // Air tearing off the pillars, mirrors and seals sheds vortices at a
  // Strouhal frequency (f ~ U/size, so the hiss climbs with speed) and
  // radiates as a dipole: pressure ~ U^3 in theory, nearer U^2.5 measured in
  // real cabins (about 15 dB per doubling of speed). The separated,
  // buffeting flow over the body is lower and grows about as U^2.2. Gusts
  // and crosswind move the airspeed and the balance between the ears; now
  // and then a door seal or mirror locks into a whistle. A lorry in the next
  // lane throws its own wake: a whoosh and a shove of buffeting as you pass.
  aeroCtl(dtc) {
    const fs = this.fs;
    const v = this.v;
    const near = this.truckDx < 120 && this.truckDx > -120;
    if (v < 0.5 && !near) {
      this.aAh = this.aAb = this.aAw = this.aAt = this.aAr = this.aTb = 0;
      return;
    }
    // Ornstein-Uhlenbeck processes: x += -x dt/tau + sigma sqrt(2 dt/tau) N
    const n = (tau, sig) => sig * Math.sqrt((2 * dtc) / tau) * this.arnd() * 3.4641;
    this.aGust += (-this.aGust * dtc) / 2.5 + n(2.5, 0.05);
    this.aTurb += (-this.aTurb * dtc) / 0.12 + n(0.12, 0.03);
    this.aCross += (-this.aCross * dtc) / 4 + n(4, 0.35);
    this.aLock += (-this.aLock * dtc) / 1.5 + n(1.5, 0.5);
    const U = v * Math.max(0.4, 1 + this.aGust + this.aTurb);
    this.aU = U;
    const q = U / 70;
    // hiss band (unity peak), centred on the shedding frequency
    const g = Math.tan((Math.PI * Math.min(300 + 14 * U, 0.4 * fs)) / fs);
    const k = 1 / 0.7;
    this.aH1 = 1 / (1 + g * (g + k));
    this.aH2 = g * this.aH1;
    this.aH3 = g * this.aH2;
    this.aAh = Math.pow(q, 2.5);
    this.aBa = lpCoef(30 + 1.7 * U, fs);
    this.aAb = Math.pow(q, 2.2) * Math.max(0, 1 + 3 * this.aGust);
    const cr = clamp(this.aCross, -1, 1) * 0.3;
    this.aGl = 1 - cr;
    this.aGr = 1 + cr;
    this.aWf = 21 * U;
    this.aAw = clamp((this.aLock - 0.45) * 2.5, 0, 1) * clamp((U - 38) / 15, 0, 1) * q * q;
    // the lorry: its wake as the car goes by, and its tyres and engine
    if (near) {
      const dx = this.truckDx;
      const env = Math.exp(-(dx / 9) * (dx / 9));
      const vr = this.truckVr;
      this.aAt = ((vr / 40) * (vr / 40)) * env;
      this.aTb = 1.6 * env * Math.min(1, Math.abs(vr) / 30);
      this.aAr = 3.8 / Math.hypot(dx, 3.8);
    } else this.aAt = this.aAr = this.aTb = 0;
  }

  // Wind, one sample at the mic; returns [l, r] in Pa.
  aero() {
    const s = this.aS;
    const o = this.aOut;
    const nl = this.arnd(), nr = this.arnd(), nc = this.arnd();
    // hiss: mostly different at each ear (the flow is torn up), some common
    const H1 = this.aH1, H2 = this.aH2, H3 = this.aH3;
    let x = nl + 0.5 * nc;
    let v3 = x - s[1];
    let v1 = H1 * s[0] + H2 * v3;
    let v2 = s[1] + H2 * s[0] + H3 * v3;
    s[0] = 2 * v1 - s[0];
    s[1] = 2 * v2 - s[1];
    let hl = v1 * 1.43;
    x = nr + 0.5 * nc;
    v3 = x - s[3];
    v1 = H1 * s[2] + H2 * v3;
    v2 = s[3] + H2 * s[2] + H3 * v3;
    s[2] = 2 * v1 - s[2];
    s[3] = 2 * v2 - s[3];
    let hr = v1 * 1.43;
    // buffet: low and mostly common to both ears; a slow high-pass keeps DC out
    const ba = this.aBa;
    s[4] += ba * (nc + 0.35 * nl - s[4]);
    s[5] += ba * (s[4] - s[5]);
    s[6] += this.aHpA * (s[5] - s[6]);
    let b = (s[5] - s[6]) * 9;
    const cab = this.aeroMic === 2;
    let l, r;
    if (cab) {
      // the glass and seals pass the low buffeting, soften the hiss
      const ca = this.aCabA;
      s[7] += ca * (hl - s[7]);
      s[8] += ca * (hr - s[8]);
      hl = s[7] * 1.5;
      hr = s[8] * 1.5;
      l = hl * this.aAh * 2.3 * this.aGl + b * this.aAb * 1.85;
      r = hr * this.aAh * 2.3 * this.aGr + b * this.aAb * 1.85;
      if (this.aAw > 0.001) {
        this.aWph += (this.aWf * (1 + this.aTurb * 0.6)) / this.fs;
        this.aWph -= Math.floor(this.aWph);
        const w = Math.sin(TAU * this.aWph) * this.aAw * 0.05;
        l += w * 0.4;
        r += w;
      }
    } else {
      l = hl * this.aAh * 1.8 * this.aGl + b * this.aAb * 0.9;
      r = hr * this.aAh * 1.8 * this.aGr + b * this.aAb * 0.9;
    }
    if (this.aAt > 1e-4 || this.aAr > 0.05) {
      // lorry on the right: its wake, and the rumble of its tyres and engine
      s[9] += this.aRumA * (nr - s[9]);
      s[10] += this.aRumA * (s[9] - s[10]);
      const iso = cab ? 0.5 : 1;
      const wk = this.aAt * iso * 3;
      const tb = b * this.aAb * this.aTb * (cab ? 1.85 : 0.9);
      const rum = s[10] * 6 * this.aAr * iso * 0.12;
      l += hl * wk * 0.3 + tb * 0.3 + rum * 0.4;
      r += hr * wk + tb + rum;
    }
    o[0] = l;
    o[1] = r;
    return o;
  }

  // A joint in the road under one axle (amp: Pa at 1 m, roughly).
  bump(amp) {
    amp *= 0.75 + 0.5 * (this.arnd() + 0.5); // no two joints alike
    this.bumpX += amp;
    this.bumpCl = Math.max(this.bumpCl, amp);
  }
}
