// Camera and body geometry: where the mic and each source sit, and how
// that sets the listener's taps (distance delay and Doppler, ground
// reflection, air absorption, directivity, the body's shadow, the cabin).

import { C_AIR, N_SRC, TAU } from './constants.js';
import { clamp, lpCoef } from './dsp.js';

export const CAMERAS = {
  rear: { pos: [-1.3, 1.0, -6.5], cabin: 0 },
  exhaust: { pos: [-0.35, 0.45, -3.1], cabin: 0 },
  side: { pos: [4.5, 1.1, -0.3], cabin: 0 },
  front: { pos: [1.2, 1.0, 6.0], cabin: 0 },
  bay: { pos: [0.3, 1.3, 1.4], cabin: 0 },
  cockpit: { pos: [-0.35, 1.05, 0.1], cabin: 1 },
  flyby: { pos: [0, 1.4, 0], cabin: 0, world: true, lateral: 7.5 },
};

function sourcePositions(cfg) {
  const lay = cfg.vehicle.layout;
  const engZ = lay === 'mid' ? -0.7 : lay === 'rear' ? -1.8 : 1.5;
  const intZ = lay === 'mid' ? -0.35 : lay === 'rear' ? -1.4 : 1.9;
  const intY = lay === 'mid' ? 1.15 : 0.85;
  // side pipes exit just behind the front wheels (front engines) or ahead of
  // the rear wheels (mid/rear engines)
  const side = cfg.exhaustExit === 'side';
  const sideZ = lay === 'front' ? 0.55 : -0.9;
  return [
    side ? [-0.98, 0.3, sideZ] : [-0.5, 0.35, -2.3], // exL
    side ? [0.98, 0.3, sideZ] : [0.5, 0.35, -2.3], // exR
    side ? [0.98, 0.3, sideZ] : [0.0, 0.35, -2.3], // exC
    [0.0, intY, intZ], // intake
    [0.0, 0.7, engZ], // mech
    [0.0, 0.3, 0.0], // chassis
    [0.7, 0.3, engZ - 0.25], // wastegate dump (screamer pipe)
  ];
}

// Direction each pipe mouth points (radiation is brighter on that axis).
function sourceAxes(cfg) {
  const side = cfg.exhaustExit === 'side';
  return [side ? [-1, 0, 0] : [0, 0, -1], side ? [1, 0, 0] : [0, 0, -1], side ? [1, 0, 0] : [0, 0, -1], null, null, null, [0.6, -0.8, 0]];
}

// Radius of the pipe mouth feeding each source channel (m).
function mouthRadii(ex) {
  const r = new Float64Array(N_SRC).fill(0.035);
  const seen = new Uint8Array(N_SRC);
  for (let i = 0; i < ex.opens.length; i++) {
    const ch = ex.oCh[i];
    const a = ex.np[ex.opens[i] * 4 + 1];
    if (!seen[ch] || a > r[ch]) r[ch] = a;
    seen[ch] = 1;
  }
  return r;
}

// The body between the engine bay and the world: roof line (z, height) of
// the rest of the car, front to back. The bay itself is open underneath and
// through the grille, so it does not shadow its own engine.
const BODY_W = 0.9; // half width, m
const BODY = {
  front: [[0.95, 0.98], [0.3, 1.32], [-1.0, 1.3], [-1.7, 1.0], [-2.3, 0.95]],
  mid: [[2.25, 0.55], [2.0, 0.72], [1.0, 0.95], [0.2, 1.18], [-0.6, 1.15]],
  rear: [[2.25, 0.55], [2.0, 0.72], [0.9, 0.95], [0.3, 1.3], [-0.5, 1.3], [-1.0, 1.25]],
};
function bodyTop(prof, z) {
  if (z > prof[0][0] || z < prof[prof.length - 1][0]) return 0;
  for (let i = 1; i < prof.length; i++) {
    const [z1, y1] = prof[i];
    if (z >= z1) {
      const [z0, y0] = prof[i - 1];
      return y1 + ((y0 - y1) * (z - z1)) / (z0 - z1 || 1);
    }
  }
  return 0;
}

// Extra path length (m) for sound from a source in the engine bay to reach
// the listener over the body (car coordinates): the shortest string from one
// to the other drawn over the roof line, less the straight line.
const shadowPts = new Float64Array(2 * 42);
function bodyShadow(layout, sx, sy, sz, lx, ly, lz) {
  const prof = BODY[layout] ?? BODY.front;
  const dx = lx - sx, dz = lz - sz;
  const H = Math.hypot(dx, dz);
  if (H < 0.5) return 0;
  // points along the way, in (distance from source, height); the source's own
  // surroundings (the bay) are left out
  const P = shadowPts;
  let n = 0;
  P[n++] = 0;
  P[n++] = sy;
  let any = false;
  for (let j = 1; j < 40; j++) {
    const t = j / 40;
    const h = t * H;
    if (h < 0.35) continue;
    const x = sx + dx * t, z = sz + dz * t;
    if (x > BODY_W || x < -BODY_W) continue;
    const top = bodyTop(prof, z);
    if (top <= sy + (ly - sy) * t) continue;
    P[n++] = h;
    P[n++] = top;
    any = true;
  }
  if (!any) return 0;
  P[n++] = H;
  P[n++] = ly;
  // upper convex hull, left to right
  const st = [];
  for (let i = 0; i < n; i += 2) {
    while (st.length >= 4) {
      const ax = st[st.length - 4], ay = st[st.length - 3], bx = st[st.length - 2], by = st[st.length - 1];
      if ((bx - ax) * (P[i + 1] - ay) - (by - ay) * (P[i] - ax) >= 0) st.length -= 2;
      else break;
    }
    st.push(P[i], P[i + 1]);
  }
  let len = 0;
  for (let i = 2; i < st.length; i += 2) len += Math.hypot(st[i] - st[i - 2], st[i + 1] - st[i - 1]);
  return Math.max(0, len - Math.hypot(H, ly - sy));
}

export class CameraMethods {
  // Compute listener tap targets for the current camera and car pose.
  updateScene(blockLen) {
    const sim = this.sim;
    const L = this.L;
    if (!sim) return;
    const cam = CAMERAS[this.camera] ?? CAMERAS.rear;
    const flyby = (sim.mode === 'flyby' && this.flyby) || (this.scene?.world && this.camera === 'scene');
    const srcs = sourcePositions(sim.cfg);
    const axes = sourceAxes(sim.cfg);
    const fs = sim.fs;
    let carX = 0, carZ = 0;
    let lisPos, lisRight;
    if (flyby) {
      const sc = this.scene?.world ? this.scene : null;
      carZ = sc ? sc.carZ ?? 0 : this.flyby.x;
      carX = 0;
      lisPos = sc ? sc.lisPos : [CAMERAS.flyby.lateral, 1.4, 0];
      lisRight = [0, 0, 1]; // facing the road (-x): right ear toward +z
    } else {
      lisPos = cam.pos;
      // the bay mic hangs over the engine, wherever the engine is
      if (cam === CAMERAS.bay) lisPos = [cam.pos[0], cam.pos[1], srcs[4][2] - 0.1];
      // face the car centre (or forward in cockpit)
      if (cam.cabin) lisRight = [1, 0, 0];
      else {
        const dx = -lisPos[0], dz = -lisPos[2];
        const d = Math.hypot(dx, dz) || 1;
        lisRight = [dz / d, 0, -dx / d];
      }
    }
    const cabin = !flyby && cam.cabin;
    L.cabin = cabin ? 1 : 0;
    L.moving = !!flyby;
    sim.aeroMic = flyby ? 0 : cabin ? 2 : 1;
    // The starter hides low beside the bell housing and is heard through the
    // block and body rather than as a point source: wherever the mic is, it
    // keeps roughly the balance against the exhaust that it has from behind.
    const dist = (p, q) => Math.max(0.35, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    const exM = [carX + srcs[0][0], srcs[0][1], carZ + srcs[0][2]], stM = [carX + srcs[4][0], srcs[4][1], carZ + srcs[4][2]];
    const rear = CAMERAS.rear.pos;
    const rel = (dist(lisPos, stM) / dist(lisPos, exM)) / (dist(rear, srcs[4]) / dist(rear, srcs[0]));
    sim.stNear = clamp(Math.pow(rel, 0.75), 0.08, 1.5) * (cabin ? 0.8 : 1);
    const active = [
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 0),
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 1),
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 2),
      true,
      true,
      // (the road's channel, which also carries the fuel pump)
      true,
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 6),
    ];
    const n = blockLen || 1;
    const layout = sim.cfg.vehicle.layout;
    const mouthR = sim.mouthR ?? (sim.mouthR = mouthRadii(sim.ex));
    const shadow = this.shadow ?? (this.shadow = [0, 0]);
    for (let s = 0; s < N_SRC; s++) {
      L.active[s] = active[s] ? 1 : 0;
      const sp = srcs[s];
      const wx = carX + sp[0], wy = sp[1], wz = carZ + sp[2];
      // the intake, behind the rest of the car (direct, and by way of the
      // ground); the mechanical source carries the starter and the gearbox,
      // which come through the body and from under the car
      shadow[0] = shadow[1] = 0;
      if (!cabin && s === 3) {
        const lx = lisPos[0] - carX, lz = lisPos[2] - carZ;
        shadow[0] = bodyShadow(layout, sp[0], sp[1], sp[2], lx, lisPos[1], lz);
        shadow[1] = bodyShadow(layout, sp[0], -sp[1], sp[2], lx, lisPos[1], lz);
      }
      for (let ear = 0; ear < 2; ear++) {
        const sgn = ear === 0 ? -1 : 1;
        const ex = lisPos[0] + lisRight[0] * 0.09 * sgn;
        const ey = lisPos[1];
        const ez = lisPos[2] + lisRight[2] * 0.09 * sgn;
        for (let path = 0; path < 2; path++) {
          const t = s * 4 + path * 2 + ear;
          let gain, delay, fc;
          const sy = path === 0 ? wy : -wy;
          const dx = wx - ex, dy = sy - ey, dz = wz - ez;
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          delay = (r / C_AIR) * fs + 4;
          // inside, the sound arrives through whole panels, not from a point
          // beside the ear
          gain = 1 / Math.max(r, cabin ? 1 : 0.35);
          // air absorption + ground impedance (the road's reflection follows
          // the weather: sim/weather.js)
          fc = 18000 / (1 + r / 70);
          if (path === 1) {
            gain *= sim.gndG;
            fc = Math.min(fc, sim.gndF);
          }
          // A pipe mouth radiates evenly while it is small against the wave
          // (ka < 1); above that it beams (Levine & Schwinger): about +6 dB
          // on its axis, a little down to the side, far down behind it. So a
          // high shelf from ka ~ 1. (Inside, what counts is the body panels
          // near the pipes, not the beam.)
          let shG = 1, shF = 0;
          const ax = axes[s];
          if (ax && !cabin) {
            const cosA = -(ax[0] * dx + ax[1] * dy + ax[2] * dz) / (r || 1); // +1 on axis
            shG = Math.pow(10, (6 - 10.5 * (1 - cosA)) / 20);
            shF = (C_AIR / (TAU * mouthR[s])) * Math.sqrt(shG);
          } else if (shadow[path] > 0) {
            // The body in the way: Maekawa's barrier loss, 10 log(1 + 20 N)
            // with N = 2 δ f / c, as a high shelf; it stops growing where
            // sound round the sides and under the car takes over.
            const d = shadow[path];
            const il = Math.min(15, 10 * Math.log10(1 + (40 * d * 8000) / C_AIR));
            shG = Math.pow(10, -il / 20);
            shF = (((Math.pow(10, il / 20) - 1) / 20) * C_AIR * Math.sqrt(shG)) / (2 * d);
          }
          // head shadow
          const dot = (dx * lisRight[0] + dz * lisRight[2]) / (r || 1);
          const facing = sgn * dot;
          if (facing < 0) {
            fc *= 0.55 + 0.45 * (1 + facing);
            gain *= 0.8 + 0.2 * (1 + facing);
          }
          // Into the cabin the sound comes through the body: panels and glass
          // lose about 6 dB more per octave (the mass law) from a corner fc
          // until the leaks round the seals, glass edges and grommets take
          // over and the loss levels off at leak; the trim soaks up the top
          // (fc2). Behind a mid or rear engine the silencer sits just behind
          // the bulkhead, so the exhaust is louder in there than up front.
          // Road roar comes up through the floor and the suspension,
          // high-passed (fhp) below the tyres' and the body's lowest modes.
          let leak = 0, fc2 = 0, fhp = 0;
          if (cabin) {
            const sidePipes = sim.cfg.exhaustExit === 'side';
            if (path === 1) {
              gain = 0;
            } else if (s <= 2) {
              gain *= sidePipes ? 0.35 : layout === 'front' ? 0.55 : layout === 'mid' ? 0.9 : 0.8;
              fc = sidePipes ? 450 : 280;
              leak = sidePipes ? 0.15 : 0.1;
              fc2 = sidePipes ? 8000 : 6000;
            } else if (s === 6) {
              gain *= 0.4;
              fc = 700;
              leak = 0.12;
              fc2 = 6000;
            } else if (s === 3) {
              gain *= layout === 'front' ? 0.25 : 0.35;
              fc = layout === 'front' ? 1100 : 2400;
              leak = layout === 'front' ? 0.2 : 0.3;
              fc2 = layout === 'front' ? 5500 : 8000;
            } else if (s === 4) {
              gain *= 0.45;
              fc = 1800;
              leak = 0.25;
              fc2 = 7000;
            } else {
              gain *= 1.3;
              fc = 900;
              fhp = 35;
            }
          }
          const alpha = lpCoef(Math.min(fc, fs * 0.45), fs);
          if (L.first || blockLen === 0) {
            L.dCur[t] = delay;
            L.gCur[t] = gain;
            L.dInc[t] = 0;
            L.gInc[t] = 0;
          } else {
            L.dInc[t] = (delay - L.dCur[t]) / n;
            L.gInc[t] = (gain - L.gCur[t]) / n;
          }
          L.al[t] = alpha;
          L.lk[t] = leak;
          L.al2[t] = fc2 ? lpCoef(fc2, fs) : alpha;
          L.shg[t] = shG;
          L.ash[t] = shF ? lpCoef(shF, fs) : 0;
          L.hp[t] = fhp ? lpCoef(fhp, fs) : 0;
        }
      }
    }
    L.first = false;
  }
}
