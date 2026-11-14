// The scripted drives: flyby, quarter mile and autobahn.

import { clamp } from './dsp.js';

export class SceneMethods {
  startFlyby(m) {
    const s = this.sim;
    if (!s) return;
    s.mode = 'flyby';
    const v = s.veh;
    // start in 2nd gear at a speed giving ~45% of redline
    const g = Math.min(2, v.gears.length);
    const G = v.gears[g - 1] * v.final;
    const rpm0 = s.limitRpm * (m.style === 'cruise' ? 0.4 : 0.45);
    const w = rpm0 / 9.5493;
    s.gear = g;
    s.clutch = 1;
    s.shift = null;
    s.scripted = true;
    s.ww = w / G;
    s.v = s.ww * v.tire;
    s.omega = w;
    s.autoShift = true;
    const dist = m.distance ?? 220;
    this.flyby = { t: 0, style: m.style ?? 'wot', start: -dist, x: -dist, done: false, lifted: false };
    s.pos = 0;
    this.updateScene(0);
  }

  // -------------------------------------------------------------- scenes
  // Scripted runs: the car drives itself along a course while the scene
  // switches the surroundings (open road, canyon, tunnel) and records times.
  startScene(m) {
    const s = this.sim;
    if (!s) return;
    this.flyby = null;
    this.clearRoad();
    const v = s.veh;
    s.mode = 'drive';
    s.autoShift = true;
    s.scripted = true;
    s.shift = null;
    s.brake = 0;
    s.launch = false;
    s.pos = 0;
    const sc = { id: m.id, t: 0, phase: 'run', env: null, track: m.track ?? [], length: m.length ?? 600, marks: m.marks ?? [], times: {}, done: false, shiftT: 0 };
    if (m.id === 'drag') {
      // staged at the line on the launch limiter
      s.gear = 1;
      s.clutch = 0;
      s.v = 0;
      s.ww = 0;
      sc.phase = 'stage';
      s.launch = true;
      sc.world = true;
      sc.lisPos = [9, 1.4, 14];
      sc.tree = -1;
    } else if (m.id === 'autobahn') {
      // down the slip road at a cruise, in the gear that suits it
      const v0 = 75 / 3.6;
      let g = 1;
      for (let i = v.gears.length; i >= 1; i--) {
        if ((v0 / v.tire) * v.gears[i - 1] * v.final * 9.549 > s.limitRpm * 0.32) {
          g = i;
          break;
        }
      }
      const G = v.gears[g - 1] * v.final;
      s.gear = g;
      s.clutch = 1;
      s.v = v0;
      s.ww = v0 / v.tire;
      s.omega = Math.max(s.omega, s.ww * G);
      sc.trucks = Float64Array.from(m.trucks ?? []);
      sc.vT = 23; // lorries sit at 83 km/h
      sc.joints = m.joints ?? [];
      sc.derest = m.derest ?? 200;
      sc.wb = v.mass < 500 ? 1.45 : 2.65; // wheelbase
      sc.ax = [0, -sc.wb];
      sc.peak = 0;
      sc.best = 0;
      sc.bestT = 0;
      sc.cross = {};
    } else {
      // rolling start in second gear
      const g = Math.min(2, v.gears.length);
      const G = v.gears[g - 1] * v.final;
      const w = (s.limitRpm * (m.id === 'tunnel' ? 0.32 : 0.42)) / 9.5493;
      s.gear = g;
      s.clutch = 1;
      s.ww = w / G;
      s.v = s.ww * v.tire;
      s.omega = Math.max(s.omega, w);
    }
    this.scene = sc;
    this.sceneEnv(0);
    this.port.postMessage({ type: 'scene', ev: 'start', id: m.id });
    this.updateScene(0);
  }

  sceneGo() {
    const sc = this.scene;
    if (!sc || sc.id !== 'drag' || sc.phase !== 'stage') return;
    const s = this.sim;
    sc.goT = sc.t;
    sc.foul = sc.greenT == null || sc.t < sc.greenT;
    s.launch = false;
    sc.phase = 'run';
  }

  endScene(aborted) {
    const sc = this.scene;
    if (!sc || sc.done) return;
    sc.done = true;
    sc.phase = 'stop';
    this.port.postMessage({ type: 'scene', ev: 'done', id: sc.id, aborted: !!aborted, times: sc.times, foul: sc.foul, rt: sc.rt });
  }

  // which surroundings the car is in at position x (with a blend zone)
  sceneEnv(x) {
    const sc = this.scene;
    let env = 'open';
    let fl = 18; // metres the change blends over: short under a bridge
    for (const seg of sc.track) {
      if (x >= seg.s && x < seg.s + seg.len) {
        env = seg.env ?? 'open';
        fl = seg.blend ?? 18;
      }
    }
    if (env !== sc.env) {
      const b = Math.min(fl, sc.blend ?? 18);
      const fade = sc.env == null ? 0.05 : clamp(b / Math.max(5, this.sim.v), b < 18 ? 0.03 : 0.25, 2.5);
      sc.env = env;
      sc.blend = fl;
      this.port.postMessage({ type: 'scene', ev: 'env', env, fade });
    }
  }

  // The road under the car: surface, joints, lorries in the next lane.
  clearRoad() {
    const s = this.sim;
    if (!s) return;
    s.surface = 'asphalt';
    s.truckDx = 1e9;
    s.truckVr = 0;
  }

  // Autobahn: down the slip road at a cruise, floor it at the end of the
  // speed limit and hold it until the car will go no faster, then lift.
  autobahnStep(sc, dtb) {
    const s = this.sim;
    const x = s.pos;
    const v = s.v;
    // lorries in the right-hand lane
    const tr = sc.trucks;
    let near = 1e9;
    for (let i = 0; i < tr.length; i++) {
      tr[i] += sc.vT * dtb;
      const dx = tr[i] - x;
      if (Math.abs(dx) < Math.abs(near)) near = dx;
    }
    s.truckDx = near;
    s.truckVr = v - sc.vT;
    // surface under the front wheels; slab joints in concrete every 5 m and
    // expansion joints at each end of a viaduct, front axle then rear
    let surf = 'asphalt';
    for (const seg of sc.track) if (x >= seg.s && x < seg.s + seg.len) surf = seg.surface ?? 'asphalt';
    s.surface = surf;
    const kv = Math.pow(Math.max(v, 1) / 30, 0.7);
    for (let a = 0; a < 2; a++) {
      const p0 = sc.ax[a], p1 = x - (a ? sc.wb : 0);
      sc.ax[a] = p1;
      if (p1 <= p0) continue;
      if (surf === 'concrete' && Math.floor(p1 / 5) > Math.floor(p0 / 5)) s.bump(1.2 * kv * (a ? 0.8 : 1));
      for (const j of sc.joints) if (p0 < j && p1 >= j) s.bump(3.5 * kv * (a ? 0.8 : 1));
    }
    const kmh = v * 3.6;
    if (sc.phase === 'run') {
      s.brake = 0;
      if (x < sc.derest) {
        // the limit still applies: hold a steady cruise onto the main road
        s.pedal = clamp(0.25 + (80 / 3.6 - v) * 0.12, 0, 0.9);
        return;
      }
      if (sc.wotT == null) {
        sc.wotT = sc.t;
        sc.wotX = x;
      }
      s.pedal = 1;
      // splits: interpolate each crossing within this block
      for (let k = 100; k <= 450; k += 50) {
        if (sc.cross[k] == null && kmh >= k) sc.cross[k] = sc.t - (kmh - k) / 3.6 / Math.max(0.2, s.accel);
      }
      if (v > sc.peak) {
        sc.peak = v;
        sc.peakGear = s.gear;
        sc.peakRpm = s.rpm;
        sc.peakX = x - sc.wotX;
        sc.peakT = sc.t - sc.wotT;
      }
      // topped out: no more than 1 km/h gained in the last five seconds
      if (v > sc.best + 0.28) {
        sc.best = v;
        sc.bestT = sc.t;
      }
      if ((sc.t - sc.bestT > 5 && sc.t - sc.wotT > 8) || x >= sc.length - 400) {
        sc.phase = 'lift';
        sc.liftT = sc.t;
        const top = sc.peakGear >= s.veh.gears.length;
        sc.times = {
          vmax: sc.peak,
          gear: sc.peakGear,
          rpm: sc.peakRpm,
          limiter: top && sc.peakRpm > s.limitRpm - 300,
          dist: sc.peakX,
          time: sc.peakT,
          cross: sc.cross,
        };
        this.port.postMessage({ type: 'scene', ev: 'vmax', vmax: sc.peak });
      }
    } else if (sc.phase === 'lift') {
      // off the throttle at speed: the overrun, the wind, the wind dying
      s.pedal = 0;
      s.brake = 0;
      if (sc.t - sc.liftT > 6) this.endScene(false);
    } else {
      s.pedal = 0;
      s.brake = v > 0.5 ? 0.3 : 0;
    }
  }

  sceneStep(dtb) {
    const sc = this.scene;
    const s = this.sim;
    sc.t += dtb;
    const x = s.pos;
    const red = s.limitRpm;
    const v = s.veh;
    s.holdGear = false;
    if (sc.id === 'autobahn') {
      this.autobahnStep(sc, dtb);
      this.sceneEnv(x);
      return;
    }
    if (sc.id === 'drag') {
      if (sc.phase === 'stage') {
        s.pedal = 1;
        s.brake = 0;
        // sportsman tree: three ambers half a second apart, then green
        const t0 = 2.4;
        const k = sc.t < t0 ? -1 : Math.min(3, Math.floor((sc.t - t0) / 0.5));
        if (k !== sc.tree) {
          sc.tree = k;
          if (k === 3) sc.greenT = t0 + 1.5;
          this.port.postMessage({ type: 'scene', ev: 'tree', light: k });
        }
        // nobody pressed GO: launch for them after a slow reaction
        if (sc.greenT != null && sc.t > sc.greenT + 1.2) this.sceneGo();
      } else if (sc.phase === 'run') {
        s.pedal = 1;
        if (sc.leaveT == null && x > 0.3) {
          sc.leaveT = sc.t;
          sc.rt = sc.greenT != null ? sc.goT - sc.greenT : 0;
        }
        for (const [name, d] of sc.marks) {
          if (sc.times[name] == null && x >= d && sc.leaveT != null) {
            // interpolate the crossing within this block
            const over = (x - d) / Math.max(0.1, s.v);
            sc.times[name] = sc.t - over - sc.leaveT;
            sc.times[name + '_v'] = s.v;
          }
        }
        if (x >= sc.length) {
          sc.phase = 'brake';
          this.endScene(false);
        }
      } else {
        s.pedal = 0;
        s.brake = s.v > 0.5 ? 0.7 : 0;
      }
      sc.carZ = x;
      return;
    }
    // course driver: brake for the corners ahead, then power out
    let vt = 1e9;
    let inCorner = null;
    for (const seg of sc.track) {
      if (!seg.v) continue;
      const vc = seg.v / 3.6;
      if (x >= seg.s && x < seg.s + seg.len) {
        inCorner = seg;
        vt = Math.min(vt, vc);
      } else if (seg.s > x) vt = Math.min(vt, Math.sqrt(vc * vc + 2 * 8.5 * (seg.s - x)));
    }
    let coast = false;
    if (sc.id === 'tunnel') {
      // cruise to the portal, drop a gear and floor it through the tunnel
      const tun = sc.track.find((q) => q.env === 'tunnel');
      if (x < tun.s - 45) vt = Math.min(vt, s.v < 14 ? 16 : s.v);
      if (x > tun.s + tun.len - 70 && x < tun.s + tun.len + 40) coast = true; // lift: let it crackle in the tunnel
      else if (x >= tun.s + tun.len + 40) vt = Math.min(vt, s.v);
    }
    if (sc.phase === 'run') {
      const err = vt - s.v;
      s.holdGear = !!inCorner;
      if (coast) {
        s.pedal = 0;
        s.brake = 0;
      } else if (inCorner) {
        // hold the line: smooth part throttle, brake only if far too fast
        s.pedal = clamp(0.3 + err * 0.25, 0.05, 0.8);
        s.brake = err < -3 ? clamp(-err / 8, 0, 0.6) : 0;
      } else if (err > 1.5) {
        s.pedal = 1;
        s.brake = 0;
      } else if (err < -1) {
        s.pedal = 0;
        s.brake = clamp(-err / 6, 0.15, 1);
      } else {
        s.pedal = inCorner ? clamp(0.35 + err * 0.3, 0.15, 0.7) : clamp(0.5 + err * 0.4, 0, 1);
        s.brake = 0;
      }
      // a quick driver goes down the box under braking, blipping each time
      sc.shiftT -= dtb;
      if (s.brake > 0.1 && !s.shift && s.gear > 1 && sc.shiftT <= 0) {
        const G2 = v.gears[s.gear - 2] * v.final;
        const r2 = (s.v / v.tire) * G2 * 9.549;
        if (r2 < red * 0.82) {
          s.requestShift(-1);
          sc.shiftT = 0.35;
        }
      }
      if (sc.id === 'tunnel' && !sc.kicked && x > sc.track.find((q) => q.env === 'tunnel').s - 40 && s.gear > 1) {
        sc.kicked = true;
        s.requestShift(-1);
      }
      if (x >= sc.length) {
        sc.phase = 'stop';
        this.endScene(false);
      }
    } else {
      s.pedal = 0;
      s.brake = s.v > 0.5 ? 0.6 : 0;
    }
    this.sceneEnv(x);
  }

  flybyStep(dtb) {
    const f = this.flyby;
    const s = this.sim;
    f.t += dtb;
    f.x = f.start + s.pos;
    if (f.style === 'wot') {
      s.pedal = f.x < 90 ? 1 : 0;
      if (f.x > 90 && !f.lifted) f.lifted = true;
    } else {
      // cruise past, then downshift & bark
      s.pedal = f.x < -30 ? 0.35 : f.x < 40 ? 1 : 0;
    }
    if (f.x > 260 && !f.done) {
      f.done = true;
      s.pedal = 0;
      this.port.postMessage({ type: 'flyby-done' });
    }
    if (f.done) s.brake = 0.6;
  }
}
