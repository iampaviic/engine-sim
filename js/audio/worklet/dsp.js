// Small helpers for the per-sample path: the seeded random stream, fast
// math, map lookups, the orifice flow solver and the resonator banks.

import { PI, TAU } from './constants.js';

// One seeded stream for the whole simulation, so a render is repeatable.
const SEED = 0x2545f491;
let rs = SEED;
// The offline tools restart the stream before each render; the app never does.
export function reseed() {
  rs = SEED;
}
export function rnd() {
  rs ^= rs << 13;
  rs ^= rs >>> 17;
  rs ^= rs << 5;
  return (rs >>> 0) * 2.3283064365386963e-10;
}
export function gauss() {
  return (rnd() + rnd() + rnd() + rnd() - 2) * 1.7320508;
}
export function ftanh(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}
export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}
// Compressor speed line at flow fraction x of choke: a peak with surge on its
// left. In reverse flow the spinning wheel resists like a restriction, so the
// pressure needed to push air backwards rises: that closes the deep-surge
// cycle (the "flutter"). h (0..1) is the size of the hump left of the peak:
// it grows with tip speed, so a slow wheel only stalls mildly and the flutter
// dies away as the turbo winds down.
export function speedLine(x, h) {
  if (x >= 1) return Math.max(-0.6, -2 * (x - 1));
  if (x >= 0.32) {
    // flat across the middle of the map, diving only as it nears choke
    const y = (x - 0.32) / 0.68;
    const y2 = y * y;
    const y4 = y2 * y2;
    return 1 - 0.18 * y2 - 0.82 * y4 * y4 * y2;
  }
  if (x >= 0) {
    const y = (0.32 - x) / 0.32;
    return 1 - 0.28 * h * y * y;
  }
  return 1 - 0.28 * h + 3.5 * x * x;
}
// Valve lift (fraction of max) after a floating valve hits its seat: a big
// first rebound, a smaller second one. ph = crank degrees since closing.
export function bounce(ph) {
  if (ph < 17) return 0.3 * Math.sin((PI * ph) / 17);
  if (ph < 23) return 0;
  if (ph < 36) return 0.12 * Math.sin((PI * (ph - 23)) / 13);
  return 0;
}
export function crossed(prev, cur, ev) {
  return prev <= cur ? prev < ev && ev <= cur : ev > prev || ev <= cur;
}
// One-pole low-pass coefficient for cutoff f (Hz).
export function lpCoef(f, fs) {
  return 1 - Math.exp((-TAU * Math.min(f, fs * 0.45)) / fs);
}

// Where x falls on a map axis: index plus fraction, held at the ends.
export function axisAt(a, x) {
  const n = a.length;
  if (x <= a[0]) return 0;
  if (x >= a[n - 1]) return n - 1;
  let i = 0;
  while (x > a[i + 1]) i++;
  return i + (x - a[i]) / (a[i + 1] - a[i]);
}
export function lerpAt(t, p) {
  const i = Math.min(t.length - 2, Math.floor(p));
  const f = p - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}
// Laminar flame speed against lambda (shape only): fastest a little rich.
export function flameSpeed(lam) {
  const phi = 1 / lam;
  return Math.pow(phi, 0.25) * Math.exp(-4.5 * (phi - 1.1) * (phi - 1.1));
}
// Torque from a given charge of air against lambda: best around 0.88, from
// the extra moles and less dissociation; too rich it burns incompletely.
// (Leaner than 1 the fuel itself runs short, which the burn already counts.)
const RICH_LAM = [0.6, 0.7, 0.75, 0.8, 0.88, 0.95, 1];
const RICH_GAIN = [0.86, 0.94, 0.972, 0.99, 1, 0.986, 0.965];
export function richGain(lam) {
  if (lam >= 1) return 0.965;
  if (lam <= 0.6) return 0.86;
  return lerpAt(RICH_GAIN, axisAt(RICH_LAM, lam));
}
// Exhaust temperature against lambda (shape only): the flame is hottest a
// little lean of stoichiometric; extra fuel soaks up heat as it dissociates.
const EGT_LAM = [0.6, 0.75, 0.85, 0.95, 1.05, 1.15, 1.3];
const EGT_GAIN = [0.83, 0.91, 0.96, 0.995, 1, 0.985, 0.95];
export function egtGain(lam) {
  return lerpAt(EGT_GAIN, axisAt(EGT_LAM, lam));
}

// Mass flow through an orifice of effective area A (Cd included), driven by
// pressure difference D > 0, solved implicitly against the combined reacting
// impedance Z of both sides (pipe wave impedance + chamber compliance), and
// limited by choked flow from the upstream stagnation state (p0, T0).
export function orifice(A, D, rho, Z, p0, sqrtT0, choke) {
  const K = A * Math.sqrt(2 * rho);
  const B = K * Z;
  const s = (2 * D) / (B + Math.sqrt(B * B + 4 * D));
  const m = K * s;
  const mc = (choke * A * p0) / sqrtT0;
  return m < mc ? m : mc;
}

// Struck structural modes, heard as sound. A surface radiates with its
// velocity, so each mode's response to a force falls away towards 0 Hz (a
// plain two-pole resonator answers like a displacement and passes every low
// harmonic of whatever strikes it). An impulse of 1 sets mode i ringing at
// amplitude gains[i]; qs are the quality factors.
export class Struck {
  constructor(freqs, qs, gains, fs) {
    const n = freqs.length;
    this.n = n;
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    this.g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = (TAU * Math.min(freqs[i], fs * 0.45)) / fs;
      const r = Math.exp(-w / (2 * qs[i]));
      this.a1[i] = 2 * r * Math.cos(w);
      this.a2[i] = -r * r;
      // the difference of the ringing state swings 1 / cos(w / 2) per unit
      this.g[i] = gains[i] * Math.cos(w / 2);
    }
  }
  tick(x) {
    let out = 0;
    const { a1, a2, y1, y2, g } = this;
    for (let i = 0; i < this.n; i++) {
      const y = a1[i] * y1[i] + a2[i] * y2[i] + x;
      out += (y - y1[i]) * g[i];
      y2[i] = y1[i];
      y1[i] = y;
    }
    return out;
  }
}

// Fourth-order band-pass: two identical constant-peak biquads. For noises
// that must stay in their band; a pair of one-pole filters leaks a flat
// hiss right up to Nyquist.
export class Band4 {
  constructor(f, q, fs) {
    const w = (TAU * f) / fs;
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    this.b0 = al / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - al) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = this.z1 = this.z2 = 0;
  }
  tick(x) {
    const { b0, a1, a2 } = this;
    const y = b0 * (x - this.x2) - a1 * this.y1 - a2 * this.y2;
    const z = b0 * (y - this.y2) - a1 * this.z1 - a2 * this.z2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    this.z2 = this.z1;
    this.z1 = z;
    return z;
  }
}

// Struck structural modes: a unit impulse sets mode i ringing at amplitude
// g[i], dying away with time constant tau[i] (s).
export class Modes {
  constructor(freqs, taus, gains, fs) {
    const n = freqs.length;
    this.n = n;
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.b = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = (TAU * Math.min(freqs[i], fs * 0.45)) / fs;
      const r = Math.exp(-1 / (taus[i] * fs));
      this.a1[i] = 2 * r * Math.cos(w);
      this.a2[i] = -r * r;
      this.b[i] = gains[i] * Math.sin(w);
    }
  }
  tick(x) {
    let out = 0;
    const { a1, a2, b, y1, y2 } = this;
    for (let i = 0; i < this.n; i++) {
      const y = a1[i] * y1[i] + a2[i] * y2[i] + b[i] * x;
      y2[i] = y1[i];
      y1[i] = y;
      out += y;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Waveguide pipe network
// ---------------------------------------------------------------------------
