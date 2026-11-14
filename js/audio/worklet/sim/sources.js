// The sound sources: mixes exhaust, intake, mechanical, chassis and
// wastegate channels each sample, and captures the scope and pressure-wave
// snapshots.

import { SRC_BUF, SRC_MASK, TAU } from '../constants.js';
import { crossed, rnd } from '../dsp.js';

const FOURPI = 2 * TAU;

export class SourceMethods {
  // Intake, mechanical and chassis sources; write all sources (Pa at 1 m)
  // into the listener's delay lines; scope capture.
  stepSources(rpm, omega, lis) {
    const fs = this.fs;
    const snd = this.snd;
    const src = this.srcBuf;

    // Intake. The inlet tract is driven by the change in the flow it feeds:
    // the throttle's (with individual throttles, the bell mouths'), or on a
    // boosted engine the compressor's, which hides the engine's own gulps
    // behind its charge pipes and its wheel.
    const q = this.boosted ? this.inFlow : this.mdTh;
    let s = (this.inPrev - q) * fs;
    this.inPrev = q;
    this.inMean += this.inMeanA * (q - this.inMean);
    if (!this.boosted) {
      // The throttle's jet: broadband noise about the frequency its eddies
      // are shed at, as loud as the jet power going back upstream (jetUp).
      const nz = rnd() - 0.5;
      const v3 = nz - this.jet2;
      const v1 = this.jetA1 * this.jet1 + this.jetA2 * v3;
      const v2 = this.jet2 + this.jetA2 * this.jet1 + this.jetA3 * v3;
      this.jet1 = 2 * v1 - this.jet1;
      this.jet2 = 2 * v2 - this.jet2;
      s += v1 * this.jetG * Math.sqrt(this.jetW);
      if (this.edgeA > 0) {
        this.edgeJit += this.wJitA * (rnd() - 0.5 - this.edgeJit);
        this.edgePh += (this.edgeF * (1 + this.edgeJit * 0.2)) / fs;
        this.edgePh -= Math.floor(this.edgePh);
        s += Math.sin(TAU * this.edgePh) * this.edgeA;
      }
    }
    // (the compressor's voice is in pascals at 1 m as if in the open)
    let intake = this.inlet.tick(s + this.turboSnd * FOURPI) + this.bovSnd;
    if (this.nosFlow > 0 || this.purgeFlow > 0 || this.nosClick > 0 || this.nosRing > 0) intake += this.nitrousSound();

    // mechanical: the engine's structure and accessories, the gearbox
    let mech = this.stepMech(rpm, omega) * snd.mech;
    this.axleSnd = 0;
    if (this.gear > 0 && this.clutch > 0.5) mech += this.gearSound();
    if (this.msPhase === 3 || this.grRing > 0) mech += this.grindSound();
    if (this.isCentri) mech += this.blowerGear(omega);
    if (this.stActive) mech += this.starterSound();
    // the exhaust ticking as it cools, the radiator fan
    if (this.tkOn > 0 || this.fanW > 0) mech += this.thermalSound();

    // chassis: road, wind, tyre squeal
    // (a mic riding on the car hears the wind on its own, in aero())
    let chassis = this.axleSnd;
    // the fuel pump, in the tank under the rear seat
    if (this.pumpW > 0) chassis += this.pumpSound();
    if (this.v > 0.3) {
      const vv = this.v;
      const nz = rnd() - 0.5;
      this.roadLp += 0.02 * (nz - this.roadLp);
      this.windLp1 += 0.15 * (nz - this.windLp1);
      this.windLp2 += 0.03 * (this.windLp1 - this.windLp2);
      const sf = this.surface === 'asphalt' ? 1 : this.surface === 'concrete' ? 1.3 : 1.15;
      chassis += this.roadLp * vv * 0.35 * sf + (this.aeroMic ? 0 : (this.windLp1 - this.windLp2) * vv * vv * 0.0025);
    }
    if (this.bumpX !== 0 || this.bumpCl > 1e-5 || this.bumpY1 > 1e-6 || this.bumpY1 < -1e-6) {
      // tyre and suspension ring at ~70 Hz; the tread slaps the joint
      const y = this.bumpB1 * this.bumpY1 + this.bumpB2 * this.bumpY2 + this.bumpX;
      this.bumpX = 0;
      this.bumpY2 = this.bumpY1;
      this.bumpY1 = y;
      this.bumpCl *= this.bumpClD;
      chassis += y * this.bumpG + this.arnd() * this.bumpCl * 0.6;
    }
    const sl = Math.abs(this.slip);
    if (sl > 1.2 && this.gear > 0) {
      this.sqPhase += (820 + 180 * Math.sin(this.pos * 3 + sl) + (rnd() - 0.5) * 300) / fs;
      this.sqPhase -= Math.floor(this.sqPhase);
      chassis += Math.sin(TAU * this.sqPhase) * Math.min(1, (sl - 1.2) / 4) * 1.4;
    }

    // The wastegate dump leaves as a near-sonic jet: broadband turbulent
    // roar on top of the pulses the pipe carries (Lighthill: power ~ U^8,
    // so pressure ~ flow^4 relative; a softer power keeps it controllable).
    if (this.wgRes >= 0) {
      const u = this.ex.rU[this.wgRes];
      const nz = rnd() - 0.5;
      this.jetLp += 0.45 * (nz - this.jetLp);
      this.jetHp += 0.04 * (this.jetLp - this.jetHp);
      const a = u > 0 ? u : 0;
      src[6] = src[6] * 2.5 + (this.jetLp - this.jetHp) * a * a * 9e3;
    }

    // assemble sources (Pa at 1 m)
    const exG = this.exG;
    const buf = lis.buf;
    const w = lis.w;
    const mix = this.mix;
    buf[w] = src[0] * exG * mix[0];
    buf[SRC_BUF + w] = src[1] * exG * mix[1];
    buf[2 * SRC_BUF + w] = src[2] * exG * mix[2];
    buf[3 * SRC_BUF + w] = intake * mix[3];
    buf[4 * SRC_BUF + w] = mech * mix[4];
    buf[5 * SRC_BUF + w] = chassis * mix[5];
    buf[6 * SRC_BUF + w] = src[6] * exG * mix[6];
    lis.w = (w + 1) & SRC_MASK;

    // scope capture (tail pipe sum, cylinder 1 pressure & volume)
    const sw = this.scopeW;
    this.scopeBuf[sw] = (src[0] + src[1] + src[2]) * exG;
    this.scopeP[sw] = this.cP[0];
    this.scopeV[sw] = this.cV[0];
    this.scopeW = (sw + 1) & 16383;
    const ca0 = this.cCA[0];
    if (crossed(this.scopePrevCA, ca0, this.tdcFire)) this.onScopeCycle();
    this.scopePrevCA = ca0;
  }

  // Snapshot of cylinders + pressure along every exhaust pipe (visualiser).
  captureSnap() {
    const n = this.n;
    const ex = this.ex;
    const P = 10;
    const a = new Float32Array(8 + n * 4 + ex.S * P);
    a[0] = this.crank;
    a[1] = this.rpm;
    a[2] = this.egt;
    a[3] = this.pPl;
    a[4] = this.pB;
    a[5] = this.valveOpen;
    a[6] = this.wg;
    a[7] = this.bov;
    let o = 8;
    const exT = this.camHi ? this.exTabHi : this.exTabLo;
    const inT = this.camHi ? this.inTabHi : this.inTabLo;
    if (!this.maxAe) {
      let me = 1e-9, mi = 1e-9;
      for (let i = 0; i < exT.length; i++) {
        if (exT[i] > me) me = exT[i];
        if (inT[i] > mi) mi = inT[i];
      }
      this.maxAe = me;
      this.maxAi = mi;
    }
    for (let c = 0; c < n; c++) {
      const i0 = (this.cCA[c] * this.tabScale) | 0;
      a[o++] = this.cP[c] / 1e5;
      a[o++] = exT[i0] / this.maxAe;
      a[o++] = inT[i0] / this.maxAi;
      a[o++] = this.cBurn[c] === 2 ? this.cXb[c] + 0.01 : 0;
    }
    for (let k = 0; k < ex.S; k++) {
      ex.sampleSeg(k, P, a, o);
      o += P;
    }
    return a;
  }

  onScopeCycle() {
    const end = this.scopeW;
    let len = (end - this.scopeStart) & 16383;
    this.scopeStart = end;
    if (len < 64 || len > 16000) return;
    if (this.scopeReady) return; // previous not yet posted
    const N = 360;
    const sig = new Float32Array(N);
    const pr = new Float32Array(N);
    const vo = new Float32Array(N);
    const st = (end - len) & 16383;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * len;
      const i0 = a | 0;
      const idx = (st + i0) & 16383;
      sig[i] = this.scopeBuf[idx];
      pr[i] = this.scopeP[idx];
      vo[i] = this.scopeV[idx];
    }
    this.scopeReady = { sig, pr, vo };
  }
}
