// Loudness (ITU-R BS.1770-4: K-weighting, 400 ms blocks, absolute and
// relative gates) and true peak (4x oversampled) of stereo PCM at 48 kHz.
// Used by tools/loudness.mjs and tools/mix.mjs.
import { kWeights } from '../js/audio/worklet/loudness.js';

export const FS = 48000;

// K-weighting: the app's own (js/audio/worklet/loudness.js), the standard's
// two biquads.
const [K1, K2] = kWeights(FS);
function biquad(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
// mean-square of the K-weighted sum per 400 ms block, 100 ms hop
function blocks(L, R, a = 0, b = L.length) {
  const kl = biquad(biquad(L.subarray(a, b), K1), K2), kr = biquad(biquad(R.subarray(a, b), K1), K2);
  const n = Math.round(0.4 * FS), hop = Math.round(0.1 * FS);
  const out = [];
  for (let s = 0; s + n <= kl.length; s += hop) {
    let z = 0;
    for (let i = s; i < s + n; i++) z += kl[i] * kl[i] + kr[i] * kr[i];
    out.push(z / n);
  }
  return out;
}
const lk = (z) => -0.691 + 10 * Math.log10(z + 1e-30);
// Integrated loudness, LUFS, with the absolute (-70) and relative (-10 LU) gates.
export function integrated(L, R, a, b) {
  const z = blocks(L, R, a, b).filter((v) => lk(v) > -70);
  if (!z.length) return -Infinity;
  const g = lk(z.reduce((s, v) => s + v, 0) / z.length) - 10;
  const z2 = z.filter((v) => lk(v) > g);
  return lk(z2.reduce((s, v) => s + v, 0) / z2.length);
}
// Momentary loudness (400 ms) over time, and the short-term (3 s) maximum.
export function momentary(L, R) {
  return blocks(L, R).map(lk);
}
export function shortTermMax(L, R) {
  const z = blocks(L, R);
  let m = -Infinity;
  for (let i = 0; i + 30 <= z.length; i++) {
    let s = 0;
    for (let j = i; j < i + 30; j += 4) s += z[j];
    m = Math.max(m, lk(s / Math.ceil(30 / 4)));
  }
  return m;
}
// 4x oversampling: a 48-tap windowed-sinc interpolator (12 taps per phase,
// as BS.1770-4 annex 2 uses), then the largest absolute sample.
const OS = 4, TAPS = 48;
const H = (() => {
  const h = new Float64Array(TAPS);
  const c = (TAPS - 1) / 2;
  for (let i = 0; i < TAPS; i++) {
    const t = (i - c) / OS;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * w;
  }
  return h;
})();
export function truePeak(x) {
  let m = 0;
  const per = TAPS / OS;
  for (let n = per; n < x.length; n++) {
    for (let p = 0; p < OS; p++) {
      let s = 0;
      for (let k = 0; k < per; k++) s += H[p + k * OS] * x[n - k];
      const a = s < 0 ? -s : s;
      if (a > m) m = a;
    }
  }
  return m;
}
export const db = (x) => 20 * Math.log10(x + 1e-30);
