// Mechanical noise: valves landing, lash, piston slap, combustion ringing
// the block, the timing drive, injectors, the alternator and the gearbox.
// The masses, mode frequencies, tooth counts and radiation gains are worked
// out per engine in compile.js (mechSpec), where the physics is explained;
// this file turns the simulation's own events into impulses and tones.

import { KNOCK_RAD, P_AMB, TAU } from '../constants.js';
import { lpCoef, Struck } from '../dsp.js';

export class MechanicalMethods {
  initMech(cfg) {
    const m = cfg.mech;
    const fs = this.fs;
    const top = 0.45 * fs;
    const n = this.n;
    this.mech = m;
    // head and covers (valves, lash, timing chain, injectors); block and sump
    // (piston slap, combustion). An impulse in N·s comes out in Pa at 1 m.
    this.headBank = new Struck(m.headF, m.headQ, m.headG, fs);
    this.blockBank = new Struck(m.blockF, m.blockQ, m.blockG, fs);
    // The block also answers the combustion force. Fed the change in
    // cylinder pressure rather than the pressure, a mode gives its true
    // response at resonance and rejects the slow rise and fall of the cycle,
    // which the closed load path carries without moving the walls.
    this.combK = m.combArea / (TAU * Math.min(m.blockF[0], top));
    // a poor radiator at low frequencies: two one-pole high-passes
    this.radA = lpCoef(m.radF, fs);
    this.rad1 = 0;
    this.rad2 = 0;
    this.seatIn = m.seatIn;
    this.seatEx = m.seatEx;
    this.lashIn = m.lashIn;
    this.lashEx = m.lashEx;
    this.hydJ = m.hydLash; // a bled-down hydraulic lifter's tick (sim/thermal.js)
    this.vtRpmK = 1 / m.designRpm;
    this.slapK = m.slap.k;
    this.slapA = m.slap.area;
    this.slapIn = m.slap.inertia;
    this.slapLam = m.slap.lambda;
    this.slapCross = m.slap.cross;
    this.slapF = Math.PI * 0.3 * Math.min(m.blockF[1], top);
    this.injJ = m.injector;
    // Lash, clearance and injector tolerances differ a little from cylinder
    // to cylinder, the same way on every start.
    this.cTol = new Float64Array(n);
    for (let c = 0; c < n; c++) this.cTol[c] = 0.8 + 0.4 * (((c * 2654435761) >>> 0) / 4294967296);
    this.vtExcS = 0; // valve and lash impulses this sample, at design speed
    this.slapExcS = 0; // piston impulses this sample
    this.injExcS = 0; // injector impulses this sample
    this.combExcS = 0;
    // timing drive: one impulse (chain, belt) or one cycle of whine (gears)
    // per tooth of the crank sprocket
    this.timZ = m.timing.z;
    this.timJ = m.timing.impulse;
    this.timTone = m.timing.tone;
    this.timStep = m.timing.z / (TAU * fs);
    this.timPh = 0;
    // alternator: charging hard after a start, easing off as the battery fills
    this.altOrder = m.alternator.order;
    this.altPa = m.alternator.pa;
    this.altStep = m.alternator.order / (TAU * fs);
    this.altPh = 0;
    this.altLoad = 1;
    this.altK = 1 / (15 * fs);
    // gearbox: input and output shaft angles (turns), so the mesh and its
    // sidebands stay locked to the shafts
    this.gearIn = 0;
    this.gearOut = 0;
    this.gearTinv = 1 / this.peakTorqueGuess();
    this.axleSnd = 0;
    this.mRs = 0x9e3779b9;
  }

  // The mechanical sounds' own random stream: changing them never disturbs
  // the engine's cycle-to-cycle variation.
  mrnd() {
    let s = this.mRs;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.mRs = s;
    return (s >>> 0) * 2.3283064365386963e-10;
  }

  // Piston c passes a dead centre: the impulse (N·s) of its slap across the
  // bore. The side force reverses there at a rate F' = |axial force| (r/l)
  // omega; gas pressure pushes the piston down, its inertia pulls it on past
  // top centre and pushes it into bottom centre. The oil film spreads the
  // blow over a time that the block's modes may or may not notice.
  slap(c, top) {
    const w = this.omega;
    if (w < 5) return 0;
    const lam = this.slapLam;
    const gas = (this.cP1[c] - (this.twoStroke ? this.ccP[c] : P_AMB)) * this.slapA;
    const inertia = this.slapIn * w * w * (top ? 1 + lam : 1 - lam);
    const f = top ? gas - inertia : gas + inertia;
    const fd = (f < 0 ? -f : f) * lam * w + 1;
    // a blow lasting a third of the crossing time, against the period of the
    // block's second mode
    const x = this.slapF * Math.cbrt(this.slapCross / fd);
    return (this.slapK * this.cTol[c] * Math.cbrt(fd)) / (1 + x * x);
  }

  // Engine structure and accessories this sample, Pa at 1 m.
  stepMech(rpm, omega) {
    let xh = this.injExcS;
    // valve seating and lash: the cam's ramps set the velocity, so the
    // impulse grows with speed; no two landings are quite alike
    if (this.vtExcS > 0 && rpm > 30) xh += this.vtExcS * rpm * this.vtRpmK * (0.85 + 0.3 * this.mrnd());
    let out = 0;
    if (this.timZ > 0 && omega > 6) {
      this.timPh += this.timStep * omega;
      if (this.timJ > 0) {
        if (this.timPh >= 1) {
          this.timPh -= Math.floor(this.timPh);
          xh += this.timJ * rpm * (0.8 + 0.4 * this.mrnd());
        }
      } else {
        this.timPh -= Math.floor(this.timPh);
        const f = (this.timZ * omega) / TAU;
        if (f < 0.4 * this.fs) out += (Math.sin(TAU * this.timPh) * this.timTone * f) / (f * f + 250000);
      }
    }
    const st = this.headBank.tick(xh) + this.blockBank.tick(this.slapExcS + this.combExcS * this.combK);
    this.rad1 += this.radA * (st - this.rad1);
    const h1 = st - this.rad1;
    this.rad2 += this.radA * (h1 - this.rad2);
    out += h1 - this.rad2;
    out += this.knockSndS * KNOCK_RAD;
    if (this.altPa > 0) {
      if (this.stActive) this.altLoad = 1;
      else this.altLoad += this.altK * (0.25 - this.altLoad);
      if (this.running && omega > 20) {
        this.altPh += this.altStep * omega;
        this.altPh -= Math.floor(this.altPh);
        const f = (this.altOrder * omega) / TAU;
        if (f < 0.4 * this.fs) out += Math.sin(TAU * this.altPh) * this.altPa * Math.min(4, rpm * 0.00125) * this.altLoad;
      }
    }
    return out;
  }

  // Gear whine in the engaged gear, Pa at 1 m: the loaded mesh's tooth
  // frequency and two harmonics, heavier under load (the teeth deflect more),
  // with each shaft's runout modulating it once a turn, which puts sidebands
  // one shaft order either side. A final drive in the gearbox is heard with
  // it; one in a rear axle goes to the chassis (axleSnd).
  gearSound() {
    const fs = this.fs;
    const g = this.mech.gears;
    const fOut = (this.ww * this.veh.final) / TAU; // gearbox output shaft, Hz
    const fIn = fOut * this.veh.gears[this.gear - 1];
    this.gearOut += fOut / fs;
    this.gearOut -= Math.floor(this.gearOut);
    this.gearIn += fIn / fs;
    this.gearIn -= Math.floor(this.gearIn);
    const t = this.gearTorque * this.gearTinv;
    const load = 0.35 + 0.65 * Math.min(1.5, t < 0 ? -t : t);
    const wob = (1 + 0.15 * Math.sin(TAU * this.gearIn)) * (1 + 0.15 * Math.sin(TAU * this.gearOut + 1)) * load;
    const h = g.harm;
    let box = 0;
    const zin = g.zin[this.gear - 1];
    const fm = fIn * zin;
    if (fm > 20 && fm < 0.4 * fs) {
      // sin of 2x and 3x the mesh angle from one sine and cosine
      const th = TAU * zin * this.gearIn;
      const s = Math.sin(th), c = Math.cos(th);
      box = ((s * h[0] + 2 * s * c * h[1] + s * (3 - 4 * s * s) * h[2]) * g.rad * fm * wob) / (fm * fm + 250000);
    }
    let axle = 0;
    const ff = fOut * g.pinion;
    if (ff > 20 && ff < 0.4 * fs) {
      const th = TAU * g.pinion * this.gearOut;
      const s = Math.sin(th);
      axle = ((s * (1 + 0.5 * Math.cos(th))) * g.finalRad * ff * wob) / (ff * ff + 250000);
    }
    if (g.transaxle) return box + axle;
    this.axleSnd = axle;
    return box;
  }
}
