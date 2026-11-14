// The ECU, at control rate: tuning maps, idle, limiter, fuel cut, knock
// control, boost control, cam switching, and the exhaust valves and other
// resistors it moves.

import { DYN_STAGE, DYN_TURBINE, DYN_VALVE, DYN_WASTEGATE, KNOCK_CAL, P_AMB, R, T_AMB } from '../constants.js';
import { axisAt, clamp, lerpAt, rnd } from '../dsp.js';

export class EcuMethods {
  // Tuning maps from the workshop: an ignition trim over rpm and manifold
  // pressure, the full-load mixture and boost target over rpm, and the share
  // of that boost each gear may use. Cells left as the factory set them are
  // dropped, so an untouched map changes nothing at all.
  setMaps(m) {
    this.maps = m ?? null;
    const flat = (a) => (a ? Float64Array.from(a.flat()) : null);
    this.mRpm = flat(m?.rpm);
    this.mKpa = flat(m?.kpa);
    this.mSpark = flat(m?.spark);
    if (this.mSpark && this.mSpark.every((x) => x === 0)) this.mSpark = null;
    this.mAfr = flat(m?.afr);
    if (this.mAfr && this.mAfr.every((x) => x === this.afrTarget)) this.mAfr = null;
    this.mBoost = flat(m?.boost);
    this.mGear = flat(m?.gear);
    if (this.mGear && this.mGear.every((x) => x === 1)) this.mGear = null;
  }

  // ignition trim (degrees) at this rpm and manifold pressure
  sparkMap(rpm) {
    const cols = this.mRpm.length;
    const pc = axisAt(this.mRpm, rpm), pr = axisAt(this.mKpa, this.pPl / 1000);
    const c = Math.min(cols - 2, Math.floor(pc)), r = Math.min(this.mKpa.length - 2, Math.floor(pr));
    const fc = pc - c, fr = pr - r;
    const t = this.mSpark, i = r * cols + c;
    const lo = t[i] + (t[i + 1] - t[i]) * fc;
    const hi = t[i + cols] + (t[i + cols + 1] - t[i + cols]) * fc;
    return lo + (hi - lo) * fr;
  }

  setOctane(ron) {
    this.octane = ron;
    this.kTauInv = (this.cfg.ecu.knockCal || KNOCK_CAL) / (17.68e-3 * Math.pow(ron / 100, 3.402));
  }

  // -------------------------------------------------------------------------
  // Control-rate logic (ECU, gearbox automation, boost control)
  // -------------------------------------------------------------------------

  control(dtc) {
    const rpm = this.rpm;
    const e = this.ecu;
    this.sinceStart += dtc;

    // Starter: let go once the engine has caught and holds its own speed
    if (this.starter) {
      this.starterT += dtc;
      this.crankRevs += (rpm / 60) * dtc;
      this.stHold = this.running && rpm > this.offRpm ? this.stHold + dtc : 0;
      if (!this.ignition || this.stHold > 0.1 || this.starterT > (this.kick ? 9 : 6)) this.starter = false;
    }
    if (this.kick) this.kickControl(dtc);
    // the pinion meshes and the main contacts close ~40 ms after the key
    const eng = this.starter && this.starterT > 0.04 && !this.kick;
    if (eng !== this.stEng) {
      this.stEng = eng;
      this.stLock = false;
      this.stTc = 0;
      if (eng) {
        this.stKickG += 3.5; // pinion slams into the ring gear
        this.stKickC += 3;
      } else {
        this.stKickC += 1.6; // plunger springs back, pinion out
        this.stKickG += 0.8;
      }
      this.stActive = true;
    }
    // cycle-averaged speed: cranking a big twin swings the instantaneous rpm
    // far more than the threshold
    this.rpmAvg += (rpm - this.rpmAvg) * Math.min(1, dtc * 6);
    if (!this.running && this.ignition && this.rpmAvg > this.runRpm) {
      this.running = true;
      this.flare = e.startFlare;
      this.idleI = 0;
      this.sinceStart = 0;
    }
    if (this.running && (rpm < 120 || !this.ignition)) this.running = false;

    // Idle target with start flare & cold fast idle
    this.flare *= Math.exp(-dtc / 1.4);
    this.coldT = Math.max(0, this.coldT - dtc / 25);
    this.idleTarget = e.idle + this.flare + 250 * this.coldT;

    // Idle speed control (bypass air PI + fast spark trim)
    const idleActive = this.ignition && this.pedal < 0.03;
    // rpm rate for predictive fuel resume / dashpot
    const dRpm = (rpm - this.lastRpm) / dtc;
    this.lastRpm = rpm;
    this.rpmRate += (dRpm - this.rpmRate) * Math.min(1, dtc * 20);
    if (idleActive && this.running) {
      // integrate unless coasting down fast (anti-windup)
      // act on where the revs are heading, not just where they are
      const errP = this.idleTarget - (rpm + this.rpmRate * 0.25);
      // Learn only once the revs have landed: integrating the overshoot of a
      // blip or lift-off would leave the idle sagging for seconds afterwards.
      if (!this.dfco && this.landing < 0.15 && this.liftT > 1.2) {
        const ei = clamp(errP, -250, 400);
        this.idleI = clamp(this.idleI + ei * (ei > 60 ? 9e-4 : 4e-4) * dtc, -0.9, 2.5);
      }
      if (this.dfco) {
        // dashpot: hold air proportional to speed while coasting down
        this.bypass = this.bypassFF * clamp(0.9 + this.idleI, 0.5, 2.5) * clamp((0.8 * rpm) / this.idleTarget, 1, 4);
      } else {
        const pe = clamp(errP, -500, 800);
        this.landing *= Math.exp(-dtc / 0.5);
        this.bypass = clamp(this.bypassFF * (1 + this.idleI + pe * 7e-4 + 1.2 * this.landing), this.bypassFF * 0.1, this.bypassFF * 5);
      }
      this.sparkTrim = clamp(errP * 0.05, -12, 18);
    } else {
      this.bypass += (this.bypassFF * (1 + this.idleI) - this.bypass) * Math.min(1, dtc * 3);
      this.sparkTrim *= 0.9;
    }
    // cranking air; a two-stroke kicked over at speed needs no extra
    if (!this.running) this.bypass = this.bypassFF * (this.twoStroke ? 1 : 1.6);

    // Decel fuel cut / burble
    // Coast (decel fuel cut) vs idle regulation. Fuel resumes early when the
    // revs are falling fast so the engine lands softly on its idle speed.
    const resume = this.idleTarget + 250 + clamp(-this.rpmRate * 0.15, 0, 900);
    if (this.pedal < 0.03 && this.running && !this.launch && !this.twoStroke) {
      if (this.dfco) {
        if (rpm < resume) {
          this.dfco = false;
          // extra air for a soft landing, in proportion to how fast the revs fall
          this.landing = clamp(-this.rpmRate / 2500, 0, 1);
        }
      } else if (rpm > this.idleTarget + 700 && (this.liftT < 2 || rpm > this.idleTarget + 1400)) this.dfco = true;
    } else this.dfco = false;
    // Overrun burble: a burst of crackles for a couple of seconds after lift-off.
    if (this.pedal > 0.25) this.liftT = 0;
    else this.liftT += dtc;
    const win = 0.6 + 3.2 * this.burble;
    this.burbleActive =
      this.burble > 0 && this.dfco && rpm > 1900 && rpm < this.limitRpm * 0.85 && this.liftT < win && rnd() < 0.25 + 0.5 * this.burble * (1 - this.liftT / win);

    // Anti-lag: keep air & fuel flowing, retard spark massively
    this.alsActive =
      this.antilag && this.isTurbo && this.pedal < 0.15 && rpm > 3000 && this.running && this.gear > 0 && (this.mode === 'drive' || this.mode === 'flyby');

    // Rev limiter with hysteresis
    const lim = this.launch && this.v < 1 ? this.launchRpm : this.limitRpm;
    if (rpm > lim) this.limCut = true;
    else if (rpm < lim - (this.launch ? 250 : e.hyst)) this.limCut = false;
    this.launchCut = this.launch && this.v < 1 && this.limCut;
    if (this.launchCut) this.limCut = false;

    // Two-stroke exhaust power valve: a servo raises the port roof through
    // its rpm range
    if (this.pvRpm) {
      const pvT = clamp((rpm - this.pvRpm[0]) / (this.pvRpm[1] - this.pvRpm[0]), 0, 1);
      this.pv += (pvT - this.pv) * Math.min(1, dtc * 5);
    }

    // VTEC-style cam switch
    if (this.camSwitch > 0) {
      if (!this.camHi && rpm > this.camSwitch && this.thr > 0.35) this.camHi = true;
      else if (this.camHi && (rpm < this.camSwitch - 300 || this.thr < 0.2)) this.camHi = false;
    }

    // Traction control: trims torque with spark cuts when the driven wheels
    // spin (the classic stuttering 'brap').
    if (this.tc && this.gear > 0 && (this.mode === 'drive' || this.mode === 'flyby')) {
      const allow = 1.6 + 0.12 * this.v;
      const ex = this.slip - allow;
      this.tcCut = clamp(this.tcCut + (ex > 0 ? ex * 0.25 : -0.8) * dtc * 10, 0, rpm < 2500 ? 0.2 : 0.7);
    } else this.tcCut = 0;

    // Shift ignition cut timers
    if (this.shiftCut > 0) this.shiftCut -= dtc;
    if (this.shiftRetard > 0) this.shiftRetard = Math.max(0, this.shiftRetard - dtc * 8);

    this.nitrousControl(dtc, rpm);

    // Exhaust bypass valve
    let vt = 0;
    if (this.valveMode === 'open') vt = 1;
    else if (this.valveMode === 'auto') {
      vt = rpm > 3800 && this.thr > 0.35 ? 1 : this.thr > 0.8 ? 1 : 0;
      // cold start: the valves stay open through the start flare
      if (this.running && this.coldT > 0.5 && this.sinceStart < 2.5) vt = 1;
    }
    this.valveOpen += (vt - this.valveOpen) * Math.min(1, dtc * 6);

    // Throttle command (pedal, blips, ALS)
    let cmd = this.pedal;
    if (this.blip > 0) {
      cmd = Math.max(cmd, 0.55);
      this.blip -= dtc;
    }
    if (this.alsActive) cmd = Math.max(cmd, 0.11);
    if (!this.ignition) cmd = this.pedal;
    this.thrCmd = cmd;
    // idle air moves in control-rate steps; ramp it so the flow through the
    // throttle (heard at the intake) has no 1.5 kHz staircase in it
    this.bypassStep = (this.bypass - this.bypassS) / 32;

    // Boost control
    if (this.isTurbo || this.isCentri) {
      // Electronic boost control on the wastegate: a gentle proportional
      // band, an integral trim, and a lead on the shaft's acceleration (the
      // wheel races ahead of the boost it is about to make).
      // (anti-lag aims a little lower: enough to come back on boost at once
      // without the relief valve venting all the while)
      // (the tuning map sets the target by rpm, and a share of it by gear)
      let bt = this.boostTarget;
      if (this.mBoost) bt = lerpAt(this.mBoost, axisAt(this.mRpm, rpm)) * 1e5;
      if (this.mGear && this.gear > 0 && (this.mode === 'drive' || this.mode === 'flyby')) bt *= this.mGear[Math.min(this.gear, this.mGear.length) - 1];
      this.boostNow = bt;
      const tgt = this.alsActive ? bt * 0.7 : bt;
      const b = this.pB - P_AMB;
      const e = (b - tgt) / (tgt + 2e4);
      this.pBrate += ((this.pB - this.pBprev) / dtc - this.pBrate) * Math.min(1, dtc * 40);
      this.pBprev = this.pB;
      // (a sequential pair's second shaft counts once its compressor delivers)
      const r1 = (this.wt - this.wtPrev) / dtc, r2 = (this.wt2 - this.wt2Prev) / dtc;
      this.wtRate += (Math.max(0, r1) + (this.mc2 > 0 ? Math.max(0, r2) : 0) - this.wtRate) * Math.min(1, dtc * 30);
      this.wtPrev = this.wt;
      this.wt2Prev = this.wt2;
      // (held while anti-lag runs, so the gate is where it belongs on the way back in)
      if (!this.alsActive) this.wgI = clamp(this.wgI + e * 3 * dtc, 0, 1);
      const lead = b > 0.6 * tgt && this.pBrate > 0 ? (this.wtRate * this.tRtip) / 560 : 0;
      // the actuator spring starts cracking the gate open just short of target
      const crack = clamp((b - 0.85 * tgt) / (0.25 * tgt + 1e4), 0, 1) * 0.25;
      const wgT = clamp(this.wgI + crack + e * 1.2 + lead * 0.6, 0, 1);
      this.wg += (wgT - this.wg) * Math.min(1, dtc * 25);
      // Blow-off valve opens on closed throttle with pressure in the pipes; with
      // anti-lag it doubles as a pressure relief above the boost target.
      const relief = this.alsActive && this.pB - P_AMB > bt;
      // (vacuum referenced: it opens on the pressure drop across a closing
      // throttle, before the plate is even shut, but not across one still
      // opening as the driver gets back on it)
      const bovT = (this.bovType !== 'none' && this.thr < 0.5 && this.thrCmd < 0.3 && this.pB - this.pPl > 35000 && !this.alsActive) || relief ? 1 : 0;
      if (bovT) this.bov = Math.min(1, this.bov + dtc * 120);
      // (anti-lag shuts it again once armed: the boost is there to be kept)
      else if (this.pB - P_AMB < 12000 || this.thr > 0.3 || this.alsActive) this.bov = Math.max(0, this.bov - dtc * 25);
      this.bovStep = (this.bov - this.bovS) / 32;
    }
    if (this.seqRpm) {
      // second stage: its valves open above the switch speed under load and
      // close again lower down or off the throttle
      if (rpm > this.seqRpm && this.thr > 0.3) this.stageT = 1;
      else if (rpm < this.seqRpm - 400 || this.thr < 0.12) this.stageT = 0;
      this.stage += (this.stageT - this.stage) * Math.min(1, dtc * 7);
    }
    if (this.isSC) {
      const byT = this.pedal > 0.55 ? 0 : 1;
      this.scBypass += (byT - this.scBypass) * Math.min(1, dtc * 12);
      this.scBypassStep = (this.scBypass - this.scBypassS) / 32;
    }

    // Valve float above the spring limit; knock retard creeps back.
    const fRpm = this.floatRpm * this.floatMul;
    this.floatSev = rpm > fRpm ? Math.min(1.6, (rpm - fRpm) / (0.07 * fRpm)) : 0;
    if (this.knockRet > 0) this.knockRet = Math.max(0, this.knockRet - dtc * 2);
    // tip-in retard: a sudden throttle opening fills the cylinders before the
    // spark map has caught up, so the ECU pulls timing for a moment
    const dThr = this.thr - this.thrPrevC;
    this.thrPrevC = this.thr;
    this.tipRet = Math.max(0, Math.min(8, this.tipRet + (dThr > 0 ? dThr * 30 : 0)) - dtc * 12);

    // Friction torque (FMEP from mean piston speed). Below ~400 rpm the rings
    // and bearings run short of oil film and drag harder, more so cold.
    const sp = (2 * this.cfg.stroke * rpm) / 60;
    const dry = (0.45 + 0.35 * this.coldT) * Math.exp(-(rpm * rpm) / 90000);
    this.fric = this.fricK * (0.72 + 0.024 * sp + 0.0019 * sp * sp + dry);
    // turning slowly, compression has time to leak past the rings
    const lk = clamp((520 - rpm) / 260, 0, 1);
    for (let c = 0; c < this.n; c++) this.cLeak[c] = 1 + lk * (2.5 + 2.5 * this.cLeakVar[c]);

    this.vehicleControl(dtc, rpm);
    if (this.aeroMic) this.aeroCtl(dtc);

    // Temperatures -> pipe sound speed
    if (this.twoStroke) {
      // everything the port lets out, scavenging air and all, averaged
      // over the last ~50 ms
      if (this.egtOutW > 0) this.egtInst = this.egtOut / this.egtOutW;
      else if (!this.running) this.egtInst += (T_AMB + 40 - this.egtInst) * dtc * 0.3;
      const k = Math.exp(-dtc / 0.05);
      this.egtOut *= k;
      this.egtOutW *= k;
      this.egtAcc = 0;
      this.egtW = 0;
    } else if (this.egtW > 0) {
      this.egtInst = (this.egtAcc / this.egtW) * 0.78;
      this.egtAcc = 0;
      this.egtW = 0;
    } else if (!this.running) {
      this.egtInst += (T_AMB + 40 - this.egtInst) * dtc * 0.3;
    }
    // The pipe walls hold their heat. On fuel cut the engine pumps air that
    // expanded colder than ambient through them; it picks up heat from the
    // steel on the way, so the gas in the pipe stays well above ambient and
    // cools only as fast as the walls do.
    this.pipeWall += (this.egt - this.pipeWall) * Math.min(1, dtc / (this.egt > this.pipeWall ? 6 : 25));
    const floor = T_AMB + 0.55 * Math.max(0, this.pipeWall - T_AMB);
    this.egt += (Math.max(this.egtInst, floor) - this.egt) * Math.min(1, dtc * 1.3);
    this.ex.wander(dtc);
    this.inn.wander(dtc);
    if (++this.tempCounter >= 8) {
      this.tempCounter = 0;
      this.ex.setGasTemp(clamp(this.egt, 320, 1250));
      this.inn.setGasTemp(this.Tpl);
    }
    this.updateResistors();
  }

  // Valves, wastegates and turbines change at control rate; each resistor
  // glides to its new value over the next 32 samples (geometrically, as K
  // spans decades) so the flow has no 1.5 kHz staircase in it.
  updateResistors() {
    const ex = this.ex;
    for (let i = 0; i < ex.res.length; i++) {
      const d = ex.rDyn[i];
      let K;
      if (d === DYN_VALVE) {
        const o = this.valveOpen;
        const A = 0.0022 * o + 1e-6;
        K = Math.min(ex.rClosedK[i], (1 / (2 * 0.6 * A * A)) * 0.15);
      } else if (d === DYN_TURBINE) {
        const rho = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
        K = 1 / (2 * rho * this.tA * this.tA);
      } else if (d === DYN_WASTEGATE) {
        const rho = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
        const A = this.tAwg * this.wg * Math.sqrt(this.wg) + 1e-7;
        K = Math.min(ex.rClosedK[i], 1 / (2 * rho * A * A));
      } else if (d === DYN_STAGE) {
        const rho = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
        const A = this.tAstage * this.stage + 1e-7;
        K = Math.min(ex.rClosedK[i], 1 / (2 * rho * A * A));
      } else continue;
      const k0 = ex.rK[i];
      ex.rKstep[i] = k0 > 0 ? Math.pow(K / k0, 1 / 32) : 1;
      if (!(k0 > 0)) ex.rK[i] = K;
    }
  }
}
