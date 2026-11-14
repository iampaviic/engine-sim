// The AudioWorkletProcessor: messages from the app, hot swaps between
// engines, eco (half-rate) mode, and telemetry back to the app.

import { N_SRC, P_AMB, R, TAU } from './constants.js';
import { clamp } from './dsp.js';
import { Listener } from './listener.js';
import { EngineSim } from './engine-sim.js';
import { CameraMethods } from './camera.js';
import { SceneMethods } from './scenes.js';
import { mixin } from './mixin.js';

export class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fs = sampleRate;
    this.sim = null;
    this.next = null;
    this.L = new Listener(this.fs);
    this.camera = 'rear';
    this.env = 'open';
    this.flyby = null;
    this.telEvery = Math.round(this.fs / 40);
    this.telCount = 0;
    this.frames = 0;
    this.pending = [];
    this.eco = false;
    this.quality = 'auto';
    this.busyMs = 0;
    this.loadFrames = 0;
    this.load = 0;
    this.hot = 0;
    this.upL = this.upR = this.upZL = this.upZR = 0;
    this.mix = new Float64Array(N_SRC).fill(1);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'config':
        this.cfgMsg = m.cfg;
        this.installSim(m.cfg, m.tune, !!m.hot);
        break;
      case 'quality':
        this.quality = m.quality;
        this.setEco(m.quality === 'eco');
        break;
      case 'input':
        if (!this.sim) return;
        if (m.pedal != null && !this.sim.follow) this.sim.pedal = clamp(m.pedal, 0, 1);
        if (m.brake != null && !this.sim.follow) this.sim.brake = clamp(m.brake, 0, 1);
        if (m.clutch != null) this.sim.clutchPedal = m.clutch;
        if (m.launch != null) this.sim.launch = !!m.launch;
        if (m.nos != null) this.sim.nosBtn = !!m.nos;
        break;
      case 'ignition': {
        if (!this.sim) return;
        const was = this.sim.ignition;
        this.sim.ignition = !!m.on;
        if (m.on && !was) this.sim.keyOn();
        if (m.on && m.crank) this.sim.crankStart();
        if (!m.on) this.sim.starter = false;
        break;
      }
      case 'thermal':
        // the engine's temperatures: a stored state, or forced cold or warm
        this.sim?.setThermal(m);
        break;
      case 'shift':
        this.sim?.requestShift(m.dir);
        break;
      case 'mode':
        if (!this.sim) return;
        if (this.sim.follow) this.sim.setFollow({ stop: true });
        this.followOn = false;
        this.sim.mode = m.mode;
        this.sim.scripted = false;
        if (m.mode !== 'drive' && m.mode !== 'flyby') {
          this.sim.gear = 0;
          this.sim.v = 0;
        } else if (this.sim.gear === 0 && !this.sim.manual) this.sim.gear = 1;
        if (m.mode !== 'flyby') this.flyby = null;
        this.scene = null;
        this.clearRoad();
        this.updateScene(0);
        break;
      case 'camera':
        this.camera = m.camera;
        this.updateScene(0);
        break;
      case 'tune':
        if (this.sim) this.applyTune(this.sim, m.tune);
        break;
      case 'mix':
        for (let i = 0; i < N_SRC; i++) this.mix[i] = m.gains[i] ?? 1;
        break;
      case 'dyno':
        if (!this.sim) return;
        if (m.action === 'start') {
          const s = this.sim;
          s.mode = 'dyno';
          s.dyno = {
            active: true,
            phase: 'settle',
            t: 0,
            start: Math.max(1500, s.ecu.idle * 1.8),
            end: s.limitRpm - 150,
            rate: Math.max(400, (s.limitRpm - 1500) / 9),
            target: 0,
          };
          s.dynoI = 0;
        } else if (m.action === 'hold') {
          // steady state: the absorber holds one speed, the throttle is yours
          const s = this.sim;
          const was = s.mode === 'dyno' && s.dyno?.phase === 'hold';
          s.mode = 'dyno';
          s.dyno = { active: true, phase: 'hold', t: 0, start: m.rpm, end: m.rpm, rate: 0, target: m.rpm };
          if (!was) s.dynoI = 0;
        } else if (this.sim.dyno) {
          this.sim.dyno.active = false;
          this.sim.pedal = 0;
        }
        break;
      case 'flyby':
        this.scene = null;
        this.clearRoad();
        this.startFlyby(m);
        break;
      case 'scene':
        this.startScene(m);
        break;
      case 'scene-go':
        this.sceneGo();
        break;
      case 'scene-stop':
        if (this.scene) this.endScene(true);
        break;
      case 'follow':
        if (!this.sim) return;
        this.sim.setFollow(m);
        if (m.stop || !this.followOn) {
          this.followOn = !m.stop;
          this.scene = null;
          this.flyby = null;
          this.clearRoad();
          this.updateScene(0);
        }
        break;
      case 'strobe':
        if (!this.sim) return;
        this.sim.strobeOn = !!m.on;
        if (m.step != null) this.sim.strobeStep = m.step;
        break;
    }
  }

  applyTune(sim, t) {
    if (t.limit != null) sim.limitRpm = t.limit;
    if (t.limiter != null) sim.limiterType = t.limiter;
    if (t.burble != null) sim.burble = t.burble;
    if (t.antilag != null) sim.antilag = !!t.antilag;
    if (t.boost != null) sim.boostTarget = t.boost * 1e5;
    if (t.valve != null) sim.valveMode = t.valve;
    if (t.launchRpm != null) sim.launchRpm = t.launchRpm;
    if (t.autoShift != null) sim.autoShift = !!t.autoShift;
    if (t.manual != null) sim.manual = !!t.manual;
    if (t.bov != null) sim.bovType = t.bov;
    if (t.tc != null) sim.tc = !!t.tc;
    if (t.spark != null) sim.sparkAdj = t.spark;
    if (t.octane != null) sim.setOctane(t.octane);
    if (t.knockCtl != null) {
      sim.knockCtl = !!t.knockCtl;
      if (!sim.knockCtl) sim.knockRet = 0;
    }
    if (t.springs != null) sim.floatMul = t.springs === 'race' ? 1.12 : 1;
    if (t.nosShot != null) sim.nosShot = t.nosShot;
    if (t.nosRefill) sim.bottle = sim.nosBottle;
    if (t.boost != null && sim.isCentri) sim.setCentriRatio();
    if (t.maps !== undefined) sim.setMaps(t.maps);
  }

  // Build a simulation for cfg; hot = same car with new hardware (keep the
  // running state). The previous engine keeps rendering briefly for a
  // crossfade.
  installSim(cfg, tune, hot) {
    const old = this.sim;
    const rate = this.eco ? this.fs / 2 : this.fs;
    const sim = new EngineSim(cfg, rate);
    if (old) {
      sim.mode = old.mode;
      sim.valveMode = old.valveMode;
      sim.autoShift = old.autoShift;
      sim.manual = old.manual;
      sim.strobeOn = old.strobeOn;
      sim.tc = old.tc;
      sim.strobeStep = old.strobeStep;
      for (const k of ['limitRpm', 'limiterType', 'burble', 'antilag', 'boostTarget', 'launchRpm', 'bovType', 'sparkAdj', 'knockCtl', 'floatMul', 'nosShot']) if (!tune) sim[k] = old[k];
      if (!tune) {
        sim.setOctane(old.octane);
        if (sim.isCentri) sim.setCentriRatio();
        sim.setMaps(old.maps);
      }
    }
    sim.mix = this.mix;
    if (tune) this.applyTune(sim, tune);
    if (hot && old) {
      // Same car, new hardware: carry the running state across.
      for (const k of ['omega', 'ignition', 'running', 'gear', 'v', 'ww', 'pos', 'clutch', 'pedal', 'thr', 'thrCmd', 'brake', 'idleI', 'egt', 'egtInst', 'pipeWall', 'launch', 'dyno', 'dynoI', 'dynoLoad', 'mode', 'flare', 'accel', 'follow', 'followV', 'followA', 'clutchPedal', 'scripted', 'nLo', 'nHi'])
        sim[k] = old[k];
      // same car: same temperatures, same lifters, the same fan still turning
      Object.assign(sim.th, old.th);
      sim.ambT = old.ambT;
      for (const k of ['vapour', 'fanW', 'tkPrev', 'pumpT', 'pumpW', 'pumpP', 'heldSet']) sim[k] = old[k];
      for (let c = 0; c < sim.n; c++) sim.cHeld[c] = old.cHeld[c % old.n];
      sim.thermalEffects();
      // a start in progress carries on with the new hardware
      for (const k of ['starter', 'starterT', 'stHold', 'crankRevs', 'syncRevs', 'filmLeft', 'stW', 'stLock', 'stEng', 'stV', 'stR', 'stActive', 'stEnv'])
        sim[k] = old[k];
      if (sim.kick && old.kick) for (const k of ['kicking', 'kickN', 'kickT', 'kickRev', 'kickWait', 'kickGrip']) sim[k] = old[k];
      else if (sim.kick !== old.kick) {
        sim.stEng = false;
        sim.stW = 0;
        sim.kickWait = 0.3;
      }
      if (sim.twoStroke) sim.pv = old.pv ?? 0;
      // same car: the bottle stays as full as it was
      sim.bottle = sim.nosBottle * (old.bottle / old.nosBottle);
      sim.nosBtn = old.nosBtn;
      sim.crank = old.crank % sim.cycle;
      for (let c = 0; c < sim.n; c++) sim.cCA[c] = (sim.crank + sim.off[c]) % sim.cycle;
      sim.pPl = old.pPl;
      sim.mPl = (sim.pPl * sim.Vpl) / (R * sim.Tpl);
      sim.fade = 1;
    }
    if (old && old.fs === sim.fs) {
      this.xOld = old;
      this.xL = this.L;
      this.xN = hot ? 1600 : 4800;
      this.xT = 0;
    } else this.xOld = null;
    this.L = new Listener(sim.fs);
    this.tmpL ??= new Float32Array(128);
    this.tmpR ??= new Float32Array(128);
    this.sim = sim;
    this.L.first = true;
    this.updateScene(0);
  }

  // Half-rate physics for slow devices (output upsampled x2).
  setEco(on) {
    if (on === this.eco) return;
    this.eco = on;
    if (this.cfgMsg && this.sim) this.installSim(this.cfgMsg, null, true);
    this.port.postMessage({ type: 'quality', eco: on });
  }

  // Render a sim into n output frames, upsampling if it runs at half rate.
  renderSim(sim, lis, L, R, n) {
    if (sim.fs === this.fs) {
      sim.render(L, R, n, lis);
      return;
    }
    const h = n >> 1;
    if (!this.hL || this.hL.length < h) {
      this.hL = new Float32Array(h);
      this.hR = new Float32Array(h);
    }
    const hL = this.hL, hR = this.hR;
    sim.render(hL, hR, h, lis);
    let pl = this.upL, pr = this.upR, zl = this.upZL, zr = this.upZR;
    const a = 0.72;
    for (let i = 0; i < h; i++) {
      const l = hL[i], r = hR[i];
      zl += a * ((pl + l) * 0.5 - zl);
      zr += a * ((pr + r) * 0.5 - zr);
      L[2 * i] = zl;
      R[2 * i] = zr;
      zl += a * (l - zl);
      zr += a * (r - zr);
      L[2 * i + 1] = zl;
      R[2 * i + 1] = zr;
      pl = l;
      pr = r;
    }
    this.upL = pl;
    this.upR = pr;
    this.upZL = zl;
    this.upZR = zr;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], Rr = out[1] ?? out[0];
    const nF = L.length;
    const sim = this.sim;
    if (!sim) {
      L.fill(0);
      if (Rr !== L) Rr.fill(0);
      return true;
    }
    // flyby / scene scripts
    if (sim.mode === 'flyby' && this.flyby) this.flybyStep(nF / this.fs);
    if (this.scene && sim.mode === 'drive') this.sceneStep(nF / this.fs);
    if (sim.mode === 'flyby' || (this.scene?.world && this.camera === 'scene')) this.updateScene(sim.fs === this.fs ? nF : nF >> 1);
    const t0 = Date.now();
    const Rw = Rr !== L ? Rr : this.monoR || (this.monoR = new Float32Array(nF));
    this.renderSim(sim, this.L, L, Rw, nF);
    if (this.xOld) {
      const tl = this.tmpL.length >= nF ? this.tmpL : (this.tmpL = new Float32Array(nF));
      const tr = this.tmpR.length >= nF ? this.tmpR : (this.tmpR = new Float32Array(nF));
      this.renderSim(this.xOld, this.xL, tl, tr, nF);
      for (let i = 0; i < nF; i++) {
        const k = Math.max(0, 1 - (this.xT + i) / this.xN);
        const kn = 1 - k;
        L[i] = L[i] * kn + tl[i] * k;
        if (Rr !== L) Rr[i] = Rr[i] * kn + tr[i] * k;
      }
      this.xT += nF;
      if (this.xT >= this.xN) {
        this.xOld = null;
        this.xL = null;
      }
    }
    // CPU load estimate -> automatic half-rate fallback
    this.busyMs += Date.now() - t0;
    this.loadFrames += nF;
    if (this.loadFrames >= this.fs) {
      const load = this.busyMs / 1000;
      this.load = load;
      this.busyMs = 0;
      this.loadFrames = 0;
      if (this.quality === 'auto' && !this.eco) {
        this.hot = load > 0.62 ? this.hot + 1 : 0;
        if (this.hot >= 2) this.setEco(true);
      }
    }
    this.frames += nF;
    this.telCount += nF;
    this.postSnap();
    if (this.telCount >= this.telEvery) {
      this.telCount = 0;
      this.postTelemetry();
    }
    return true;
  }

  postSnap() {
    const sim = this.sim;
    if (!sim.snapReady) return;
    const a = sim.snapReady;
    sim.snapReady = null;
    this.port.postMessage({ type: 'snap', data: a, segPts: 10, strobe: sim.strobeOn, step: sim.strobeStep }, [a.buffer]);
  }

  postTelemetry() {
    const s = this.sim;
    const tq = s.cycleTorque;
    s.torqueAvg += (tq - s.torqueAvg) * 0.5;
    s.telTq = 0;
    s.telN = 0;
    const spl = s.telSplN ? Math.sqrt(s.telSpl / s.telSplN) : 0;
    s.telSpl = 0;
    s.telSplN = 0;
    const msg = {
      type: 'tel',
      rpm: s.rpm,
      tq: s.torqueAvg,
      thr: s.thr,
      pedal: s.pedal,
      map: s.pPl,
      boost: s.pB - P_AMB,
      egt: s.egt,
      turbo: (s.wt * 60) / TAU,
      turbo2: s.nB ? (s.wt2 * 60) / TAU : null,
      stage: s.stage,
      gear: s.gear,
      speed: s.v,
      clutch: s.clutch,
      lim: s.limCut || s.launchCut,
      running: s.running,
      ignition: s.ignition,
      starter: s.starter,
      af: s.afEvents,
      afI: s.afIntensity,
      spl,
      mode: s.mode,
      camHi: s.camHi,
      pv: s.twoStroke ? s.pv : null,
      nos: s.nosOn,
      purge: s.nosPurge,
      bottle: s.bottle / s.nosBottle,
      kick: s.kick,
      // a two-stroke "on the pipe": the chamber is stuffing charge back in
      onPipe: s.twoStroke && s.plug > 0.05 && s.thr > 0.5,
      valve: s.valveOpen,
      shifting: !!s.shift,
      slip: s.slip,
      pos: s.pos,
      flyX: this.flyby ? this.flyby.x : null,
      bov: s.bov,
      dfco: s.dfco,
      launch: s.launchCut,
      load: this.load,
      eco: this.eco,
      scene: this.scene ? { id: this.scene.id, x: s.pos, phase: this.scene.phase, env: this.scene.env, vmax: this.scene.peak } : null,
      knock: s.knockMax,
      knockN: s.knockN,
      knockRet: s.knockRet,
      float: s.floatSev,
      adv: s.lastAdv,
      afr: s.lastAfr,
      boostTgt: s.boostNow,
      follow: s.follow ? s.follow.kind : null,
      // temperatures (K): the gauge's, the oil's; the whole state, for the
      // app to keep between sessions
      id: s.cfg.id,
      coolant: s.th.h,
      oil: s.th.o,
      fan: s.th.fan,
      th: s.th,
      // the manual gearbox: the clutch pedal, and since the last message the
      // stalls, the refused gears and the largest speed difference a gear
      // ground at (rpm)
      manual: s.manualOn,
      clutchPedal: s.clutchPedal,
      stall: s.evStall,
      refused: s.evRefused,
      grind: s.evGrind,
    };
    s.evStall = 0;
    s.evRefused = 0;
    s.evGrind = 0;
    s.afEvents = 0;
    s.afIntensity = 0;
    s.knockMax = 0;
    s.knockN = 0;
    if (s.mode === 'dyno' && s.dyno && s.dyno.phase === 'sweep') msg.dyno = { rpm: s.rpm, tq: s.torqueAvg };
    this.port.postMessage(msg);
    if (s.scopeReady) {
      const sc = s.scopeReady;
      s.scopeReady = null;
      this.port.postMessage({ type: 'scope', sig: sc.sig, pr: sc.pr, vo: sc.vo }, [sc.sig.buffer, sc.pr.buffer, sc.vo.buffer]);
    }
    for (const p of s.posts) this.port.postMessage(p);
    s.posts.length = 0;
  }
}

// The rest of the class: each of these is a class used only as a bag of
// methods, copied onto the prototype once, here. After that they are
// ordinary methods, so a call from the per-sample loop costs what it would
// if the whole class were written in this file.
mixin(EngineProcessor, SceneMethods, CameraMethods);
