// The manual gearbox: the driver's clutch, the synchronisers, a gear that
// will not go in and grinds, and the input shaft that spins on its own while
// no gear is engaged. The automatic gearbox (sim/drivetrain.js) never comes
// here. The sizes (dog teeth, synchroniser torque, the casing's modes) are
// worked out in compile.js (mechSpec's shift, and the vehicle's synchro).

import { TAU } from '../constants.js';
import { ftanh, Struck } from '../dsp.js';

// The clutch's grip against pedal travel (0 up, 1 floored). The first few
// per cent is free play; from there the release bearing lifts the diaphragm
// spring's fingers and the pressure plate backs off, the cushion springs
// between the facings unloading as it goes, until near the middle of the
// travel the facings part: the bite point. The cushion springs are
// progressive, so the clamping load, and the torque the clutch can carry,
// falls steeply at first and then gently into the bite (Vasca et al.,
// IEEE/ASME Trans. Mechatronics 16(3), 2011, measured a dry clutch's torque
// against release-bearing travel). Free play and bite are typical figures.
const CL_FREE = 0.06;
const CL_BITE = 0.42;
// The input side: clutch disc, input shaft and the gears on it, kg m^2 (the
// drivetrain's own figure), and its oil drag, N·m per rad/s (an estimate:
// about a newton-metre at 2,500 rpm).
const J_IN = 0.04;
const DRAG_IN = 0.004;
// A driver pushes a gear that will not go for about a second before giving
// up, and a synchroniser's blocker holds out against an engine (which it is
// not made to stop) for about the synchronising time it is designed for
// (estimates). Out of gear, the sleeve takes 40 ms to clear its dogs.
const T_BLOCK = 0.3;
const T_GIVE_UP = 0.9;
const T_OUT = 0.04;

export class GearboxMethods {
  initGearbox(cfg) {
    const s = cfg.mech.shift;
    this.gbx = s;
    this.caseBank = new Struck(s.caseF, s.caseQ, s.caseG, this.fs);
    this.grPh = 0;
    this.grRing = 0; // samples the casing rings on after the last blow
    this.grHold = Math.round(0.05 * this.fs);
  }

  // The driver takes over the gearbox, or hands it back: no shift is left
  // half done, and the input shaft starts where the drivetrain has it.
  setManualOn(on) {
    this.manualOn = on;
    this.msPhase = 0;
    this.shift = null;
    const v = this.veh;
    if (on) this.wIn = this.gear > 0 ? this.ww * v.gears[this.gear - 1] * v.final : this.omega;
    else if (this.gear === 0 && this.mode === 'drive') this.gear = 1;
  }

  // Control rate: the clutch follows the pedal, and a shift under way moves on.
  manualControl(dtc) {
    const v = this.veh;
    const p = this.clutchPedal;
    const x = (CL_BITE - p) / (CL_BITE - CL_FREE);
    this.clutch = p <= CL_FREE ? 1 : p >= CL_BITE ? 0 : x * x;
    // the same reserve over the engine's torque as the automatic's clutch
    this.clutchCap = 1.5 * this.peakTorqueGuess() * this.clutch;
    if (this.msPhase === 0) return;
    this.msT += dtc;
    if (this.msPhase === 1) {
      // Out of gear: the sleeve slides off its dogs while the torque on them
      // (the clutch's, through this gear) is below what the push can free,
      // and stays put while it is above: driving or on the overrun, a gear
      // comes out only as the load passes through zero.
      const tq = this.gearTorque < 0 ? -this.gearTorque : this.gearTorque;
      if (tq * v.gears[this.gear - 1] < this.gbx.hold) this.msFree += dtc;
      if (this.msFree >= T_OUT) {
        // the input side spins on at the old gear's speed
        this.wIn = this.ww * v.gears[this.gear - 1] * v.final;
        this.gear = 0;
        if (this.msTo === 0) {
          this.msPhase = 0;
          this.nLo = 0;
          this.nHi = this.msFrom;
        } else {
          this.msPhase = 2;
          this.msT = 0;
        }
      } else if (this.msT > T_GIVE_UP) {
        // held in gear under load: the lever will not come out
        this.msPhase = 0;
        this.evRefused++;
      }
      return;
    }
    // Into the new gear: the speed across its synchroniser (the gear, turned
    // by the input shaft, against the output shaft)
    const r = v.gears[this.msTo - 1];
    const d = (this.wIn - this.ww * r * v.final) / r;
    const ad = d < 0 ? -d : d;
    if (ad < this.gbx.window) {
      // close enough: the sleeve's teeth slide in between the dogs
      this.gear = this.msTo;
      this.msPhase = 0;
      return;
    }
    if (this.msPhase === 2 && this.msT > T_BLOCK) this.msPhase = 3;
    if (this.msPhase === 3) {
      // the speed difference the dogs grind at, as the engine sees it (rpm)
      const g = ad * r * 9.5493;
      if (g > this.evGrind) this.evGrind = g;
      if (this.msT > T_GIVE_UP) {
        // the driver gives up: the box stays in neutral, between the two
        this.msPhase = 0;
        this.nLo = Math.min(this.msFrom, this.msTo);
        this.nHi = Math.max(this.msFrom, this.msTo);
        this.evRefused++;
      }
    }
  }

  // The lever moves one gear up or down (or into neutral below first).
  // From neutral it goes to one of the gears either side of it: after a
  // refused shift, back to the old gear or on to the new one.
  manualShift(dir) {
    if (this.msPhase !== 0) return;
    const n = this.veh.gears.length;
    let to;
    if (this.gear > 0) to = Math.max(0, Math.min(n, this.gear + dir));
    else to = dir > 0 ? Math.max(1, this.nHi) : this.nLo;
    if (to === this.gear) return;
    this.msFrom = this.gear;
    this.msTo = to;
    this.msT = 0;
    this.msFree = 0;
    if (this.gear > 0) this.msPhase = 1;
    else {
      this.msFrom = to > this.nLo ? this.nLo : this.nHi;
      this.msPhase = 2;
    }
  }

  // Per sample, while no gear is engaged: the input shaft between the clutch
  // and the synchroniser. Returns the clutch's torque on the crank. (The
  // synchroniser's reaction on the car is far too small for it to notice.)
  stepInputShaft(omega) {
    const v = this.veh;
    if (this.gear > 0) {
      this.wIn = this.ww * v.gears[this.gear - 1] * v.final;
      return 0;
    }
    const dt = this.dt;
    let load = 0;
    const cap = this.clutchCap;
    if (cap > 0) {
      // friction with a slope the explicit step can carry (as the
      // drivetrain's clutch does)
      const kmax = 0.45 / (cap * dt * (1 / this.J + 1 / J_IN));
      load = cap * ftanh((omega - this.wIn) * (kmax < 0.6 ? kmax : 0.6));
    }
    let ts = 0;
    if (this.msPhase >= 2) {
      // the cone, and while grinding the dogs' blows too (about the push at
      // the dog radius, at the gear: an estimate), drag the input side
      // towards the new gear's speed
      const r = v.gears[this.msTo - 1];
      const T = v.synchro + (this.msPhase === 3 ? (this.gbx.push * this.gbx.dogR) / r : 0);
      const ks = (0.45 * J_IN) / (T * dt);
      ts = T * ftanh((this.wIn - this.ww * r * v.final) * (ks < 2 ? ks : 2));
    }
    const w = this.wIn + ((load - ts - DRAG_IN * this.wIn) / J_IN) * dt;
    this.wIn = w > 0 ? w : 0;
    return load;
  }

  // Per sample, Pa at 1 m: the gear grinding. The sleeve's teeth hammer
  // over the gear's dogs, one passing per dog tooth; it hits about every
  // other one, each blow averaging out the driver's push but never harder
  // than the sleeve's mass meeting a tooth at the slip speed (with a
  // restitution of 0.5); the casing's modes ring with each. Drawn from the
  // mechanical sounds' own random stream.
  grindSound() {
    let x = 0;
    if (this.msPhase === 3) {
      const v = this.veh;
      const s = this.gbx;
      const r = v.gears[this.msTo - 1];
      const d = (this.wIn - this.ww * r * v.final) / r;
      const ad = d < 0 ? -d : d;
      const f = (ad * s.dogZ) / TAU;
      this.grPh += f * this.dt;
      if (this.grPh >= 1) {
        this.grPh -= Math.floor(this.grPh);
        if (this.mrnd() < 0.5) {
          const jAvg = s.push / (0.5 * f);
          const jMax = 1.5 * s.sleeve * ad * s.dogR;
          x = (jAvg < jMax ? jAvg : jMax) * (0.6 + 0.8 * this.mrnd());
        }
      }
      this.grRing = this.grHold;
    } else this.grRing--;
    return this.caseBank.tick(x);
  }
}
