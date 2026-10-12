// Follow a real car: readings from a source (the OBD adapter, GPS and
// motion, or the demo drive) go to the engine simulation, which runs where
// the car runs. With revs from the car, the simulated engine is held at them
// (stretched from the car's rev range to the engine's, so a diesel that
// stops at 4,800 can still take a V12 to its red line); with road speed
// only, the simulated car's own gearbox picks the revs.

import { ObdSource } from './obd.js';
import { GpsSource } from './gps.js';
import { DemoSource, DEMO_CAR } from './demo.js';

export const SOURCES = {
  obd: { label: 'OBD adapter', make: (s, st) => new ObdSource(s, st) },
  gps: { label: 'GPS', make: (s, st) => new GpsSource(s, st) },
  demo: { label: 'Demo drive', make: (s) => new DemoSource(s) },
};

const LEAD = 0.1; // s: readings arrive late; lean them forward along their trend

export class CarFollow {
  // app: { post(msg), engine(): { idle, limit }, running(), crank(), off(), onStatus(text, bad), onStop() }
  constructor(app, settings) {
    this.app = app;
    this.s = settings; // { carIdle, carRed, stretch }
    this.src = null;
    this.kind = null;
    this.on = false;
    this.last = null; // latest reading
    this.rate = 0;
    this.prev = null;
    this.hz = 0;
    this.count = 0;
    this.countT = 0;
    this.offT = 0;
  }

  async start(kind) {
    this.stop(true);
    this.kind = kind;
    const status = (t, bad) => {
      this.app.onStatus(t, bad);
      if (bad) this.stop();
    };
    this.src = SOURCES[kind].make((x) => this.onSample(x), status);
    this.on = true;
    this.countT = performance.now();
    try {
      const info = await this.src.start();
      if (!this.on) return null;
      if (kind === 'demo') {
        // the demo car is a 2.0 TDI: its rev range, whatever was set
        this.demoRange = { carIdle: DEMO_CAR.idle, carRed: DEMO_CAR.red };
      } else this.demoRange = null;
      return info;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  stop(quiet) {
    const was = this.on;
    this.on = false;
    try {
      this.src?.stop();
    } catch {}
    this.src = null;
    this.last = null;
    this.prev = null;
    if (was) {
      this.app.post({ type: 'follow', stop: true });
      if (!quiet) this.app.onStop?.();
    }
  }

  // car rpm -> engine rpm
  mapRpm(r) {
    const { idle, limit } = this.app.engine();
    const s = { ...this.s, ...this.demoRange };
    if (r < 250) return 0;
    if (!this.s.stretch) return Math.min(r, limit);
    const top = limit * 0.97;
    if (r <= s.carIdle) return (idle * r) / s.carIdle;
    return idle + ((r - s.carIdle) * (top - idle)) / Math.max(500, s.carRed - s.carIdle);
  }

  onSample(x) {
    if (!this.on) return;
    const now = x.t ?? performance.now();
    this.count++;
    if (now - this.countT > 1000) {
      this.hz = (this.count * 1000) / (now - this.countT);
      this.count = 0;
      this.countT = now;
    }
    this.last = x;
    const msg = { type: 'follow', pedal: x.pedal ?? 0, brake: x.brake ?? 0, speed: x.speed ?? 0, accel: x.accel ?? 0 };
    if (x.rpm != null) {
      const r = this.mapRpm(x.rpm);
      if (this.prev && now > this.prev.t) {
        const d = (r - this.prev.r) / ((now - this.prev.t) / 1000);
        this.rate += (d - this.rate) * 0.6;
      }
      this.prev = { t: now, r };
      msg.rpm = r > 0 ? Math.max(0, r + this.rate * LEAD) : 0;
      msg.rate = this.rate;
      this.engine = r;
      // the simulated engine starts and stops with the car's
      if (x.rpm < 200) {
        if (!this.offT) this.offT = now;
        if (now - this.offT > 1200 && this.app.running()) this.app.off();
      } else {
        this.offT = 0;
        if (x.rpm > 400 && !this.app.running()) this.app.crank();
      }
    } else this.engine = null;
    this.app.post(msg);
  }
}
