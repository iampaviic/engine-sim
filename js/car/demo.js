// A demo drive in a 2.0 TDI hatchback, so following can be heard (and
// tested) without a car: idle, a pull through the gears, a motorway cruise,
// overrun, blipped downshifts, braking to a stop. It is computed once from a
// small car model and replayed as an adapter would report it.

const CAR = {
  mass: 1450,
  tire: 0.316,
  gears: [3.77, 2.09, 1.32, 0.98, 0.76, 0.62],
  final: 3.45,
  idle: 800,
  red: 4800,
};

// diesel torque at full pedal, Nm (turbo lag below 1,500)
function torque(rpm) {
  if (rpm < 1000) return 160;
  if (rpm < 1750) return 160 + ((rpm - 1000) / 750) * 180;
  if (rpm < 3000) return 340;
  return Math.max(200, 340 - ((rpm - 3000) / 1800) * 140);
}

// The driver's plan: [what, value]
const PLAN = [
  ['idle', 3],
  ['pull', { gear: 1, pedal: 0.75, to: 3600 }],
  ['shift', 2],
  ['pull', { gear: 2, pedal: 1, to: 3900 }],
  ['shift', 3],
  ['pull', { gear: 3, pedal: 1, to: 3900 }],
  ['shift', 4],
  ['pull', { gear: 4, pedal: 0.8, kmh: 115 }],
  ['shift', 5],
  ['shift', 6],
  ['cruise', { kmh: 120, secs: 5 }],
  ['coast', { kmh: 100, brake: 0.15 }],
  ['shift', 4],
  ['pull', { gear: 4, pedal: 1, kmh: 140 }],
  ['coast', { kmh: 125, brake: 0.6 }],
  ['shift', 3],
  ['coast', { kmh: 85, brake: 0.6 }],
  ['shift', 2],
  ['coast', { kmh: 45, brake: 0.5 }],
  ['stop', null],
  ['idle', 4],
];

function simulate() {
  const dt = 0.01;
  const out = [];
  let v = 0, gear = 1, rpm = CAR.idle, pedal = 0, t = 0, blip = 0;
  const G = (g) => CAR.gears[g - 1] * CAR.final;
  const roadRpm = (g) => (v / CAR.tire) * G(g) * 9.5493;
  const push = (clutchIn) => {
    out.push({ t, rpm, pedal, kmh: v * 3.6, load: clutchIn ? pedal * 30 : Math.min(100, pedal * 100), gear });
  };
  const drive = (p, brake = 0) => {
    pedal = Math.min(1, Math.max(0, p));
    p = pedal;
    const r = roadRpm(gear);
    rpm += (Math.max(r, gear === 1 && v < 5 ? 1200 + 600 * p : CAR.idle) - rpm) * Math.min(1, dt * 15);
    const F = (torque(rpm) * p * G(gear) * 0.9) / CAR.tire;
    const drag = 0.5 * 1.2 * 0.65 * v * v + CAR.mass * 9.81 * 0.011 + brake * CAR.mass * 7;
    v = Math.max(0, v + ((F - drag) / CAR.mass) * dt);
    t += dt;
    push(false);
  };
  for (const [what, x] of PLAN) {
    if (what === 'idle') {
      for (let i = 0; i < x / dt; i++) {
        pedal = 0;
        rpm += (CAR.idle - rpm) * Math.min(1, dt * 4);
        t += dt;
        push(true);
      }
    } else if (what === 'pull') {
      gear = x.gear;
      const t1 = t + 40;
      while ((x.to ? rpm < x.to : v * 3.6 < x.kmh) && t < t1) drive(x.pedal);
    } else if (what === 'cruise') {
      for (let i = 0; i < x.secs / dt; i++) drive(0.28 + (x.kmh / 3.6 - v) * 0.2);
    } else if (what === 'coast') {
      const t1 = t + 40;
      while (v * 3.6 > x.kmh && t < t1) drive(0, x.brake ?? 0);
    } else if (what === 'shift') {
      // clutch in, off the pedal (a blip on the way down), clutch out
      const down = x < gear;
      const target = Math.max(CAR.idle, (v / CAR.tire) * G(x) * 9.5493);
      const from = rpm;
      for (let i = 0; i < 0.5 / dt; i++) {
        const f = i / (0.5 / dt);
        blip = down && f > 0.2 && f < 0.55 ? 0.45 : 0;
        pedal = blip;
        rpm = down ? from + (target - from) * Math.min(1, f * 1.6) : from + (Math.max(target, CAR.idle) - from) * Math.min(1, f * 1.4);
        v = Math.max(0, v - 0.6 * dt);
        t += dt;
        push(true);
      }
      gear = x;
    } else if (what === 'stop') {
      while (v > 0.05) {
        pedal = 0;
        v = Math.max(0, v - 6.5 * dt);
        rpm += (Math.max(CAR.idle, v > 4 ? roadRpm(gear) : CAR.idle) - rpm) * Math.min(1, dt * 8);
        t += dt;
        push(v < 4);
      }
      v = 0;
      gear = 1;
    }
  }
  return out;
}

let TRACE = null;
export const DEMO_CAR = CAR;

// The demo car's state at time t (seconds, looping).
export function demoAt(t) {
  TRACE ??= simulate();
  const T = TRACE[TRACE.length - 1].t;
  const tt = ((t % T) + T) % T;
  let lo = 0, hi = TRACE.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (TRACE[m].t <= tt) lo = m;
    else hi = m;
  }
  const a = TRACE[lo], b = TRACE[hi];
  const f = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0;
  const L = (k) => a[k] + (b[k] - a[k]) * f;
  const rpm = L('rpm'), load = L('load');
  return {
    rpm,
    pedal: L('pedal'),
    kmh: L('kmh'),
    load,
    // turbo diesel: boost builds with rpm and load
    map: 100 + Math.min(1, Math.max(0, (rpm - 1300) / 1200)) * (load / 100) * 130,
    gear: a.gear,
  };
}

// Plays the demo as an adapter would: about 12 readings a second, each a
// little late, with jitter.
export class DemoSource {
  constructor(onSample) {
    this.onSample = onSample;
    this.t0 = 0;
    this.timer = 0;
  }
  start() {
    this.t0 = performance.now();
    const tick = () => {
      const now = performance.now();
      const s = demoAt((now - this.t0) / 1000 - 0.1);
      this.onSample({ t: now, rpm: s.rpm, pedal: s.pedal, speed: s.kmh / 3.6, map: s.map, load: s.load });
      this.timer = setTimeout(tick, 70 + Math.random() * 25);
    };
    tick();
    return { label: 'Demo drive · 2.0 TDI hatchback' };
  }
  stop() {
    clearTimeout(this.timer);
  }
}
