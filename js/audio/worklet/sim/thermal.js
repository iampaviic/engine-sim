// Engine temperature, at control rate, and what it changes: seven lumped
// masses heated by the fuel's heat and the engine's friction, cooled by the
// radiator and the air, and the sounds an engine makes as it cools.
//
//   w  the hot metal round the combustion chambers and exhaust ports
//   h  the head's coolant and the head round it (the temperature sender)
//   b  the rest of the coolant and the block
//   o  the oil, with the crank, rods, pistons and sump
//   m  the intake manifold
//   r  the fuel rail and the fuel in it
//   x  the exhaust manifold and down pipe
//
// The masses and conductances come from the engine's size (compile.js,
// thermalSpec, where they are explained). Each mass in turn relaxes towards
// the temperature its neighbours and its heat input hold it at, which stays
// stable for a step of any length, so the same step serves the worklet
// (every 32 samples)
// and the app, which cools a stored engine down by the hours it was left
// (soakThermal). Nothing here is in the per-sample path except the sounds.

import { LHV, T_AMB, TAU } from '../constants.js';
import { Band4, clamp, lpCoef, Struck } from '../dsp.js';

// The fully warm engine: the state every offline tool runs at, and the one
// the rest of the model was calibrated at. Every temperature effect below is
// measured from it, so at this state the engine behaves as it did before it
// had a temperature.
export const T_WARM = 363.15; // coolant, 90 °C
export const T_OIL_WARM = 368.15; // oil, 95 °C

// Wax thermostat: starts to open at 88 °C, fully open by 92 °C.
const THERMO_OPEN = 361.15;
const THERMO_FULL = 365.15;
// Radiator fan: on at 100 °C, off again at 96 °C.
const FAN_ON = 373.15;
const FAN_OFF = 369.15;
// The fuel washing through the rail while the pump runs, return flow
// included: about 30 W/K (an estimate).
const RAIL_FLOW = 30;

// Kinematic viscosity (cSt) of a 5W-30 oil at T kelvin, by Walther's
// equation (ASTM D341) through its data-sheet points, 64 cSt at 40 °C and
// 10.8 at 100 °C: about 125 cSt at 25 °C, 550 at 0 °C, 2,900 at -20 °C.
export function oilVisc(T) {
  const t = T > 233 ? T : 233;
  return Math.pow(10, Math.pow(10, 7.867 - 3.049 * Math.log10(t))) - 0.7;
}
const VISC_WARM = oilVisc(T_OIL_WARM);

// A mass at T with heat capacity C (J/K), joined by conductances summing to
// G (W/K) to neighbours whose conductance-weighted temperatures sum to GT,
// heated by Q (W), after dt seconds.
function relax(T, C, G, GT, Q, dt) {
  if (!(G > 0)) return T + (Q * dt) / C;
  const Te = (GT + Q) / G;
  return Te + (T - Te) * Math.exp((-G * dt) / C);
}

// The warm manifold: held between the head and the air under the bonnet,
// with the exhaust's glow on it.
function manifoldRef(p, amb) {
  const gMA = p.aMan * 9;
  const x = exhaustRef(amb);
  return (p.gHM * T_WARM + gMA * amb + p.gXM * x) / (p.gHM + gMA + p.gXM);
}
// The exhaust manifold at a warm idle, about 200 °C.
function exhaustRef(amb) {
  return amb + 0.6 * (650 - amb);
}

// A fresh state object, fully warm (the default) or cold through at amb.
export function newThermal(p, amb = T_AMB, cold = false) {
  const s = { w: 0, h: 0, b: 0, o: 0, m: 0, r: 0, x: 0, th: 0, fan: false, after: 0, bleed: 0, runT: 0 };
  return setThermalState(p, s, amb, cold);
}
export function setThermalState(p, s, amb, cold) {
  if (cold) {
    s.w = s.h = s.b = s.o = s.m = s.r = s.x = amb;
    s.th = 0;
    // a night's rest: the lifters held open by their cams have bled down
    s.bleed = 1;
  } else {
    s.h = s.b = T_WARM;
    s.w = T_WARM + 4;
    s.o = T_OIL_WARM;
    s.m = manifoldRef(p, amb);
    s.r = amb + 5 + ((s.m - amb - 5) * p.gRM) / (p.gRM + RAIL_FLOW);
    s.x = exhaustRef(amb);
    s.th = 0.5;
    s.bleed = 0;
  }
  s.fan = false;
  s.after = 0;
  s.runT = 99;
  return s;
}

// One step of dt seconds. q holds what the engine is doing: run (the crank
// turns the pumps), rpm, fuelW (fuel power, W), load (0..1), fricW
// (friction power, W), air (kg/s drawn in), eps (the share of the wall's
// excess temperature the charge picks up), tin (K, air arriving at the
// ports), exFlow (kg/s), egt (K), v (road speed, m/s), pump (the fuel pump
// runs), amb (K).
export function thermalStep(p, s, q, dt) {
  const a = q.amb;
  const run = q.run;
  // Air through the radiator core: ram air through the grille (about a
  // quarter of the road speed), the fan, a little natural draught.
  const ram = 0.25 * q.v;
  const fanU = s.fan ? p.fanU : 0;
  const u = Math.sqrt(ram * ram + fanU * fanU) + p.uNat;
  const rad = p.gRad * Math.pow(u / p.uDesign, 0.7);
  // Surfaces: 9 W/m^2 K in still air, more in the draught under the bonnet
  // (a fifth of the road speed, or the fan's) and under the car.
  const ub = Math.sqrt(0.04 * q.v * q.v + (s.fan ? 4 : 0));
  const hb = 9 + 6 * Math.sqrt(ub);
  const hu = 9 + 6 * Math.sqrt(0.5 * q.v);
  // The thermostat's wax melts over a few kelvin and follows in ~15 s; shut,
  // a bypass still lets 3% through.
  const thT = s.h <= THERMO_OPEN ? 0 : s.h >= THERMO_FULL ? 1 : (s.h - THERMO_OPEN) / (THERMO_FULL - THERMO_OPEN);
  s.th += (thT - s.th) * (1 - Math.exp(-dt / 15));
  const open = 0.03 + 0.97 * s.th;

  // Heat in: a third of the fuel's energy at light load, a quarter at full
  // (Heywood), into the chamber walls, a twentieth of it through the pistons
  // into the oil; friction half into the oil (bearings, cams), half into
  // the bores and so the block.
  const qGas = q.fuelW * (0.33 - 0.08 * q.load);
  const qFr = q.fricW;
  // The charge picks up heat from the ports and the manifold on its way in.
  const qCh = q.air * 1005 * q.eps * (0.5 * (s.m + s.h) - q.tin);

  const gWH = run ? p.gWH : p.gWH / 6; // forced flow, or a still jacket
  const gHB = run ? p.gPump * Math.max(0.15, q.rpm / 3000) : p.gSiphon;
  // the oil sprayed and splashed on the block's walls, more of it the faster
  // the oil pump turns (heat transfer ~ flow^0.8); stopped, drained to the sump
  const gBO = run ? p.gBO * Math.pow(Math.max(0.4, q.rpm / 3000), 0.8) : p.gBO / 3;
  // stopped, only a trickle of thermosiphon moves coolant through the
  // radiator (a few percent of the pump's flow, an estimate)
  const gR = open * rad * (run ? 1 : 0.03);
  s.w = relax(s.w, p.cW, gWH, gWH * s.h, 0.95 * qGas, dt);
  // (the exhaust manifold's flange conducts into the head: running, a share
  // of the exhaust's heat; stopped, the heat soak that lifts the head's
  // coolant for minutes after a hard run)
  s.h = relax(s.h, p.cH, gWH + gHB + p.gHM + gR + p.gXH, gWH * s.w + gHB * s.b + p.gHM * s.m + gR * a + p.gXH * s.x, -0.5 * qCh, dt);
  const gBA = p.aEng * hb;
  s.b = relax(s.b, p.cB, gHB + gBO + gBA, gHB * s.h + gBO * s.o + gBA * a, 0.5 * qFr, dt);
  const gOA = p.aSump * hu;
  s.o = relax(s.o, p.cO, gBO + gOA, gBO * s.b + gOA * a, 0.5 * qFr + 0.05 * qGas, dt);
  const gMA = p.aMan * hb;
  s.m = relax(s.m, p.cM, p.gHM + gMA + p.gXM, p.gHM * s.h + gMA * a + p.gXM * s.x, -0.5 * qCh, dt);
  // The fuel rail sits on the manifold. While the pump runs, fuel from the
  // tank (a few kelvin above the air) keeps it cool; stopped, it soaks up
  // towards the manifold's temperature over a few minutes.
  const gF = q.pump ? RAIL_FLOW : 0;
  s.r = relax(s.r, p.cR, p.gRM + gF, p.gRM * s.m + gF * (a + 5), 0, dt);
  // The exhaust: heated by the gas (pulsing pipe flow, 20 to 250 W/m^2 K
  // with the flow), cooled by the air and by its own glow (emissivity 0.85,
  // which dominates once it is hot).
  const gGX = run ? p.aX * (20 + 230 * Math.pow(q.exFlow / p.exMax, 0.8)) : 0;
  const gXA = p.aX * (hu + 4.8e-8 * (s.x * s.x + a * a) * (s.x + a));
  s.x = relax(s.x, p.cX, gGX + gXA + p.gXM + p.gXH, gGX * q.egt + gXA * a + p.gXM * s.m + p.gXH * s.h, 0, dt);

  // The fan runs on the sender's temperature, and for ten minutes after
  // the engine stops it may come on again to clear the heat soak.
  if (run) s.after = 600;
  else if (s.after > 0) s.after -= dt;
  if ((run || s.after > 0) && s.h > FAN_ON) s.fan = true;
  else if (s.h < FAN_OFF || (!run && s.after <= 0)) s.fan = false;

  // Hydraulic lifters: a lifter held open by its cam bleeds down over an
  // hour or two at rest; running, the oil pressure refills it in a few
  // seconds, once the pump has filled the galleries (~1 s). (Estimates.)
  if (run) {
    s.runT += dt;
    if (s.runT > 1) s.bleed *= Math.exp(-dt / 3);
  } else {
    s.runT = 0;
    s.bleed += (1 - s.bleed) * (1 - Math.exp(-dt / 5400));
  }
}

// Cool a stopped engine down by secs seconds: the app's catch-up for the
// time it was not running.
const SOAK_IN = { run: false, rpm: 0, fuelW: 0, load: 0, fricW: 0, air: 0, eps: 0, tin: T_AMB, exFlow: 0, egt: T_AMB, v: 0, pump: false, amb: T_AMB };
export function soakThermal(p, s, secs, amb = T_AMB) {
  SOAK_IN.amb = SOAK_IN.tin = SOAK_IN.egt = amb;
  let t = Math.min(secs, 2 * 86400);
  let done = 0;
  while (t > 0) {
    // short steps while the heat soak and the fan's after-run play out
    const dt = Math.min(t, done < 1200 ? 2 : 30);
    thermalStep(p, s, SOAK_IN, dt);
    t -= dt;
    done += dt;
  }
  if (secs > 2 * 86400) setThermalState(p, s, amb, true);
  return s;
}

export class ThermalMethods {
  initThermal(cfg) {
    const p = cfg.thermal;
    const fs = this.fs;
    this.thP = p;
    this.ambT = T_AMB; // the one ambient temperature (weather will set it)
    this.th = newThermal(p, this.ambT);
    this.thQ = { run: false, rpm: 0, fuelW: 0, load: 0, fricW: 0, air: 0, eps: 0, tin: T_AMB, exFlow: 0, egt: T_AMB, v: 0, pump: false, amb: T_AMB };
    // what the cylinders burned and breathed since the last control step
    this.thFuel = 0;
    this.thAir = 0;
    this.thLoad = 0;
    this.thN = 0;
    this.thAirS = 0; // air flow, smoothed over the cylinders' events
    this.wallRef = 0.5 * (T_WARM + manifoldRef(p, this.ambT));
    // the temperature effects, all neutral at the warm state
    this.visc = 1;
    this.fastIdle = 0;
    this.idleAirK = 1;
    this.chargeDT = 0;
    this.burnK = 1;
    this.eps = 0.27;
    this.covCold = 0;
    this.vapour = 0; // share of the fuel rail that is vapour after a hot soak
    // piston clearance against block temperature (mechSpec)
    this.clrK = cfg.mech.slap.dcdT / Math.max(1e-9, cfg.mech.slap.clearance);
    this.slapK0 = this.slapK;
    this.slapCross0 = this.slapCross;
    // hydraulic lifters held open at rest (set when the engine stops)
    this.cHeld = new Float64Array(this.n);
    this.cBleed = new Float64Array(this.n);
    this.heldSet = false;

    // Exhaust ticking. As the pipe cools it shrinks (steel, 12e-6 /K) and
    // its joints, hangers and heat shields hold on by friction until the
    // stress lets go in a slip: stick-slip, a tick each time, more often
    // the faster it cools. Six joints, three of them heat shields (thin
    // panels ringing at 1-6 kHz with little damping: the "ping"), three
    // flanges and hangers on the pipe itself (a duller tick). Each slip is
    // an impulse into its structure, calibrated so a shield pings at about
    // 0.1 Pa at 1 m (74 dB) and the pipe ticks at about 0.06 (estimates; the
    // radiation is mechSpec's p = rho c v sqrt(S / 2 pi)).
    this.tkS = new Struck([1450, 2650, 4100, 5900], [180, 200, 220, 240], [0.4, 0.3, 0.2, 0.1].map((g) => g * 1745), fs);
    this.tkP = new Struck([720, 1300, 2300], [18, 22, 26], [0.5, 0.3, 0.2].map((g) => g * 74), fs);
    this.tkJ = new Float64Array(6); // stress since the last slip
    this.tkLim = new Float64Array(6); // where each lets go next
    this.tkK = Float64Array.from([1.3, 0.8, 1.1, 0.7, 1.5, 0.9]); // slips per kelvin
    this.tRs = 0x6a09e667; // the thermal sounds' own random stream
    for (let j = 0; j < 6; j++) this.tkLim[j] = 0.6 + 0.8 * this.trnd();
    this.tkXs = 0;
    this.tkXp = 0;
    this.tkOn = 0;
    this.tkPrev = this.th.x;
    // Radiator fan: seven blades at 2,400 rpm at full speed; broadband noise
    // from the blades' wakes and a tone at the blade pass, the noise power
    // rising as the fifth power of speed (the fan laws). It spins up in about
    // a second and coasts down over several.
    this.fanW = 0;
    this.fanPh = 0;
    this.fanBand = new Band4(900, 0.6, fs);
    this.fanLoA = lpCoef(350, fs);
    this.fanLo = 0;
    this.fanBpf = (7 * 2400) / 60;
    // level of the band-limited noise for unit input, measured once
    {
      const b = new Band4(900, 0.6, fs);
      let e = 0, r = 7;
      for (let i = 0; i < 6000; i++) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        const y = b.tick(r / 0x7fffffff - 0.5);
        if (i > 1000) e += y * y;
      }
      this.fanG = (p.fanPa * 0.9) / Math.sqrt(e / 5000);
    }
  }

  trnd() {
    let s = this.tRs;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.tRs = s;
    return (s >>> 0) * 2.3283064365386963e-10;
  }

  // A stored or forced state from the app: { state } (from a save, already
  // cooled by the time away) or { preset: 'cold' | 'warm' }.
  setThermal(m) {
    const p = this.thP;
    if (m.ambient) this.ambT = m.ambient;
    if (m.preset) setThermalState(p, this.th, this.ambT, m.preset === 'cold');
    else if (m.state) Object.assign(this.th, m.state);
    this.tkPrev = this.th.x;
    if (!this.running && this.omega < 1) {
      // the gas left in a cold pipe is as cold as the pipe
      const t = clamp(this.th.x, this.ambT, 500);
      this.egt = this.egtInst = this.pipeWall = t;
      this.heldSet = false;
    }
    this.thermalEffects();
  }

  // Control rate: integrate the temperatures, then what they change.
  thermalControl(dtc, rpm) {
    const q = this.thQ;
    const s = this.th;
    q.amb = this.ambT;
    q.run = this.omega > 30;
    q.rpm = rpm;
    // (the fuel's heat as it comes, a charge at a time; the air flow
    // smoothed, as the heat transfer and the charge's warming follow its mean)
    q.fuelW = (this.thFuel * LHV) / dtc;
    this.thAirS += (this.thAir / dtc - this.thAirS) * Math.min(1, dtc / 0.3);
    q.air = this.thAirS;
    q.load = this.thN > 0 ? clamp(this.thLoad / this.thN, 0, 1.5) : 0;
    q.fricW = this.fric * this.omega;
    q.exFlow = 1.07 * this.thAirS;
    q.egt = this.egt;
    q.v = this.v;
    q.pump = this.pumpW > 0.5;
    q.tin = this.boosted ? this.TB : this.Tpl;
    // the charge picks up a quarter of the walls' excess at idle flow, less
    // as the flow grows (heat transfer ~ flow^0.8)
    q.eps = q.air > 0 ? clamp(0.27 * Math.pow(q.air / this.thP.airIdle, -0.2), 0.08, 0.35) : 0.27;
    this.thFuel = this.thAir = this.thLoad = 0;
    this.thN = 0;
    thermalStep(this.thP, s, q, dtc);
    this.eps = q.eps;
    this.thermalEffects();

    // which lifters stay held open: the cams' position where the crank stops
    if (!q.run && this.omega < 1 && !this.heldSet && this.hydJ > 0) {
      this.heldSet = true;
      const exT = this.exTabLo, inT = this.inTabLo;
      for (let c = 0; c < this.n; c++) {
        const i = (this.cCA[c] * this.tabScale) | 0;
        this.cHeld[c] = exT[i] > 0.05 * this.maxAeT || inT[i] > 0.05 * this.maxAiT ? 1 : 0;
      }
    } else if (q.run) this.heldSet = false;
    if (this.hydJ > 0) for (let c = 0; c < this.n; c++) this.cBleed[c] = this.cHeld[c] * s.bleed * this.hydJ;

    // vapour in the rail collapses under the pump's pressure in a few seconds
    if (this.vapour > 0) {
      if (this.ignition) this.vapour *= Math.exp(-dtc / 4);
      if (this.vapour < 0.005) this.vapour = 0;
    }

    // exhaust ticking: stress builds with each kelvin the pipe moves
    const dx = s.x - this.tkPrev;
    this.tkPrev = s.x;
    const ad = dx < 0 ? -dx : dx;
    if (ad > 1e-6) {
      for (let j = 0; j < 6; j++) {
        this.tkJ[j] += ad * this.tkK[j];
        if (this.tkJ[j] >= this.tkLim[j]) {
          const k = this.tkLim[j];
          this.tkJ[j] -= k;
          this.tkLim[j] = 0.6 + 0.8 * this.trnd();
          if (j < 3) this.tkXs += 5.8e-5 * k * (0.6 + 0.8 * this.trnd());
          else this.tkXp += 8e-4 * k * (0.6 + 0.8 * this.trnd());
          this.tkOn = (0.4 * this.fs) | 0;
        }
      }
    }
    // the fan spins up in about a second and coasts down over four
    const fT = s.fan ? 1 : 0;
    this.fanW += (fT - this.fanW) * Math.min(1, dtc / (fT > this.fanW ? 0.8 : 4));
    if (this.fanW < 1e-4 && !s.fan) this.fanW = 0;
  }

  // What the temperatures change, each neutral at the warm state.
  thermalEffects() {
    const s = this.th;
    const cfg = this.cfg;
    // Oil viscosity: the hydrodynamic part of the friction (bearings, skirts,
    // rings' film) grows as the square root of the viscosity, the form of the
    // hydrodynamic terms in Sandoval and Heywood's friction model (SAE
    // 2003-01-0725), whose cold engine has about twice the warm friction.
    this.visc = s.o === T_OIL_WARM ? 1 : Math.sqrt(oilVisc(s.o) / VISC_WARM);
    // The ECU's fast idle: 250 rpm more at 25 °C, nothing above 80 °C, up to
    // 400 rpm more in a frost (a typical calibration).
    this.fastIdle = 250 * clamp((353.15 - s.h) / 55, 0, 1.6);
    // and the extra idle air it allows for the extra friction at that speed
    if (this.visc !== 1) {
      const sp = (2 * cfg.stroke * (this.ecu.idle + this.fastIdle)) / 60;
      const warm = 0.72 + 0.024 * sp + 0.0019 * sp * sp;
      this.idleAirK = (warm + (this.visc - 1) * (0.22 + 0.024 * sp)) / warm;
    } else this.idleAirK = 1;
    // The charge warms on the ports and manifold: less than a warm engine's
    // when they are cold, more after a heat soak. A cooler charge burns
    // slower (laminar flame speed ~ T^2.18, Metghalchi and Keck; the
    // turbulent burn ~ its square root, an estimate).
    const dW = 0.5 * (s.m + s.h) - this.wallRef;
    this.chargeDT = dW === 0 ? 0 : this.eps * dW;
    const tin = (this.boosted ? this.TB : this.Tpl) + 20;
    this.burnK = this.chargeDT === 0 ? 1 : Math.pow(tin / (tin + this.chargeDT), 1.09);
    // Below about 80 °C some of the fuel reaches the cylinder as liquid off
    // the port walls, and the mixture varies from cycle to cycle: about
    // twice the warm engine's variation at 25 °C (an estimate).
    this.covCold = 0.03 * clamp((353.15 - s.h) / 55, 0, 1.5);
    // piston slap: impulse ~ c^(2/3), crossing time ~ c (see mechSpec)
    if (this.slapK0 > 0) {
      const k = Math.max(0.3, 1 + this.clrK * (T_WARM - s.b));
      this.slapK = k === 1 ? this.slapK0 : this.slapK0 * Math.cbrt(k * k);
      this.slapCross = this.slapCross0 * k;
    }
  }

  // Key on: after a hot soak the fuel in the rail has partly boiled (its
  // light ends, once the rail is past about 70 °C and its pressure has bled
  // away), so the first injections run lean until the pump's pressure
  // collapses the bubbles. (Estimates.)
  keyOnVapour() {
    if (!this.thP.injected || this.running) return;
    this.vapour = 0.6 * clamp((this.th.r - 343.15) / 20, 0, 1);
  }

  // The cooling engine's sounds, Pa at 1 m: exhaust ticks and the fan.
  thermalSound() {
    let out = 0;
    if (this.tkOn > 0) {
      out += this.tkS.tick(this.tkXs) + this.tkP.tick(this.tkXp);
      this.tkXs = this.tkXp = 0;
      this.tkOn--;
    }
    const fw = this.fanW;
    if (fw > 0) {
      const nz = this.trnd() - 0.5;
      const bb = this.fanBand.tick(nz);
      this.fanLo += this.fanLoA * (nz - this.fanLo);
      // blade pass, wavering a little with the blades' wakes
      this.fanPh += (this.fanBpf * fw * (1 + 0.01 * (this.trnd() - 0.5))) / this.fs;
      this.fanPh -= Math.floor(this.fanPh);
      const lvl = fw * fw * Math.sqrt(fw);
      out += (bb * this.fanG + this.fanLo * this.fanG * 0.5) * lvl + Math.sin(TAU * this.fanPh) * this.thP.fanPa * 0.5 * lvl;
    }
    return out;
  }
}
