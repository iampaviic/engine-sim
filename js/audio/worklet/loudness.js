// Loudness as people hear it: ITU-R BS.1770-4. One definition for the whole
// app: the loudness tool and the virtual dyno trim each engine with it, and
// the master processor reads its own level with it.

// Every engine is trimmed so the top of a full-load dyno sweep (its last 3
// s, at full throttle near the rev limit: an engine's loudest sustained
// state), heard by the rear camera's mic, has this integrated loudness at
// the worklet's output. An engine's peaks stand 12 to 16 dB above its
// loudness, so at -20 its sustained full load stays 4 to 6 dB under full
// scale and clear of the worklet's safety clip (listener.js); the master
// chain (master.js) then brings full load up to MASTER_TARGET and its
// true-peak limiter holds the peaks.
export const LOUDNESS_TARGET = -20;
export const MASTER_TARGET = -16;

// K-weighting at any sample rate. The standard gives its two biquads at 48
// kHz; these are the analog prototypes they come from (a high shelf, +4 dB
// above about 1.7 kHz, for the head's effect on what reaches the ear, then
// the "RLB" high-pass at 38 Hz), mapped with the bilinear transform as the
// reference implementation libebur128 does. At 48 kHz they give the
// standard's coefficients to 1e-14. Returns [b0, b1, b2, a1, a2] for each.
export function kWeights(fs) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

// True peak (BS.1770-4 annex 2): the signal oversampled 4 times, and the
// largest of those samples. The interpolator is a windowed sinc (Blackman
// window) with 12 taps a phase, as the annex's is. Phase p of input step n,
// the sum over k of h[p + os k] x[n - k], is the signal (12 os - 1) / (2 os)
// - p / os samples ago (5.875 - p / 4 at 4x). One definition for the
// master's limiter (which oversamples finer, os 8) and the tools' meter.
export const TP_OS = 4;
export function truePeakTaps(os = TP_OS, per = 12) {
  const n = os * per, h = new Float64Array(n), c = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - c) / os;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)));
  }
  return h;
}

// Loudness of a mean square of K-weighted samples (summed over channels).
export function lufs(ms) {
  return -0.691 + 10 * Math.log10(ms + 1e-30);
}

// Integrated loudness (LUFS) of a stereo recording at fs: K-weighted, 400 ms
// blocks every 100 ms, the absolute gate at -70 LUFS and the relative gate
// 10 LU under the mean of what passed it. (For the tools and the virtual
// dyno; not for the per-sample path.)
export function integratedLoudness(L, R, fs) {
  const [s, h] = kWeights(fs);
  const kl = new Float64Array(L.length), kr = new Float64Array(L.length);
  // one biquad stage, direct form I
  const stage = (x, y, c) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1;
      x1 = x[i];
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
  };
  stage(L, kl, s);
  stage(kl, kl, h);
  stage(R, kr, s);
  stage(kr, kr, h);
  const n = Math.round(0.4 * fs), hop = Math.round(0.1 * fs);
  const z = [];
  for (let st = 0; st + n <= kl.length; st += hop) {
    let e = 0;
    for (let i = st; i < st + n; i++) e += kl[i] * kl[i] + kr[i] * kr[i];
    if (lufs(e / n) > -70) z.push(e / n);
  }
  if (!z.length) return -Infinity;
  const gate = lufs(z.reduce((a, b) => a + b, 0) / z.length) - 10;
  const z2 = z.filter((e) => lufs(e) > gate);
  return lufs(z2.reduce((a, b) => a + b, 0) / z2.length);
}
