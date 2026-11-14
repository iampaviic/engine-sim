// Drivetrain and vehicle: clutch, gearbox and shifts, tyres, traction and
// launch control, the dyno brake, and following a real car.

import { P_AMB, TAU } from '../constants.js';
import { clamp, ftanh } from '../dsp.js';

export class DrivetrainMethods {
  vehicleControl(dtc, rpm) {
    const v = this.veh;
    if (this.follow) this.followStep(dtc);
    if (this.mode === 'dyno') {
      this.gear = 0;
      this.clutchCap = 0;
      if (this.dyno && this.dyno.active) {
        const d = this.dyno;
        d.t += dtc;
        if (d.phase === 'settle') {
          d.target = d.start;
          this.pedal = 1;
          if (d.t > 1.2) {
            d.phase = 'sweep';
            d.t = 0;
          }
        } else if (d.phase === 'sweep') {
          d.target = d.start + d.rate * d.t;
          this.pedal = 1;
          if (d.target >= d.end) {
            d.phase = 'done';
            d.active = false;
            this.pedal = 0;
            this.posts.push({ type: 'dyno-done' });
          }
        }
        // PI absorber
        const errW = rpm - d.target;
        if (d.phase === 'follow') {
          // a motoring dyno: it brakes the engine or drives it, so the engine
          // runs where the car's does, on overrun too; the lead covers the
          // torque to speed the crank up along with the car's
          if (d.target < 250 || this.stEng) {
            this.dynoI = 0;
            this.dynoLoad = 0;
          } else {
            this.dynoI = clamp(this.dynoI + errW * 25 * dtc, -1500, 6000);
            this.dynoLoad = errW * 4 + this.dynoI - this.J * (d.rate / 9.5493) * 0.8;
          }
        } else {
          this.dynoI = clamp(this.dynoI + errW * 25 * dtc, 0, 6000);
          this.dynoLoad = Math.max(0, errW * 4 + this.dynoI);
        }
        if (d.phase === 'sweep' && d.t > 0.05 && this.telN > 0) {
          // record brake torque vs rpm
        }
      } else {
        this.dynoLoad = Math.max(0, this.dynoLoad - dtc * 2000);
        this.dynoI = 0;
      }
      return;
    }
    this.dynoLoad = 0;
    if (this.mode === 'rev') {
      this.gear = 0;
      this.clutchCap = 0;
      this.v *= Math.max(0, 1 - dtc * 2);
      this.ww = this.v / v.tire;
      return;
    }
    // drive / flyby
    const maxT = 1.5 * this.peakTorqueGuess();
    const G = this.gear > 0 ? v.gears[this.gear - 1] * v.final : 0;
    const wIn = this.ww * G;

    if (this.shift) {
      const s = this.shift;
      s.t += dtc;
      const T = v.shiftTime;
      if (s.phase === 'out') {
        this.clutch = Math.max(0, 1 - s.t / (T * 0.3));
        if (s.t >= T * 0.3) {
          this.gear = s.to;
          s.phase = 'in';
          s.t = 0;
          if (s.dir < 0) this.blip = T * 0.9;
        }
      } else {
        this.clutch = Math.min(1, s.t / (T * 0.7));
        if (s.t >= T * 0.7) {
          this.clutch = 1;
          this.shift = null;
        }
      }
    } else if (this.gear > 0) {
      // Auto-clutch for pulling away and stopping.
      const stall = Math.max(900, this.ecu.idle * 1.15);
      if (this.launch && this.v < 1 && this.pedal > 0.5) {
        this.clutch = 0;
      } else if (wIn * 9.549 < stall && this.pedal < 0.05) {
        // creeping / stopping: let the clutch slip to avoid stalling
        this.clutch += (0 - this.clutch) * Math.min(1, dtc * 10);
      } else if (wIn * 9.549 < rpm - 150 && this.v < 14) {
        // pull-away: slip the clutch to hold the engine near a launch speed
        // that rises with pedal (DCT-style launch).
        const tgt = stall + 250 + this.pedal * Math.max(0, this.launchRpm - stall - 250) * 0.85;
        this.clutch = clamp(this.clutch + (rpm - tgt) * 0.0009 * dtc * 60, 0, 1);
      } else {
        this.clutch = Math.min(1, this.clutch + dtc * 6);
      }
      if (this.clutchPedal > 0.5) this.clutch = 0;
    } else {
      this.clutch = 0;
    }
    this.clutchCap = maxT * this.clutch;

    // Automatic gear selection (sporty DCT logic: holds the gear on lift-off,
    // blips down when slowing). Decisions use road speed, not wheel speed, so
    // wheelspin doesn't confuse it.
    this.shiftCool = Math.max(0, this.shiftCool - dtc);
    if (this.autoShift && !this.shift && this.gear > 0 && this.shiftCool <= 0) {
      const red = this.limitRpm;
      const roadRpm = (this.v / v.tire) * G * 9.549;
      const up = this.pedal > 0.6 ? red - 250 : 2600 + 3200 * this.pedal;
      const down = this.pedal > 0.8 ? red * 0.52 : this.pedal > 0.1 ? 1500 + 900 * this.pedal : 1450 + 350 * this.brake;
      if (this.pedal > 0.12 && rpm > up && roadRpm > up * 0.8 && this.gear < v.gears.length && this.clutch > 0.95 && (!this.holdGear || rpm > red - 200)) this.requestShift(1);
      else if (roadRpm < down && this.gear > 1 && this.v > 3) {
        const G2 = v.gears[this.gear - 2] * v.final;
        if ((this.v / v.tire) * G2 * 9.549 < red - 600) this.requestShift(-1);
      }
    }
    if (this.gear > 1 && this.v < 1.5 && !this.shift && this.pedal < 0.05) this.gear = 1;
  }

  peakTorqueGuess() {
    const boost = this.isTurbo || this.isSC || this.isCentri ? 1 + this.boostTarget / P_AMB : 1;
    return 110 * this.cfg.dispLitres * boost + 50;
  }

  // Following a real car, control rate: carry each reading forward along its
  // trend until the next one arrives (they come 5 to 25 times a second) and
  // smooth the steps out.
  followStep(dtc) {
    const f = this.follow;
    f.age += dtc;
    const ahead = Math.min(f.age, 0.3);
    const k = Math.min(1, dtc * 22);
    f.pedS += (f.pedal - f.pedS) * k;
    this.pedal = f.pedS;
    this.brake = f.brake;
    const vT = Math.max(0, f.v + f.a * Math.min(f.age, 0.5));
    f.vS += (vT - f.vS) * Math.min(1, dtc * 12);
    if (f.kind === 'rpm') {
      const rT = Math.max(0, f.rpm + f.rate * ahead);
      f.rpmS += (rT - f.rpmS) * k;
      if (this.dyno?.phase === 'follow') {
        this.dyno.target = f.rpmS;
        this.dyno.rate = f.age < 0.3 ? f.rate : 0;
      }
      // the wind and the road still go by at the car's speed
      this.v = f.vS;
      this.ww = this.v / this.veh.tire;
      this.followV = -1;
    } else {
      this.followV = f.vS;
      this.followA = f.age < 0.5 ? f.a : 0;
    }
  }

  // A reading from the car: rpm (with its rate, rpm/s) when it reports one,
  // else just road speed; pedal 0..1; speed m/s; accel m/s^2.
  setFollow(m) {
    if (m.stop) {
      this.follow = null;
      this.followV = -1;
      if (this.dyno?.phase === 'follow') this.dyno.active = false;
      this.dynoLoad = 0;
      this.pedal = 0;
      this.brake = 0;
      return;
    }
    const kind = m.rpm != null ? 'rpm' : 'speed';
    let f = this.follow;
    if (!f || f.kind !== kind) {
      f = this.follow = { kind, age: 0, rpm: m.rpm ?? 0, rate: 0, pedal: 0, pedS: 0, brake: 0, v: m.speed ?? 0, vS: m.speed ?? 0, a: 0, rpmS: m.rpm ?? this.rpm };
      if (kind === 'rpm') {
        this.mode = 'dyno';
        this.gear = 0;
        this.dyno = { active: true, phase: 'follow', t: 0, start: 0, end: 0, rate: 0, target: f.rpmS };
        this.dynoI = 0;
      } else {
        this.mode = 'drive';
        this.dyno = null;
        this.autoShift = true;
        this.shift = null;
        if (this.gear === 0) this.gear = 1;
        this.clutch = 1;
        const vh = this.veh;
        this.ww = f.v / vh.tire;
        this.v = f.v;
      }
    }
    f.age = 0;
    if (m.rpm != null) {
      f.rpm = m.rpm;
      f.rate = m.rate ?? 0;
    }
    f.pedal = clamp(m.pedal ?? 0, 0, 1);
    f.brake = clamp(m.brake ?? 0, 0, 1);
    f.v = Math.max(0, m.speed ?? 0);
    f.a = m.accel ?? 0;
  }

  requestShift(dir) {
    const v = this.veh;
    if (this.mode !== 'drive' && this.mode !== 'flyby') return;
    if (this.shift) return;
    const to = clamp(this.gear + dir, 0, v.gears.length);
    if (to === this.gear) return;
    if (this.gear === 0) {
      this.gear = to;
      this.clutch = 0;
      return;
    }
    if (to === 0) {
      this.gear = 0;
      return;
    }
    this.shift = { dir, to, t: 0, phase: 'out' };
    this.shiftCool = dir > 0 ? 1.2 : 0.6;
    if (dir > 0 && this.pedal > 0.3) {
      this.shiftCut = v.shiftTime * 0.45;
      this.shiftRetard = 1;
    }
  }

  // Crank, clutch, wheels and car. Returns the new crank speed.
  stepDrivetrain(omega, torque, scTorque) {
    const dt = this.dt;
    let tq = torque - this.fric * ftanh(omega * 0.5) - scTorque;
    if (this.kicking) {
      // the leg pushes hardest from rest and can't drive the crank past the
      // speed it straightens at
      const f = 1 - omega / this.kickW;
      if (f > 0) tq += this.kickTq * this.kickGrip * f;
      this.kickRev += (omega * dt) / TAU;
    }
    let load = 0;
    if (this.mode === 'dyno') {
      load = this.dynoLoad;
    } else if (this.gear > 0 && this.clutchCap > 0) {
      const v = this.veh;
      const G = v.gears[this.gear - 1] * v.final;
      const slipW = omega - this.ww * G;
      const Jwe = this.Jw + 0.04 * G * G;
      const kmax = 0.45 / (this.clutchCap * dt * (1 / this.J + (G * G) / Jwe) + 1e-9);
      const k = kmax < 0.6 ? kmax : 0.6;
      load = this.clutchCap * ftanh(slipW * k);
      this.clutchT = load;
      // wheel & car
      const vv = this.v;
      const slipV = this.ww * v.tire - vv;
      const Nz = this.axleLoad + this.loadTransfer * Math.max(0, this.accel);
      const as = slipV < 0 ? -slipV : slipV;
      const mu = v.mu * ftanh(slipV / 0.55) * (1 - 0.22 * clamp((as - 1.5) / 8, 0, 1));
      const Fx = Nz * mu;
      const brakeT = this.brake * this.brakeK * v.tire * 0.45 * ftanh(this.ww * 4);
      this.ww += ((load * G * 0.92 - Fx * v.tire - brakeT) / Jwe) * dt;
      const drag = this.dragK * vv * vv + this.rollK * ftanh(vv * 2);
      const brakeF = this.brake * this.brakeK * 0.55 * ftanh(vv * 3);
      const acc = (Fx - drag - brakeF) / v.mass;
      this.accel = acc;
      this.v = vv + acc * dt;
      if (this.v < 0 && this.brake > 0.05) this.v = 0;
      this.slip = slipV;
      this.gearTorque = load;
    } else if (this.mode === 'drive' || this.mode === 'flyby') {
      // coasting in neutral / clutch open
      const v = this.veh;
      const vv = this.v;
      const drag = this.dragK * vv * vv + this.rollK * ftanh(vv * 2);
      const brakeF = this.brake * this.brakeK * ftanh(vv * 3);
      this.accel = (-drag - brakeF) / v.mass;
      this.v = Math.max(0, vv + this.accel * dt);
      this.ww = this.v / v.tire;
      this.slip = 0;
      this.clutchT = 0;
      this.gearTorque = 0;
    }
    if (this.followV >= 0 && this.mode === 'drive') {
      // following a real car's speed: the road holds the wheels to it
      this.v = this.followV;
      this.ww = this.v / this.veh.tire;
      this.slip = 0;
      this.accel = this.followA;
    }
    this.pos += this.v * dt;
    const net = torque - this.fric - scTorque;
    this.telTq += net;
    this.telN++;
    this.cycTq += net;
    this.cycN++;
    let w;
    if (this.stEng) w = this.stepStarter(omega, tq - load, dt);
    else {
      w = omega + ((tq - load) / this.J) * dt;
      if (w < 0) w = 0;
      if (this.stW > 0) {
        // pinion out: the armature runs down on its own
        const wa = this.stW - ((this.stLoss0 + this.stLoss1 * this.stW) / this.stJ) * dt;
        this.stW = wa > 0 ? wa : 0;
        this.stI = 0;
      }
    }
    this.alpha = (w - omega) / dt;
    return w;
  }
}
