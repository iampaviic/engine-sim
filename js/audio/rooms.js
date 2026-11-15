// The surroundings' reverberation, from their geometry and surfaces: the
// impulse response the convolver adds to what the mic hears directly.
//
// Every place is a box around the car (metres, the car's centre at the
// origin; x to its right, y up, z forward), each face a material or open
// air. Two parts:
//
// - Early reflections from image sources (Allen and Berkley, "Image method
//   for efficiently simulating small-room acoustics", JASA 65, 1979): each
//   path's delay after the direct sound, its spreading (r_direct / r_image),
//   each face's reflection factor sqrt(1 - alpha) per octave band, and air
//   absorption (ISO 9613-1) over the extra distance. A path through an open
//   face does not exist. The worklet already renders the direct sound and
//   its reflection off the road, so those two are left out.
// - From the mixing time (Lindau, Kosanke and Weinzierl, JAES 60(11), 2012:
//   20 V / S + 12 ms), a late tail: noise decaying at the place's
//   reverberation time by Eyring's formula, RT = 0.161 V / (-S ln(1 - a) +
//   4 m V), per octave band, with the air's absorption m. Its energy against
//   the direct sound's is the diffuse field's, (r / r_c)^2, where r_c =
//   sqrt(Q A / 16 pi) is the critical distance (A = -S ln(1 - a) + 4 m V;
//   Q = 2, a source on the floor). So the further the mic, the wetter: the
//   balance comes from the mic's distance against r_c, not a mix knob.
//   Eyring assumes a diffuse field; the open and long places (a canyon, a
//   road beside a noise wall, under a bridge, a tunnel) are not diffuse, so
//   their tails are estimates of the right order.
//
// The source is the exhaust's tail pipe (the loudest source); the mic is the
// camera's (js/audio/worklet/camera.js), one ear each side of it, so the
// response changes with the camera. In the cockpit the outside reverberation
// reaches the ears through the same body as the direct sound, so its balance
// against the direct sound is taken as the one just outside.

import { CAMERAS } from './worklet/camera.js';

const C = 343.2; // m/s, 20 C
export const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const EDGES = [177, 354, 707, 1414, 2828, 5657];

// Absorption coefficients, octave bands 125 Hz to 8 kHz. The published
// tables (Everest and Pohlmann, Master Handbook of Acoustics, appendix)
// stop at 4 kHz; 8 kHz repeats 4 kHz. Marked (est.) where no table entry
// fits and the values are estimates.
const MAT = {
  open: [1, 1, 1, 1, 1, 1, 1],
  // concrete, poured and sealed or painted
  concrete: [0.01, 0.01, 0.015, 0.02, 0.02, 0.02, 0.02],
  // concrete block, painted
  block: [0.1, 0.05, 0.06, 0.07, 0.09, 0.08, 0.08],
  // 12.5 mm plasterboard on joists
  plasterboard: [0.29, 0.1, 0.05, 0.04, 0.07, 0.09, 0.09],
  // brick, unglazed
  brick: [0.03, 0.03, 0.03, 0.04, 0.05, 0.07, 0.07],
  // a sheet-steel up-and-over door: a panel absorbing at its low resonances (est.)
  steelDoor: [0.25, 0.12, 0.08, 0.06, 0.05, 0.05, 0.05],
  // dense asphalt (est., as hard as sealed concrete with a little texture)
  asphalt: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05],
  // sprayed concrete lining a tunnel, rougher than poured (est.)
  shotcrete: [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.08],
  // weathered rock faces, fissured (est.)
  rock: [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.08],
  // a canyon floor: the road and its gravel and scrub verges (est.)
  verge: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.5],
};

// Places. box: [x0, x1, y0, y1, z0, z1]; faces in that order. contents: the
// equivalent absorption area (m^2 a band) of what is in the room besides its
// walls. tail: whether there is a late field at all.
export const ROOMS = {
  // A two-bay workshop garage, 10 by 15 m and 3.2 m to a plasterboard
  // ceiling, block walls, a concrete floor and a steel door ahead of the car,
  // which sits 3.5 m from the left wall so every camera is inside.
  // Contents: shelving, tyres, boxes and a workbench (est.).
  garage: {
    box: [-3.5, 6.5, 0, 3.2, -8, 7],
    faces: ['block', 'block', 'concrete', 'plasterboard', 'block', 'steelDoor'],
    contents: [8, 12, 18, 22, 25, 26, 26],
    tail: true,
  },
  // A two-lane road tunnel 10 m wide and 6 m high (its vault taken as
  // square), 400 m long with open portals, the car in the left lane.
  // Contents: jet fans, signs, lights and other traffic, per metre of
  // tunnel 0.1 m^2 (est.).
  tunnel: {
    box: [-3.25, 6.75, 0, 6, -200, 200],
    faces: ['shotcrete', 'shotcrete', 'asphalt', 'shotcrete', 'open', 'open'],
    contents: [40, 40, 40, 40, 40, 40, 40],
    tail: true,
  },
  // A road along a canyon floor between rock faces 40 m apart and 60 m
  // high, open to the sky and at both ends 150 m away.
  canyon: {
    box: [-15, 25, 0, 60, -150, 150],
    faces: ['rock', 'rock', 'verge', 'open', 'open', 'open'],
    contents: [0, 0, 0, 0, 0, 0, 0],
    tail: true,
  },
  // A reflective concrete noise wall 4 m high, one lane to the right; the
  // carriageway's far side (20 m left), the sky and the road ahead and
  // behind are open.
  barrier: {
    box: [-20, 5.25, 0, 4, -150, 150],
    faces: ['open', 'concrete', 'asphalt', 'open', 'open', 'open'],
    contents: [0, 0, 0, 0, 0, 0, 0],
    tail: true,
  },
  // Under a road bridge: the deck's underside 5.5 m up, 14 m wide along the
  // road, on abutment walls 11 m apart; open ahead and behind.
  bridge: {
    box: [-5, 6, 0, 5.5, -7, 7],
    faces: ['concrete', 'concrete', 'asphalt', 'concrete', 'open', 'open'],
    contents: [0, 0, 0, 0, 0, 0, 0],
    tail: true,
  },
  // The open road: no enclosure and so no late field; besides the road's
  // own reflection, the facade of a building 30 m to the right.
  open: {
    box: [-1000, 30, 0, 1000, -1000, 1000],
    faces: ['open', 'brick', 'asphalt', 'open', 'open', 'open'],
    contents: [0, 0, 0, 0, 0, 0, 0],
    tail: false,
  },
};

// Air absorption, dB/m, at frequency f (Hz): ISO 9613-1, at 20 C, 50%
// relative humidity and 101.325 kPa.
export function airAbsorption(f, T = 293.15, rh = 50, pa = 101.325) {
  const pr = 101.325, T0 = 293.15, T01 = 273.16;
  const Csat = -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151;
  const h = (rh * Math.pow(10, Csat)) / (pa / pr);
  const frO = (pa / pr) * (24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN = (pa / pr) * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.17 * (Math.pow(T / T0, -1 / 3) - 1)));
  return (
    8.686 *
    f *
    f *
    (1.84e-11 * (pr / pa) * Math.sqrt(T / T0) +
      Math.pow(T / T0, -2.5) * ((0.01275 * Math.exp(-2239.1 / T)) / (frO + (f * f) / frO) + (0.1068 * Math.exp(-3352 / T)) / (frN + (f * f) / frN)))
  );
}

// Volume, surface, mixing time, and per band the reverberation time and the
// critical distance.
export function roomAcoustics(room) {
  const [x0, x1, y0, y1, z0, z1] = room.box;
  const W = x1 - x0, H = y1 - y0, D = z1 - z0;
  const V = W * H * D;
  const areas = [H * D, H * D, W * D, W * D, W * H, W * H];
  const S = areas.reduce((a, b) => a + b, 0);
  const rt = [], rc = [], abar = [];
  for (let b = 0; b < BANDS.length; b++) {
    let A = room.contents[b];
    for (let f = 0; f < 6; f++) A += areas[f] * MAT[room.faces[f]][b];
    const a = Math.min(0.99, A / S);
    const m = airAbsorption(BANDS[b]) / 4.343; // energy, 1/m
    const Aeff = -S * Math.log(1 - a) + 4 * m * V;
    abar.push(a);
    rt.push((0.161 * V) / Aeff);
    rc.push(Math.sqrt((2 * Aeff) / (16 * Math.PI)));
  }
  return { V, S, abar, rt, rc, tmix: (20 * V) / S / 1000 + 0.012 };
}

// Where the mic and the source sit for a camera ('scene' and 'flyby': the
// roadside mic at the car's closest approach).
function geometry(camera) {
  const cam = camera === 'scene' || camera === 'flyby' ? { pos: [CAMERAS.flyby.lateral, 1.4, 0] } : CAMERAS[camera] ?? CAMERAS.rear;
  const mic = cam.pos.slice();
  if (camera === 'bay') mic[2] = 1.4;
  let right;
  if (cam.cabin) right = [1, 0, 0];
  else {
    const dx = -mic[0], dz = -mic[2], d = Math.hypot(dx, dz) || 1;
    right = [dz / d, 0, -dx / d];
  }
  return { mic, right, src: [0, 0.35, -2.3] };
}

// Zero-phase second-order Butterworth low or high pass (run forward then
// backward): magnitude |H|^2, so a low and a high pass at the same corner sum
// to exactly 1, and a tree of them splits and rejoins the octave bands
// without colouring.
function fbFilter(x, fc, fs, high) {
  const K = Math.tan((Math.PI * fc) / fs), K2 = K * K, q = Math.SQRT2;
  const a0 = 1 + q * K + K2;
  const b0 = (high ? 1 : K2) / a0, b1 = ((high ? -2 : 2) * (high ? 1 : K2)) / a0, b2 = b0;
  const a1 = (2 * (K2 - 1)) / a0, a2 = (1 - q * K + K2) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  x1 = x2 = y1 = y2 = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    const u = y[i];
    const v = b0 * u + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = u; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// Image sources along one axis of a box [a, b] for a source at s: positions
// and how many times each path meets the low and the high face.
function axisImages(s, a, b, reach) {
  const L = b - a, u = s - a, out = [];
  const nMax = Math.ceil(reach / (2 * L)) + 1;
  for (let n = -nMax; n <= nMax; n++)
    for (let p = 0; p < 2; p++) {
      const pos = a + (1 - 2 * p) * u + 2 * n * L;
      if (Math.abs(pos - s) > reach + L) continue;
      out.push([pos, Math.abs(n - p), Math.abs(n)]);
    }
  return out;
}

// The impulse response (relative to the direct sound, which has amplitude
// 1) of a place for a camera, at sample rate fs: { L, R, info }.
export function roomIR(name, camera, fs) {
  const room = ROOMS[name];
  if (!room) return null;
  const ac = roomAcoustics(room);
  const { mic, right, src } = geometry(camera);
  // keep the mic inside the box
  const bx = room.box;
  for (let k = 0; k < 3; k++) mic[k] = Math.min(bx[2 * k + 1] - 0.3, Math.max(bx[2 * k] + 0.3, mic[k]));
  const rd = Math.hypot(mic[0] - src[0], mic[1] - src[1], mic[2] - src[2]);
  const rtMax = Math.max(...ac.rt);
  // images up to the mixing time (or 0.6 s with no late field); the tail
  // until it has decayed 50 dB, at most 4 s (the convolver's cost grows
  // with the length), the last 0.4 s faded out
  const tImg = room.tail ? ac.tmix : 0.6;
  let len = tImg + 0.05;
  if (room.tail) len = Math.min(4, Math.max(len, ac.tmix + (rtMax * 50) / 60));
  const pad = Math.round(0.02 * fs); // room for the zero-phase filters' pre-ringing
  const N = Math.round(len * fs) + pad;
  const reach = rd + C * tImg;
  const air = BANDS.map((f) => airAbsorption(f));
  const refl = room.faces.map((f) => MAT[f].map((a) => Math.sqrt(Math.max(0, 1 - a))));
  const out = [];
  let images = 0;
  // the tail's noise: uniform, unit variance (the band filters make it
  // Gaussian), from a fixed seed so a place always sounds the same
  let seed = 0x9e3779b9;
  for (let ear = 0; ear < 2; ear++) {
    const sg = ear ? 1 : -1;
    const e = [mic[0] + right[0] * 0.09 * sg, mic[1], mic[2] + right[2] * 0.09 * sg];
    const red = Math.hypot(e[0] - src[0], e[1] - src[1], e[2] - src[2]);
    const bands = BANDS.map(() => new Float64Array(N));
    const ax = axisImages(src[0], bx[0], bx[1], reach), ay = axisImages(src[1], bx[2], bx[3], reach), az = axisImages(src[2], bx[4], bx[5], reach);
    for (const [x, nx0, nx1] of ax)
      for (const [y, ny0, ny1] of ay)
        for (const [z, nz0, nz1] of az) {
          const counts = [nx0, nx1, ny0, ny1, nz0, nz1];
          const order = nx0 + nx1 + ny0 + ny1 + nz0 + nz1;
          // the direct sound and the road's reflection are the worklet's
          if (order === 0 || (order === 1 && ny0 === 1)) continue;
          let open = false;
          for (let f = 0; f < 6; f++) if (counts[f] && room.faces[f] === 'open') open = true;
          if (open) continue;
          const r = Math.hypot(x - e[0], y - e[1], z - e[2]);
          const dt = (r - red) / C;
          if (dt > tImg || dt < 0) continue;
          const at = Math.round(dt * fs) + pad;
          for (let b = 0; b < BANDS.length; b++) {
            let g = red / r;
            for (let f = 0; f < 6; f++) if (counts[f]) g *= Math.pow(refl[f][b], counts[f]);
            g *= Math.pow(10, (-air[b] * (r - red)) / 20);
            bands[b][at] += g;
          }
          if (ear === 0) images++;
        }
    // the late field: independent noise a band, decaying at the band's
    // reverberation time, faded in over 5 ms from the mixing time
    if (room.tail) {
      const i0 = Math.round(ac.tmix * fs), fade = Math.round(0.005 * fs), out0 = N - pad - Math.round(0.4 * fs);
      for (let b = 0; b < BANDS.length; b++) {
        // energy a second at t (after the direct sound): (r / r_c)^2 (13.82 / RT) exp(-13.82 t / RT)
        const e0 = Math.pow(rd / ac.rc[b], 2) * (13.82 / ac.rt[b]);
        const k = Math.exp(-6.91 / (ac.rt[b] * fs)); // amplitude, a sample
        let amp = Math.sqrt(e0 / fs) * Math.exp((-6.91 * i0) / (ac.rt[b] * fs));
        const d = bands[b];
        let sd = seed;
        for (let i = i0; i < N - pad && amp > 1e-8; i++) {
          let w = i - i0 < fade ? (i - i0) / fade : 1;
          if (i > out0) w *= 0.5 + 0.5 * Math.cos((Math.PI * (i - out0)) / (N - pad - out0));
          sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0;
          d[i + pad] += (sd / 4294967296 - 0.5) * 3.4641016 * w * amp;
          amp *= k;
        }
        seed = sd;
      }
    }
    // join the bands: acc = band 6; for each lower band, acc = LP(band) + HP(acc)
    let acc = bands[BANDS.length - 1];
    for (let b = BANDS.length - 2; b >= 0; b--) {
      const lo = fbFilter(bands[b], EDGES[b], fs, false), hi = fbFilter(acc, EDGES[b], fs, true);
      for (let i = 0; i < N; i++) lo[i] += hi[i];
      acc = lo;
    }
    out.push(new Float32Array(acc.subarray(pad)));
  }
  let eW = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) eW += ch[i] * ch[i];
  return {
    L: out[0],
    R: out[1],
    info: { rd, images, rt: ac.rt, rc: ac.rc, tmix: ac.tmix, V: ac.V, wetDb: 10 * Math.log10(eW / 2 + 1e-30) },
  };
}
