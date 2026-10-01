// Compiles a human-readable engine spec (see presets.js) into the flat numeric
// description that the audio worklet simulates: geometry tables, valve flow-area
// tables, firing offsets and the intake / exhaust pipe networks.

export const TAB_N = 2048;

// Node types understood by the worklet's pipe network.
export const NODE = {
  JUNCTION: 0,
  PORT: 1,
  OPEN: 2,
  CLOSED: 3,
  RESISTOR: 4,
  PLENUM: 5,
};

// Dynamic resistor roles (their resistance is driven by the simulation).
export const DYN = {
  NONE: 0,
  TURBINE: 1,
  WASTEGATE: 2,
  VALVE: 3, // exhaust bypass valve (sport / race mode)
};

// Output channels for radiating open ends.
export const CH = { EX_L: 0, EX_R: 1, INTAKE: 2 };

const mm = (x) => x / 1000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------------------
// Pipe network builder
// ---------------------------------------------------------------------------

export class PipeNet {
  constructor() {
    this.nodes = [];
    this.segs = [];
  }
  node(type, props = {}) {
    const n = { id: this.nodes.length, type, ends: [], x: 0.5, y: 0.5, ...props };
    this.nodes.push(n);
    return n.id;
  }
  junction(x, y, props = {}) {
    return this.node(NODE.JUNCTION, { x, y, ...props });
  }
  // A pipe from node a to node b. len/dia in metres. temp = fraction of the
  // exhaust-gas temperature rise this section sees (1 = right at the port).
  pipe(a, b, { len, dia, temp = 1, hf = 0.05, g = 0.985, nl = 0, pts = null, label = '' }) {
    const id = this.segs.length;
    this.segs.push({ id, a, b, len: Math.max(len, 0.03), dia, temp, hf, g, nl, pts, label });
    this.nodes[a].ends.push(2 * id);
    this.nodes[b].ends.push(2 * id + 1);
    return id;
  }
  pt(id) {
    const n = this.nodes[id];
    return [n.x, n.y];
  }
}

// Polyline helper: from node a to node b with an elbow.
function elbow(net, a, b, mode = 'hv') {
  const [x0, y0] = net.pt(a);
  const [x1, y1] = net.pt(b);
  if (mode === 'vh') return [[x0, y0], [x0, y1], [x1, y1]];
  if (mode === 'straight') return [[x0, y0], [x1, y1]];
  if (mode === 'drop') {
    const ym = y0 + (y1 - y0) * 0.45;
    return [[x0, y0], [x0, ym], [x1, y1]];
  }
  return [[x0, y0], [x1, y0], [x1, y1]];
}

// ---------------------------------------------------------------------------
// Muffler / component sub-networks. Each takes an inlet node and returns the
// outlet node; x0..x1 is the horizontal span it occupies in the schematic.
// ---------------------------------------------------------------------------

function component(net, inNode, kind, dia, x0, x1, y, opts = {}) {
  const temp = opts.temp ?? 0.55;
  const span = x1 - x0;
  const mid = (f) => x0 + span * f;
  const box = { kind, x0, x1, y };
  (net.boxes ??= []).push(box);
  let n = inNode;
  const chain = (parts) => {
    // parts: [{len, dia, hf, g, frac}] -> sequential segments with junctions
    let acc = 0;
    const total = parts.reduce((s, p) => s + p.frac, 0);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      acc += p.frac / total;
      const nx = i === parts.length - 1 && opts.out != null ? opts.out : net.junction(mid(acc), y);
      net.pipe(n, nx, {
        len: p.len,
        dia: p.dia,
        temp,
        hf: p.hf ?? 0.05,
        g: p.g ?? 0.999,
        pts: [net.pt(n), net.pt(nx)],
        label: kind,
      });
      n = nx;
    }
    return n;
  };
  switch (kind) {
    case 'straight':
      return chain([{ len: opts.len ?? 0.5, dia, frac: 1 }]);
    case 'cat':
      // Catalytic converter: widened ceramic brick, viscous HF loss.
      return chain([{ len: 0.34, dia: dia * 1.4, frac: 1, hf: 0.4, g: 0.955 }]);
    case 'resonator':
      return chain([{ len: 0.45, dia: dia * 1.1, frac: 1, hf: 0.34, g: 0.975 }]);
    case 'glasspack':
      // Perforated core wrapped in fibreglass: absorbs highs, passes the lows.
      return chain([{ len: 0.52, dia: dia * 1.15, frac: 1, hf: 0.55, g: 0.95 }]);
    case 'sport':
      // Straight-through perforated core with packing: loud, some damping.
      return chain([{ len: 0.5, dia: dia * 1.06, frac: 1, hf: 0.44, g: 0.965 }]);
    case 'chambered':
      // Two-chamber reactive muffler (baffles): tonal, aggressive.
      return chain([
        { len: 0.15, dia: dia * 2.0, frac: 0.38, hf: 0.2, g: 0.98 },
        { len: 0.08, dia: dia * 0.9, frac: 0.2, hf: 0.1 },
        { len: 0.19, dia: dia * 2.0, frac: 0.42, hf: 0.28, g: 0.975 },
      ]);
    case 'stock': {
      // Road muffler: reactive chambers + packing + flow restriction.
      n = chain([
        { len: 0.22, dia: dia * 2.6, frac: 0.4, hf: 0.5, g: 0.96 },
        { len: 0.14, dia: dia * 0.75, frac: 0.2, hf: 0.2 },
        { len: 0.26, dia: dia * 2.6, frac: 0.4, hf: 0.58, g: 0.96 },
      ]);
      const r = net.node(NODE.RESISTOR, { x: mid(0.96), y, R: 0, K: opts.K ?? 900 / (dia * dia * 1e3), dyn: DYN.NONE });
      net.pipe(n, r, { len: 0.04, dia: dia * 0.9, temp, pts: [net.pt(n), net.pt(r)] });
      const o = opts.out ?? net.junction(x1, y);
      net.pipe(r, o, { len: 0.06, dia, temp, pts: [net.pt(r), net.pt(o)] });
      return o;
    }
    case 'valved': {
      // Modern supercar silencer: a straight perforated core behind a flap
      // valve, plus an always-open narrow, heavily damped side path. Valve shut
      // -> sound squeezes through the lossy route; open -> straight through.
      const out = opts.out ?? net.junction(x1, y);
      const merge = net.junction(mid(0.9), y);
      const v = net.node(NODE.RESISTOR, { x: mid(0.55), y, R: 0, K: 0, dyn: DYN.VALVE, closedK: 4e7 });
      net.pipe(n, v, { len: 0.3, dia, temp, hf: 0.3, g: 0.975, pts: [net.pt(n), net.pt(v)], label: 'core' });
      net.pipe(v, merge, { len: 0.16, dia, temp, hf: 0.3, g: 0.975, pts: [net.pt(v), net.pt(merge)], label: 'core' });
      const yb = y + (opts.bypassDy ?? 0.07);
      net.pipe(n, merge, {
        len: 0.62,
        dia: dia * 0.58,
        temp,
        hf: 0.62,
        g: 0.9,
        pts: [net.pt(n), [mid(0.1), yb], [mid(0.8), yb], net.pt(merge)],
        label: 'muffler',
      });
      net.pipe(merge, out, { len: 0.05, dia, temp, pts: [net.pt(merge), net.pt(out)] });
      box.valve = true;
      return out;
    }
    default:
      throw new Error('unknown component ' + kind);
  }
}

// Add a radiating tail pipe. ch: 0 = left, 1 = right, 2 = centre. Several
// tips on one side are acoustically one pipe; they are only drawn separately.
function tails(net, inNode, { tips = 1, len = 0.5, dia = 0.07, ch = 0, x1 = 0.985, temp = 0.4, side = 0 }) {
  const [x0, y0] = net.pt(inNode);
  const area = tips * Math.pow(tips > 1 ? dia * 0.8 : dia, 2);
  const d = Math.sqrt(area);
  // side pipes turn out through the sill (up = left side, down = right side)
  const end = side ? [x0 + 0.03, side < 0 ? 0.03 : 0.97] : [x1, y0];
  const o = net.node(NODE.OPEN, { x: end[0], y: end[1], ch, radius: d / 2, tips, dir: side < 0 ? 'up' : side > 0 ? 'down' : 'right' });
  const pts = side ? [[x0, y0], [end[0], y0], end] : [[x0, y0], end];
  net.pipe(inNode, o, { len: len + 0.6 * d / 2, dia: d, temp, pts, label: 'tail' });
  return [o];
}

// ---------------------------------------------------------------------------
// Exhaust layouts
// ---------------------------------------------------------------------------

// Cylinder schematic positions, shared by the renderer.
function cylinderLayout(spec) {
  const banks = spec.banks ?? [spec.firingOrder.slice().sort((a, b) => a - b)];
  const pos = new Array(spec.cylinders);
  const nb = banks.length;
  const maxPerBank = Math.max(...banks.map((b) => b.length));
  const x0 = 0.05;
  const pitch = Math.min(0.075, 0.36 / Math.max(maxPerBank - 1, 1));
  banks.forEach((bank, bi) => {
    const sorted = bank.slice().sort((a, b) => a - b);
    sorted.forEach((cyl, k) => {
      const top = nb === 1 || bi === 0;
      pos[cyl - 1] = {
        bank: bi,
        x: x0 + k * pitch + (nb > 1 && bi === 1 ? pitch * 0.25 : 0),
        y: top ? 0.14 : 0.86,
        portY: top ? 0.24 : 0.76,
        up: top, // piston drawn pointing up (bank A) or down (bank B)
      };
    });
  });
  return { pos, banks, pitch };
}

function bankHeaders(net, spec, lay, bank, bi, ex, collectorXY) {
  const [cx, cy] = collectorXY;
  const coll = net.junction(cx, cy, { collector: true });
  const style = ex.headers?.style ?? 'n-1';
  const dia = mm(ex.headers?.dia ?? 42);
  const baseLen = ex.headers?.len ?? 0.75;
  const lens = ex.headers?.lens;
  const cyls = bank.slice();
  const ports = cyls.map((cyl) => {
    const p = lay.pos[cyl - 1];
    return net.node(NODE.PORT, { cyls: [cyl - 1], x: p.x, y: p.portY });
  });
  const primLen = (i) => (lens ? lens[cyls[i] - 1] ?? baseLen : baseLen);
  if (style === 'tri-y' && cyls.length >= 4) {
    // Pair cylinders that fire far apart, merge pairs, then merge to one.
    const half = Math.ceil(cyls.length / 2);
    const groups = [ports.slice(0, half), ports.slice(half)];
    const gy = cy + (lay.pos[cyls[0] - 1].up ? -0.05 : 0.05);
    const mids = groups.map((g, gi) => {
      const gx = cx - 0.16 + gi * 0.07;
      const j = net.junction(gx, gy);
      g.forEach((pn, k) => {
        const i = ports.indexOf(pn);
        net.pipe(pn, j, { len: primLen(i) * 0.6, dia, temp: 1, pts: elbow(net, pn, j, 'drop'), label: 'primary' });
      });
      return j;
    });
    mids.forEach((j) => {
      net.pipe(j, coll, { len: baseLen * 0.4, dia: dia * 1.3, temp: 0.95, pts: elbow(net, j, coll, 'straight'), label: 'secondary' });
    });
  } else if (style === 'log') {
    // Cast log manifold: short runners into a common log.
    let prev = null;
    const logY = lay.pos[cyls[0] - 1].up ? lay.pos[cyls[0] - 1].portY + 0.05 : lay.pos[cyls[0] - 1].portY - 0.05;
    const order = cyls.map((c, i) => i).sort((a, b) => lay.pos[cyls[a] - 1].x - lay.pos[cyls[b] - 1].x);
    for (const i of order) {
      const pn = ports[i];
      const [px] = net.pt(pn);
      const j = net.junction(px, logY);
      net.pipe(pn, j, { len: primLen(i), dia, temp: 1, pts: elbow(net, pn, j, 'straight'), label: 'primary' });
      if (prev != null) {
        net.pipe(prev, j, { len: Math.abs(px - net.pt(prev)[0]) * 1.6 + 0.05, dia: dia * 1.35, temp: 1, pts: elbow(net, prev, j, 'straight'), label: 'log' });
      }
      prev = j;
    }
    net.pipe(prev, coll, { len: 0.15, dia: dia * 1.35, temp: 1, pts: elbow(net, prev, coll, 'vh'), label: 'log' });
  } else {
    ports.forEach((pn, i) => {
      net.pipe(pn, coll, { len: primLen(i), dia, temp: 1, nl: 1, pts: elbow(net, pn, coll, 'drop'), label: 'primary' });
    });
  }
  return coll;
}

// Turbine stage: housing volume + turbine resistor, with a wastegate branch.
// Returns outlet node.
function turbine(net, inNode, x, y, t, idx) {
  const house = net.junction(x, y, { turbo: idx });
  const [ix, iy] = net.pt(inNode);
  net.pipe(inNode, house, { len: 0.12, dia: mm(t.housingDia ?? 75), temp: 1, pts: [[ix, iy], [x, y]], label: 'turbine housing' });
  const r = net.node(NODE.RESISTOR, { x: x + 0.035, y, R: 0, K: t.K, dyn: DYN.TURBINE, turbo: idx });
  net.pipe(house, r, { len: 0.06, dia: mm(t.housingDia ?? 75) * 0.8, temp: 1, pts: [[x, y], [x + 0.035, y]], label: 'turbine' });
  const out = net.junction(x + 0.075, y);
  net.pipe(r, out, { len: 0.08, dia: mm(t.downpipeDia ?? 76), temp: 0.85, pts: [[x + 0.035, y], [x + 0.075, y]], label: 'turbine' });
  // wastegate branch
  const wy = y + (y < 0.5 ? -0.07 : 0.07);
  const w = net.node(NODE.RESISTOR, { x: x + 0.035, y: wy, R: 0, K: 0, dyn: DYN.WASTEGATE, turbo: idx, closedK: 3e8 });
  net.pipe(house, w, { len: 0.1, dia: mm(38), temp: 1, pts: [[x, y], [x, wy], [x + 0.035, wy]], label: 'wastegate' });
  if (t.screamer) {
    // Screamer pipe: the wastegate dumps straight to the air through its own
    // short pipe instead of rejoining the exhaust.
    const up = y < 0.5;
    const so = net.node(NODE.OPEN, { x: x + 0.06, y: up ? 0.03 : 0.97, ch: 6, radius: mm(19), tips: 1, dir: up ? 'up' : 'down' });
    net.pipe(w, so, { len: 0.5, dia: mm(38), temp: 0.95, pts: [[x + 0.035, wy], [x + 0.06, wy], [x + 0.06, up ? 0.03 : 0.97]], label: 'screamer' });
  } else {
    net.pipe(w, out, { len: 0.1, dia: mm(38), temp: 0.9, pts: [[x + 0.035, wy], [x + 0.075, wy], [x + 0.075, y]], label: 'wastegate' });
  }
  return out;
}

function buildExhaust(spec) {
  const net = new PipeNet();
  const ex = spec.exhaust;
  const lay = cylinderLayout(spec);
  const turbo = spec.induction?.type === 'turbo';
  const nTurbo = turbo ? spec.induction.count ?? 1 : 0;
  const muff = ex.muffler ?? 'sport';
  const midDia = mm(ex.pipeDia ?? 63);
  const tailDia = mm(ex.tailDia ?? ex.pipeDia ?? 63);
  const midLen = ex.midLen ?? 1.2;
  const tailLen = ex.tailLen ?? 0.4;
  const dual = lay.banks.length > 1 && ex.merge !== 'single';
  const tips = ex.tips ?? (dual ? 2 : 1);
  const tipsPerSide = dual ? Math.max(1, Math.round(tips / 2)) : tips;

  if (spec.kind === 'rotary') {
    // Each rotor has one peripheral exhaust port shared by its three faces.
    const coll = net.junction(0.42, 0.5, { collector: true });
    const nr = spec.cylinders / 3;
    const pitch = Math.min(0.14, 0.3 / Math.max(1, nr - 1));
    for (let r = 0; r < nr; r++) {
      const cyls = [r * 3, r * 3 + 1, r * 3 + 2];
      const p = net.node(NODE.PORT, { cyls, x: 0.12 + r * pitch, y: 0.3 });
      net.pipe(p, coll, { len: ex.headers?.len ?? 0.55, dia: mm(ex.headers?.dia ?? 50), temp: 1, nl: 1, pts: elbow(net, p, coll, 'drop'), label: 'primary' });
    }
    buildSingleTail(net, spec, coll, 0.5);
    return finishNet(net, lay);
  }

  if (!dual) {
    // Inline / single collector.
    let coll;
    if (lay.banks.length > 1) {
      // Two banks merged straight away (e.g. V-twin 2-into-1).
      const c = net.junction(0.42, 0.5, { collector: true });
      lay.banks.forEach((bank, bi) => {
        bank.forEach((cyl) => {
          const p = lay.pos[cyl - 1];
          const pn = net.node(NODE.PORT, { cyls: [cyl - 1], x: p.x, y: p.portY });
          const L = ex.headers?.lens?.[cyl - 1] ?? ex.headers?.len ?? 0.8;
          net.pipe(pn, c, { len: L, dia: mm(ex.headers?.dia ?? 45), temp: 1, nl: 1, pts: elbow(net, pn, c, 'drop'), label: 'primary' });
        });
      });
      coll = c;
    } else if (ex.headers?.style === '4-2-1' && spec.cylinders === 4) {
      coll = headers421(net, spec, lay, ex);
    } else {
      coll = bankHeaders(net, spec, lay, lay.banks[0], 0, ex, [0.36, 0.52]);
    }
    let n = coll;
    if (turbo) n = turbine(net, n, 0.46, 0.52, spec.induction, 0);
    buildSingleTail(net, spec, n, 0.52);
    return finishNet(net, lay);
  }

  // Dual bank (V / boxer). With 180-degree headers the cylinders are regrouped
  // across the banks so each collector sees evenly spaced pulses (the Ford
  // GT40 'bundle of snakes').
  const groups = ex.headers?.style === '180' ? evenGroups(spec) : lay.banks;
  const sides = groups.map((bank, bi) => {
    const y = bi === 0 ? 0.36 : 0.64;
    let n = bankHeaders(net, spec, lay, bank, bi, ex, [0.36, y]);
    if (turbo && nTurbo >= 2) n = turbine(net, n, 0.44, y, spec.induction, bi);
    return { n, y };
  });
  if (turbo && nTurbo === 1) {
    // Both banks into one turbine (e.g. hot-V single turbo) - rare; merge first.
    const m = net.junction(0.44, 0.5);
    sides.forEach((s) => net.pipe(s.n, m, { len: 0.3, dia: mm(55), temp: 1, pts: elbow(net, s.n, m, 'hv') }));
    const t = turbine(net, m, 0.48, 0.5, spec.induction, 0);
    buildSingleTail(net, spec, t, 0.5);
    return finishNet(net, lay);
  }

  const side = ex.exit === 'side';
  const merge = side ? 'dual' : ex.merge ?? 'dual';
  // cats and resonators in each bank's pipe, squeezed to fit before the crossover
  const inline = [ex.cat && ['cat', 0.85], ex.resonator && ['resonator', 0.75]].filter(Boolean);
  const xoverW = merge === 'x' ? 0.08 : merge === 'h' ? 0.03 : 0;
  let x = turbo ? 0.53 : 0.4;
  if (inline.length) {
    const w = Math.max(0.045, Math.min(0.11, (0.56 - x - 0.02) / inline.length - 0.01));
    for (const [kind, temp] of inline) {
      sides.forEach((s) => (s.n = component(net, s.n, kind, midDia, x + 0.01, x + 0.01 + w, s.y, { temp })));
      x += w + 0.01;
    }
  }

  if (side) {
    // Side pipes: a short run to a side silencer, then out under the doors.
    sides.forEach((s, i) => {
      const j = net.junction(x + 0.04, s.y);
      net.pipe(s.n, j, { len: Math.min(midLen, 0.45), dia: midDia, temp: 0.7, pts: elbow(net, s.n, j, 'straight'), label: 'mid' });
      let n = j;
      if (muff !== 'none') n = component(net, n, muff, midDia, x + 0.05, x + 0.2, s.y, { temp: 0.6 });
      tails(net, n, { tips: tipsPerSide, len: 0.12, dia: tailDia, ch: i === 0 ? 0 : 1, side: i === 0 ? -1 : 1, temp: 0.5 });
    });
    return finishNet(net, lay);
  }

  if (merge === 'y' || merge === 'y-dual') {
    // Both banks merge into a single pipe (maybe split again at the back).
    const xm0 = Math.max(0.6, x + 0.04);
    const m = net.junction(xm0, 0.5);
    sides.forEach((s, i) => {
      net.pipe(s.n, m, { len: midLen * 0.6 + (i ? ex.asym ?? 0.18 : 0), dia: midDia, temp: 0.75, pts: elbow(net, s.n, m, 'hv'), label: 'mid' });
    });
    let n = m;
    const mf = net.junction(Math.max(0.68, xm0 + 0.05), 0.5);
    net.pipe(n, mf, { len: midLen * 0.4, dia: midDia * 1.25, temp: 0.65, pts: [net.pt(n), net.pt(mf)], label: 'mid' });
    n = mf;
    const mx = net.pt(mf)[0];
    if (merge === 'y-dual') {
      // single muffler box feeding both sides
      n = component(net, n, muff === 'none' ? 'straight' : muff, midDia * 1.25, mx + 0.01, 0.86, 0.5, { temp: 0.55 });
      const yl = 0.4, yr = 0.6;
      const jl = net.junction(0.9, yl), jr = net.junction(0.9, yr);
      net.pipe(n, jl, { len: 0.25, dia: tailDia, temp: 0.45, pts: [net.pt(n), [0.88, 0.5], [0.88, yl], [0.9, yl]] });
      net.pipe(n, jr, { len: 0.25, dia: tailDia, temp: 0.45, pts: [net.pt(n), [0.88, 0.5], [0.88, yr], [0.9, yr]] });
      tails(net, jl, { tips: tipsPerSide, len: tailLen, dia: tailDia, ch: 0 });
      tails(net, jr, { tips: tipsPerSide, len: tailLen, dia: tailDia, ch: 1 });
    } else {
      if (muff !== 'none') n = component(net, n, muff, midDia * 1.25, mx + 0.01, 0.88, 0.5, { temp: 0.55 });
      tails(net, n, { tips, len: tailLen, dia: tailDia, ch: 2 });
    }
    return finishNet(net, lay);
  }

  // Mid pipes with optional crossover
  const xc = Math.max(0.56, x + 0.03);
  const cx = sides.map((s, i) => {
    const j = net.junction(xc, s.y);
    // the second bank's pipe is routed a little longer, as under a real car
    net.pipe(s.n, j, { len: midLen * 0.5 + (i ? ex.asym ?? 0.18 : 0), dia: midDia, temp: 0.75, pts: elbow(net, s.n, j, 'straight'), label: 'mid' });
    return j;
  });
  if (merge === 'x') {
    // X-pipe: both pipes pinch into a shared merge and split again.
    const xm = net.junction(xc + 0.04, 0.5, { crossover: true });
    const o = sides.map((s) => net.junction(xc + 0.08, s.y));
    cx.forEach((j) => net.pipe(j, xm, { len: 0.22, dia: midDia, temp: 0.72, pts: elbow(net, j, xm, 'straight'), label: 'x-pipe' }));
    o.forEach((j) => net.pipe(xm, j, { len: 0.22, dia: midDia, temp: 0.72, pts: elbow(net, xm, j, 'straight'), label: 'x-pipe' }));
    sides.forEach((s, i) => (s.n = o[i]));
  } else if (merge === 'h') {
    net.pipe(cx[0], cx[1], { len: 0.28, dia: midDia * 0.85, temp: 0.72, pts: elbow(net, cx[0], cx[1], 'straight'), label: 'h-pipe' });
    sides.forEach((s, i) => (s.n = cx[i]));
  } else {
    sides.forEach((s, i) => (s.n = cx[i]));
  }
  const xmid = Math.max(0.66, xc + xoverW + 0.02);
  sides.forEach((s, i) => {
    const j = net.junction(xmid, s.y);
    net.pipe(s.n, j, { len: midLen * 0.5, dia: midDia, temp: 0.65, pts: elbow(net, s.n, j, 'straight'), label: 'mid' });
    let n = j;
    if (muff !== 'none') {
      n = component(net, n, muff, midDia, xmid + 0.01, 0.86, s.y, { temp: 0.55, bypassDy: i === 0 ? -0.07 : 0.07 });
    }
    tails(net, n, { tips: tipsPerSide, len: tailLen, dia: tailDia, ch: i === 0 ? 0 : 1 });
  });
  return finishNet(net, lay);
}

// Split the cylinders into two collectors that each fire at even intervals:
// alternate cylinders in firing order.
function evenGroups(spec) {
  const ang = firingAngles(spec);
  const order = ang.map((a, i) => [a, i + 1]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  return [order.filter((_, k) => k % 2 === 0), order.filter((_, k) => k % 2 === 1)];
}

function headers421(net, spec, lay, ex) {
  // 4-2-1: pair cylinders 180 deg apart in the firing order (1&4, 2&3).
  const dia = mm(ex.headers?.dia ?? 42);
  const len = ex.headers?.len ?? 0.75;
  const coll = net.junction(0.38, 0.52, { collector: true });
  const pairs = [[1, 4], [2, 3]];
  pairs.forEach((pair, pi) => {
    const j = net.junction(0.2 + pi * 0.08, 0.42);
    pair.forEach((cyl) => {
      const p = lay.pos[cyl - 1];
      const pn = net.node(NODE.PORT, { cyls: [cyl - 1], x: p.x, y: p.portY });
      net.pipe(pn, j, { len: len * 0.55, dia, temp: 1, nl: 1, pts: elbow(net, pn, j, 'drop'), label: 'primary' });
    });
    net.pipe(j, coll, { len: len * 0.45, dia: dia * 1.25, temp: 0.95, pts: elbow(net, j, coll, 'straight'), label: 'secondary' });
  });
  return coll;
}

function buildSingleTail(net, spec, n, y) {
  const ex = spec.exhaust;
  const midDia = mm(ex.pipeDia ?? 63);
  const tailDia = mm(ex.tailDia ?? ex.pipeDia ?? 63);
  const muff = ex.muffler ?? 'sport';
  const [x0] = net.pt(n);
  let x = Math.max(x0 + 0.03, 0.46);
  if (ex.cat) {
    n = component(net, n, 'cat', midDia, x, x + 0.1, y, { temp: 0.85 });
    x += 0.11;
  }
  if (ex.resonator) n = component(net, n, 'resonator', midDia, x, Math.min(x + 0.08, 0.64), y, { temp: 0.75 });
  if (ex.exit === 'side') {
    // one side pipe on the right: short run to the silencer, out under the door
    const [xs] = net.pt(n);
    const j = net.junction(xs + 0.04, y);
    net.pipe(n, j, { len: Math.min(ex.midLen ?? 1.2, 0.5), dia: midDia, temp: 0.7, pts: [net.pt(n), [xs + 0.04, y]], label: 'mid' });
    n = j;
    if (muff !== 'none') n = component(net, n, muff, midDia, xs + 0.05, xs + 0.2, y, { temp: 0.6 });
    tails(net, n, { tips: 1, len: 0.12, dia: tailDia, ch: 1, side: 1, temp: 0.5 });
    return;
  }
  const j1 = net.junction(0.66, y);
  net.pipe(n, j1, { len: ex.midLen ?? 1.2, dia: midDia, temp: 0.7, pts: [net.pt(n), [0.66, y]], label: 'mid' });
  n = j1;
  if (muff !== 'none') n = component(net, n, muff, midDia, 0.67, 0.86, y, { temp: 0.55 });
  const tips = ex.tips ?? 1;
  if (tips >= 2 && ex.splitTips !== false) {
    // Split into left/right tips (stereo).
    const yl = y - 0.1, yr = y + 0.1;
    const jl = net.junction(0.9, yl), jr = net.junction(0.9, yr);
    net.pipe(n, jl, { len: 0.3, dia: tailDia * 0.85, temp: 0.45, pts: [net.pt(n), [0.88, y], [0.88, yl], [0.9, yl]] });
    net.pipe(n, jr, { len: 0.3, dia: tailDia * 0.85, temp: 0.45, pts: [net.pt(n), [0.88, y], [0.88, yr], [0.9, yr]] });
    const per = Math.max(1, Math.round(tips / 2));
    tails(net, jl, { tips: per, len: ex.tailLen ?? 0.35, dia: tailDia * 0.85, ch: 0 });
    tails(net, jr, { tips: per, len: ex.tailLen ?? 0.35, dia: tailDia * 0.85, ch: 1 });
  } else {
    tails(net, n, { tips: 1, len: ex.tailLen ?? 0.4, dia: tailDia, ch: 2 });
  }
}

function finishNet(net, lay) {
  net.layout = lay;
  return net;
}

// Intake: one runner per cylinder (per rotor for rotaries) into a plenum.
function buildIntake(spec) {
  const net = new PipeNet();
  const it = spec.intake ?? {};
  const lay = cylinderLayout(spec);
  const plenum = net.node(NODE.PLENUM, { x: 0.25, y: 0.5 });
  const dia = mm(it.runnerDia ?? 45);
  const len = it.runnerLen ?? 0.3;
  if (spec.kind === 'rotary') {
    const nr = spec.cylinders / 3;
    const pitch = Math.min(0.14, 0.3 / Math.max(1, nr - 1));
    for (let r = 0; r < nr; r++) {
      const p = net.node(NODE.PORT, { cyls: [r * 3, r * 3 + 1, r * 3 + 2], x: 0.12 + r * pitch, y: 0.1 });
      net.pipe(p, plenum, { len, dia, temp: 0, hf: 0.15, g: 0.965, pts: [net.pt(p), net.pt(plenum)] });
    }
  } else {
    for (let c = 0; c < spec.cylinders; c++) {
      const p = lay.pos[c];
      const pn = net.node(NODE.PORT, { cyls: [c], x: p.x, y: p.up ? 0.04 : 0.96 });
      net.pipe(pn, plenum, { len, dia, temp: 0, hf: 0.15, g: 0.965, pts: [net.pt(pn), net.pt(plenum)] });
    }
  }
  net.layout = lay;
  return net;
}

// ---------------------------------------------------------------------------
// Flatten a PipeNet into typed arrays for the worklet.
// ---------------------------------------------------------------------------

function flattenNet(net) {
  const S = net.segs.length;
  const N = net.nodes.length;
  const segLen = new Float64Array(S);
  const segDia = new Float64Array(S);
  const segTemp = new Float64Array(S);
  const segHf = new Float64Array(S);
  const segG = new Float64Array(S);
  const segNl = new Uint8Array(S);
  net.segs.forEach((s, i) => {
    segLen[i] = s.len;
    segDia[i] = s.dia;
    segTemp[i] = s.temp;
    segHf[i] = s.hf;
    segG[i] = s.g;
    segNl[i] = s.nl;
  });
  const nodeType = new Uint8Array(N);
  const nodeEndStart = new Int32Array(N);
  const nodeEndCount = new Int32Array(N);
  const ends = [];
  const nodeP = new Float64Array(N * 4); // generic params
  const nodeCyls = []; // per node list of cylinders (ports)
  net.nodes.forEach((n, i) => {
    nodeType[i] = n.type;
    nodeEndStart[i] = ends.length;
    nodeEndCount[i] = n.ends.length;
    ends.push(...n.ends);
    switch (n.type) {
      case NODE.OPEN:
        nodeP[i * 4] = n.ch;
        nodeP[i * 4 + 1] = n.radius;
        break;
      case NODE.RESISTOR:
        nodeP[i * 4] = n.R ?? 0;
        nodeP[i * 4 + 1] = n.K ?? 0;
        nodeP[i * 4 + 2] = n.dyn ?? 0;
        nodeP[i * 4 + 3] = n.dyn === DYN.TURBINE || n.dyn === DYN.WASTEGATE ? n.turbo ?? 0 : n.closedK ?? 0;
        break;
      case NODE.JUNCTION:
        nodeP[i * 4] = n.collector ? 1 : 0;
        break;
    }
    nodeCyls.push(n.type === NODE.PORT ? n.cyls : null);
  });
  // Afterfire injection node for each cylinder: the node at the far end of its
  // port's pipe.
  return {
    S,
    N,
    segLen,
    segDia,
    segTemp,
    segHf,
    segG,
    segNl,
    nodeType,
    nodeEndStart,
    nodeEndCount,
    ends: Int32Array.from(ends),
    nodeP,
    nodeCyls,
    closedK: net.nodes.map((n) => n.closedK ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Geometry / valve tables
// ---------------------------------------------------------------------------

function camLift(u, shape) {
  if (u <= 0 || u >= 1) return 0;
  if (shape === 'port') {
    const r = 0.14;
    const s = (t) => t * t * (3 - 2 * t);
    if (u < r) return s(u / r);
    if (u > 1 - r) return s((1 - u) / r);
    return 1;
  }
  // Real lobes open and close on a constant-velocity ramp (~0.3 mm), so the
  // flow starts with a kink rather than a smooth tangent. Main event is a
  // cosine bell with a fuller nose.
  const ur = 0.07, hr = 0.028;
  if (u < ur) return (hr * u) / ur;
  if (u > 1 - ur) return (hr * (1 - u)) / ur;
  const v = (u - ur) / (1 - 2 * ur);
  const s = Math.sin(Math.PI * v);
  return hr + (1 - hr) * s * s * (1.35 - 0.35 * s * s);
}

function valveAreaFromLift(lift, d, n, cd) {
  if (lift <= 0) return 0;
  const Ac = Math.PI * d * lift;
  const At = 0.9 * (Math.PI * d * d) / 4;
  return n * cd * Math.pow(Math.pow(Ac, -4) + Math.pow(At, -4), -0.25);
}

// Build an effective-area table (Cd*A, m^2) over the cycle for one valve set.
function valveTable(spec, which, cam) {
  const cycle = spec.kind === 'rotary' ? 1080 : 720;
  const stroke = cycle / 4;
  const tab = new Float32Array(TAB_N + 1);
  let open, close;
  if (which === 'in') {
    open = -cam[0];
    close = stroke + cam[1];
  } else {
    open = 3 * stroke - cam[0];
    close = cycle + cam[1];
  }
  const dur = close - open;
  const v = spec.valves;
  let area;
  if (spec.kind === 'rotary') {
    const portArea = (which === 'in' ? v.inPortArea : v.exPortArea) * 1e-6; // mm^2 -> m^2
    area = (lift) => lift * portArea * 0.72;
  } else {
    const d = mm(which === 'in' ? v.inDia : v.exDia);
    const n = which === 'in' ? v.inCount : v.exCount;
    const L = mm(cam[2]);
    area = (lift) => valveAreaFromLift(lift * L, d, n, 0.68);
  }
  const shape = spec.kind === 'rotary' ? 'port' : 'cam';
  for (let i = 0; i <= TAB_N; i++) {
    const th = (i / TAB_N) * cycle;
    let phi = th - open;
    phi = ((phi % cycle) + cycle) % cycle;
    tab[i] = phi < dur ? area(camLift(phi / dur, shape)) : 0;
  }
  const norm = (a) => ((a % cycle) + cycle) % cycle;
  return { tab, open: norm(open), close: norm(close), dur };
}

function geometryTables(spec) {
  const cycle = spec.kind === 'rotary' ? 1080 : 720;
  const vol = new Float64Array(TAB_N + 1);
  const dvd = new Float64Array(TAB_N + 1); // dV/dtheta per radian of crank
  let vd, vc, pistonArea = 0;
  if (spec.kind === 'rotary') {
    vd = spec.chamberDisplacement * 1e-6; // cc -> m^3
    vc = vd / (spec.compression - 1);
    for (let i = 0; i <= TAB_N; i++) {
      const th = (i / TAB_N) * cycle;
      const ph = (2 * Math.PI * th) / 540;
      vol[i] = vc + (vd / 2) * (1 - Math.cos(ph));
      dvd[i] = (vd / 3) * Math.sin(ph);
    }
  } else {
    const B = mm(spec.bore), S = mm(spec.stroke);
    const r = S / 2;
    const l = mm(spec.rod ?? spec.stroke * 1.65);
    pistonArea = (Math.PI * B * B) / 4;
    vd = pistonArea * S;
    vc = vd / (spec.compression - 1);
    for (let i = 0; i <= TAB_N; i++) {
      const th = ((i / TAB_N) * cycle * Math.PI) / 180;
      const s = Math.sin(th), co = Math.cos(th);
      const q = Math.sqrt(l * l - r * r * s * s);
      const x = r * (1 - co) + l - q;
      vol[i] = vc + pistonArea * x;
      dvd[i] = pistonArea * (r * s + (r * r * s * co) / q);
    }
  }
  return { vol, dvd, vd, vc, cycle, pistonArea };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

// Crank angle (0..cycle) at which each cylinder fires.
export function firingAngles(spec) {
  const n = spec.cylinders;
  const cycle = spec.kind === 'rotary' ? 1080 : 720;
  const angles = new Array(n);
  if (spec.firingAngles) {
    for (let i = 0; i < n; i++) angles[i] = spec.firingAngles[i];
  } else {
    const order = spec.firingOrder;
    const iv = spec.intervals ?? cycle / n;
    let a = 0;
    for (let k = 0; k < order.length; k++) {
      angles[order[k] - 1] = a;
      a += Array.isArray(iv) ? iv[k % iv.length] : iv;
    }
  }
  return angles;
}

export function compileEngine(spec) {
  const g = geometryTables(spec);
  const cycle = g.cycle;
  const n = spec.cylinders;
  const tdcFire = cycle / 2;

  // Firing offsets
  const angles = firingAngles(spec);
  const cylOffset = new Float64Array(n);
  for (let i = 0; i < n; i++) cylOffset[i] = (((tdcFire - angles[i]) % cycle) + cycle) % cycle;

  const inLo = valveTable(spec, 'in', spec.cam.in);
  const exLo = valveTable(spec, 'ex', spec.cam.ex);
  const inHi = spec.camHigh ? valveTable(spec, 'in', spec.camHigh.in) : inLo;
  const exHi = spec.camHigh ? valveTable(spec, 'ex', spec.camHigh.ex) : exLo;

  const exNet = buildExhaust(spec);
  const inNet = buildIntake(spec);

  const displacement = g.vd * n * (spec.kind === 'rotary' ? 2 / 3 : 1); // swept volume per 720 deg equiv.
  const dispLitres = spec.kind === 'rotary' ? (spec.chamberDisplacement * (n / 3)) / 1000 : (g.vd * n) * 1000;

  const it = spec.intake ?? {};
  const ind = spec.induction ?? { type: 'na' };
  const ecu = spec.ecu ?? {};
  const veh = spec.vehicle ?? {};
  const snd = spec.sound ?? {};

  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind ?? 'piston',
    nCyl: n,
    cycle,
    tdcFire,
    tabN: TAB_N,
    vol: g.vol,
    dvd: g.dvd,
    vd: g.vd,
    vc: g.vc,
    pistonArea: g.pistonArea,
    displacement, // m^3 per 4-stroke cycle equivalent
    dispLitres,
    cylOffset,
    fireAngles: Float64Array.from(angles),
    inTab: inLo.tab,
    exTab: exLo.tab,
    inTabHi: inHi.tab,
    exTabHi: exHi.tab,
    camSwitchRpm: spec.camSwitchRpm ?? 0,
    ivc: inLo.close,
    evo: exLo.open,
    evc: exLo.close,
    ivo: inLo.open,
    ivcHi: inHi.close,
    evoHi: exHi.open,
    ex: flattenNet(exNet),
    in: flattenNet(inNet),
    exNet, // kept on main thread for drawing (stripped before posting)
    inNet,
    plenumVolume: (it.plenum ?? 5) / 1000,
    throttleArea: (Math.PI * Math.pow(mm(it.throttleDia ?? 80), 2)) / 4 * (it.throttleCount ?? 1),
    itb: !!it.itb,
    airbox: it.airbox ?? 'stock',
    induction: {
      type: ind.type ?? 'na',
      count: ind.count ?? 1,
      boost: ind.boost ?? 0, // bar gauge target
      size: ind.size ?? 1, // relative turbo size (lag / flow)
      ratio: ind.ratio ?? 2.5, // supercharger drive ratio
      blowerDisp: ind.displacement ?? 2.0, // litres per blower rev
      lobes: ind.lobes ?? 4,
      blades: ind.blades ?? 6,
      bov: ind.bov ?? 'atm',
      K: ind.K ?? 1,
    },
    ecu: {
      idle: ecu.idle ?? 800,
      limit: ecu.limit ?? 6500,
      limiter: ecu.limiter ?? 'fuel',
      hyst: ecu.hyst ?? 150,
      afr: ecu.afr ?? 12.8,
      burble: ecu.burble ?? 0,
      antilag: !!ecu.antilag,
      launchRpm: ecu.launchRpm ?? 4000,
      sparkBase: ecu.sparkBase ?? 0,
      startFlare: ecu.startFlare ?? 600,
      octane: ecu.octane ?? 98,
      knockCal: ecu.knockCal ?? 0, // 0 = generic calibration
    },
    inertia: spec.inertia ?? 0.2,
    friction: spec.friction ?? 1,
    combustion: spec.combustion ?? 0.8,
    burnScale: spec.burnScale ?? 1,
    stroke: mm(spec.stroke ?? 70),
    bore: mm(spec.bore ?? 90),
    // valve springs: float a little above the factory rev limit
    floatRpm: ecu.floatRpm ?? (snd.valvetrain === 'pneumatic' || snd.valvetrain === 'none' ? 40000 : (ecu.limit ?? 6500) * 1.07),
    exhaustExit: spec.exhaust?.exit ?? 'rear',
    vehicle: {
      mass: veh.mass ?? 1500,
      gears: veh.gears ?? [3.2, 2.1, 1.5, 1.15, 0.92, 0.75],
      final: veh.final ?? 3.7,
      tire: veh.tire ?? 0.33,
      cd: veh.cd ?? 0.32,
      area: veh.area ?? 2.0,
      rearBias: veh.rearBias ?? 0.55,
      drive: veh.drive ?? 'rwd',
      layout: veh.layout ?? 'front',
      mu: veh.mu ?? 1.2,
      straightCut: !!veh.straightCut,
      shiftTime: veh.shiftTime ?? 0.12,
    },
    sound: {
      exhaust: snd.exhaust ?? 1,
      intake: snd.intake ?? 1,
      mech: snd.mech ?? 1,
      valvetrain: snd.valvetrain ?? 'dohc',
      rasp: snd.rasp ?? 1,
      gear: snd.gear ?? 0.3,
      trim: snd.trim ?? 1,
    },
  };
}

// Strip main-thread-only data before posting to the worklet.
export function workletConfig(c) {
  const { exNet, inNet, ...rest } = c;
  return rest;
}
