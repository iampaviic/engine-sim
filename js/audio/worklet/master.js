// The master chain: everything the engine and the reverbs make goes through
// it on its way to the speakers. Two stages, in one processor so the app and
// the test harness (tools/mix.mjs) run the same code in every browser (the
// built-in DynamicsCompressor it replaces differs between them).
//
// 1. A loudness leveller. Every engine is trimmed so its full load reaches
//    the master at LOUDNESS_TARGET (-20 LUFS, loudness.js). The leveller
//    reads the loudness it is given (BS.1770-4's K-weighting, averaged as the
//    momentary loudness is, over about 400 ms) and sets a gain:
//    - makeup to MASTER_TARGET (-16 LUFS, the level AES TD1004.1.15-10
//      recommends for streamed audio), so full load plays at -16;
//    - from full load down to 18 LU under it, nothing more: that much
//      contrast is kept exactly as the physics makes it. 18 LU is the
//      narrowest an engine has between settled idle and full load (the twin-
//      turbo rotary, 18.4; tools/loudness.mjs);
//    - deeper than that, upward compression at 2:1, at most +10 dB: settled
//      idles sit 18 to 43 LU under full load, and the deepest, at -16 LUFS
//      full load on a phone's speaker (an estimate: 80 dB(A) peaks at arm's
//      length, so full load near 65), would idle under a quiet room's 35
//      dB(A) background (ANSI/ASA S12.60's limit for classrooms); lifted,
//      the 18 to 43 LU spread becomes 18 to 33 LU and engines keep their
//      order. The lift fades out from -70 LUFS at the input (BS.1770's
//      absolute gate) to -80, so silence and a stopped engine stay quiet;
//    - above full load, downward compression at 2:1. The trims measure a
//      loaded sweep; a free rev into the limiter, with its afterfire bangs,
//      measures -4.7 to +14.4 LU against it depending on the engine, and
//      2:1 halves that spread while keeping louder louder.
//    The gain falls with a 50 ms time constant and recovers with 0.8 s
//    (estimates: fast enough that a blip from idle is not lifted for long,
//    slow enough that the idle does not swell audibly after one); 6 dB soft
//    knees (Giannoulis, Massberg and Reiss, "Digital dynamic range
//    compressor design", JAES 60(6), 2012).
// 2. A true-peak look-ahead limiter at -1 dBTP (AES TD1004's ceiling, which
//    leaves room for the resampling a phone's mixer may do). The leveller's
//    output is oversampled with BS.1770's kind of true-peak interpolator
//    (truePeakTaps in loudness.js, finer here) to find the gain each moment
//    needs; that gain is held for the look-ahead (5 ms), released with an 80
//    ms time constant (an estimate; slower distorts less on an engine's low
//    firing frequencies, faster pumps less), and smoothed by a 5 ms moving
//    average, which reaches the held gain exactly when the delayed signal
//    arrives.
//    A peak is therefore never let through over the ceiling, as the
//    estimate measures it, and the gain never steps.

import { LOUDNESS_TARGET, MASTER_TARGET, kWeights, truePeakTaps } from './loudness.js';

const LEV_ABOVE = 2; // downward ratio above full load
const LEV_DEEP = 18; // LU under full load kept untouched
const LEV_UP = 2; // upward ratio below that
const LEV_LIFT = 10; // dB, the most the upward compression adds
const LEV_KNEE = 6; // dB
const LEV_GATE = -70; // LUFS at the input: the lift fades out from here...
const LEV_FLOOR = -80; // ...to here
const LIM_CEIL = Math.pow(10, -1 / 20); // -1 dBTP
const CTRL = 32; // samples between the leveller's gain updates
// The limiter's true-peak estimate oversamples 8 times, with 16 taps a
// phase: BS.1770's 4x estimate can miss a peak by up to 0.2 dB on content
// near 12 kHz and more on clicks. Rendered engines through this one measure
// within 0.05 dB of the ceiling by a 16x estimate (tools/mix.mjs); it costs
// about 1.5% of a desktop core.
const LIM_OS = 8, LIM_PER = 16;

// Static curve, after Giannoulis et al. (2012): the gain (dB) a compressor
// with threshold 0, the given ratio and knee gives an input x dB over it.
function kneeGain(x, ratio, knee) {
  if (2 * x < -knee) return 0;
  if (2 * x > knee) return x / ratio - x;
  const u = x + knee / 2;
  return ((1 / ratio - 1) * u * u) / (2 * knee);
}

// The leveller's gain (dB) for an input loudness (LUFS).
export function levelGain(lufsIn) {
  const x = lufsIn - LOUDNESS_TARGET;
  let g = MASTER_TARGET - LOUDNESS_TARGET + kneeGain(x, LEV_ABOVE, LEV_KNEE);
  // upward: the same curve mirrored about LEV_DEEP under full load
  let lift = -kneeGain(-LEV_DEEP - x, LEV_UP, LEV_KNEE);
  lift = lift > LEV_LIFT ? LEV_LIFT : lift;
  const f = (lufsIn - LEV_FLOOR) / (LEV_GATE - LEV_FLOOR);
  g += lift * (f < 0 ? 0 : f > 1 ? 1 : f);
  return g;
}

export class Master {
  constructor(fs) {
    this.fs = fs;
    // leveller: K-weighting (two biquads a channel, direct form I), the
    // mean square averaged with a 0.2 s time constant (an exponential
    // average's equivalent window is twice its time constant: 400 ms, the
    // momentary loudness's)
    const [sh, hp] = kWeights(fs);
    this.ksh = sh;
    this.khp = hp;
    this.kz = new Float64Array(16); // x1 x2 y1 y2 for 2 stages x 2 channels
    this.ms = 0;
    this.msA = 1 - Math.exp(-1 / (0.2 * fs));
    this.ctr = 0;
    this.gDb = levelGain(-200);
    this.gLin = Math.pow(10, this.gDb / 20);
    this.gStep = 0;
    this.atkA = 1 - Math.exp(-CTRL / (0.05 * fs));
    this.relA = 1 - Math.exp(-CTRL / (0.8 * fs));
    this.inLufs = -200;
    // limiter
    this.N = Math.max(8, Math.round(0.005 * fs)); // look-ahead and smoothing, samples
    this.H = this.N + 2; // hold: covers both samples around an inter-sample peak
    this.tpOs = LIM_OS;
    this.tp = truePeakTaps(LIM_OS, LIM_PER);
    this.tpPer = LIM_PER;
    this.tpLag = Math.ceil((this.tp.length - 1) / 2 / LIM_OS); // the peak found at step n lies between samples n - tpLag and n - tpLag + 1
    this.D = this.N + this.tpLag; // audio delay
    this.histL = new Float64Array(this.tpPer);
    this.histR = new Float64Array(this.tpPer);
    this.hPos = 0;
    this.dlL = new Float64Array(this.D + 1);
    this.dlR = new Float64Array(this.D + 1);
    this.dPos = 0;
    // sliding minimum over H samples: a monotonic deque of (time, gain)
    this.qT = new Float64Array(this.H + 1);
    this.qG = new Float64Array(this.H + 1);
    this.qHead = 0;
    this.qLen = 0;
    this.n = 0;
    this.rel = 1;
    this.relK = 1 - Math.exp(-1 / (0.08 * fs));
    this.box = new Float64Array(this.N).fill(1);
    this.boxSum = this.N;
    this.bPos = 0;
    // metering for the tools: per frame the limiter's smallest gain and the
    // leveller's gain
    this.grMin = 1;
  }

  // the leveller's gain for the next CTRL samples, from the loudness so far
  levelStep() {
    const lufsIn = -0.691 + 10 * Math.log10(this.ms + 1e-30);
    this.inLufs = lufsIn;
    const tgt = levelGain(lufsIn);
    this.gDb += (tgt - this.gDb) * (tgt < this.gDb ? this.atkA : this.relA);
    const next = Math.pow(10, this.gDb / 20);
    this.gStep = (next - this.gLin) / CTRL;
  }

  // in/out: Float32Arrays of n samples (inR may be inL for mono; in may be
  // null for silence)
  process(inL, inR, outL, outR, n) {
    const sh = this.ksh, hp = this.khp, z = this.kz, tp = this.tp, per = this.tpPer, OS = this.tpOs;
    const hL = this.histL, hR = this.histR, dlL = this.dlL, dlR = this.dlR, D1 = this.D + 1;
    const qT = this.qT, qG = this.qG, Q = this.H + 1, box = this.box, N = this.N, H = this.H;
    for (let i = 0; i < n; i++) {
      if (this.ctr === 0) this.levelStep();
      this.ctr = this.ctr + 1 === CTRL ? 0 : this.ctr + 1;
      const xl = inL ? inL[i] : 0, xr = inR ? inR[i] : xl;
      // loudness detector
      let a = sh[0] * xl + sh[1] * z[0] + sh[2] * z[1] - sh[3] * z[2] - sh[4] * z[3];
      z[1] = z[0]; z[0] = xl; z[3] = z[2]; z[2] = a;
      let kl = hp[0] * a + hp[1] * z[4] + hp[2] * z[5] - hp[3] * z[6] - hp[4] * z[7];
      z[5] = z[4]; z[4] = a; z[7] = z[6]; z[6] = kl;
      a = sh[0] * xr + sh[1] * z[8] + sh[2] * z[9] - sh[3] * z[10] - sh[4] * z[11];
      z[9] = z[8]; z[8] = xr; z[11] = z[10]; z[10] = a;
      const kr = hp[0] * a + hp[1] * z[12] + hp[2] * z[13] - hp[3] * z[14] - hp[4] * z[15];
      z[13] = z[12]; z[12] = a; z[15] = z[14]; z[14] = kr;
      this.ms += this.msA * (kl * kl + kr * kr - this.ms);
      // leveller
      this.gLin += this.gStep;
      const yl = xl * this.gLin, yr = xr * this.gLin;
      // true peak of the levelled signal: every phase of the interpolator
      // over the last few samples, and the plain sample tpLag back
      const hp0 = this.hPos;
      hL[hp0] = yl;
      hR[hp0] = yr;
      let pk = 0;
      for (let p = 0; p < OS; p++) {
        let sl = 0, sr = 0;
        for (let k = 0, j = hp0; k < per; k++) {
          const c = tp[p + k * OS];
          sl += c * hL[j];
          sr += c * hR[j];
          j = j === 0 ? per - 1 : j - 1;
        }
        if (sl < 0) sl = -sl;
        if (sr < 0) sr = -sr;
        if (sl > pk) pk = sl;
        if (sr > pk) pk = sr;
      }
      const j6 = (hp0 - this.tpLag + per) % per;
      const s6 = Math.max(Math.abs(hL[j6]), Math.abs(hR[j6]));
      if (s6 > pk) pk = s6;
      this.hPos = hp0 + 1 === per ? 0 : hp0 + 1;
      const need = pk > LIM_CEIL ? LIM_CEIL / pk : 1;
      // sliding minimum of the needed gain over the last H samples
      const t = this.n++;
      while (this.qLen > 0 && qG[(this.qHead + this.qLen - 1) % Q] >= need) this.qLen--;
      const back = (this.qHead + this.qLen) % Q;
      qT[back] = t;
      qG[back] = need;
      this.qLen++;
      if (qT[this.qHead] <= t - H) {
        this.qHead = this.qHead + 1 === Q ? 0 : this.qHead + 1;
        this.qLen--;
      }
      const held = qG[this.qHead];
      // release, then the moving average
      this.rel = held < this.rel ? held : this.rel + (held - this.rel) * this.relK;
      const b = this.bPos;
      this.boxSum += this.rel - box[b];
      box[b] = this.rel;
      if (b + 1 === N) {
        // refresh the running sum once a window against rounding drift
        let s = 0;
        for (let k = 0; k < N; k++) s += box[k];
        this.boxSum = s;
        this.bPos = 0;
      } else this.bPos = b + 1;
      const g = this.boxSum / N;
      if (g < this.grMin) this.grMin = g;
      // the levelled signal, D samples late
      const d = this.dPos;
      const r = d + 1 === D1 ? 0 : d + 1; // the oldest
      dlL[d] = yl;
      dlR[d] = yr;
      outL[i] = dlL[r] * g;
      outR[i] = dlR[r] * g;
      this.dPos = r;
    }
  }
}

// The AudioWorkletProcessor around it. Messages: { type: 'meter', on } turns
// on 'meter' messages back: every 0.1 s, per 10 ms frame, the limiter's gain
// reduction and the leveller's gain (dB) and its input loudness (LUFS).
export class MasterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.m = new Master(sampleRate);
    this.meterOn = false;
    this.frame = Math.round(sampleRate / 100);
    this.fCount = 0;
    this.mBuf = new Float32Array(30);
    this.mN = 0;
    this.mT = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'meter') this.meterOn = !!e.data.on;
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const l = inp && inp.length ? inp[0] : null;
    const r = inp && inp.length > 1 ? inp[1] : l;
    this.m.process(l, r, out[0], out[1] ?? out[0], n);
    if (this.meterOn) {
      this.fCount += n;
      if (this.fCount >= this.frame) {
        this.fCount -= this.frame;
        const m = this.m, k = this.mN * 3;
        this.mBuf[k] = 20 * Math.log10(m.grMin);
        this.mBuf[k + 1] = m.gDb;
        this.mBuf[k + 2] = m.inLufs;
        m.grMin = 1;
        if (++this.mN === 10) {
          this.port.postMessage({ type: 'meter', t: this.mT, dt: this.frame / sampleRate, v: this.mBuf.slice() });
          this.mT += (10 * this.frame) / sampleRate;
          this.mN = 0;
        }
      }
    }
    return true;
  }
}
