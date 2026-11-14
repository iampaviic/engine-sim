// Starting: the electric starter motor and its sounds, and the kick start.

import { TAU } from '../constants.js';
import { clamp, ftanh, gauss, lpCoef, Modes, rnd } from '../dsp.js';

export class StarterMethods {
  // -------------------------------------------------------------------------
  // Starter motor
  // -------------------------------------------------------------------------
  //
  // A DC motor on the battery turns the flywheel through its pinion and a
  // one-way clutch. Every compression stroke loads it: the current climbs,
  // the armature slows and the gear teeth carry the load. Past top centre the
  // compressed charge pushes back and the engine runs ahead of the starter
  // until the next compression catches it up. Multiplied by the gear ratio
  // the armature's inertia is as large as the engine's, so many cylinders
  // crank at a steady speed while a twin nearly stops on every compression.
  // Everything is referred to the crank: N·m, crank rad/s, kg·m².

  initStarter(cfg) {
    const st = cfg.starter;
    const fs = this.fs;
    this.st = st;
    const Ist = st.volts / st.ohms;
    this.stTst = st.sat > 0 ? (st.K * Ist * Ist) / (Ist + st.sat) : st.K * Ist; // stall torque
    this.stIref = 0.35 * Ist;
    // brushes, bearings and gears: a free armature runs down in under a second
    this.stLoss0 = 0.035 * this.stTst;
    this.stLoss1 = (0.05 * this.stTst * st.K) / st.volts;
    this.stJ = st.inertia;
    this.stGa = (st.ring / st.pinion) * st.gearing; // armature turns per crank turn
    this.stV = st.volts;
    this.stR = st.ohms;
    this.stW = 0; // armature speed
    this.stI = 0; // motor current (A)
    this.stTc = 0; // torque through the one-way clutch
    this.stLock = false;
    this.stEng = false; // pinion in mesh, main contacts closed
    this.stNear = 1; // set by the listener
    this.alpha = 0; // crank angular acceleration
    const e = cfg.ecu;
    // A starter alone can't spin the engine past runRpm; it lets go once the
    // engine has caught and holds offRpm on its own.
    this.runRpm = Math.max(Math.min(500, e.idle * 0.6), (1.15 * 9.5493 * st.volts) / st.K);
    this.offRpm = Math.max(this.runRpm, clamp(e.idle * 0.6, 450, 900));

    // sound
    this.stActive = false;
    this.stQuiet = 0;
    this.stTooth = -1;
    this.stPin = 0;
    this.stArm = 0;
    this.stPlan = 0;
    this.stKickG = 0;
    this.stKickC = 0;
    this.stEnv = 0;
    this.stEnvK = Math.exp(-1 / (0.7 * fs));
    this.rkA = lpCoef(110, fs);
    this.rkB = lpCoef(16, fs);
    this.rk1 = 0;
    this.rk2 = 0;
    this.rkH = 0;
    // Every pinion tooth and commutator bar is a little different, and the
    // ring gear is worn where the engine comes to rest between compressions.
    this.stPinW = Float64Array.from({ length: st.pinion }, (_, k) => clamp(1 + 0.3 * Math.sin((TAU * k) / st.pinion + 1.3) + 0.18 * gauss(), 0.35, 1.9));
    const rests = Math.max(1, Math.round((this.n * 360) / this.cycle));
    this.stRingW = Float64Array.from({ length: st.ring }, (_, k) => {
      const wear = Math.pow(Math.max(0, Math.cos(TAU * ((k / st.ring) * rests + 0.25))), 12);
      return clamp(1 + 0.08 * gauss() + 0.5 * wear, 0.7, 1.8);
    });
    this.stBarW = Float64Array.from({ length: st.bars }, () => clamp(1 + 0.2 * gauss(), 0.5, 1.6));
    // flywheel, bell housing and starter case modes; sound.starter sets
    // the level against the engine's own (presets are matched to their idle)
    const sz = Math.sqrt(st.kw / 1.5) * (cfg.sound.starter ?? 1);
    const big = Math.pow(2.5 / Math.max(0.6, cfg.dispLitres), 0.12);
    this.stGear = new Modes(
      [310 * big, 560 * big, 880 * big, 1330 * big, 2050 * big],
      [0.014, 0.01, 0.007, 0.005, 0.0035],
      [0.15 * sz, 0.25 * sz, 0.21 * sz, 0.14 * sz, 0.075 * sz],
      fs
    );
    const small = Math.pow(1.5 / st.kw, 0.15);
    this.stCase = new Modes([780 * small, 1450 * small, 2350 * small, 3500 * small], [0.006, 0.005, 0.004, 0.003], [0.05 * sz, 0.08 * sz, 0.065 * sz, 0.04 * sz], fs);
    this.stMagG = 0.02 * sz;
    this.stPlanG = 0.025 * sz;
    this.rockG = 0.0008 * (cfg.sound.starter ?? 1);

    // Cranking slowly, compression leaks past the rings, and no two
    // cylinders seal quite alike.
    this.cLeak = new Float64Array(this.n).fill(1);
    this.cLeakVar = Float64Array.from({ length: this.n }, () => clamp(0.6 * gauss(), -0.9, 1.5));

    this.kick = st.type === 'kick';
    this.kicking = false;
    if (this.kick) {
      this.kickTq = st.torque;
      this.kickW = st.rpm / 9.5493;
      this.kickRevs = st.revs;
      this.kickN = 0;
      this.kickT = 0;
      this.kickRev = 0;
      this.kickWait = 0;
      this.kickGrip = 1;
      this.kickClick = 0;
      this.kickClickT = 0;
      // the leg alone spins it this fast: running means faster than that
      this.runRpm = st.rpm * 1.15;
      this.offRpm = this.runRpm;
    }
  }

  // Key to START: the solenoid clicks in, and ~40 ms later the pinion is in
  // mesh and the main contacts close.
  crankStart() {
    if (this.starter) return;
    const s = this.th;
    this.starter = true;
    this.starterT = 0;
    this.stHold = 0;
    this.rk1 = this.rk2 = this.rkH = this.J * this.alpha;
    this.stActive = true;
    if (this.kick) {
      // a moment to find compression before the first kick
      this.kickN = 0;
      this.kickWait = 0.3;
    } else {
      // A cold battery sags further under the cranking current: a lead-acid
      // cell's resistance rises about 0.3% for each kelvin it cools (an
      // estimate). The battery sits under the bonnet, a third of the way
      // from the air's temperature to the engine's.
      const bt = this.ambT + 0.3 * (s.h - this.ambT);
      const bc = Math.max(0, (this.ambT + 0.3 * (363.15 - this.ambT) - bt) / 19.5);
      this.stV = this.st.volts * (1 - 0.02 * bc);
      this.stR = this.st.ohms * (1 + 0.06 * bc);
      this.stKickC += 0.6;
    }
    if (!this.running) {
      // The ECU fires only once it has seen the cam and crank signals (a
      // dry-sump race engine is spun up for oil pressure first; a magneto
      // sparks at once), and a port wall below about 60 °C soaks up the
      // first squirts as a film, more of them the colder it is.
      this.crankRevs = 0;
      this.syncRevs = this.kick ? 0.05 : (this.st.type === 'external' ? 7 : 1.1) + 1.3 * rnd();
      const wet = Math.min(2, (333.15 - s.h) / 35);
      this.filmLeft = wet > 0 ? Math.round(this.n * (0.3 + 0.4 * rnd()) * wet) + 1 : 0;
    }
  }

  // Kick start: one stroke of the lever turns the crank ~2.5 times, then the
  // gear lets go and the lever springs back up over its ratchet. Another
  // kick follows if the engine didn't catch.
  kickControl(dtc) {
    if (this.kicking) {
      this.kickT += dtc;
      if (this.kickRev >= this.kickRevs || this.kickT > 0.45 || !this.starter) {
        this.kicking = false;
        this.kickClick = 6;
        this.kickClickT = 0.06;
        this.kickWait = 0.8 + 0.4 * rnd();
        this.stActive = true;
      }
    } else if (this.starter && !this.running) {
      this.kickWait -= dtc;
      if (this.kickWait <= 0) {
        if (this.kickN >= 6) {
          this.starter = false; // flooded or out of breath
          return;
        }
        this.kicking = true;
        this.kickN++;
        this.kickT = 0;
        this.kickRev = 0;
        this.kickGrip = 0.85 + 0.3 * rnd(); // no two kicks alike
        this.stKickG += 2.2; // boot on the lever, the kick gear snaps in
        this.stKickC += 0.8;
        this.stActive = true;
      }
    }
  }

  // Armature current at crank-referred speed w. A series field saturates
  // (flux ~ I / (I + sat)), which gives a closed form; sat = 0 is a
  // permanent-magnet motor.
  motorCurrent(w) {
    const V = this.stV, R = this.stR, K = this.st.K, S = this.st.sat;
    if (S <= 0) {
      const I = (V - K * w) / R;
      return I > 0 ? I : 0;
    }
    const b = V - R * S - K * w;
    return (b + Math.sqrt(b * b + 4 * R * V * S)) / (2 * R);
  }

  motorTorque(I) {
    const S = this.st.sat;
    return S > 0 ? (this.st.K * I * I) / (I + S) : this.st.K * I;
  }

  // Engine and starter for one sample with the pinion in mesh. net: every
  // other torque on the crank. Returns the new crank speed.
  stepStarter(omega, net, dt) {
    const J = this.J, Ja = this.stJ;
    let wa = this.stW;
    const I = this.motorCurrent(wa);
    const Tm = this.motorTorque(I) - this.stLoss0 - this.stLoss1 * wa;
    this.stI = I;
    if (this.stLock) {
      const a = (net + Tm) / (J + Ja);
      const Tc = Tm - Ja * a; // what the clutch passes on
      if (Tc >= 0) {
        this.stTc = Tc;
        const w = omega + a * dt;
        this.stW = w > 0 ? w : 0;
        return this.stW;
      }
      // the engine runs ahead: the rollers let go and the teeth unload
      this.stLock = false;
      this.stKickG += 0.12;
    }
    this.stTc = 0;
    let w = omega + (net / J) * dt;
    if (w < 0) w = 0;
    wa += (Tm / Ja) * dt;
    if (wa < 0) wa = 0;
    if (wa >= w) {
      // caught up: the rollers wedge and the two turn together
      w = wa = (J * w + Ja * wa) / (J + Ja);
      this.stLock = true;
    }
    this.stW = wa;
    return w;
  }

  // Starter sound, Pa at 1 m: pinion teeth slapping into the ring gear (hard
  // under load, a light rattle while the engine runs ahead), brushes
  // snapping across the commutator, the magnets' hum and the planetary
  // gears' whine, all following current and speed; the solenoid's clunks;
  // and the engine rocking on its mounts.
  starterSound() {
    if (this.kick) return this.kickSound();
    const st = this.st;
    const fs = this.fs;
    let gx = this.stKickG;
    let cx = this.stKickC;
    this.stKickG = 0;
    this.stKickC = 0;
    const load = this.stTc / this.stTst;
    const cur = this.stI / this.stIref;
    if (this.stEng) {
      const tooth = ((this.cCA[0] % 360) * st.ring / 360) | 0;
      if (tooth !== this.stTooth) {
        this.stTooth = tooth;
        this.stPin = this.stPin + 1 >= st.pinion ? 0 : this.stPin + 1;
        gx += (0.35 + 1.3 * load) * this.stPinW[this.stPin] * this.stRingW[tooth] * (0.8 + 0.4 * rnd());
      }
    }
    let tone = 0;
    const fa = (this.stW * this.stGa) / TAU; // armature turns per second
    if (fa > 0.2) {
      const a0 = this.stArm;
      let a1 = a0 + (fa * st.bars) / fs;
      if ((a1 | 0) !== (a0 | 0)) cx += (0.15 + 0.6 * cur) * this.stBarW[(a1 | 0) % st.bars] * (0.7 + 0.6 * rnd());
      if (a1 >= st.bars) a1 -= st.bars;
      this.stArm = a1;
      tone += Math.sin((TAU * st.poles * a1) / st.bars) * cur * this.stMagG;
      if (st.sun > 0) {
        let p = this.stPlan + (st.sun * fa * (1 - 1 / st.gearing)) / fs;
        p -= Math.floor(p);
        this.stPlan = p;
        tone += (Math.sin(TAU * p) + 0.3 * Math.sin(2 * TAU * p + 0.9)) * (0.4 + load + 0.3 * cur) * this.stPlanG * Math.min(1, fa / 40);
      }
    }
    // the mounts react the crank's angular acceleration: a low thud with
    // every compression, and a kick when the engine catches
    this.stEnv = this.stEng ? 1 : this.stEnv * this.stEnvK;
    this.rk1 += this.rkA * (this.J * this.alpha - this.rk1);
    this.rk2 += this.rkA * (this.rk1 - this.rk2);
    this.rkH += this.rkB * (this.rk2 - this.rkH);
    const thud = 0.4 * ftanh(((this.rk2 - this.rkH) * this.rockG * this.stEnv) / 0.4);
    if (this.stEng || this.stW > 0.3 || this.stEnv > 2e-3) this.stQuiet = 0;
    else if (++this.stQuiet > fs * 0.1) this.stActive = false;
    return (this.stGear.tick(gx) + this.stCase.tick(cx) + tone + thud) * this.stNear;
  }

  // Kick start sound: the kick gear snapping in and whirring through the
  // primary drive, the lever ratcheting back up and topping out on its stop,
  // and the engine rocking on its mounts.
  kickSound() {
    let gx = this.stKickG;
    let cx = this.stKickC;
    this.stKickG = 0;
    this.stKickC = 0;
    if (this.kicking) {
      const tooth = ((this.cCA[0] % 360) * 18 / 360) | 0; // primary gear teeth
      if (tooth !== this.stTooth) {
        this.stTooth = tooth;
        gx += 0.12 * (0.6 + 0.8 * rnd());
      }
    }
    if (this.kickClick > 0) {
      this.kickClickT -= this.dt;
      if (this.kickClickT <= 0) {
        this.kickClick--;
        if (this.kickClick > 0) cx += 0.4 * (0.7 + 0.6 * rnd());
        else gx += 1.1;
        this.kickClickT = 0.014 + 0.01 * rnd();
      }
    }
    this.stEnv = this.kicking ? 1 : this.stEnv * this.stEnvK;
    this.rk1 += this.rkA * (this.J * this.alpha - this.rk1);
    this.rk2 += this.rkA * (this.rk1 - this.rk2);
    this.rkH += this.rkB * (this.rk2 - this.rkH);
    const thud = 0.4 * ftanh(((this.rk2 - this.rkH) * this.rockG * this.stEnv) / 0.4);
    if (this.kicking || this.kickClick > 0 || this.stEnv > 2e-3) this.stQuiet = 0;
    else if (++this.stQuiet > this.fs * 0.1) this.stActive = false;
    return (this.stGear.tick(gx) + this.stCase.tick(cx) + thud) * this.stNear;
  }
}
