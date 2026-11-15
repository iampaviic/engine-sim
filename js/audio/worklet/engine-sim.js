// One engine. The constructor declares all of its state, and render() is the
// per-sample loop; the methods it calls live in sim/*.js, one file per
// subsystem.

import { AFR_ST, CHOKE_AIR, CV, DYN_WASTEGATE, INV4PI, N_SRC, P_AMB, PI, R, RAD2DEG, T_AMB, TAU } from './constants.js';
import { Band4, clamp, crossed, lpCoef, Modes } from './dsp.js';
import { Inlet } from './inlet.js';
import { Net } from './net.js';
import { ListenMethods } from './listener.js';
import { EcuMethods } from './sim/ecu.js';
import { CylinderMethods } from './sim/cylinders.js';
import { StarterMethods } from './sim/starter.js';
import { InductionMethods } from './sim/induction.js';
import { NitrousMethods } from './sim/nitrous.js';
import { DrivetrainMethods } from './sim/drivetrain.js';
import { MechanicalMethods } from './sim/mechanical.js';
import { AeroMethods } from './sim/aero.js';
import { ThermalMethods } from './sim/thermal.js';
import { GearboxMethods } from './sim/gearbox.js';
import { WeatherMethods } from './sim/weather.js';
import { SourceMethods } from './sim/sources.js';
import { mixin } from './mixin.js';

export class EngineSim {
  constructor(cfg, fs) {
    this.cfg = cfg;
    this.fs = fs;
    this.dt = 1 / fs;
    const n = cfg.nCyl;
    this.n = n;
    this.cycle = cfg.cycle;
    this.tdcFire = cfg.tdcFire;
    this.tabScale = cfg.tabN / cfg.cycle;
    this.vol = cfg.vol;
    this.dvd = cfg.dvd;
    this.off = cfg.cylOffset;
    this.inTabLo = cfg.inTab;
    this.exTabLo = cfg.exTab;
    this.inTabHi = cfg.inTabHi;
    this.exTabHi = cfg.exTabHi;
    this.vd = cfg.vd;
    this.dispTot = cfg.displacement;

    this.ex = new Net(cfg.ex, fs, true);
    this.inn = new Net(cfg.in, fs, false);

    // cylinder -> port ends & afterfire nodes
    this.cExEnd = new Int32Array(n).fill(-1);
    this.cInEnd = new Int32Array(n).fill(-1);
    this.cAf = new Int32Array(n).fill(-1);
    for (let i = 0; i < this.ex.N; i++) {
      const cyls = this.ex.nodeCyls[i];
      if (!cyls) continue;
      const e = this.ex.ends[this.ex.es[i]];
      for (const c of cyls) {
        this.cExEnd[c] = e;
        this.cAf[c] = this.ex.endNode[e ^ 1];
      }
    }
    for (let i = 0; i < this.inn.N; i++) {
      const cyls = this.inn.nodeCyls[i];
      if (!cyls) continue;
      const e = this.inn.ends[this.inn.es[i]];
      for (const c of cyls) this.cInEnd[c] = e;
    }

    // Cylinder state
    this.cm = new Float64Array(n);
    this.cU = new Float64Array(n);
    this.cMb = new Float64Array(n);
    this.cV = new Float64Array(n);
    this.cCA = new Float64Array(n);
    this.cP = new Float64Array(n);
    this.cP1 = new Float64Array(n);
    this.cFuel = new Float64Array(n);
    this.cBurnable = new Float64Array(n);
    this.cQ = new Float64Array(n);
    this.cSpark = new Float64Array(n);
    this.cDur = new Float64Array(n);
    this.cBurn = new Uint8Array(n); // 0 idle, 1 armed, 2 burning, 3 done
    this.cXb = new Float64Array(n);
    this.cFired = new Float64Array(n); // viz: recent combustion intensity
    this.cAirIn = new Float64Array(n);
    this.cRunB = new Float64Array(n); // burned gas pushed back into the intake runner
    this.cExB = new Float64Array(n).fill(0.9); // burned fraction of gas in this cylinder's exhaust port
    for (let c = 0; c < n; c++) {
      let ca = this.off[c] % this.cycle;
      this.cCA[c] = ca;
      const V = this.volAt(ca);
      this.cV[c] = V;
      const m = (P_AMB * V) / (R * T_AMB);
      this.cm[c] = m;
      this.cU[c] = m * CV * T_AMB;
      this.cMb[c] = 0.05 * m;
      this.cP[c] = P_AMB;
      this.cP1[c] = P_AMB;
    }

    // Two-stroke: a sealed crankcase under each piston, fed through a reed
    // valve and emptied up the transfer ports; an exhaust power valve.
    const ts = cfg.twoStroke;
    this.twoStroke = !!ts;
    if (ts) {
      this.ccTot = ts.ccTot;
      this.reedA = ts.reedArea;
      this.reedP0 = ts.reedP0;
      this.reedPf = ts.reedPf;
      this.scavK = ts.scav;
      this.exPool = 0.7 * cfg.vd; // kg of gas the header holds, about
      this.pvRpm = ts.pv;
      this.pv = 0; // power valve 0 = low-speed port .. 1 = raised
      this.reedK = lpCoef(650, fs); // petals can't follow faster than this
      this.ccM = new Float64Array(n);
      this.ccU = new Float64Array(n);
      this.ccB = new Float64Array(n); // burned gas blown back into the crankcase
      this.ccV = new Float64Array(n);
      this.ccP = new Float64Array(n).fill(P_AMB);
      this.cTf = new Float64Array(n).fill(T_AMB); // fresh charge temperature in the cylinder
      this.evapH = 350e3 / cfg.ecu.afr; // latent heat of the fuel per kg of air
      this.cReed = new Float64Array(n);
      for (let c = 0; c < n; c++) {
        const V = this.ccTot - this.cV[c];
        this.ccV[c] = V;
        this.ccM[c] = (P_AMB * V) / (R * T_AMB);
        this.ccU[c] = this.ccM[c] * CV * T_AMB;
      }
    }
    this.egtOut = 0; // two-stroke: outflow-weighted exhaust temperature
    this.egtOutW = 0;
    this.plugAcc = 0; // two-stroke: charge the chamber pushed back this cycle
    this.plug = 0;

    // Afterfire pools per exhaust node
    const N = this.ex.N;
    this.afFuel = new Float64Array(N);
    this.afAir = new Float64Array(N);
    this.afHeat = new Float64Array(N);
    this.afAmp = new Float64Array(N);
    this.afEnv = new Float64Array(N);
    this.afRise = new Float64Array(N);
    this.afDecay = new Float64Array(N);
    this.afNodes = Int32Array.from([...new Set(Array.from(this.cAf).filter((x) => x >= 0))]);
    this.afEvents = 0;
    this.afMin = (1.18 * cfg.vd) / AFR_ST * 0.06; // ~6% of a cylinder's fuel charge
    this.afIntensity = 0;
    this.afSide = 0;

    // Crank
    this.crank = 0;
    this.omega = 0;
    this.J = cfg.inertia;
    this.torqueGas = 0;

    // Plenum / throttle
    this.Vpl = cfg.plenumVolume;
    this.Tpl = T_AMB;
    this.pPl = P_AMB;
    this.mPl = (P_AMB * this.Vpl) / (R * T_AMB);
    this.mdTh = 0;
    // The inlet tract (airbox and snorkel) and what drives it: the flow it
    // feeds, the throttle's jet noise and edge tone.
    this.inlet = new Inlet(cfg.inlet, fs);
    this.inFlow = 0;
    this.inPrev = 0;
    this.inMean = 0;
    this.inMeanA = lpCoef(8, fs);
    this.jetW = 0;
    this.jetG = 0;
    this.jet1 = this.jet2 = 0;
    this.jetA1 = this.jetA2 = this.jetA3 = 0;
    this.edgeA = 0;
    this.edgeF = 0;
    this.edgePh = 0;
    this.edgeJit = 0;
    this.bovSnd = 0;
    this.runnerFlow = 0;
    this.itb = cfg.itb ? 1 : 0;
    this.mapA = lpCoef(25, fs); // the manifold pressure rail of individual throttles
    this.mdLp = 0;
    this.Ath = cfg.throttleArea;
    // air that gets past a closed throttle: less on a small engine
    this.thrLeak = 2e-6 * clamp(cfg.dispLitres, 0.25, 1);

    // Boost system
    const ind = cfg.induction;
    this.fiType = ind.type;
    this.isTurbo = ind.type === 'turbo';
    this.isSC = ind.type === 'roots' || ind.type === 'twinscrew';
    this.isCentri = ind.type === 'centrifugal';
    this.pB = P_AMB;
    // boost plumbing and turbos sized by the air the engine breathes: a
    // rotor moves as much as a four-stroke of twice its chamber volume
    const airL = cfg.kind === 'rotary' ? cfg.displacement * 1000 : cfg.dispLitres;
    this.Vb = this.isTurbo || this.isCentri ? 0.004 + airL * 0.0012 : 0.003 + airL * 0.0006;
    this.TB = T_AMB;
    this.boostTarget = ind.boost * 1e5;
    this.boostNow = this.boostTarget; // what the boost control aims at right now
    this.nT = this.isTurbo ? Math.max(1, ind.count) : this.isCentri ? 1 : 0;
    this.wt = 0; // turbo shaft speed (rad/s), aggregated over turbos
    this.mc = 0; // compressor mass flow (Greitzer state)
    this.mcPrev = 0;
    // turbo voice: surge activity and pulse bursts, band-limited noises for
    // the whoosh and the stalled wheel, the blade tone's wobble and halo
    this.sgAct = 0;
    this.sgActDec = Math.exp(-1 / (0.15 * fs));
    this.mcSgn = 0;
    this.burst = 0;
    this.burstDec = Math.exp(-1 / (0.005 * fs));
    this.sgD = 0;
    this.sgDA = lpCoef(2500, fs);
    this.burstBand = new Band4(1400, 0.8, fs);
    this.whBand = new Band4(1700, 0.7, fs);
    this.wJit = 0;
    this.wJitA = lpCoef(25, fs);
    this.tpLp = 0;
    this.tpLpA = lpCoef(300, fs);
    this.tPulse = 1;
    this.sgB = new Float64Array(3);
    this.sgX1 = this.sgX2 = this.sgY1 = this.sgY2 = 0;
    this.bovBand = new Band4(3000, 0.5, fs);
    this.sgK = 32;
    this.pBrate = 0;
    this.pBprev = P_AMB;
    this.wg = 0; // wastegate opening 0..1
    this.wtRate = 0;
    this.wtPrev = 0;
    this.wt2Prev = 0;
    this.bov = 0;
    this.bovS = 0; // per-sample ramps of the control-rate valve positions
    this.bovStep = 0;
    this.mdBov = 0;
    this.turbP = new Float64Array(Math.max(this.nT, 1));
    this.turbPs = 0;
    this.scBypass = 1;
    this.scBypassS = 1;
    this.scBypassStep = 0;
    this.scPower = 0;
    const size = ind.size;
    // turbo sizing (per turbo) scaled from displacement per turbo
    const dPer = airL / Math.max(this.nT, 1);
    this.tJ = 4e-5 * Math.pow(dPer, 1.1) * size * size;
    this.tRtip = 0.024 * Math.sqrt(dPer / 2) * Math.sqrt(size);
    this.tChokeK = 0.00072 * Math.pow(dPer, 0.85) * size; // kg/s per (m/s) tip speed
    // turbine effective area: the housing (A/R) sets where the turbo wakes up;
    // the wastegate and the sequential valves are sized by the frame
    const tFrame = 9e-4 * Math.pow(dPer / 2, 0.8) * size;
    this.tA = tFrame * (ind.ar ?? 1);
    this.tAwg = tFrame * 2.4;
    this.tAstage = tFrame * 2.5;
    // dump valve(s) sized to the engine's air: ~40 mm for a 2 L four
    this.bovA = 5.5e-4 * Math.pow(airL, 0.8);
    // inlet duct from the compressor face to the filter (~0.25-0.4 m): a
    // tube closed at the wheel, open at the filter, as a delay loop
    const ductL = clamp(0.06 + 9 * this.tRtip, 0.2, 0.42);
    this.dD = Math.max(4, Math.round(((2 * ductL) / 343) * fs));
    this.dBuf = new Float64Array(1024);
    this.dI = 0;
    this.dLp = 0;
    this.dLpA = lpCoef(2800, fs);
    // more compressor, more whoosh: noise power grows with the air moved
    this.whK = Math.sqrt(airL / 2);
    // inlet/compressor restriction: a bigger engine per compressor gets a
    // proportionally bigger wheel
    // Sequential turbos: half of them (one per side) take all the exhaust
    // until valves open the second stage above ind.sequential rpm. Each
    // stage has its own shaft speed and compressor.
    this.seqRpm = this.isTurbo && this.nT >= 2 && ind.sequential > 0 ? ind.sequential : 0;
    this.nA = this.seqRpm ? this.nT / 2 : this.nT;
    this.nB = this.nT - this.nA;
    this.stage = 0; // second-stage valves, 0..1
    this.stageT = 0;
    this.wt2 = 0;
    this.mc2 = 0;
    this.flap2 = 0;
    this.turbPs2 = 0;
    // tonal voices: a parallel pair (or a sequential stage of two) gets a
    // second voice, the other turbo spinning a hair slower
    const voice = () => ({ ph2: 0, jit: 0 });
    this.vA2 = voice();
    this.vB = voice();
    this.vB2 = voice();
    const restr = (k) => (4e5 * Math.min(1, Math.pow(2.5 / dPer, 2))) / Math.pow(Math.max(k, 1) * size, 2);
    this.tRestr = restr(this.nA);
    this.tRestrB = restr(this.nB);
    this.wgI = 0;
    this.blades = ind.blades;
    this.bovType = ind.bov;
    this.tPhase2 = 0;
    this.scPhase = 0;
    this.turbPsm = 0;
    this.burbleActive = false;
    this.alsActive = false;
    this.launchCut = false;
    this.shiftRetard = 0;
    this.accel = 0;
    this.cycTq = 0;
    this.cycN = 0;
    this.cycleTorque = 0;
    this.strobeOn = true;
    this.strobeStep = 3;
    this.strobeAngle = 0;
    this.snapWait = 0;
    this.snapGap = Math.round(fs / 45);
    this.snapReady = null;
    this.scRatio = ind.ratio;
    this.scDisp = ind.blowerDisp / 1000;
    this.scLobes = ind.lobes;
    // Pockets that come round per turn of the rotors, their built-in pressure
    // ratio and the shape of each one's pulse (see stepBlower). A Roots blower
    // discharges from both rotors in turn, through a helix that smears each
    // pulse over about half the gap to the next: nearly a pure tone. A
    // twin-screw has one pocket per lobe of its male rotor and a port that
    // opens in about a quarter of the gap, so its second harmonic is strong.
    // (Harmonic k of a pulse smeared over a fraction w of its period is
    // sinc(k w) / k.)
    const screw = ind.type === 'twinscrew';
    this.scPockets = screw ? ind.lobes : 2 * ind.lobes;
    this.scPi = screw ? 1.5 : 1;
    this.scH = screw ? [0.9, 0.32, 0.1] : [0.64, 0, 0.07];
    this.scTq = 0;
    this.bgPh = 0;
    this.redline = cfg.ecu.limit;
    if (this.isCentri) this.setCentriRatio();

    // Knock: Livengood-Wu integral of the end-gas ignition delay
    // (Douaud-Eyzat correlation) during each burn. When the end gas
    // autoignites, what is left of the charge burns at once and the chamber
    // rings at its first acoustic modes (1.84 c / (pi B) and ~1.66x that).
    this.octane = cfg.ecu.octane;
    // the day's air: its dry air against the reference day's, and what its
    // water is worth in octane numbers (sim/weather.js)
    this.weather = 'dry';
    this.airO2 = 1;
    this.humON = 0;
    // and its road: the tyres' grip against the dry road's, and how fast a
    // wet road's friction falls with sliding speed (per m/s)
    this.gripK = 1;
    this.slideK = 0;
    this.squealK = 1;
    // the water on it: film depth (mm), the spray's level and filters, and
    // the weather's own random stream
    this.film = 0;
    this.sprayK = 0;
    this.sprayA = 0;
    this.spHa = this.spLa = 0;
    this.spL = this.spH1 = this.spH2 = 0;
    this.wRs = 0x6a09e667;
    // rain on the roof: per drop class (half a roof each) the chance of a
    // drop each sample, its peak force and its decay; the force on each half
    // now; the near field's high-pass; the panel's modes; the sound at the
    // ears (sim/weather.js)
    this.rainOn = false;
    this.rnP = new Float64Array(6);
    this.rnF = new Float64Array(6);
    this.rnD = new Float64Array(6);
    this.rnYL = new Float64Array(6);
    this.rnYR = new Float64Array(6);
    this.rnNear = this.rnFar = this.rnHp = 0;
    this.rnHl = this.rnHr = 0;
    this.roofBank = null;
    this.rainL = this.rainR = 0;
    // the road's reflection to the listener: gain, and the corner above
    // which it loses the highs (camera.js)
    this.gndG = 0.62;
    this.gndF = 5200;
    this.setOctane(this.octane);
    this.kF1 = 1.841 / (PI * cfg.bore);
    this.kDecay = Math.exp(-1 / (fs * 0.0015));
    this.cKi = new Float64Array(n);
    this.cKl = new Float64Array(n).fill(1); // knock tendency from the mixture (tuning maps)
    this.cEgt = new Float64Array(n).fill(1); // exhaust temperature from the mixture (tuning maps)
    this.cPs = new Float64Array(n);
    this.cTs = new Float64Array(n);
    this.cKq = new Float64Array(n);
    this.cKa = new Float64Array(n);
    this.cKf = new Float64Array(n);
    this.cKph = new Float64Array(n);
    this.knockRet = 0;
    this.tipRet = 0;
    this.thrPrevC = 0;
    this.knockCtl = true;
    this.sparkAdj = 0;
    // Tuning maps (null: the factory calibration)
    this.maps = null;
    this.mRpm = this.mKpa = this.mSpark = this.mAfr = this.mBoost = this.mGear = null;
    this.lastAdv = 0;
    this.lastAfr = 0;
    // Following a real car (null: off). kind 'rpm': its engine speed comes
    // from the car; kind 'speed': only its road speed does.
    this.follow = null;
    this.followV = -1; // road speed the wheels are held to (speed kind), m/s
    this.followA = 0;
    this.knockSndS = 0;
    this.knockN = 0;
    this.knockMax = 0;
    // Valve float: above the spring's limit the valves loft off the cam and
    // bounce on their seats after closing.
    this.floatRpm = cfg.floatRpm;
    this.floatMul = 1;
    this.floatSev = 0;
    this.cBi = new Float64Array(n);
    this.cBe = new Float64Array(n);
    let mxe = 1e-9, mxi = 1e-9;
    for (let i = 0; i < cfg.exTab.length; i++) {
      mxe = Math.max(mxe, cfg.exTab[i], cfg.exTabHi[i]);
      mxi = Math.max(mxi, cfg.inTab[i], cfg.inTabHi[i]);
    }
    this.maxAeT = mxe;
    this.maxAiT = mxi;
    // per-source mixer gains (shared with the processor)
    this.mix = new Float64Array(N_SRC).fill(1);
    // screamer pipe: wastegate resistor whose outlet radiates on its own
    this.wgRes = -1;
    if (this.ex.opens.some((_, i) => this.ex.oCh[i] === 6)) {
      for (let i = 0; i < this.ex.res.length; i++) if (this.ex.rDyn[i] === DYN_WASTEGATE) this.wgRes = i;
    }
    this.jetLp = 0;
    this.jetHp = 0;

    // ECU
    const e = cfg.ecu;
    this.ecu = e;
    this.ignition = false;
    this.starter = false; // key held at START (or the ECU's start request)
    this.starterT = 0;
    this.stHold = 0;
    this.crankRevs = 99;
    this.syncRevs = 0;
    this.filmLeft = 0; // injections a cold port wall still soaks up
    this.rpmAvg = 0;
    this.running = false;
    this.idleTarget = e.idle;
    this.idleI = 0;
    this.bypass = 0;
    this.sparkTrim = 0;
    this.limCut = false;
    this.dfco = false;
    this.burble = e.burble;
    this.liftT = 99;
    this.antilag = e.antilag;
    this.limiterType = e.limiter;
    this.limitRpm = e.limit;
    this.afrTarget = e.afr;
    this.launch = false;
    this.launchRpm = e.launchRpm;
    this.launchEff = e.launchRpm; // as the road's grip allows (sim/ecu.js)
    this.shiftCut = 0;
    this.flare = 0;
    this.camHi = false;
    this.camSwitch = cfg.camSwitchRpm;
    // Nitrous: liquid N2O through a solenoid into the intake
    this.nosShot = cfg.nitrous.shot; // hp
    this.nosBottle = cfg.nitrous.bottle; // kg when full
    this.bottle = this.nosBottle;
    this.nosBtn = false;
    this.nosOn = false; // spraying
    this.nosPurge = false;
    this.nosFlow = 0; // kg/s into the intake
    this.purgeFlow = 0; // kg/s out of the purge valve
    this.nosX = 0; // N2O share of the fresh charge
    this.mNos = 0; // N2O in the plenum, kg
    this.nosCool = 0; // charge cooling, K
    this.nosRet = 0; // timing pulled while spraying
    this.nosClick = 0;
    this.nosRing = 0;
    this.nosSol = new Modes([2350, 3900, 6200], [0.005, 0.0035, 0.0025], [0.9, 0.6, 0.35], fs);
    // The purge jet's hiss: noise between 3 and 12 kHz (see nitrousSound).
    // hsG scales it to pascals at 1 m per root kg/s; the band's own level is
    // measured here once, with a throwaway random sequence.
    this.hsA = lpCoef(Math.min(12000, 0.45 * fs), fs);
    this.hsB = lpCoef(3000, fs);
    {
      let a = 0, b = 0, e = 0, r = 12345;
      for (let i = 0; i < 4000; i++) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        a += this.hsA * (r / 0x7fffffff - 0.5 - a);
        b += this.hsB * (a - b);
        e += (a - b) * (a - b);
      }
      this.hsG = 13.6 / Math.sqrt(e / 4000);
    }
    this.hs1 = 0;
    this.hs2 = 0;
    this.valveOpen = 0; // exhaust bypass valve 0..1
    this.valveMode = 'auto';
    this.sinceStart = 0;

    // Requested inputs
    this.pedal = 0;
    this.thrCmd = 0;
    this.thr = 0;
    this.thrArea = 0;
    this.bypassS = 0; // idle air as the throttle sees it, ramped per sample
    this.bypassStep = 0;
    this.brake = 0;
    this.clutchPedal = 0; // 1 = pressed (disengaged)
    this.blip = 0;

    this.kLeak = 1.5e-10 * (cfg.vd / 5e-4);
    // Friction constants
    this.fricK = (cfg.displacement / (4 * PI)) * 1e5 * cfg.friction;
    this.fric = 0;

    // Feed-forward idle air
    // (a two-stroke has no intake stroke to pump against: it idles on less)
    const needed = 1.18 * cfg.displacement * (e.idle / 120) * (cfg.twoStroke ? 0.04 : 0.092);
    this.bypassFF = needed / ((CHOKE_AIR * P_AMB) / Math.sqrt(T_AMB)) / 0.8;

    // Vehicle / drivetrain
    const v = cfg.vehicle;
    this.veh = v;
    this.mode = 'rev';
    this.gear = 0;
    this.v = 0;
    this.ww = 0;
    this.pos = 0;
    this.Jw = 2.2 + v.mass * 0.0008;
    this.clutch = 0; // engagement 0..1
    this.clutchT = 0;
    this.clutchCap = 0;
    this.shift = null;
    this.autoShift = true;
    this.shiftCool = 0;
    this.tc = true;
    this.tcCut = 0;
    this.slip = 0;
    this.gearTorque = 0;
    this.dynoLoad = 0;
    this.dynoI = 0;
    this.dyno = null;
    // Manual gearbox (sim/gearbox.js): the driver works the clutch and the
    // lever, unless a scene, the flyby or a followed car is driving
    this.manual = false;
    this.manualOn = false;
    this.scripted = false; // a scene drives the car
    this.wIn = 0; // the gearbox input shaft while no gear is engaged, rad/s
    this.msPhase = 0; // a shift: 0 none, 1 coming out, 2 synchronising, 3 grinding
    this.msFrom = 0;
    this.msTo = 0;
    this.msT = 0;
    this.msFree = 0; // how long the sleeve has been free to slide off its dogs
    this.nLo = 0; // in neutral, the gears either side of the lever
    this.nHi = 1;
    // events since the last telemetry: stalls, refused gears, and the
    // largest speed difference a gear ground at (rpm)
    this.evStall = 0;
    this.evRefused = 0;
    this.evGrind = 0;

    // Sound bits
    this.snd = cfg.sound;
    this.srcBuf = new Float64Array(N_SRC);
    this.ibRes1 = 0;
    this.ibRes2 = 0;
    this.roadLp = 0;
    this.windLp1 = 0;
    this.windLp2 = 0;
    this.sqPhase = 0;
    this.sqLp = 0;
    this.clunk = 0;
    // Wind at a mic that rides on the car, and the road under it. The wind
    // draws from its own random stream, so the engine's cycle-to-cycle
    // variation is the same whether or not it is heard.
    this.aRs = 0x2545f491;
    this.aeroMic = 0; // 0 roadside, 1 outside on the car, 2 in the cabin
    this.aGust = 0; // slow gusts, fraction of the airspeed
    this.aTurb = 0; // fast turbulence
    this.aCross = 0; // crosswind: which side of the car the wind favours
    this.aLock = 0; // whistle lock-in
    this.aU = 0;
    this.aH1 = this.aH2 = this.aH3 = 0; // hiss band-pass (TPT state-variable filter)
    this.aBa = 0; // buffet low-pass
    this.aAh = this.aAb = this.aAw = this.aAt = this.aAr = this.aTb = 0; // levels: hiss, buffet, whistle, lorry wake, lorry rumble, lorry buffet
    this.aWf = 0; // whistle frequency
    this.aWph = 0;
    this.aGl = this.aGr = 1;
    this.aS = new Float64Array(16);
    this.aCabA = lpCoef(1700, fs);
    this.aRumA = lpCoef(260, fs);
    this.aHpA = lpCoef(11, fs);
    this.aOut = [0, 0];
    // a lorry in the next lane: how far ahead of the car (m), closing speed (m/s)
    this.truckDx = 1e9;
    this.truckVr = 0;
    // road joints: a thump through tyres and suspension, and the tread's slap
    this.surface = 'asphalt';
    this.bumpX = 0;
    this.bumpY1 = 0;
    this.bumpY2 = 0;
    this.bumpCl = 0;
    const bw = (TAU * 72) / fs, br = Math.exp(-1 / (0.018 * fs));
    this.bumpB1 = 2 * br * Math.cos(bw);
    this.bumpB2 = -br * br;
    this.bumpG = Math.sin(bw); // impulse in, the same peak out at any rate
    this.bumpClD = Math.exp(-1 / (0.004 * fs));

    // EGT & temps
    this.egt = 500;
    this.egtInst = 500;
    this.pipeWall = 500; // exhaust pipe wall temperature, K
    this.egtAcc = 0;
    this.egtW = 0;
    this.tempCounter = 0;

    // Telemetry accumulators
    this.telTq = 0;
    this.telN = 0;
    this.telAir = 0;
    this.telFuel = 0;
    this.telSpl = 0;
    this.telSplN = 0;
    this.torqueAvg = 0;
    this.airflow = 0;
    this.ctrlN = 0;
    this.lastRpm = 0;
    this.rpmRate = 0;
    this.landing = 0;

    // Scope (angle domain) capture
    this.scopeBuf = new Float32Array(16384);
    this.scopeP = new Float32Array(16384);
    this.scopeV = new Float32Array(16384);
    this.scopeW = 0;
    this.scopeStart = 0;
    this.scopeReady = null;

    this.lastPost = 0;
    // per-sample constants
    this.thrK = lpCoef(6, fs);
    this.rasp26 = 26 * cfg.sound.rasp;
    this.exG = INV4PI * cfg.sound.exhaust;
    this.initStarter(cfg);
    this.boosted = this.isTurbo || this.isSC || this.isCentri;
    this.initMech(cfg);
    this.initThermal(cfg);
    this.initGearbox(cfg);
    this.setWeather('dry');
    const vh = cfg.vehicle;
    this.axleLoad = vh.mass * 9.81 * (vh.drive === 'awd' ? 1 : vh.rearBias);
    this.loadTransfer = vh.drive === 'awd' ? 0 : vh.mass * 0.2;
    this.brakeK = vh.brakeK ?? vh.mass * 9.81 * 0.95;
    this.dragK = 0.5 * 1.2 * vh.cd * vh.area;
    this.rollK = vh.mass * 9.81 * 0.012;
    this.turboSnd = 0;
    this.scopePrevCA = 0;
    this.posts = [];
    this.fade = 0; // output fade in
  }

  volAt(ca) {
    const fi = ca * this.tabScale;
    const i0 = fi | 0;
    const fr = fi - i0;
    return this.vol[i0] + (this.vol[i0 + 1] - this.vol[i0]) * fr;
  }

  get rpm() {
    return this.omega * 9.549296585513721;
  }

  // -------------------------------------------------------------------------
  // Main render loop
  // -------------------------------------------------------------------------

  render(outL, outR, nFrames, L) {
    const dt = this.dt;
    const cycle = this.cycle;
    const thrK = this.thrK;
    let omega = this.omega;
    let crank = this.crank;
    for (let s = 0; s < nFrames; s++) {
      if (++this.ctrlN >= 32) {
        this.ctrlN = 0;
        this.omega = omega;
        this.crank = crank;
        this.control(32 * dt);
      }
      this.thr += (this.thrCmd - this.thr) * thrK;

      // crank advance
      const rpm = omega * 9.549296585513721;
      const crankPrev = crank;
      crank += omega * dt * RAD2DEG;
      if (crank >= cycle) {
        crank -= cycle;
        if (this.cycN > 0) this.cycleTorque = this.cycTq / this.cycN;
        this.cycTq = 0;
        this.cycN = 0;
      }

      // pipes in -> cylinders -> pipe junctions -> pipes out
      this.ex.read();
      this.inn.read();
      const torque = this.stepCylinders(crank, rpm);
      this.stepAfterfireSources();
      this.ex.scatter(this.srcBuf, this.turbP, this.fs);
      this.stepIntake();
      this.ex.write();
      this.inn.write();
      this.stepAfterfirePools();
      const scTorque = this.stepBoost(omega);
      omega = this.stepDrivetrain(omega, torque, scTorque);

      // strobe snapshot for the visualiser
      if (this.snapWait > 0) this.snapWait--;
      else if (!this.snapReady) {
        if (!this.strobeOn || omega < 3 || crossed(crankPrev, crank, this.strobeAngle)) {
          this.crank = crank;
          this.snapReady = this.captureSnap();
          this.snapWait = this.snapGap;
          if (this.strobeOn) this.strobeAngle = (this.strobeAngle + this.strobeStep) % cycle;
        }
      }

      this.stepSources(rpm, omega, L);
      const out = this.listen(L);
      outL[s] = out[0];
      outR[s] = out[1];
    }
    this.omega = omega;
    this.crank = crank;
  }
}

// The rest of the class: each of these is a class used only as a bag of
// methods, copied onto the prototype once, here. After that they are
// ordinary methods, so a call from the per-sample loop costs what it would
// if the whole class were written in this file.
mixin(EngineSim, EcuMethods, CylinderMethods, StarterMethods, InductionMethods, NitrousMethods, DrivetrainMethods, GearboxMethods, WeatherMethods, MechanicalMethods, ThermalMethods, AeroMethods, SourceMethods, ListenMethods);
