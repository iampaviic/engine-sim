// Induction: throttle and plenum, turbochargers (spool, surge, wastegate,
// dump valve and their sounds) and superchargers.

import { CHOKE_AIR, P_AMB, R, T_AMB, TAU } from '../constants.js';
import { clamp, jetUp, orifice, rnd, speedLine } from '../dsp.js';

export class InductionMethods {
  // Centrifugal blower: pick the pulley ratio that reaches the boost target
  // at the rev limit (pressure ratio rises with impeller tip speed squared).
  setCentriRatio() {
    const PR = 1 + Math.max(0.1, this.boostTarget / P_AMB);
    const Ut = Math.sqrt((Math.pow(PR, 1 / 3.5) - 1) / 2.17e-6);
    this.scRatio = (Ut * 1.3) / (this.tRtip * (this.redline / 9.5493) * 3.2);
  }

  // Intake runner junctions, then the throttle: one butterfly feeding a
  // plenum, or one in each runner.
  stepIntake() {
    const inn = this.inn;
    const inIn = inn.inW, inOut = inn.outW, inY = inn.Y;
    const es = inn.es, ec = inn.ec, ends = inn.ends;
    const junc = inn.junc;
    for (let j = 0; j < junc.length; j++) {
      const nd = junc[j];
      const st = es[nd], cnt = ec[nd];
      let sy = 0, sya = 0;
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        sy += inY[e];
        sya += inY[e] * inIn[e];
      }
      const pj = (2 * sya) / sy;
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        inOut[e] = pj - inIn[e];
      }
    }
    const dt = this.dt;
    const boosted = this.boosted;
    const pUp = boosted ? this.pB : P_AMB;
    const Tup = boosted ? this.TB : T_AMB;
    // butterfly area vs opening, every sample: a stepped area would buzz
    const th = this.thr > 0 ? (this.thr < 1 ? this.thr : 1) : 0;
    this.thrArea = this.Ath * 0.82 * th * Math.sqrt(th * Math.sqrt(th)); // th^1.75
    this.bypassS += this.bypassStep;
    const A = this.thrArea + this.bypassS + this.thrLeak;
    const pls = inn.plenums;
    if (this.itb) {
      // Individual throttles: there is no plenum. Each runner ends at its own
      // butterfly, and beyond that is the bell mouth and the air it breathes
      // (the airbox, or a boosted engine's charge pipe). The plate is an
      // orifice between that air and the runner's end, solved against the
      // runner's wave impedance: shut, it is a closed end the runner's waves
      // bounce off; wide open, a pressure release like a plenum. With the
      // plates cracked each runner refills on its own between its cylinder's
      // gulps, so the flow through every bell mouth pulses even at idle.
      //   A plate in a pipe is not a hole into a plenum: the jet past it
      // spreads back out to the full bore and gets most of its pressure back
      // (Borda-Carnot: the loss is (1/(Cc b) - 1)^2 dynamic heads for an open
      // fraction b), and wide open it is a thin disc edge-on to the flow,
      // worth about 0.2 of a head (Idelchik, Handbook of Hydraulic
      // Resistance, butterfly valves). As an equivalent orifice area:
      const beta = th * Math.sqrt(th * Math.sqrt(th));
      const cb = (0.82 + 0.18 * beta) * beta;
      const Aeq = (this.Ath * cb) / Math.sqrt((1 - cb) * (1 - cb) + 0.2 * cb * cb) + this.bypassS + this.thrLeak;
      const rhoUp = pUp / (R * Tup), sqT = Math.sqrt(Tup);
      const pUpG = pUp - P_AMB;
      const kCh = (CHOKE_AIR * pUp) / sqT;
      let md = 0, ps = 0, ne = 0, jw = 0;
      for (let i = 0; i < pls.length; i++) {
        const nd = pls[i];
        const st = es[nd], cnt = ec[nd];
        const Ae = Aeq / cnt;
        for (let k = 0; k < cnt; k++) {
          const e = ends[st + k];
          const Z = 1 / inY[e];
          const p0 = 2 * inIn[e]; // the end's pressure with no flow through the plate
          const D = pUpG - p0;
          let q;
          if (D >= 0) q = orifice(Ae, D, rhoUp, Z, pUp, sqT, CHOKE_AIR);
          else {
            const pe = p0 + P_AMB;
            q = -orifice(Ae, -D, pe / (R * this.Tpl), Z, pe, Math.sqrt(this.Tpl), CHOKE_AIR);
          }
          inOut[e] = inIn[e] + q * Z;
          if (q > 0) jw += jetUp(q, kCh * Ae);
          md += q;
          ps += p0 + q * Z;
          ne++;
        }
      }
      this.mdTh = md;
      this.jetW = jw;
      this.runnerFlow = md;
      // The manifold pressure the ECU reads comes from a small rail joined to
      // every runner through restrictors: their average, smoothed.
      this.pPl += this.mapA * (P_AMB + ps / ne - this.pPl);
      this.mdLp += this.mapA * (md - this.mdLp);
      // nitrous fogs into each runner and leaves with the air passing it
      this.nosX = this.nosFlow > 0 ? this.nosFlow / (this.nosFlow + (this.mdLp > 1e-4 ? this.mdLp : 1e-4)) : 0;
      return;
    }
    const pg = this.pPl - P_AMB;
    let qr = 0;
    for (let i = 0; i < pls.length; i++) {
      const nd = pls[i];
      const st = es[nd], cnt = ec[nd];
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        inOut[e] = pg - inIn[e];
        qr += (pg - 2 * inIn[e]) * inY[e];
      }
    }
    this.runnerFlow = qr;
    // throttle (implicit against plenum compliance)
    const kpl = (R * this.Tpl * dt) / this.Vpl;
    const pPred = this.pPl - kpl * qr;
    const D = pUp - pPred;
    let md;
    if (D >= 0) md = orifice(A, D, pUp / (R * Tup), kpl, pUp, Math.sqrt(Tup), CHOKE_AIR);
    else md = -orifice(A, -D, this.pPl / (R * this.Tpl), kpl, this.pPl, Math.sqrt(this.Tpl), CHOKE_AIR);
    this.mdTh = md;
    this.jetW = boosted ? 0 : jetUp(md, (CHOKE_AIR * A * pUp) / Math.sqrt(Tup));
    if (this.nosFlow > 0 || this.mNos > 0) {
      // nitrous mixes into the plenum and leaves with the charge
      const x = this.mNos / this.mPl;
      this.mNos += (this.nosFlow - (md < 0 ? qr - md : qr) * x) * dt;
      if (this.mNos < 1e-10) this.mNos = 0;
      this.nosX = x;
    }
    this.mPl += (md + this.nosFlow - qr) * dt;
    if (this.mPl < 1e-6) this.mPl = 1e-6;
    this.pPl = (this.mPl * R * this.Tpl) / this.Vpl;
  }

  // Control rate: the inlet's mean flow, and the voice of the throttle's jet.
  throttleNoise() {
    const fs = this.fs;
    const md = this.inMean > 0 ? this.inMean : 0;
    this.inlet.setFlow(md);
    if (this.boosted) return;
    // The jet's speed, from the mean flow and the area open to it (as jetUp).
    const A = this.thrArea + this.bypassS + this.thrLeak;
    const x = Math.min(1, md / ((CHOKE_AIR * A * P_AMB) / Math.sqrt(T_AMB)));
    const M = (0.579 * x) / (1 - 0.421 * x * x);
    const U = 340 * M;
    // Hiss. A jet's noise peaks where its eddies are shed, at a Strouhal
    // number of about 0.2 on its width: 0.2 U / d, with d the width of a
    // round jet of the open area. Through a cracked throttle that is far
    // above hearing, and only the foot of the spectrum is audible: below its
    // peak a jet's power falls as f^3 (Tam et al., The sources of jet noise,
    // J. Fluid Mech. 615, 2008), so with the peak out of reach the band is
    // placed at the top of ours and turned down to match.
    const d = Math.sqrt(A * 1.273);
    let fc = (0.2 * Math.max(U, 20)) / d;
    let cut = 1;
    const top = 0.3 * fs;
    if (fc > top) {
      const r = top / fc;
      cut = r * Math.sqrt(r);
      fc = top;
    }
    if (fc < 300) fc = 300;
    const g = Math.tan((Math.PI * fc) / fs);
    const k = 1 / 0.7;
    this.jetA1 = 1 / (1 + g * (g + k));
    this.jetA2 = g * this.jetA1;
    this.jetA3 = g * this.jetA2;
    // Noise of 0.289 rms through a band of quality 0.7 at fc keeps
    // pi fc / (0.7 fs) of its power; W watts from a point source are
    // sqrt(W rho c / 4 pi) = 5.73 sqrt(W) Pa at 1 m, and the tract takes its
    // input as 4 pi times that.
    this.jetG = (k * cut * 5.73 * 4 * Math.PI) / (0.289 * Math.sqrt((Math.PI * fc) / (0.7 * fs)));
    // Whistle. At a small opening and a small pressure drop the sheet of air
    // through the gap stays laminar and, where it strikes the bore's step or
    // the plate's far edge about 3 mm on, it locks into an edge tone: Brown's
    // formula (Proc. Phys. Soc. 49, 1937), f = 0.466 (U - 40)(1/h - 0.07) in
    // cm and cm/s, first stage. An edge tone is a dipole, so the share of the
    // jet's power it radiates goes as M^3. The 1e-4 in front is an estimate,
    // not a measurement: it is what a row of such dipoles gives if about a
    // tenth of the gap's length sings. The sheet turns turbulent, and the
    // tone dies, as the Reynolds number on the gap's width passes 1,000 to
    // 2,500 (Brown's own jets stopped near 1,200). In practice that leaves
    // the thin gaps of individual throttles at light load, which sizzle; one
    // big plate's gap is too wide.
    const w = A / (Math.PI * Math.sqrt(this.Ath * 1.273 / (this.itb ? this.n : 1)) * (this.itb ? this.n : 1));
    const re = (U * w) / 1.5e-5;
    const lam = clamp((2500 - re) / 1500, 0, 1) * clamp((U - 8) / 10, 0, 1) * (this.thr < 0.4 ? 1 : 0);
    if (lam > 0 && md > 0) {
      const f = 0.466 * (100 * U - 40) * (1 / 0.3 - 0.07);
      const W = 0.5 * 1e-4 * M * M * M * 0.5 * md * U * U * lam * lam;
      this.edgeF = f;
      this.edgeA = f < 0.4 * fs ? 1.414 * 5.73 * Math.sqrt(W) * 4 * Math.PI : 0;
    } else this.edgeA = 0;
  }

  // Turbocharger / supercharger dynamics and their sounds. Returns the torque
  // the crank spends driving a supercharger.
  stepBoost(omega) {
    this.turboSnd = 0;
    this.bovSnd = 0;
    if (this.isTurbo || this.isCentri) return this.stepTurbo(omega);
    if (this.isSC) return this.stepBlower(omega);
    return 0;
  }

  stepTurbo(omega) {
    const dt = this.dt, fs = this.fs;
    let scTorque = 0;
    // Greitzer compressor + plenum model; compressor map is a speed line with
    // a peak (surge on its left), scaled with tip speed squared.
    const nA = this.nA;
    const Ut = this.wt * this.tRtip;
    const mChoke = this.tChokeK * Math.max(Ut, 80) * nA;
    const PRm = Math.pow(1 + 2.17e-6 * Ut * Ut, 3.5);
    let pc = P_AMB * (1 + (PRm - 1) * speedLine(this.mc / mChoke, clamp((Ut / 400 - 0.4) / 0.45, 0, 1))) - this.tRestr * this.mc * Math.abs(this.mc);
    if (pc < 0.4 * P_AMB) pc = 0.4 * P_AMB;
    const Lc = 0.35;
    this.mc += ((0.0016 * nA) / Lc) * (pc - this.pB) * dt;
    // Second stage (sequential turbos): its compressor delivers through a
    // check flap, only once its exhaust valve is open and it has spooled up
    // past the boost already in the pipes.
    let mc2 = 0;
    if (this.nB) {
      const Ut2 = this.wt2 * this.tRtip;
      const mCh2 = this.tChokeK * Math.max(Ut2, 80) * this.nB;
      const PRm2 = Math.pow(1 + 2.17e-6 * Ut2 * Ut2, 3.5);
      const pc2 = P_AMB * (1 + (PRm2 - 1) * speedLine(this.mc2 / mCh2, clamp((Ut2 / 400 - 0.4) / 0.45, 0, 1))) - this.tRestrB * this.mc2 * Math.abs(this.mc2);
      this.mc2 += ((0.0016 * this.nB) / Lc) * (pc2 - this.pB) * dt;
      if (this.mc2 < 0) this.mc2 = 0;
      // its check valve swings open over a fifth of a second, so the second
      // stage eases in instead of slamming its boost into the pipes, and
      // swings shut in a tenth as the stage drops out (no click as it cuts off)
      if (this.stage < 0.2) this.flap2 = Math.max(0, this.flap2 - dt * 10);
      else if (pc2 > this.pB || this.mc2 > 0) this.flap2 = Math.min(1, this.flap2 + dt * 5);
      if (this.mc2 > this.flap2 * mCh2) this.mc2 = this.flap2 * mCh2;
      mc2 = this.mc2;
    }
    // BOV vent
    let mb = 0;
    this.bovS += this.bovStep;
    if (this.bovS > 0.01 && this.pB > P_AMB) {
      const Ab = this.bovA * this.bovS;
      mb = orifice(Ab, this.pB - P_AMB, this.pB / (R * this.TB), 0, this.pB, Math.sqrt(this.TB), CHOKE_AIR);
    }
    this.mdBov = mb;
    this.pB += ((R * this.TB) / this.Vb) * (this.mc + mc2 - this.mdTh - mb) * dt;
    if (!(this.pB > 0.3 * P_AMB)) {
      this.pB = 0.3 * P_AMB;
      if (this.mc < 0) this.mc = 0;
    }
    if (this.pB > 4.5 * P_AMB) this.pB = 4.5 * P_AMB;
    if (!(Math.abs(this.mc) < 5)) this.mc = 0;
    // shafts
    const PR = this.pB / P_AMB;
    const work = (1005 * T_AMB * (Math.pow(PR, 0.2857) - 1)) / 0.7; // J per kg compressed
    // Air shoved back out through the spinning wheel has to be given the
    // wheel's swirl all over again (about U^2 per kg): surge brakes the shaft
    // hard, so each flutter cycle comes a little slower and lower than the last.
    const Pc = this.mc > 0 ? this.mc * work : -this.mc * Ut * Ut * 0.85;
    const wMax = 560 / this.tRtip;
    if (this.isTurbo) {
      // smoothed turbine power from the exhaust network's turbine resistors
      let tp = 0, tp2 = 0;
      for (let i = 0; i < this.turbP.length; i++) {
        if (i < nA) tp += this.turbP[i];
        else tp2 += this.turbP[i];
        this.turbP[i] = 0;
      }
      const rhoT = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
      this.turbPs += (tp / rhoT - this.turbPs) * 0.002;
      this.turbPsm = Math.max(0, this.turbPs) * 1.5;
      // each exhaust pulse that kicks the wheel swells its whistle
      this.tpLp += this.tpLpA * (tp / rhoT - this.tpLp);
      this.tPulse = 0.7 + 0.3 * clamp(this.tpLp / Math.max(this.turbPs, 1e-3), 0, 3);
      const w = Math.max(this.wt, 300);
      // with the throttle shut the wheel churns the trapped air against the
      // boost instead of moving it: an aerodynamic loss that grows with speed
      const low = clamp(1 - this.mc / (0.25 * mChoke), 0, 1);
      const churn = (low * this.wt * this.wt * (this.pB / P_AMB)) / (wMax * 2.2);
      this.wt += ((this.turbPsm * 0.72 - Pc) / (this.tJ * nA * w) - this.wt * 0.08 - churn) * dt;
      if (this.wt < 0) this.wt = 0;
      if (this.wt > wMax) this.wt = wMax;
      if (this.nB) {
        this.turbPs2 += (tp2 / rhoT - this.turbPs2) * 0.002;
        const w2 = Math.max(this.wt2, 300);
        this.wt2 += ((Math.max(0, this.turbPs2) * 1.08 - mc2 * work) / (this.tJ * this.nB * w2) - this.wt2 * 0.08) * dt;
        if (this.wt2 < 0) this.wt2 = 0;
        if (this.wt2 > wMax) this.wt2 = wMax;
      }
    } else {
      // centrifugal supercharger: gear-driven impeller
      this.wt = omega * this.scRatio * 3.2;
      scTorque = Pc / Math.max(omega, 30);
      this.scTq = scTorque;
    }
    const Tc = T_AMB * (1 + (Math.pow(Math.max(PR, 1), 0.2857) - 1) / 0.7);
    this.TB = Tc - 0.72 * (Tc - T_AMB);
    this.Tpl = this.TB - this.nosCool;
    // Blade-pass whistle and shaft whine. The wheel never sings a clean
    // sine: flow unsteadiness wobbles its tone by a few tenths of a percent,
    // each exhaust pulse that kicks the turbine swells it, and turbulence
    // round the blades smears it into a narrow band of noise.
    //   Nor is any wheel cut perfectly. Its blades differ a little in pitch
    // and angle, so the pressure pattern turning with it repeats once per
    // turn, not once per blade: from a fixed point the blade-pass tone rises
    // and falls with the shaft, and that puts sidebands one and two shaft
    // orders either side of it, about 16 and 22 dB down (the rotor-locked
    // "multiple pure tones" of compressor noise; Raitor and Neise, Sound
    // generation in centrifugal compressors, J. Sound Vib. 314, 2008). They
    // are what makes a turbo's whistle a reedy chord and not a test tone.
    //   The level follows measured in-duct spectra: 120-130 dB at blade-pass
    // in the inlet pipe of a car's turbo at speed (Teng and Homco, SAE
    // 2009-01-2053), which is 85-90 dB at 1 m off an open inlet.
    const fShaft = this.wt / TAU;
    this.wJit += this.wJitA * (rnd() - 0.5 - this.wJit);
    const jit = 1 + this.wJit * 0.3;
    const fB = fShaft * this.blades * jit;
    this.tPhase2 += (fShaft * jit) / fs;
    this.tPhase2 -= Math.floor(this.tPhase2);
    const shaft = TAU * this.tPhase2;
    const sh1 = Math.sin(shaft), sh2 = Math.sin(2 * shaft);
    const uneven = 1 + 0.3 * Math.cos(shaft) + 0.15 * sh2;
    if (++this.sgK >= 32) {
      this.sgK = 0;
      this.setBand(clamp(fB, 200, 0.4 * fs), 40);
    }
    const nh = rnd() - 0.5;
    const sb = this.sgB;
    const halo = sb[0] * (nh - this.sgX2) - sb[1] * this.sgY1 - sb[2] * this.sgY2;
    this.sgX2 = this.sgX1;
    this.sgX1 = nh;
    this.sgY2 = this.sgY1;
    this.sgY1 = halo;
    // A small wheel's blade pass goes ultrasonic at full spool: fade it out
    // before Nyquist instead of letting it fold back down as a false whistle.
    const whistle = (Math.sin(this.blades * shaft) * uneven * 0.85 + halo * 2.5) * this.bladeFade(fB);
    const whine = sh1 + 0.3 * sh2;
    const Utn = Ut / 400;
    // Each turbo sings with its share of the flow. Twins never run at quite
    // the same speed (one bank breathes a little differently), so the pair
    // beats against itself: the chorus of a twin-turbo engine.
    const ampA = Utn * Utn * (0.15 + (3 * Math.abs(this.mc)) / nA) * 0.8 * this.tPulse;
    let snd = (whistle * 10 + whine * 0.5) * ampA;
    if (nA > 1) snd += this.tone(this.vA2, fShaft * 0.991) * ampA;
    if (mb > 0) {
      // the dump valve's jet: broadband, but centred a few kHz up like any jet
      // (Lighthill: its loudness falls away fast as the pressure behind it bleeds off)
      const dpb = Math.max(0, this.pB - P_AMB);
      this.bovSnd = this.bovBand.tick(rnd() - 0.5) * mb * Math.sqrt(dpb) * (dpb / 1e5) * 0.5;
    }
    const Utn2 = (this.wt2 * this.tRtip) / 400;
    if (this.nB && Utn2 > 0.02) {
      // the second stage whistles and whines on its own pitch, first as its
      // valve lets it pre-spool, then fully once it delivers
      const ampB = Utn2 * Utn2 * (0.15 + (3 * mc2) / this.nB) * 0.8 * this.tPulse;
      const f2 = this.wt2 / TAU;
      snd += this.tone(this.vB, f2) * ampB;
      if (this.nB > 1) snd += this.tone(this.vB2, f2 * 0.991) * ampB;
    }
    // Whoosh: broadband 1-3 kHz noise the compressor makes working up its
    // speed line, loudest nearest surge (high boost on little flow, as when
    // it spools at low revs). It reaches us through the inlet duct.
    const xf = this.mc / mChoke;
    const wl = Utn * Utn * clamp(xf / 0.06, 0, 1) * (0.35 + 1.3 * clamp((0.6 - xf) / 0.35, 0, 1)) + (mc2 > 0 ? 0.35 * Utn2 * Utn2 : 0);
    let exc = this.whBand.tick(rnd() - 0.5) * wl * 4.9 * this.whK;
    // Surge (the flutter). Each reversal of the flow is a sharp pressure
    // pulse at the compressor face, and the moment the flow snaps forward
    // again is another. Every pulse rings the inlet duct, a tube closed at
    // the wheel and open at the filter, whose quarter-wave modes (about 300,
    // 900 and 1500 Hz for 0.3 m) give it the hollow "tu" of a turbo's
    // flutter; the stalling wheel adds a short breath of noise at the onset.
    const dmc = (this.mc + mc2 - this.mcPrev) * fs;
    this.mcPrev = this.mc + mc2;
    if (this.mc < 0) this.sgAct = 1;
    else this.sgAct *= this.sgActDec;
    if ((this.mcSgn >= 0) !== (this.mc >= 0)) {
      // (as hard as the flow turns: a deep surge cycle slams, a mild one sighs)
      const pg = clamp((this.pB - P_AMB) / 1e5, 0, 2.5);
      const hard = clamp(Math.abs(this.sgD) / 150, 0, 1);
      this.burst = Math.max(this.burst, (this.mc < 0 ? 1 : 0.45) * hard * (0.15 + pg) * (0.3 + Utn));
    }
    this.mcSgn = this.mc;
    this.burst *= this.burstDec;
    this.sgD += this.sgDA * (dmc - this.sgD);
    if (this.sgAct > 1e-3 || this.burst > 1e-4) {
      exc += this.sgD * this.sgAct * 0.2 + this.burstBand.tick(rnd() - 0.5) * this.burst * 18;
    }
    const dl = this.dBuf[(this.dI - this.dD) & 1023];
    this.dLp += this.dLpA * (dl - this.dLp);
    const yd = exc - 0.86 * this.dLp;
    this.dBuf[this.dI] = yd;
    this.dI = (this.dI + 1) & 1023;
    snd += yd;
    this.turboSnd = snd;
    // What the inlet tract breathes is the compressor's flow: its surges, and
    // what little of the engine's own pulsing gets back through the charge
    // pipes and the wheel.
    this.inFlow = this.mc + mc2;
    return scTorque;
  }

  // A centrifugal blower's impeller turns ten times faster than its pulley,
  // through a pair of straight-cut step-up gears in its own case (61 teeth
  // driving 19). Their mesh is the whine these blowers are known for: about
  // 1.5 kHz at idle and beyond 10 kHz at the limit. It is the transmission
  // error of the loaded mesh shaking a small casing, as the gearbox's is
  // (mechSpec in compile.js), wobbling with each turn of the big gear.
  blowerGear(omega) {
    const fIn = (omega * this.scRatio) / TAU;
    this.bgPh += fIn / this.fs;
    this.bgPh -= Math.floor(this.bgPh);
    const fm = fIn * 61;
    if (fm < 20 || fm > 0.42 * this.fs) return 0;
    const th = TAU * 61 * this.bgPh;
    const s = Math.sin(th), c = Math.cos(th);
    // (it grows with the torque it carries, about 60 N·m at the crank flat out)
    const load = 0.35 + 0.65 * clamp(this.scTq / 30, 0, 1.5);
    const fade = fm < 0.3 * this.fs ? 1 : (0.42 * this.fs - fm) / (0.12 * this.fs);
    return ((s + s * c + 0.25 * s * (3 - 4 * s * s)) * this.mech.blowerRad * fm * (1 + 0.15 * Math.sin(TAU * this.bgPh)) * load * fade) / (fm * fm + 250000);
  }

  // Band-pass (constant peak gain) at f with quality q.
  setBand(f, q) {
    const w = (TAU * f) / this.fs;
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    this.sgB[0] = al / a0;
    this.sgB[1] = (-2 * Math.cos(w)) / a0;
    this.sgB[2] = (1 - al) / a0;
  }

  // One turbo's tones at shaft frequency f: the blade-pass whistle and the
  // shaft whine, wobbling with the turbo's own flow unsteadiness.
  tone(v, f) {
    const fs = this.fs;
    v.jit += this.wJitA * (rnd() - 0.5 - v.jit);
    const fj = f * (1 + v.jit * 0.3);
    const fb = fj * this.blades;
    v.ph2 += fj / fs;
    v.ph2 -= Math.floor(v.ph2);
    const ph2 = TAU * v.ph2;
    const s1 = Math.sin(ph2), s2 = Math.sin(2 * ph2);
    // (its own uneven blades: see stepTurbo)
    return Math.sin(this.blades * ph2) * (1 + 0.3 * Math.cos(ph2) + 0.15 * s2) * 8.5 * this.bladeFade(fb) + (s1 + 0.3 * s2) * 0.5;
  }

  // Level for a blade tone at f. The filter element and the duct's bends
  // soak up what's above about 8 kHz (a full-spool whistle at 15 kHz is a
  // faint sizzle, not a scream), and it's gone before 0.42 fs.
  bladeFade(f) {
    const fs = this.fs;
    const r = (f / 8000) * (f / 8000);
    const g = 1 / Math.sqrt(1 + r * r);
    return f < 0.3 * fs ? g : f < 0.42 * fs ? (g * (0.42 * fs - f)) / (0.12 * fs) : 0;
  }

  stepBlower(omega) {
    const dt = this.dt, fs = this.fs;
    const wb = omega * this.scRatio;
    const PR = this.pB / P_AMB;
    const ev = clamp(1 - 0.12 * (PR - 1), 0.5, 1);
    const vflow = ((this.scDisp * wb) / TAU) * ev;
    const msc = (P_AMB / (R * T_AMB)) * vflow;
    let mby = 0;
    this.scBypassS += this.scBypassStep;
    const Aby = 0.0018 * this.scBypassS + 1e-6;
    if (this.pB > P_AMB) mby = orifice(Aby, this.pB - P_AMB, this.pB / (R * this.TB), 0, this.pB, Math.sqrt(this.TB), CHOKE_AIR);
    else mby = -orifice(Aby, P_AMB - this.pB, P_AMB / (R * T_AMB), 0, P_AMB, Math.sqrt(T_AMB), CHOKE_AIR);
    this.pB += ((R * this.TB) / this.Vb) * (msc - this.mdTh - mby) * dt;
    if (this.pB < 0.4 * P_AMB) this.pB = 0.4 * P_AMB;
    const eta = this.fiType === 'twinscrew' ? 0.7 : 0.55;
    const P = (msc * 1005 * T_AMB * (Math.pow(Math.max(PR, 1), 0.2857) - 1)) / eta + msc * 2000;
    const Tc = T_AMB * (1 + (Math.pow(Math.max(PR, 1), 0.2857) - 1) / eta);
    this.TB = Tc - 0.65 * (Tc - T_AMB);
    this.Tpl = this.TB - this.nosCool;
    // Rotor whine. The rotors seal against each other and the case by
    // clearances, and gas leaks back through them from the pressure side to
    // the inlet: the 12% per unit of pressure ratio that the delivery above
    // loses. Each pocket coming round makes and breaks those seal lines, so
    // the leak (and with it the flow the inlet draws) pulses once per pocket
    // at about half its mean. The inlet tract carries that out as the whine.
    //   A Roots blower has no compression inside: the leak is driven by the
    // boost, and with the bypass open at cruise it all but stops. A twin-screw
    // squeezes each pocket by its built-in ratio (about 1.5) before the port
    // opens, boost or no boost, so it whines at idle too.
    const drive = (PR > this.scPi ? PR : this.scPi) - 1;
    const leak = (P_AMB / (R * T_AMB)) * ((this.scDisp * wb) / TAU) * 0.12 * drive;
    this.scPhase += ((wb / TAU) * this.scPockets) / fs;
    this.scPhase -= Math.floor(this.scPhase);
    const ph = TAU * this.scPhase;
    const h = this.scH;
    const c1 = Math.cos(ph), s1 = Math.sin(ph);
    const c2 = 2 * c1 * c1 - 1;
    // (the harmonics' phases are those of a pulse that opens fast and dies away)
    this.inFlow = msc - 0.5 * leak * (h[0] * c1 + h[1] * (c2 * 0.8 - 2 * s1 * c1 * 0.6) + h[2] * (4 * c1 * c1 * c1 - 3 * c1));
    return P / Math.max(omega, 30);
  }
}
