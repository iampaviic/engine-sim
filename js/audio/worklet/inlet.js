// The inlet tract: the way the air comes in, from the open air to the
// throttle (or to the bell mouths, or to a compressor's inlet), and so the
// way the induction sound gets out.
//
// A production airbox is an expansion chamber with the filter element across
// it and a snorkel to the outside. Both are modelled as plane-wave pipes:
//
//   source -> [ half the chamber ] -> filter -> [ the other half ] -> [ snorkel ] -> mouth
//
// At low frequency this is the Helmholtz resonator the intake designer
// tunes (the chamber's air is the spring, the snorkel's the mass: 50-70 Hz
// for a car), which passes the lowest engine orders and takes 12 dB per
// octave off everything above. Higher up it is an expansion chamber whose
// loss comes and goes with the chamber's and the snorkel's own resonances,
// and the snorkel's half-wave modes let bands of the roar back through
// (Munjal, Acoustics of Ducts and Mufflers, ch. 2 and 8).
//
// An open filter on a pipe has no chamber: the pipe is closed at the throttle
// end by the source and open at the filter, and it honks at its quarter-wave
// modes.
//
// The tract is driven one way: the engine draws its flow as if from still
// air, and that flow is the source here. The tract's pressure does not act
// back on the engine's breathing.
//
// Everything runs on the time derivative of mass flow, kg/s^2 (the tract is
// linear, and the far field of a small source is d(mdot)/dt / 4 pi r), so a
// sound already expressed as pascals at 1 m in the open can be fed in as
// 4 pi times itself.

import { C_AIR, INV4PI, TAU } from './constants.js';
import { lpCoef } from './dsp.js';

const RHO_AIR = 1.184;

export class Inlet {
  // d: { box, lb, sb, ls, ss, filt } from inletSpec() in compile.js.
  constructor(d, fs) {
    this.box = d.box ? 1 : 0;
    this.direct = d.direct ? 1 : 0;
    // mass-flow wave impedance of a pipe, Pa per kg/s: c / S
    this.zb = C_AIR / d.sb;
    this.zs = C_AIR / d.ss;
    this.ys = 1 / this.zs;
    this.rf = d.filt;
    this.jk = 2 / (this.zb + this.zs);
    this.fk = 2 / (2 * this.zb + this.rf);
    this.nb = Math.max(2, Math.round((d.lb / C_AIR) * fs));
    this.nh = Math.max(1, Math.round((0.5 * d.lb / C_AIR) * fs));
    this.fd = new Float64Array(1024);
    this.gd = new Float64Array(1024);
    this.ns = Math.max(2, Math.round((d.ls / C_AIR) * fs));
    this.fb = new Float64Array(1024);
    this.gb = new Float64Array(1024);
    this.fsn = new Float64Array(1024);
    this.gsn = new Float64Array(1024);
    this.i = 0;
    // Open end: what comes back is low-passed where the mouth stops being
    // small against the wavelength (ka about 0.5, Levine and Schwinger), as
    // the exhaust's tail pipes are.
    const a = Math.sqrt((this.box ? d.ss : d.sb) / Math.PI);
    this.mA = lpCoef((0.5 * C_AIR) / (TAU * a), fs);
    this.mLp = 0;
    this.sm = this.box ? d.ss : d.sb;
    // An open filter sits on the pipe's end: a resistance in series with the
    // radiation, which takes (z - r) / (z + r) off the reflection.
    this.rEnd = this.box ? 1 : (this.zb - this.rf) / (this.zb + this.rf);
    this.r = 0.97 * this.rEnd;
    // Above the chamber's first cross mode (half a wavelength across it) the
    // sound in it is no longer a plane wave going back and forth, and the
    // filter's pleats soak it up: the wave returning from the far wall is
    // low-passed there, which leaves the direct path at high frequency.
    this.cA = lpCoef(C_AIR / (2 * Math.sqrt(d.sb)), fs);
    this.cLp = 0;
  }

  // The air flowing in through the mouth takes sound energy with it: the
  // reflection of an open end with inflow at Mach M is (1 - M) / (1 + M)
  // (Davies, Practical flow duct acoustics, J. Sound Vib. 124, 1988). mdot
  // is the mean flow, kg/s. Called at control rate.
  setFlow(mdot) {
    let m = (mdot < 0 ? -mdot : mdot) / (RHO_AIR * C_AIR * this.sm);
    if (m > 0.5) m = 0.5;
    this.r = (0.97 * this.rEnd * (1 - m)) / (1 + m);
  }

  // s: d/dt of the mass flow the source pushes into the tract, towards the
  // mouth. Returns the sound pressure 1 m from the mouth, Pa.
  tick(s) {
    if (this.direct) return s * INV4PI;
    const i = this.i;
    this.i = (i + 1) & 1023;
    const fb = this.fb, gb = this.gb;
    const ib = (i - this.nb) & 1023;
    if (!this.box) {
      // pipe: source in a closed end, the filter and the open air at the other
      const a = fb[ib];
      const lp = (this.mLp += this.mA * (a - this.mLp));
      const b = -this.r * lp;
      gb[i] = b;
      fb[i] = gb[ib] + this.zb * s;
      return (a - b) * INV4PI / this.zb;
    }
    // the chamber's wall behind the source
    const hb = (i - this.nh) & 1023;
    const back = (this.cLp += this.cA * (gb[hb] - this.cLp));
    fb[i] = back + this.zb * s;
    // the filter element, across the middle of the chamber
    const fd = this.fd, gd = this.gd;
    const f1 = fb[hb], g1 = gd[hb];
    const qf = (f1 - g1) * this.fk;
    gb[i] = f1 - this.zb * qf;
    fd[i] = g1 + this.zb * qf;
    // chamber into snorkel
    const fs_ = this.fsn, gs = this.gsn;
    const is = (i - this.ns) & 1023;
    const fa = fd[hb], ga = gs[is];
    const q = (fa - ga) * this.jk;
    gd[i] = fa - this.zb * q;
    fs_[i] = ga + this.zs * q;
    // the mouth
    const a = fs_[is];
    const lp = (this.mLp += this.mA * (a - this.mLp));
    const b = -this.r * lp;
    gs[i] = b;
    return (a - b) * this.ys * INV4PI;
  }
}
