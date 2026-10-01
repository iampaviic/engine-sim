// Engine builder: turns a compact design (layout, crank, bore, stroke, cams,
// induction, exhaust...) into a full engine spec like the presets. Firing
// orders are not picked from a table: every cylinder's top dead centre comes
// from the crank-pin angles and the bank angle, and the builder enumerates
// which revolution each cylinder fires on. Every option it offers is one a
// real crankshaft could produce, including twin-pulse and big-bang orders.

export const LAYOUTS = [
  ['inline', 'Inline'],
  ['v', 'Vee'],
  ['flat', 'Flat'],
  ['rotary', 'Rotary'],
];

// Cylinder counts per layout (rotors for the rotary).
export const COUNTS = {
  inline: [1, 2, 3, 4, 5, 6, 8],
  v: [2, 4, 6, 8, 10, 12, 16],
  flat: [2, 4, 6, 8, 12],
  rotary: [2, 3, 4],
};

// Top-dead-centre angle (mod 360, crank degrees) of each throw for the
// classic inline crankshafts. A vee or flat engine puts one cylinder from
// each bank on every throw.
const THROWS = {
  1: { single: [0] },
  2: { 360: [0, 0], 180: [0, 180], 270: [0, 270] },
  3: { 120: [0, 240, 120] },
  4: { flat: [0, 180, 180, 0], cross: [0, 90, 270, 180] },
  5: { 72: [0, 144, 216, 288, 72] },
  6: { 120: [0, 120, 240, 240, 120, 0] },
  8: { split: [0, 180, 90, 270, 270, 90, 180, 0] },
};

const CRANK_LABEL = {
  single: 'Single throw',
  360: '360° crank',
  180: '180° crank',
  270: '270° crank',
  120: '120° crank',
  flat: 'Flat-plane',
  cross: 'Cross-plane',
  72: '72° crank',
  split: 'Split-plane',
};

const CRANK_NOTE = {
  360: 'Both pistons rise together; they fire a full turn apart.',
  180: 'Pistons opposite each other: uneven 180/540° firing.',
  270: 'Throws 90° apart: 270/450° firing, the "crossplane twin" lope.',
  flat: 'All throws in one plane: even firing, a flat buzzy edge, more vibration.',
  cross: 'Throws at 90° in two planes: smooth, but each bank fires unevenly.',
};

// Crank choices that make sense for this layout and count.
export function crankOptions(d) {
  if (d.layout === 'rotary') return [['rotary', 'Eccentric shaft']];
  const m = d.layout === 'inline' ? d.cylinders : d.cylinders / 2;
  const t = THROWS[m] ?? {};
  const out = Object.keys(t).map((k) => [k, CRANK_LABEL[k] ?? `${k}°`]);
  if (d.layout === 'flat') return [['boxer', 'Boxer (own throw per cylinder)'], ...out.map(([k, l]) => [k, `180° vee, ${l.toLowerCase()}`])];
  return out;
}

export function crankNote(d) {
  if (d.layout === 'flat' && d.crank === 'boxer') return 'Opposed pistons move apart and together like a boxer\'s fists, so they balance each other.';
  return CRANK_NOTE[d.crank] ?? '';
}

function banksOf(d) {
  const n = d.cylinders;
  if (d.layout === 'inline') return [Array.from({ length: n }, (_, i) => i + 1)];
  if (d.layout === 'rotary') return Array.from({ length: n }, (_, r) => [r * 3 + 1, r * 3 + 2, r * 3 + 3]);
  const m = n / 2;
  return [Array.from({ length: m }, (_, i) => i + 1), Array.from({ length: m }, (_, i) => m + i + 1)];
}

const mod = (a, m) => ((a % m) + m) % m;

// TDC angle (mod 360) of every cylinder from the crank and the bank angle.
export function tdcAngles(d) {
  const n = d.cylinders;
  if (d.layout === 'inline') {
    const t = THROWS[n]?.[d.crank] ?? Object.values(THROWS[n] ?? { x: [0] })[0];
    return t.slice(0, n);
  }
  const m = n / 2;
  const alpha = d.layout === 'flat' ? 180 : d.bankAngle;
  if (d.layout === 'flat' && d.crank === 'boxer') {
    // each cylinder on its own throw, opposite its partner: both reach TDC
    // together (one firing, the other in overlap)
    const base = Object.values(THROWS[m] ?? { x: [0] })[0];
    return [...base, ...base];
  }
  const base = THROWS[m]?.[d.crank] ?? Object.values(THROWS[m] ?? { x: [0] })[0];
  const shift = alpha + (d.splitPin ? d.pinOffset ?? 0 : 0);
  return [...base, ...base.map((a) => mod(a + shift, 360))];
}

// Even-fire split-pin offset for a vee: the smallest throw offset that lets
// the whole engine fire at equal intervals (null if none is needed or none
// exists). Even firing every E degrees needs the TDCs, taken mod 360, to sit
// on n/2 points spaced E apart, two cylinders on each.
export function evenPinOffset(d) {
  if (d.layout !== 'v') return null;
  const n = d.cylinders;
  const E = 720 / n;
  let best = null;
  for (let off = -90; off <= 90; off += 0.5) {
    const t = tdcAngles({ ...d, splitPin: true, pinOffset: off }).map((a) => mod(Math.round(a * 2) / 2, 360));
    const base = t[0];
    const counts = new Map();
    let ok = true;
    for (const a of t) {
      const k = mod(a - base, 360) / E;
      if (Math.abs(k - Math.round(k)) > 1e-6) {
        ok = false;
        break;
      }
      const key = Math.round(k) % (n / 2);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!ok || counts.size !== n / 2 || [...counts.values()].some((c) => c !== 2)) continue;
    if (best == null || Math.abs(off) < Math.abs(best)) best = off;
  }
  return best;
}

function intervalsOf(angles, cyc) {
  const a = angles.slice().sort((x, y) => x - y);
  return a.map((v, i) => (i + 1 < a.length ? a[i + 1] - v : cyc - v + a[0]));
}

// Enumerate firing schemes: each cylinder fires at its TDC on the first or
// the second crank revolution. Returns distinct schemes, most even first.
const fireCache = new Map();
export function firingOptions(d, limit = 10) {
  const key = [d.layout, d.cylinders, d.crank, d.bankAngle, d.splitPin ? d.pinOffset : 'x'].join('|');
  let all = fireCache.get(key);
  if (!all) {
    all = enumerateFiring(d);
    if (fireCache.size > 200) fireCache.clear();
    fireCache.set(key, all);
  }
  return all.slice(0, limit);
}

function enumerateFiring(d) {
  if (d.layout === 'rotary') {
    const r = d.cylinders;
    const angles = [];
    for (let k = 0; k < r; k++) for (let f = 0; f < 3; f++) angles.push(mod((k * 1080) / (r * 3) + f * 360, 1080));
    const order = angles.map((a, i) => [a, i + 1]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    return [{ angles, order, intervals: intervalsOf(angles, 1080), spread: 0, name: `Even ${Math.round(1080 / (r * 3))}°`, key: 'rotary' }];
  }
  const tdc = tdcAngles(d);
  const n = tdc.length;
  const banks = banksOf(d);
  const bankOf = new Array(n);
  banks.forEach((b, bi) => b.forEach((c) => (bankOf[c - 1] = bi)));
  const seen = new Map();
  const N = 1 << (n - 1);
  for (let mask = 0; mask < N; mask++) {
    const angles = new Array(n);
    for (let i = 0; i < n; i++) {
      const rev = i === 0 ? 0 : (mask >> (i - 1)) & 1;
      angles[i] = mod(tdc[i] - tdc[0] + 360 * rev, 720);
    }
    const iv = intervalsOf(angles, 720);
    const spread = Math.max(...iv) - Math.min(...iv);
    // canonical key: interval sequence and bank sequence from cylinder 1
    const order = angles.map((a, i) => [a, i + 1]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[1]);
    const key = iv.map((v) => Math.round(v)).join(',') + '|' + order.map((c) => bankOf[c - 1]).join('');
    if (!seen.has(key)) seen.set(key, { angles, order, intervals: iv, spread });
  }
  const list = [...seen.values()].sort((a, b) => a.spread - b.spread || bankSpread(a, banks) - bankSpread(b, banks));
  for (const o of list) o.name = schemeName(o, n);
  return list.slice(0, 64);
}

function bankSpread(o, banks) {
  let s = 0;
  for (const b of banks) {
    if (b.length < 2) continue;
    const iv = intervalsOf(b.map((c) => o.angles[c - 1]), 720);
    s += Math.max(...iv) - Math.min(...iv);
  }
  return s;
}

function schemeName(o, n) {
  const iv = o.intervals.map((v) => Math.round(v));
  if (o.spread < 0.5) return `Even ${iv[0]}°`;
  if (n <= 3) return `Uneven ${iv.join('/')}°`;
  const zeros = iv.filter((v) => v === 0).length;
  if (n >= 4 && zeros >= n / 2) return 'Twin pulse';
  if (n >= 3 && Math.max(...iv) >= 360) return 'Big bang';
  // compress a repeating pattern
  for (let p = 1; p <= n / 2; p++) {
    if (n % p) continue;
    const pat = iv.slice(0, p);
    if (iv.every((v, i) => v === pat[i % p])) return `Uneven ${pat.join('/')}°`;
  }
  return 'Uneven';
}

// Per-bank (exhaust group) firing intervals, for the spec sheet.
export function bankIntervals(d, angles, groups) {
  return groups.map((g) => intervalsOf(g.map((c) => angles[c - 1]), d.layout === 'rotary' ? 1080 : 720).map((v) => Math.round(v)));
}

// ---------------------------------------------------------------------------
// Cams
// ---------------------------------------------------------------------------

export const CAMS = [
  ['mild', 'Mild', 236, 114, 0.92],
  ['street', 'Street', 252, 112, 1],
  ['fast', 'Fast road', 268, 110, 1.08],
  ['race', 'Race', 288, 106, 1.16],
  ['wild', 'Wild', 308, 104, 1.24],
];

// Seat-timing [open, close, lift] from duration and lobe separation, with
// the intake lobe advanced 4 degrees.
function camFrom(dur, lsa, lift) {
  const icl = lsa - 4;
  const ecl = lsa + 4;
  const exDur = dur + 8;
  return {
    in: [Math.round(dur / 2 - icl), Math.round(icl + dur / 2 - 180), +lift.toFixed(1)],
    ex: [Math.round(ecl + exDur / 2 - 180), Math.round(exDur / 2 - ecl), +(lift * 0.95).toFixed(1)],
  };
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const CARS = {
  coupe: { label: 'Sports coupé', mass: 1450, gears: [3.3, 2.1, 1.55, 1.2, 0.97, 0.8], final: 3.7, tire: 0.33, cd: 0.31, area: 1.95, rearBias: 0.52, layout: 'front', shiftTime: 0.12 },
  gt: { label: 'Grand tourer', mass: 1720, gears: [3.4, 2.2, 1.6, 1.25, 1.0, 0.83, 0.67], final: 3.5, tire: 0.35, cd: 0.33, area: 2.05, rearBias: 0.52, layout: 'front', shiftTime: 0.1 },
  super: { label: 'Mid-engined supercar', mass: 1450, gears: [3.13, 2.08, 1.55, 1.22, 0.97, 0.79, 0.65], final: 4.1, tire: 0.34, cd: 0.33, area: 1.9, rearBias: 0.58, layout: 'mid', shiftTime: 0.06, mu: 1.25 },
  muscle: { label: 'Muscle car', mass: 1750, gears: [2.66, 1.78, 1.3, 1.0, 0.74, 0.5], final: 3.55, tire: 0.35, cd: 0.36, area: 2.2, rearBias: 0.5, layout: 'front', shiftTime: 0.25 },
  hatch: { label: 'Hot hatch (AWD)', mass: 1380, gears: [3.5, 2.3, 1.6, 1.2, 0.95, 0.78], final: 4.0, tire: 0.32, cd: 0.33, area: 2.1, rearBias: 0.45, layout: 'front', drive: 'awd', shiftTime: 0.1 },
  race: { label: 'Race car', mass: 1000, gears: [2.8, 2.1, 1.7, 1.42, 1.22, 1.07], final: 4.2, tire: 0.33, cd: 0.45, area: 1.7, rearBias: 0.58, layout: 'mid', straightCut: true, shiftTime: 0.04, mu: 1.7 },
};

// ---------------------------------------------------------------------------
// Design -> spec
// ---------------------------------------------------------------------------

export const VALVETRAINS = [
  ['ohv', 'Pushrods (OHV)'],
  ['sohc', 'Single cam (SOHC)'],
  ['dohc', 'Twin cam (DOHC)'],
  ['pneumatic', 'Pneumatic (racing)'],
];
const FLOAT_RPM = { ohv: 7000, sohc: 8000, dohc: 9200, pneumatic: 40000 };

export function defaultDesign() {
  return normalize({
    v: 1,
    id: null,
    name: 'My V8',
    layout: 'v',
    cylinders: 8,
    bankAngle: 90,
    crank: 'cross',
    splitPin: false,
    pinOffset: 0,
    order: null,
    bore: 96,
    stroke: 86,
    rodRatio: 1.65,
    compression: 11,
    chamber: 650,
    valvetrain: 'dohc',
    valves: 4,
    cam: 'street',
    vtec: false,
    vtecRpm: 6000,
    induction: { type: 'na', count: 1, size: 1, boost: 1, screamer: false, antilag: false, bov: 'atm', ratio: 2.4 },
    intake: { airbox: 'stock', itb: false, runnerLen: 0.32 },
    exhaust: { headers: 'n-1', len: 0.7, unequal: false, merge: 'x', cat: true, resonator: false, muffler: 'sport', exit: 'rear', tips: 4 },
    ecu: { idle: 0, limit: 7200, limiter: 'fuel', burble: 0.2, octane: 98 },
    flywheel: 'stock',
    car: 'gt',
    drive: 'rwd',
    calib: null,
  });
}

// Clamp and repair a design so it always compiles.
export function normalize(d) {
  d = JSON.parse(JSON.stringify(d));
  if (!COUNTS[d.layout]) d.layout = 'v';
  const counts = COUNTS[d.layout];
  if (!counts.includes(d.cylinders)) d.cylinders = counts.reduce((a, c) => (Math.abs(c - d.cylinders) < Math.abs(a - d.cylinders) ? c : a), counts[0]);
  if (d.layout === 'rotary') {
    d.chamber = clamp(d.chamber ?? 650, 300, 900);
    d.crank = 'rotary';
  } else {
    const cranks = crankOptions(d).map((c) => c[0]);
    if (!cranks.includes(String(d.crank))) d.crank = cranks[0];
    d.bore = clamp(d.bore ?? 90, 50, 130);
    d.stroke = clamp(d.stroke ?? 86, 35, 140);
    d.rodRatio = clamp(d.rodRatio ?? 1.65, 1.4, 2.2);
  }
  if (d.layout === 'v') d.bankAngle = clamp(d.bankAngle ?? 90, 15, 135);
  else d.bankAngle = d.layout === 'flat' ? 180 : 0;
  d.compression = clamp(d.compression ?? 10.5, 7, 15);
  d.valves = [2, 3, 4, 5].includes(d.valves) ? d.valves : 4;
  if (d.valvetrain === 'ohv' && d.valves > 2) d.valves = 2;
  if (!CAMS.some((c) => c[0] === d.cam)) d.cam = 'street';
  d.ecu = { idle: 0, limit: 7000, limiter: 'fuel', burble: 0.2, octane: 98, ...(d.ecu ?? {}) };
  d.ecu.limit = clamp(d.ecu.limit, 3000, 20000);
  d.induction = { type: 'na', count: 1, size: 1, boost: 1, screamer: false, antilag: false, bov: 'atm', ratio: 2.4, ...(d.induction ?? {}) };
  if (d.layout === 'rotary' && d.induction.type !== 'na' && d.induction.type !== 'turbo') d.induction.type = 'turbo';
  if (d.induction.count > 1 && (d.layout === 'inline' || d.layout === 'rotary')) d.induction.count = 1;
  d.intake = { airbox: 'stock', itb: false, runnerLen: 0.32, ...(d.intake ?? {}) };
  d.exhaust = { headers: 'n-1', len: 0.7, unequal: false, merge: 'x', cat: false, resonator: false, muffler: 'sport', exit: 'rear', tips: 2, ...(d.exhaust ?? {}) };
  d.exhaust.len = clamp(d.exhaust.len, 0.2, 1.4);
  if (!CARS[d.car]) d.car = 'coupe';
  // keep the chosen firing order only if this crank can produce it
  const opts = firingOptions(d, 64);
  if (!d.order || !opts.some((o) => o.order.join() === d.order.join())) d.order = opts[0].order.slice();
  return d;
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, +x || a));
}

export function displacementL(d) {
  // Wankel convention: one chamber's displacement per rotor
  if (d.layout === 'rotary') return (d.chamber * d.cylinders) / 1000;
  return (d.cylinders * Math.PI * (d.bore / 2) ** 2 * d.stroke) / 1e6;
}

function family(d) {
  if (d.layout === 'rotary') return 'Rotary';
  const p = d.layout === 'inline' ? 'I' : d.layout === 'flat' ? 'F' : 'V';
  return `${p}${d.cylinders}`;
}

export function firingFor(d) {
  const opts = firingOptions(d, 64);
  return opts.find((o) => o.order.join() === (d.order ?? []).join()) ?? opts[0];
}

export function designToSpec(d) {
  d = normalize(d);
  const n = d.layout === 'rotary' ? d.cylinders * 3 : d.cylinders;
  const L = displacementL(d);
  const fire = firingFor(d);
  const banks = banksOf(d);
  const red = d.ecu.limit;
  const boosted = d.induction.type !== 'na';
  const boost = d.induction.type === 'turbo' || d.induction.type === 'centrifugal' ? d.induction.boost : d.induction.type === 'na' ? 0 : 0.6;
  const perCylCC = d.layout === 'rotary' ? d.chamber : (L * 1000) / n;
  const camIdx = Math.max(0, CAMS.findIndex((c) => c[0] === d.cam));
  const [, , dur, lsa, liftK] = CAMS[camIdx];

  // valves sized from the bore
  const B = d.bore ?? 90;
  const vcfg = {
    2: { inCount: 1, exCount: 1, inDia: 0.5 * B, exDia: 0.4 * B },
    3: { inCount: 2, exCount: 1, inDia: 0.36 * B, exDia: 0.42 * B },
    4: { inCount: 2, exCount: 2, inDia: 0.38 * B, exDia: 0.32 * B },
    5: { inCount: 3, exCount: 2, inDia: 0.31 * B, exDia: 0.33 * B },
  }[d.valves];
  const lift = 0.27 * vcfg.inDia * liftK;
  const spec = {
    id: d.id ?? 'my-draft',
    name: d.name || 'My engine',
    custom: true,
    origin: 'My garage',
    family: family(d),
    cylinders: n,
    compression: d.compression,
    firingAngles: fire.angles.slice(),
    firingOrder: fire.order.slice(),
    banks: d.layout === 'inline' ? undefined : banks,
    intake: {
      runnerLen: d.intake.runnerLen,
      runnerDia: Math.round(Math.max(30, vcfg.inDia * (vcfg.inCount > 1 ? 1.25 : 0.95))),
      plenum: d.intake.itb ? 0.8 : +Math.max(1.5, L * 1.1).toFixed(1),
      throttleDia: d.intake.itb ? Math.round(vcfg.inDia * (vcfg.inCount > 1 ? 1.2 : 0.95)) : Math.round(45 + 17 * Math.sqrt(L * (1 + boost * 0.5))),
      throttleCount: d.intake.itb ? n : 1,
      itb: d.intake.itb,
      airbox: d.intake.airbox,
    },
    ecu: {},
    sound: {},
  };
  if (d.layout === 'rotary') {
    spec.kind = 'rotary';
    spec.chamberDisplacement = d.chamber;
    spec.stroke = 70;
    spec.valves = { inPortArea: 2.3 * d.chamber, exPortArea: 2 * d.chamber };
    // port timing: street / bridge / peripheral by cam choice
    spec.cam = [
      { in: [20, 50, 1], ex: [70, 44, 1] },
      { in: [24, 56, 1], ex: [74, 48, 1] },
      { in: [28, 62, 1], ex: [78, 50, 1] },
      { in: [40, 72, 1], ex: [84, 58, 1] },
      { in: [58, 80, 1], ex: [88, 70, 1] },
    ][camIdx];
  } else {
    spec.bore = d.bore;
    spec.stroke = d.stroke;
    spec.rod = Math.round(d.stroke * d.rodRatio);
    spec.valves = { ...vcfg, inDia: +vcfg.inDia.toFixed(1), exDia: +vcfg.exDia.toFixed(1) };
    spec.cam = camFrom(dur, lsa, lift);
    if (d.vtec) {
      const hi = CAMS[Math.min(CAMS.length - 1, camIdx + 2)];
      spec.camHigh = camFrom(hi[2], hi[3], 0.27 * vcfg.inDia * hi[4]);
      spec.camSwitchRpm = clamp(d.vtecRpm, 2500, red - 500);
    }
  }

  // exhaust sized from displacement and rpm
  const flow = L * (red / 6500) * (1 + boost * 0.6);
  const twinBank = banks.length === 2 && d.layout !== 'rotary';
  const pipe = Math.round(Math.min(102, 40 + 13 * Math.sqrt(flow / (twinBank && d.exhaust.merge !== 'y' ? 2 : 1))));
  const prim = Math.round(1.55 * Math.sqrt(perCylCC) * Math.pow(red / 6500, 0.2));
  const headers = { style: d.exhaust.headers, len: d.exhaust.len, dia: Math.min(64, prim) };
  if (d.exhaust.unequal && n > 1 && d.layout !== 'rotary') {
    headers.lens = Array.from({ length: n }, (_, i) => +(d.exhaust.len * (0.68 + 0.64 * mod(i * 0.618 + 0.13, 1))).toFixed(2));
  }
  spec.exhaust = {
    headers,
    cat: d.exhaust.cat,
    resonator: d.exhaust.resonator,
    midLen: 1.4,
    pipeDia: pipe,
    merge: twinBank ? d.exhaust.merge : undefined,
    muffler: d.exhaust.muffler,
    exit: d.exhaust.exit,
    tips: d.exhaust.tips,
    tailLen: 0.3,
    tailDia: Math.round(pipe * 1.1),
  };

  // induction
  const ind = d.induction;
  if (ind.type === 'turbo') spec.induction = { type: 'turbo', count: twinBank ? ind.count : 1, size: ind.size, boost: ind.boost, blades: ind.count > 1 ? 9 : 7, bov: ind.bov, screamer: ind.screamer };
  else if (ind.type === 'twinscrew') spec.induction = { type: 'twinscrew', displacement: +(L * 0.4).toFixed(2), ratio: ind.ratio, lobes: 5 };
  else if (ind.type === 'roots') spec.induction = { type: 'roots', displacement: +(L * 0.45).toFixed(2), ratio: ind.ratio, lobes: 3 };
  else if (ind.type === 'centrifugal') spec.induction = { type: 'centrifugal', boost: ind.boost, size: 1, blades: 10, bov: ind.bov };
  else spec.induction = { type: 'na' };

  // ECU
  const overlap = d.layout === 'rotary' ? camIdx * 8 : spec.cam.in[0] + spec.cam.ex[1];
  const idle = d.ecu.idle || Math.round((620 + 6 * Math.max(0, overlap - 20) + (n <= 2 ? 450 : n <= 4 ? 180 : 0) + (d.layout === 'rotary' ? 450 : 0)) / 50) * 50;
  spec.ecu = {
    idle: clamp(idle, 500, 2500),
    limit: red,
    limiter: d.ecu.limiter,
    afr: boosted ? 11.8 : 12.6,
    burble: d.ecu.burble,
    antilag: ind.type === 'turbo' && ind.antilag,
    launchRpm: Math.round((red * 0.5) / 100) * 100,
    octane: d.ecu.octane,
    floatRpm: d.layout === 'rotary' ? 40000 : Math.round(FLOAT_RPM[d.valvetrain] * (d.valves >= 4 ? 1 : 0.95)),
    startFlare: 500,
  };
  // flywheel and rotating mass
  const fly = d.flywheel === 'light' ? 0.6 : d.flywheel === 'heavy' ? 1.7 : 1;
  // crank + flywheel inertia: grows a little faster than displacement; racing
  // engines that rev high carry lighter rotating parts
  spec.inertia = +((0.04 * Math.pow(L, 1.15) * (1 + 0.5 / Math.max(1, n)) * Math.pow(Math.min(1, 8000 / red), 0.7) + 0.004) * fly).toFixed(3);
  spec.friction = d.valvetrain === 'pneumatic' ? 0.9 : d.layout === 'rotary' ? 1.1 : 1;
  spec.combustion = 0.72;
  spec.burnScale = d.layout === 'rotary' ? 1.25 : +Math.sqrt((d.bore ?? 90) / 90).toFixed(2);

  // car
  const car = CARS[d.car];
  spec.vehicle = { ...car, final: +(car.final * Math.max(0.7, red / 7000)).toFixed(2), drive: car.drive ?? d.drive };
  delete spec.vehicle.label;

  spec.sound = {
    exhaust: 1,
    intake: d.intake.itb ? 1.3 : 1.1,
    mech: d.valvetrain === 'ohv' ? 1.1 : d.valvetrain === 'pneumatic' ? 1 : 0.9,
    valvetrain: d.layout === 'rotary' ? 'none' : d.valvetrain === 'sohc' ? 'dohc' : d.valvetrain,
    gear: car.straightCut ? 0.8 : 0.3,
    trim: d.calib?.trim ?? estimateTrim(d, L, n),
  };

  // descriptions
  const indTxt = ind.type === 'na' ? 'naturally aspirated' : ind.type === 'turbo' ? (spec.induction.count > 1 ? 'twin-turbo' : 'turbo') : ind.type === 'centrifugal' ? 'centrifugal blower' : `${ind.type === 'roots' ? 'Roots' : 'twin-screw'} blower`;
  const shape = d.layout === 'rotary' ? `${d.cylinders}-rotor Wankel` : d.layout === 'v' ? `${d.bankAngle}° V${d.cylinders}` : d.layout === 'flat' ? `flat-${d.cylinders}` : `inline-${d.cylinders}`;
  const crank = d.layout === 'rotary' ? '' : ` · ${(d.layout === 'flat' && d.crank === 'boxer' ? 'boxer' : CRANK_LABEL[d.crank] ?? '').toLowerCase()}`;
  spec.tagline = `${L.toFixed(1)} L ${shape}${crank} · ${indTxt}`;
  spec.blurb = describeFiring(d, fire, banks);
  spec.listen = listenHint(d, fire, banks);
  return d.base ? applyBase(d, spec) : spec;
}

const FLY = { light: 0.6, stock: 1, heavy: 1.7 };
const pick = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const sameAs = (d, k, path) => JSON.stringify(pick(d, path)) === JSON.stringify(pick(k, path));

// An engine opened from the garage keeps its exact factory spec as a base:
// only what the builder has changed is regenerated, so an untouched engine
// sounds exactly like the original and every edit is incremental.
function applyBase(d, gen) {
  const k = d.base.snap;
  const same = (p) => sameAs(d, k, p);
  const spec = JSON.parse(JSON.stringify(d.base.spec));
  for (const f of ['id', 'name', 'custom', 'origin', 'family', 'tagline', 'blurb', 'listen']) spec[f] = gen[f];
  const core = ['layout', 'cylinders', 'bankAngle', 'crank', 'splitPin', 'pinOffset', 'order', 'chamber'].every(same);
  if (!core) {
    for (const f of ['kind', 'cylinders', 'firingAngles', 'firingOrder', 'banks', 'chamberDisplacement']) spec[f] = gen[f];
    delete spec.intervals;
    spec.exhaust = gen.exhaust;
    spec.intake = gen.intake;
  }
  const bore0 = spec.bore;
  if (!same('bore') || !same('stroke') || !same('rodRatio')) {
    spec.bore = gen.bore;
    spec.stroke = gen.stroke;
    spec.rod = gen.rod;
  }
  spec.compression = d.compression;
  if (!core || !same('valvetrain') || !same('valves')) spec.valves = gen.valves;
  else if (bore0 && spec.bore !== bore0 && spec.valves?.inDia) {
    const r = spec.bore / bore0;
    spec.valves = { ...spec.valves, inDia: +(spec.valves.inDia * r).toFixed(1), exDia: +(spec.valves.exDia * r).toFixed(1) };
  }
  if (!core || !same('cam') || !same('vtec') || !same('vtecRpm') || !same('valvetrain')) {
    spec.cam = gen.cam;
    if (gen.camHigh) {
      spec.camHigh = gen.camHigh;
      spec.camSwitchRpm = gen.camSwitchRpm;
    } else {
      delete spec.camHigh;
      delete spec.camSwitchRpm;
    }
  }
  if (!same('induction')) spec.induction = gen.induction;
  // intake
  const it = spec.intake ?? {};
  if (!same('intake.itb')) {
    for (const f of ['itb', 'throttleCount', 'throttleDia', 'plenum']) it[f] = gen.intake[f];
  }
  it.airbox = d.intake.airbox;
  it.runnerLen = d.intake.runnerLen;
  spec.intake = it;
  // exhaust: keep the factory pipe sizes, apply the choices
  if (core) {
    const ex = spec.exhaust;
    const h = { ...(ex.headers ?? {}) };
    if (!same('exhaust.len')) {
      if (h.lens && h.len) h.lens = h.lens.map((v) => +((v * d.exhaust.len) / h.len).toFixed(3));
      h.len = d.exhaust.len;
    }
    if (!same('exhaust.unequal')) {
      if (d.exhaust.unequal) h.lens = gen.exhaust.headers.lens;
      else delete h.lens;
    }
    h.style = d.exhaust.headers;
    ex.headers = h;
    for (const f of ['cat', 'resonator', 'muffler', 'exit', 'tips']) ex[f] = d.exhaust[f];
    if (ex.merge != null || gen.exhaust.merge != null) ex.merge = d.exhaust.merge;
  }
  // ECU: the springs stay those of the original engine
  const e0 = d.base.spec.ecu ?? {};
  const floatRpm = e0.floatRpm ?? ((d.base.spec.sound?.valvetrain === 'pneumatic' || d.base.spec.kind === 'rotary') ? 40000 : (e0.limit ?? 6500) * 1.07);
  spec.ecu = { ...spec.ecu, limit: d.ecu.limit, limiter: d.ecu.limiter, burble: d.ecu.burble, octane: d.ecu.octane, floatRpm: same('valvetrain') && same('valves') ? floatRpm : gen.ecu.floatRpm, antilag: gen.ecu.antilag };
  if (d.ecu.idle) spec.ecu.idle = d.ecu.idle;
  else if (!core || !same('cam')) spec.ecu.idle = gen.ecu.idle;
  // the factory knock calibration only holds for the factory combustion
  if (!(core && same('bore') && same('stroke') && same('compression') && same('induction') && same('cam'))) delete spec.ecu.knockCal;
  // rotating mass and the car
  const L0 = displacementL(k), L = displacementL(d);
  spec.inertia = +((spec.inertia ?? 0.2) * ((FLY[d.flywheel] ?? 1) / (FLY[k.flywheel] ?? 1)) * Math.pow(L / L0, 1.15)).toFixed(3);
  if (!same('car')) spec.vehicle = gen.vehicle;
  // loudness: measured if the virtual dyno has run, else the factory trim
  // while nothing that matters has changed
  spec.sound = { ...spec.sound, trim: d.calib?.trim ?? (core && same('induction') && same('exhaust') ? spec.sound?.trim : gen.sound.trim) };
  return spec;
}

// Rough loudness trim until the virtual dyno has measured the real one.
function estimateTrim(d, L, n) {
  let t = 0.9 / Math.sqrt(Math.max(0.5, L));
  if (d.induction.type === 'turbo') t *= 1.5;
  if (d.exhaust.muffler === 'none') t *= 0.45;
  else if (d.exhaust.muffler === 'stock') t *= 1.6;
  if (d.exhaust.cat) t *= 1.2;
  return +Math.min(3, Math.max(0.1, t * (n >= 8 ? 0.7 : 1))).toFixed(2);
}

export function describeFiring(d, fire, banks) {
  const iv = fire.intervals.map((v) => Math.round(v));
  const n = d.layout === 'rotary' ? d.cylinders * 3 : d.cylinders;
  if (d.layout === 'rotary') return `${d.cylinders} rotors, ${n} chambers: an exhaust port opens every ${iv[0]}° of the eccentric shaft. The peripheral exhaust port snaps open, which is where the rasp comes from.`;
  let s = fire.spread < 0.5 ? `Fires evenly every ${iv[0]}°` : `Fires ${fire.name.toLowerCase()} (${iv.join('-')}°)`;
  if (banks.length === 2) {
    const bi = bankIntervals(d, fire.angles, banks);
    const even = bi.every((b) => Math.max(...b) - Math.min(...b) < 1);
    s += even ? `, and each bank fires evenly too (${bi[0][0]}°).` : `, but each bank fires unevenly (${bi[0].join('-')}°): that is a burble.`;
  } else s += '.';
  if (n % 2 === 1 && n > 1) s += ` With ${n} cylinders the firing note sits at ${n / 2}× crank speed.`;
  return s;
}

function listenHint(d, fire, banks) {
  if (d.layout === 'rotary') return 'Idle it, then rev it to the limiter: brap at the bottom, shriek at the top.';
  if (fire.name === 'Big bang' || fire.name === 'Twin pulse') return 'The pulses arrive in bunches: listen to the lumpy, V-twin-like beat.';
  if (banks.length === 2) {
    const bi = bankIntervals(d, fire.angles, banks);
    if (!bi.every((b) => Math.max(...b) - Math.min(...b) < 1)) return 'Idle and listen to each bank\'s uneven beat; try 180° headers or an X-pipe to even it out.';
  }
  return 'Rev it slowly and listen to the firing frequency climb.';
}

// Numbers for the spec sheet.
export function derived(d) {
  const L = displacementL(d);
  const n = d.layout === 'rotary' ? d.cylinders * 3 : d.cylinders;
  const red = d.ecu.limit;
  const out = { L, cc: Math.round(L * 1000), ci: Math.round(L * 61.024), n };
  if (d.layout !== 'rotary') {
    out.boreStroke = d.bore / d.stroke;
    out.pistonSpeed = (2 * (d.stroke / 1000) * red) / 60;
    // primary length tuned for scavenging (hot-rodder's rule)
    const cam = CAMS.find((c) => c[0] === d.cam);
    const evo = Math.round(cam[3] + 4 + (cam[2] + 8) / 2 - 180);
    out.headerRpm = Math.round((850 * (180 + evo)) / (d.exhaust.len / 0.0254 + 3) / 50) * 50;
  }
  out.fireHz = (n / 2) * (red / 60) * (d.layout === 'rotary' ? 2 / 3 : 1);
  out.floatRpm = d.layout === 'rotary' ? Infinity : Math.round(FLOAT_RPM[d.valvetrain] * (d.valves >= 4 ? 1 : 0.95));
  return out;
}

// Build a design that approximates an existing spec (for "Open in builder").
export function specToDesign(spec) {
  const d = defaultDesign();
  d.name = spec.custom ? spec.name : `${spec.name} (edit)`;
  if (spec.custom && spec.design) return normalize({ ...spec.design });
  if (spec.kind === 'rotary') {
    d.layout = 'rotary';
    d.cylinders = spec.cylinders / 3;
    d.chamber = spec.chamberDisplacement;
    d.cam = 'race';
  } else {
    const nb = spec.banks?.length ?? 1;
    const n = spec.cylinders;
    d.layout = nb === 1 ? 'inline' : /^F/.test(spec.family) ? 'flat' : 'v';
    d.cylinders = n;
    d.bore = spec.bore;
    d.stroke = spec.stroke;
    d.rodRatio = spec.rod ? spec.rod / spec.stroke : 1.65;
    if (d.layout === 'v') {
      const m = /(\d+)°/.exec(spec.tagline ?? '');
      d.bankAngle = m ? +m[1] : n === 12 ? 60 : n === 10 ? 72 : n === 6 ? 60 : 90;
    }
    if (n === 8 && d.layout !== 'inline') d.crank = /flat/i.test(spec.tagline + spec.name) ? 'flat' : 'cross';
    if (d.layout === 'flat') d.crank = n === 12 ? Object.keys(THROWS[6])[0] : 'boxer';
    if (n === 4 && d.layout === 'inline') d.crank = 'flat';
    d.valves = (spec.valves?.inCount ?? 1) + (spec.valves?.exCount ?? 1);
    d.valvetrain = spec.sound?.valvetrain === 'ohv' ? 'ohv' : spec.sound?.valvetrain === 'pneumatic' ? 'pneumatic' : 'dohc';
    const durIn = (spec.cam?.in?.[0] ?? 15) + 180 + (spec.cam?.in?.[1] ?? 55);
    d.cam = CAMS.reduce((a, c) => (Math.abs(c[2] - durIn) < Math.abs(a[2] - durIn) ? c : a), CAMS[1])[0];
    if (spec.camHigh) {
      d.vtec = true;
      d.vtecRpm = spec.camSwitchRpm;
    }
  }
  d.compression = spec.compression;
  const ind = spec.induction ?? { type: 'na' };
  d.induction = { ...d.induction, type: ind.type, count: ind.count ?? 1, size: ind.size ?? 1, boost: ind.boost ?? 1, screamer: !!ind.screamer, ratio: ind.ratio ?? 2.4, bov: ind.bov ?? 'atm', antilag: !!spec.ecu?.antilag };
  d.intake = { airbox: spec.intake?.airbox ?? 'stock', itb: !!spec.intake?.itb, runnerLen: spec.intake?.runnerLen ?? 0.32 };
  const ex = spec.exhaust ?? {};
  d.exhaust = {
    headers: ex.headers?.style ?? 'n-1',
    len: ex.headers?.len ?? 0.7,
    unequal: !!ex.headers?.lens && !ex.headers?.equalize,
    merge: ex.merge ?? 'dual',
    cat: !!ex.cat,
    resonator: !!ex.resonator,
    muffler: ex.muffler ?? 'sport',
    exit: ex.exit ?? 'rear',
    tips: ex.tips ?? 2,
  };
  d.ecu = { idle: spec.ecu?.idle ?? 0, limit: spec.ecu?.limit ?? 7000, limiter: spec.ecu?.limiter ?? 'fuel', burble: spec.ecu?.burble ?? 0.2, octane: spec.ecu?.octane ?? 98 };
  const v = spec.vehicle ?? {};
  d.car = v.straightCut ? 'race' : v.layout === 'mid' ? 'super' : v.drive === 'awd' ? 'hatch' : (v.mass ?? 1500) > 1700 ? 'gt' : 'coupe';
  // try to keep the original firing order
  const nd = normalize(d);
  const want = (spec.firingOrder ?? []).join();
  const opt = firingOptions(nd, 64).find((o) => o.order.join() === want);
  if (opt) nd.order = opt.order.slice();
  // remember the exact original so untouched parts stay factory
  const base = JSON.parse(JSON.stringify(spec));
  for (const f of ['design', 'custom']) delete base[f];
  const snap = JSON.parse(JSON.stringify(nd));
  delete snap.base;
  delete snap.calib;
  nd.base = { spec: base, snap };
  return nd;
}

// ---------------------------------------------------------------------------
// My garage (browser storage)
// ---------------------------------------------------------------------------

const KEY = 'firing-order.builds';

export function loadBuilds() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveBuilds(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function buildSpecs() {
  return loadBuilds().map((d) => {
    const s = designToSpec(d);
    s.design = d;
    return s;
  });
}
