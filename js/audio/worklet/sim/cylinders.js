// The cylinders: thermodynamics, combustion (with cycle-to-cycle variation
// and knock), valve flow coupled implicitly to the pipes, and afterfire in
// the exhaust.

import { AFR_ST, CHOKE, CHOKE_AIR, CP, CV, GAM, GM1, LHV, NOS_DH, NOS_O2, P_AMB, R, TAU } from '../constants.js';
import { axisAt, bounce, clamp, crossed, egtGain, flameSpeed, gauss, lerpAt, orifice, richGain, rnd } from '../dsp.js';

export class CylinderMethods {
  // -------------------------------------------------------------------------
  // Per-cycle cylinder events
  // -------------------------------------------------------------------------

  onIVC(c, rpm) {
    if (this.twoStroke) {
      // charge the chambers pushed back since the last cylinder's port
      // closed: about one cylinder's worth, however many there are
      this.plug += (this.plugAcc / (1.18 * this.vd) - this.plug) * 0.15;
      this.plugAcc = 0;
    }
    const m = this.cm[c];
    const mb = this.cMb[c];
    const fresh = Math.max(0, m - mb);
    const xr = mb / m;
    const load = fresh / (1.18 * this.vd);
    this.cAirIn[c] = fresh;
    this.telAir += fresh;
    this.thAir += fresh;
    this.thLoad += load;
    this.thN++;
    // nitrous in the charge: its oxygen counts 1.57 times
    const nos = fresh * this.nosX;
    let o2 = nos > 0 ? fresh + (NOS_O2 - 1) * nos : fresh;
    // the air's share of it carries the day's oxygen (sim/weather.js)
    if (this.airO2 !== 1) o2 -= (fresh - nos) * (1 - this.airO2);

    const cranking = rpm < 350;
    let fuelOn = this.ignition && !this.dfco && this.crankRevs >= this.syncRevs;
    // cold start: the first squirts wet the port walls instead of the charge
    if (fuelOn && this.filmLeft > 0) {
      this.filmLeft--;
      fuelOn = false;
    }
    if (this.limCut && this.limiterType === 'fuel') fuelOn = false;
    let afr = this.afrTarget;
    // (afr0: what the factory map would have given, to judge the change by)
    let afr0 = afr;
    if (this.mAfr) afr = lerpAt(this.mAfr, axisAt(this.mRpm, rpm));
    if (cranking) afr = afr0 = 11;
    if (load < 0.6) {
      afr = 14.7 + (afr - 14.7) * Math.max(0, load - 0.35) / 0.25;
      afr0 = 14.7 + (afr0 - 14.7) * Math.max(0, load - 0.35) / 0.25;
    }
    if (this.dfco && this.burbleActive) {
      fuelOn = this.ignition;
      afr = afr0 = 11.5;
    }
    if (this.alsActive) {
      fuelOn = this.ignition;
      afr = afr0 = 10.5;
    }
    if (this.launchCut) afr = afr0 = 11.5;
    // after a hot soak, vapour in the rail: the first injections run lean
    if (this.vapour > 0) afr /= 1 - this.vapour;
    if (this.tcCut > 0.45 && rnd() < (this.tcCut - 0.45) * 1.6) fuelOn = false; // TC cuts fuel
    // (the nitrous kit adds the fuel to match its oxygen)
    const fuel = fuelOn ? o2 / afr : 0;
    const burnable = Math.min(fuel, o2 / AFR_ST);
    this.cFuel[c] = fuel;
    this.cBurnable[c] = burnable;
    this.telFuel += fuel;
    this.thFuel += fuel;
    this.lastAfr = fuelOn ? afr : 0;

    // A mixture moved away from the factory's: richer burns a little faster
    // (towards lambda 0.9), makes a little more torque, and keeps the end gas
    // cooler (more fuel evaporating, a cooler flame), so it knocks later;
    // leaner burns slower and hotter and knocks sooner.
    let mixDur = 1, mixQ = 1, cool = 0;
    this.cKl[c] = 1;
    this.cEgt[c] = 1;
    if (fuel > 0 && afr !== afr0) {
      const lam = afr / AFR_ST, lam0 = afr0 / AFR_ST;
      mixDur = flameSpeed(lam0) / flameSpeed(lam);
      mixQ = richGain(lam) / richGain(lam0);
      this.cKl[c] = Math.exp(3.5 * (lam - lam0));
      this.cEgt[c] = egtGain(lam) / egtGain(lam0);
      cool = (fuel - o2 / afr0) * 200e3;
    }

    // add fuel vapour to charge
    if (fuel > 0) {
      const T = this.cU[c] / (m * CV);
      this.cm[c] = m + fuel;
      this.cU[c] += fuel * CV * T;
      if (cool !== 0) this.cU[c] -= clamp(cool, -0.1 * this.cU[c], 0.1 * this.cU[c]);
    }

    let spark = this.ignition && fuel > 0;
    if (this.limCut && this.limiterType === 'spark') spark = false;
    if (this.shiftCut > 0) spark = false;
    if (this.launchCut && rnd() < 0.55) spark = false;


    // Combustion variability grows with residual gas and light load.
    // (and with liquid fuel off a cold port wall: covCold, sim/thermal.js)
    const sig = 0.016 + 0.45 * Math.max(0, xr - 0.14) + 0.04 * Math.max(0, 0.4 - load) + this.covCold;
    let misfire = false;
    if (xr > 0.3 && rnd() < (xr - 0.3) * 1.6) misfire = true;
    if (load < 0.08 && rnd() < (0.08 - load) * 5) misfire = true;
    if (cranking && rnd() < 0.25) misfire = true;

    if (!spark || misfire || burnable <= 0) {
      this.cBurn[c] = 0;
      this.cQ[c] = 0;
      return;
    }
    const rpmF = Math.min(rpm, 16000) / 7000;
    let dur =
      50 * this.cfg.burnScale * (0.82 + 0.3 * rpmF) * (1 + 2.2 * Math.max(0, xr - 0.06)) * (1 + 0.7 * Math.max(0, 0.55 - load));
    dur *= 1 + 0.45 * sig * gauss();
    if (mixDur !== 1) dur *= mixDur;
    // a cold charge burns slower, a heat-soaked one faster (sim/thermal.js)
    if (this.burnK !== 1) dur *= this.burnK;
    if (dur < 20) dur = 20;
    // Spark advance for best torque (CA50 around 8-10 deg ATDC).
    let adv = 0.5 * dur - 9 + this.sparkTrim + this.ecu.sparkBase + this.sparkAdj - this.knockRet - this.tipRet;
    if (this.mSpark) adv += this.sparkMap(rpm);
    // factory spark map: knock-limited retard when lugging and under boost
    if (load > 0.6) adv -= 10 * clamp((2400 - rpm) / 1400, 0, 1) * Math.min(1, (load - 0.6) / 0.35) + Math.max(0, load - 0.75) * 4 + Math.max(0, load - 1) * 3;
    if (cranking) adv = 5;
    if (this.dfco && this.burbleActive) adv = -18 - 22 * rnd() * this.burble;
    if (this.alsActive) adv = -38 - 16 * rnd();
    if (this.launchCut) adv = -15 - 10 * rnd();
    if (nos > 0) {
      // oxygen-rich charge burns faster; the nitrous controller pulls timing
      dur /= 1 + (2 * nos) / fresh;
      adv -= this.nosRet;
    }
    if (this.shiftRetard > 0) adv -= 25 * this.shiftRetard;
    if (this.tcCut > 0) adv -= 28 * Math.min(1, this.tcCut * 2);
    // A flame lit after TDC burns into an expanding, cooling charge: slower.
    if (adv < 0) dur *= 1 + -adv / 16;
    let q = burnable * LHV * this.cfg.combustion * Math.max(0.2, 1 + sig * gauss());
    if (mixQ !== 1) q *= mixQ;
    if (nos > 0) q += nos * NOS_DH * this.cfg.combustion;
    this.cQ[c] = q;
    this.lastAdv = adv;
    this.cDur[c] = dur;
    let sp = this.tdcFire - adv;
    sp = ((sp % this.cycle) + this.cycle) % this.cycle;
    this.cSpark[c] = sp;
    this.cBurn[c] = 1;
    this.cXb[c] = 0;
  }

  onEVO(c) {
    const fuel = this.cFuel[c];
    const burnable = this.cBurnable[c];
    let xb = 0;
    const st = this.cBurn[c];
    if (st === 2) xb = this.cXb[c];
    else if (st === 3) xb = 1;
    // Unburned fuel leaves with the exhaust; late combustion keeps burning.
    const unburnt = fuel - burnable * xb;
    const fresh = this.cAirIn[c];
    const airLeft = Math.max(0, fresh - burnable * xb * AFR_ST);
    const node = this.cAf[c];
    if (node >= 0) {
      this.afFuel[node] += unburnt;
      this.afAir[node] += airLeft + (this.alsActive ? fresh * 0.8 : 0); // ALS secondary air
      const T = this.cU[c] / (this.cm[c] * CV);
      // a charge still burning at EVO carries flame into the pipe
      const heat = st === 2 ? 1 : st === 3 ? 0.12 : 0.05;
      this.afHeat[node] = Math.max(this.afHeat[node] * 0.9, heat * clamp((T - 700) / 900, 0, 1) + (st === 2 ? 0.5 : 0));
    }
    if (st >= 2) {
      this.cMb[c] = this.cm[c] * (0.6 + 0.4 * xb);
      this.cFired[c] = Math.min(1.5, this.cQ[c] * xb / (1.18 * this.vd * 3.0e6));
    }
    this.cBurn[c] = 0;
    this.cFuel[c] = 0;
    if (!this.twoStroke) this.cExB[c] = this.cMb[c] / this.cm[c];
    // EGT estimate weighted by mass
    const T = this.cU[c] / (this.cm[c] * CV);
    this.egtAcc += T * this.cm[c] * this.cEgt[c];
    this.egtW += this.cm[c];
  }

  // One time step of every cylinder: volume change, combustion, valve flows
  // (coupled implicitly to the pipe waves), blow-by. Returns gas torque.
  stepCylinders(crank, rpm) {
    const dt = this.dt;
    const n = this.n;
    const cycle = this.cycle;
    const tabScale = this.tabScale;
    const vol = this.vol, dvd = this.dvd, off = this.off;
    const cm = this.cm, cU = this.cU, cMb = this.cMb, cV = this.cV, cCA = this.cCA, cP = this.cP;
    const cP1 = this.cP1;
    const cBurn = this.cBurn, cXb = this.cXb, cQ = this.cQ, cSpark = this.cSpark, cDur = this.cDur;
    const cExEnd = this.cExEnd, cInEnd = this.cInEnd, cRunB = this.cRunB, cExB = this.cExB;
    const ex = this.ex, inn = this.inn;
    const exIn = ex.inW, exOut = ex.outW, exZ = ex.Zm;
    const inIn = inn.inW, inOut = inn.outW, inZ = inn.Zm;
    const hi = this.camHi;
    const exTab = hi ? this.exTabHi : this.exTabLo;
    const inTab = hi ? this.inTabHi : this.inTabLo;
    let ivc = hi ? this.cfg.ivcHi : this.cfg.ivc;
    let evo = hi ? this.cfg.evoHi : this.cfg.evo;
    const evc = this.cfg.evc;
    // two-stroke: the power valve blends the exhaust port between its low
    // and raised roof; the charge is trapped as the port closes
    const ts = this.twoStroke;
    const pv = ts ? this.pv : 0;
    const exTabP = this.exTabHi;
    if (ts) {
      ivc += (this.cfg.ivcHi - ivc) * pv;
      evo += (this.cfg.evoHi - evo) * pv;
    }
    const ccM = this.ccM, ccU = this.ccU, ccB = this.ccB, ccV = this.ccV, ccP = this.ccP, cReed = this.cReed;
    const ccTot = this.ccTot, scavK = this.scavK, exPool = this.exPool, cTf = this.cTf, evapH = this.evapH;
    const reedA = this.reedA, reedP0 = this.reedP0, reedPf = this.reedPf, reedK = this.reedK;
    let egtOut = 0, egtOutW = 0, plugAcc = 0;
    const rasp = this.rasp26;
    const kLeak = this.kLeak;
    const cLeak = this.cLeak;
    const cKi = this.cKi, cPs = this.cPs, cTs = this.cTs, cKq = this.cKq, cKa = this.cKa, cKf = this.cKf, cKph = this.cKph, cKl = this.cKl;
    const kTauInv = this.kTauInv, kDecay = this.kDecay;
    const floatSev = this.floatSev;
    const cBi = this.cBi, cBe = this.cBe;
    let knockSnd = 0;
    // the charge as the ports and manifold leave it (sim/thermal.js)
    const Tint = this.Tpl + this.chargeDT;
    const sqTint = Math.sqrt(Tint);
    const Tex = Math.max(450, this.egt * 0.85);
    const sqTex = Math.sqrt(Tex);
    let torque = 0;
    // mechanical events: valve seating and lash (N·s at the design speed),
    // piston slap and injector ticks (N·s)
    let vtExc = 0, slapExc = 0, injExc = 0;
    let combExc = 0;
    const seatIn = this.seatIn, seatEx = this.seatEx, lashIn = this.lashIn, lashEx = this.lashEx;
    // bled-down hydraulic lifters (per cylinder, sim/thermal.js)
    const cBleed = this.cBleed, hydOn = this.th.bleed > 1e-3 && this.hydJ > 0;
    const slapOn = this.slapK > 0, injJ = this.injJ, cTol = this.cTol;
    const ivo = this.cfg.ivo;
    for (let c = 0; c < n; c++) {
      let ca = crank + off[c];
      if (ca >= cycle) ca -= cycle;
      const caPrev = cCA[c];
      cCA[c] = ca;
      const fi = ca * tabScale;
      const i0 = fi | 0;
      const fr = fi - i0;
      const V = vol[i0] + (vol[i0 + 1] - vol[i0]) * fr;
      const dvdth = dvd[i0] + (dvd[i0 + 1] - dvd[i0]) * fr;

      if (caPrev !== ca) {
        if (crossed(caPrev, ca, ivc)) {
          this.onIVC(c, rpm);
          vtExc += seatIn * cTol[c];
          if (floatSev > 0) {
            cBi[c] = floatSev * (0.45 + 0.8 * rnd());
            vtExc += seatIn * floatSev * 3;
          }
        }
        if (cBurn[c] === 1 && crossed(caPrev, ca, cSpark[c])) {
          cBurn[c] = 2;
          // end-gas reference state at the spark
          cPs[c] = cP1[c];
          cTs[c] = cU[c] / (cm[c] * CV);
          cKi[c] = 0;
        }
        if (crossed(caPrev, ca, evo)) {
          this.onEVO(c);
          vtExc += (lashEx + cBleed[c]) * cTol[c];
        }
        if (crossed(caPrev, ca, evc)) {
          vtExc += seatEx * cTol[c];
          if (floatSev > 0) {
            cBe[c] = floatSev * (0.45 + 0.8 * rnd());
            vtExc += seatEx * floatSev * 3;
          }
        }
        if ((lashIn > 0 || hydOn) && crossed(caPrev, ca, ivo)) vtExc += (lashIn + cBleed[c]) * cTol[c];
        // dead centres are every 180 degrees, top centres at 0 and 360: the
        // piston slaps across the bore at each, and port injection ends
        // before the intake valve opens at the top of the exhaust stroke
        const dc = (ca * 0.005555555555555556) | 0;
        if (dc !== ((caPrev * 0.005555555555555556) | 0)) {
          if (slapOn) slapExc += this.slap(c, (dc & 1) === 0);
          if (dc === 0) injExc += injJ * cTol[c];
        }
      }

      let m = cm[c];
      let U = cU[c];
      const Vo = cV[c];
      const dV = V - Vo;
      U = (U * (1 - (GM1 * 0.5 * dV) / Vo)) / (1 + (GM1 * 0.5 * dV) / V);
      if (ts) {
        // the crankcase grows as the piston rises
        const Vc = ccTot - V;
        const dVc = Vc - ccV[c];
        ccU[c] = (ccU[c] * (1 - (GM1 * 0.5 * dVc) / ccV[c])) / (1 + (GM1 * 0.5 * dVc) / Vc);
        ccV[c] = Vc;
      }

      if (cBurn[c] === 2) {
        let ph = ca - cSpark[c];
        if (ph < 0) ph += cycle;
        const x = ph / cDur[c];
        let xb;
        if (x >= 1) {
          xb = 1;
          cBurn[c] = 3;
        } else {
          xb = 1 - Math.exp(-5 * x * x * x);
        }
        U += cQ[c] * (xb - cXb[c]);
        cXb[c] = xb;
        if (xb === 1) cMb[c] = m;
      }
      if (cKq[c] > 0) {
        // autoignited end gas releases its heat almost at once
        const r = cKq[c] * 0.3;
        U += r;
        cKq[c] = cKq[c] - r < 1 ? 0 : cKq[c] - r;
      }

      let T = U / (m * CV);
      let p = (GM1 * U) / V;

      if (cBurn[c] === 2 && cKi[c] >= 0 && rpm > 500) {
        // Livengood-Wu: sum dt / tau(p, T_endgas); knock when it reaches 1
        const Tu = cTs[c] * Math.pow(p / cPs[c], 0.259);
        cKi[c] += dt * Math.exp(1.7 * Math.log(p * 9.869e-6) - 3800 / Tu) * kTauInv * cKl[c];
        if (cKi[c] >= 1) {
          cKi[c] = -1;
          const rem = 1 - cXb[c];
          if (rem > 0.03) {
            cKq[c] += cQ[c] * rem * 0.6; // the rest is lost to the scrubbed walls
            cXb[c] = 1;
            cBurn[c] = 3;
            cMb[c] = m;
            const amp = 0.35 * rem * p;
            cKa[c] = amp;
            cKf[c] = this.kF1 * Math.sqrt(GAM * R * Math.max(1500, T));
            cKph[c] = 0;
            this.knockN++;
            if (amp > this.knockMax) this.knockMax = amp;
            if (this.knockCtl) this.knockRet = Math.min(15, this.knockRet + 1.5 + amp / 1.5e5);
          }
        }
      }
      let ring = 0;
      if (cKa[c] > 20) {
        const ph = cKph[c] + cKf[c] * dt;
        cKph[c] = ph;
        ring = cKa[c] * (Math.sin(TAU * ph) + 0.45 * Math.sin(TAU * 1.66 * ph + 0.5));
        cKa[c] *= kDecay;
        knockSnd += ring;
      }

      // exhaust valve (plus seat bounce when the valves float)
      let ae = exTab[i0] + (exTab[i0 + 1] - exTab[i0]) * fr;
      if (pv > 0) ae += pv * (exTabP[i0] + (exTabP[i0 + 1] - exTabP[i0]) * fr - ae);
      if (cBe[c] > 0) {
        let ph = ca - evc;
        if (ph < 0) ph += cycle;
        if (ph < 40) ae += this.maxAeT * cBe[c] * bounce(ph);
        else cBe[c] = 0;
      }
      if (ae > 1e-9) {
        const e = cExEnd[c];
        const zm = exZ[e];
        const zc = (GAM * R * T * dt) / V;
        const D = p - P_AMB - 2 * exIn[e];
        let md;
        if (D >= 0) {
          const rho = p / (R * T);
          md = orifice(ae, D, rho, zm + zc, p, Math.sqrt(T), CHOKE);
          // turbulent jet noise through the valve gap
          const vj = md / (rho * ae);
          exOut[e] += (rnd() - 0.5) * md * (vj < 600 ? vj : 600) * rasp;
        } else {
          const pp = P_AMB + 2 * exIn[e];
          md = -orifice(ae, -D, pp / (R * Tex), zm + zc, pp, sqTex, CHOKE);
        }
        exOut[e] += zm * md;
        const dm = md * dt;
        if (dm > 0) {
          if (ts) {
            // Loop scavenging: the fresh charge pushes the burned gas ahead
            // of it, so what leaves is more burned (and hotter) than the
            // cylinder average. Two zones: fresh charge at the temperature it
            // came in at, burned gas holding the rest of the energy.
            const mb = cMb[c] < m ? cMb[c] : m;
            const xo = mb < m ? 1 - Math.pow(1 - mb / m, scavK) : 1;
            const mf = m - mb;
            let Tb = mb > 1e-9 ? (U / CV - mf * cTf[c]) / mb : T;
            if (Tb < T) Tb = T;
            const Tout = xo * Tb + (1 - xo) * cTf[c];
            U -= dm * CP * Tout;
            egtOut += dm * Tout;
            egtOutW += dm;
            cMb[c] -= dm * xo;
            if (cMb[c] < 0) cMb[c] = 0;
            // the header holds a mix of what left lately: what the pipe
            // pushes back in is that mix (short-circuited charge included)
            cExB[c] += (xo - cExB[c]) * (dm < exPool ? dm / exPool : 1);
          } else {
            U -= dm * CP * T;
            cMb[c] -= (cMb[c] * dm) / m;
          }
        } else {
          // backflow from the port: only as 'burned' as what went out
          U -= dm * CP * Tex;
          cMb[c] -= dm * cExB[c];
          if (ts) plugAcc -= dm; // the chamber stuffing charge back in
        }
        m -= dm;
        if (m < 1e-7) m = 1e-7;
        T = U / (m * CV);
        p = (GM1 * U) / V;
      }

      if (ts) {
        // Transfer ports: crankcase charge up into the cylinder, or burned
        // gas blown back down while the cylinder is still above crankcase
        // pressure (low revs, big throttle).
        const at = inTab[i0] + (inTab[i0 + 1] - inTab[i0]) * fr;
        let mc = ccM[c], Uc = ccU[c];
        const Vc = ccV[c];
        if (at > 1e-9) {
          const Tc = Uc / (mc * CV);
          const pc = (GM1 * Uc) / Vc;
          const zs = (GAM * R * T * dt) / V + (GAM * R * Tc * dt) / Vc;
          const D = pc - p;
          let md;
          if (D >= 0) md = orifice(at, D, pc / (R * Tc), zs, pc, Math.sqrt(Tc), CHOKE_AIR);
          else md = -orifice(at, -D, p / (R * T), zs, p, Math.sqrt(T), CHOKE);
          const dm = md * dt;
          if (dm > 0) {
            const b = (ccB[c] * dm) / mc;
            cTf[c] += (Tc - cTf[c]) * (dm < m ? dm / m : 1);
            U += dm * CP * Tc;
            Uc -= dm * CP * Tc;
            cMb[c] += b;
            ccB[c] -= b;
          } else {
            const b = (cMb[c] * -dm) / m;
            U += dm * CP * T;
            Uc -= dm * CP * T;
            cMb[c] -= b;
            ccB[c] += b;
          }
          m += dm;
          mc -= dm;
          if (m < 1e-7) m = 1e-7;
          if (mc < 1e-7) mc = 1e-7;
          T = U / (m * CV);
          p = (GM1 * U) / V;
        }
        // Reed valve: the petals lift with the pressure difference across
        // them and only ever let the charge in.
        const e = cInEnd[c];
        const pu = P_AMB + 2 * inIn[e];
        const dp = pu - (GM1 * Uc) / Vc;
        const tgt = dp > reedP0 ? (dp - reedP0 < reedPf ? (dp - reedP0) / reedPf : 1) : 0;
        const rd = cReed[c] + reedK * (tgt - cReed[c]);
        cReed[c] = rd;
        if (rd > 1e-4 && dp > 0) {
          const zm = inZ[e];
          const md = orifice(reedA * rd, dp, pu / (R * Tint), zm + (GAM * R * (Uc / (mc * CV)) * dt) / Vc, pu, sqTint, CHOKE_AIR);
          inOut[e] -= zm * md;
          const dm = md * dt;
          // the carburettor's fuel evaporates on the way in and cools it
          Uc += dm * (CP * Tint - evapH);
          mc += dm;
        }
        ccM[c] = mc;
        ccU[c] = Uc;
        ccP[c] = (GM1 * Uc) / Vc;
      }

      // intake valve
      let ai = ts ? 0 : inTab[i0] + (inTab[i0 + 1] - inTab[i0]) * fr;
      if (cBi[c] > 0) {
        let ph = ca - ivc;
        if (ph < 0) ph += cycle;
        if (ph < 40) ai += this.maxAiT * cBi[c] * bounce(ph);
        else cBi[c] = 0;
      }
      if (ai > 1e-9) {
        const e = cInEnd[c];
        const zm = inZ[e];
        const zc = (GAM * R * T * dt) / V;
        const pu = P_AMB + 2 * inIn[e];
        const D = pu - p;
        let md;
        if (D >= 0) md = orifice(ai, D, pu / (R * Tint), zm + zc, pu, sqTint, CHOKE_AIR);
        else md = -orifice(ai, -D, p / (R * T), zm + zc, p, Math.sqrt(T), CHOKE);
        inOut[e] -= zm * md;
        const dm = md * dt;
        if (dm > 0) {
          U += dm * CP * Tint;
          // reverted exhaust gas comes back first and stays burned gas
          const rb = cRunB[c];
          if (rb > 0) {
            const b = dm < rb ? dm : rb;
            cMb[c] += b;
            cRunB[c] = rb - b;
          }
        } else {
          U += dm * CP * T;
          const bOut = (cMb[c] * -dm) / m;
          cMb[c] -= bOut;
          cRunB[c] += bOut;
        }
        m += dm;
        if (m < 1e-7) m = 1e-7;
      }

      // ring leakage (blow-by) toward crankcase
      const leak = (p - P_AMB) * kLeak * cLeak[c];
      if (leak > 0 && leak * dt < m * 0.01) {
        U -= leak * dt * CP * T;
        if (ts) cMb[c] -= (cMb[c] * leak * dt) / m;
        m -= leak * dt;
      }

      const Tmin = m * CV * 180;
      if (U < Tmin) U = Tmin;
      cm[c] = m;
      cU[c] = U;
      cV[c] = V;
      p = (GM1 * U) / V;
      // combustion noise excitation: the change in cylinder pressure
      combExc += p - cP1[c];
      cP1[c] = p;
      cP[c] = p + ring;
      torque += (p - (ts ? ccP[c] : P_AMB)) * dvdth;
    }
    if (ts) {
      this.egtOut += egtOut;
      this.egtOutW += egtOutW;
      this.plugAcc += plugAcc;
    }
    this.torqueGas = torque;
    this.vtExcS = vtExc;
    this.slapExcS = slapExc;
    this.injExcS = injExc;
    this.combExcS = combExc;
    this.knockSndS = knockSnd;
    return torque;
  }

  // Afterfire pressure sources at exhaust junctions (decaying bangs).
  stepAfterfireSources() {
    const afNodes = this.afNodes;
    const exSrc = this.ex.src;
    for (let k = 0; k < afNodes.length; k++) {
      const nd = afNodes[k];
      let src0 = 0;
      const env = this.afEnv[nd];
      if (env > 1e-4) {
        this.afRise[nd] += (1 - this.afRise[nd]) * 0.35;
        src0 = this.afAmp[nd] * env * this.afRise[nd] * (1 + 0.6 * (rnd() - 0.5));
        this.afEnv[nd] = env * this.afDecay[nd];
      }
      exSrc[nd] = src0;
    }
  }

  // Unburned fuel pools in the exhaust: random ignition -> bang.
  stepAfterfirePools() {
    const afNodes = this.afNodes;
    const dt = this.dt;
    const thresh = this.alsActive ? this.afMin * 4 : this.afMin;
    for (let k = 0; k < afNodes.length; k++) {
      const nd = afNodes[k];
      const f = this.afFuel[nd];
      if (f > thresh) {
        const heat = this.afHeat[nd];
        const air = this.afAir[nd];
        const mix = air / (f * AFR_ST + 1e-9);
        const rate = heat * 90 * (mix > 0.25 ? 1 : mix * 4) * (this.egt > 650 ? 1 : 0.3);
        if (rnd() < rate * dt) {
          const frac = 0.35 + 0.65 * rnd();
          const burnt = Math.min(f, air / AFR_ST + f * 0.3) * frac;
          const E = burnt * LHV;
          this.afFuel[nd] -= burnt;
          this.afAir[nd] = Math.max(0, air - burnt * AFR_ST);
          const amp = Math.min(60000, 36 * Math.pow(E, 0.8)) * (0.7 + 0.6 * rnd());
          this.afAmp[nd] = Math.max(this.afAmp[nd] * this.afEnv[nd], amp);
          this.afEnv[nd] = 1;
          this.afRise[nd] = 0;
          this.afDecay[nd] = Math.exp(-1 / (this.fs * (0.0006 + 0.0022 * rnd())));
          this.afEvents++;
          this.afIntensity = Math.max(this.afIntensity, amp / 30000);
          // (an open wastegate lets much of the bang bypass the wheel)
          if (this.isTurbo && this.alsActive) this.wt += (0.07 * E * (1 - 0.85 * this.wg)) / (this.tJ * this.nT * Math.max(this.wt, 2000));
        }
        this.afFuel[nd] = f * (1 - dt * 7);
        this.afHeat[nd] = heat * (1 - dt * 3);
      } else if (this.afAir[nd] > 0) {
        this.afAir[nd] *= 1 - dt * 7;
      }
    }
  }
}
