// FIRING ORDER — physically modelled engine sound.
//
// Everything audible here comes out of a small physics simulation that runs
// once per audio sample:
//
//   * each cylinder is a 0-D thermodynamic volume (mass + internal energy)
//     following the slider-crank volume curve, with Wiebe heat release,
//     cycle-to-cycle combustion variation and compressible valve flow;
//   * intake runners and every exhaust pipe are bidirectional digital
//     waveguides (travelling pressure waves) joined by lossless scattering
//     junctions, so headers, collectors, X-pipes, mufflers and tail pipes
//     shape the pulses the way real pipes do;
//   * the tail pipes radiate: far-field pressure = d/dt(mass outflow) / 4πr;
//   * crank speed is integrated from the gas torque, so idle lope, limiter
//     bounce and rev-matching all emerge from the model;
//   * a listener stage renders each source with distance delay (Doppler),
//     ground reflection, air absorption and head shadowing.

const PI = Math.PI;
const TAU = 2 * PI;
const RAD2DEG = 180 / PI;
const P_AMB = 101325;
const T_AMB = 298;
const R = 287;
const GAM = 1.34;
const GM1 = GAM - 1;
const CV = R / GM1;
const CP = GAM * CV;
const LHV = 43.5e6;
const AFR_ST = 14.7;
const CHOKE = Math.sqrt(GAM / R) * Math.pow(2 / (GAM + 1), (GAM + 1) / (2 * GM1));
const CHOKE_AIR = Math.sqrt(1.4 / R) * Math.pow(2 / 2.4, 2.4 / 0.8);
const INV4PI = 1 / (4 * PI);
const C_AIR = 343;

const NODE_JUNCTION = 0, NODE_PORT = 1, NODE_OPEN = 2, NODE_CLOSED = 3, NODE_RESISTOR = 4, NODE_PLENUM = 5;
const DYN_TURBINE = 1, DYN_WASTEGATE = 2, DYN_VALVE = 3;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

let rs = 0x2545f491;
function rnd() {
  rs ^= rs << 13;
  rs ^= rs >>> 17;
  rs ^= rs << 5;
  return (rs >>> 0) * 2.3283064365386963e-10;
}
function gauss() {
  return (rnd() + rnd() + rnd() + rnd() - 2) * 1.7320508;
}
function ftanh(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}
function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}
function crossed(prev, cur, ev) {
  return prev <= cur ? prev < ev && ev <= cur : ev > prev || ev <= cur;
}
// One-pole low-pass coefficient for cutoff f (Hz).
function lpCoef(f, fs) {
  return 1 - Math.exp((-TAU * Math.min(f, fs * 0.45)) / fs);
}

// Mass flow through an orifice of effective area A (Cd included), driven by
// pressure difference D > 0, solved implicitly against the combined reacting
// impedance Z of both sides (pipe wave impedance + chamber compliance), and
// limited by choked flow from the upstream stagnation state (p0, T0).
function orifice(A, D, rho, Z, p0, sqrtT0, choke) {
  const K = A * Math.sqrt(2 * rho);
  const B = K * Z;
  const s = (2 * D) / (B + Math.sqrt(B * B + 4 * D));
  const m = K * s;
  const mc = (choke * A * p0) / sqrtT0;
  return m < mc ? m : mc;
}

// Two-pole resonator (band-pass) state packed in arrays.
class ResBank {
  constructor(freqs, qs, gains, fs) {
    const n = freqs.length;
    this.n = n;
    this.b0 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    this.g = Float64Array.from(gains);
    for (let i = 0; i < n; i++) {
      const w = (TAU * freqs[i]) / fs;
      const r = Math.exp(-w / (2 * qs[i]));
      this.a1[i] = -2 * r * Math.cos(w);
      this.a2[i] = r * r;
      this.b0[i] = (1 - r * r) * 0.5;
    }
  }
  tick(x) {
    let out = 0;
    const { b0, a1, a2, y1, y2, g } = this;
    for (let i = 0; i < this.n; i++) {
      const y = b0[i] * x - a1[i] * y1[i] - a2[i] * y2[i];
      y2[i] = y1[i];
      y1[i] = y;
      out += y * g[i];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Waveguide pipe network
// ---------------------------------------------------------------------------

class Net {
  constructor(d, fs, hot) {
    this.fs = fs;
    this.hot = hot;
    const S = d.S;
    const L = 2 * S;
    this.S = S;
    this.L = L;
    this.len = d.segLen;
    this.temp = d.segTemp;
    this.area = new Float64Array(S);
    for (let k = 0; k < S; k++) this.area[k] = (PI * d.segDia[k] * d.segDia[k]) / 4;
    this.delay = new Float64Array(L);
    this.Zm = new Float64Array(L);
    this.Y = new Float64Array(L);
    this.segC = new Float64Array(S);

    // Delay line memory: each line gets a power-of-two ring big enough for the
    // longest delay it can have (coldest gas).
    this.lineOff = new Int32Array(L);
    this.lineMask = new Int32Array(L);
    const cMin = 300;
    let total = 0;
    for (let l = 0; l < L; l++) {
      const k = l >> 1;
      const maxD = (this.len[k] / cMin) * fs + 4;
      let size = 8;
      while (size < maxD) size <<= 1;
      this.lineOff[l] = total;
      this.lineMask[l] = size - 1;
      total += size;
    }
    this.buf = new Float32Array(total);

    // Per-line loss filters (one-pole low-pass + DC gain per trip).
    // Losses must not touch the mean (DC) component, or the pipes would leak
    // mass: HF low-pass + broadband damping applied to the AC part only.
    this.la1 = new Float64Array(L);
    this.lg = new Float64Array(L);
    this.lz = new Float64Array(L);
    this.ld = new Float64Array(L);
    this.ldA = lpCoef(12, fs);
    const hfScale = 48000 / fs;
    for (let l = 0; l < L; l++) {
      const k = l >> 1;
      const a = Math.min(0.97, Math.pow(d.segHf[k], hfScale));
      this.la1[l] = 1 - a;
      this.lg[l] = d.segG[k];
    }

    this.inW = new Float64Array(L);
    this.outW = new Float64Array(L);
    // Finite-amplitude propagation: pressure crests travel faster
    // (c + (g+1)/2 u), so strong pulses steepen into near-shocks.
    // (nlLines is built below, once line ends are known.)

    // Node bookkeeping.
    this.N = d.N;
    this.type = d.nodeType;
    this.es = d.nodeEndStart;
    this.ec = d.nodeEndCount;
    this.ends = d.ends;
    this.np = d.nodeP;
    this.endNode = new Int32Array(L).fill(-1);
    for (let i = 0; i < d.N; i++) {
      for (let k = 0; k < d.nodeEndCount[i]; k++) this.endNode[d.ends[d.nodeEndStart[i] + k]] = i;
    }
    // Steepening applies to the outgoing blowdown pulses (lines leaving a port).
    this.nlLines = Int32Array.from([...Array(L).keys()].filter((l) => d.segNl[l >> 1] && d.nodeType[this.endNode[l]] === NODE_PORT));
    const lists = { j: [], p: [], o: [], c: [], r: [], pl: [] };
    for (let i = 0; i < d.N; i++) {
      switch (d.nodeType[i]) {
        case NODE_JUNCTION: lists.j.push(i); break;
        case NODE_PORT: lists.p.push(i); break;
        case NODE_OPEN: lists.o.push(i); break;
        case NODE_CLOSED: lists.c.push(i); break;
        case NODE_RESISTOR: lists.r.push(i); break;
        case NODE_PLENUM: lists.pl.push(i); break;
      }
    }
    this.junc = Int32Array.from(lists.j);
    this.ports = Int32Array.from(lists.p);
    this.portEnds = Int32Array.from(lists.p.map((i) => d.ends[d.nodeEndStart[i]]));
    this.opens = Int32Array.from(lists.o);
    this.closeds = Int32Array.from(lists.c);
    this.res = Int32Array.from(lists.r);
    this.plenums = Int32Array.from(lists.pl);
    this.nodeCyls = d.nodeCyls;
    this.closedK = d.closedK;

    // Junction pressure sources (afterfire) and per-node scratch.
    this.src = new Float64Array(d.N);
    this.nodeP = new Float64Array(d.N); // last computed node pressure (for viz)

    // Open-end radiation state
    const no = this.opens.length;
    this.oLp = new Float64Array(no);
    this.oAl = new Float64Array(no);
    this.oR = new Float64Array(no);
    this.oQ = new Float64Array(no);
    this.oCh = new Int32Array(no);
    for (let i = 0; i < no; i++) {
      const n = this.opens[i];
      this.oCh[i] = d.nodeP[n * 4] | 0;
    }

    // Resistors
    const nr = this.res.length;
    this.rR = new Float64Array(nr);
    this.rK = new Float64Array(nr);
    this.rDyn = new Int32Array(nr);
    this.rIdx = new Int32Array(nr);
    this.rU = new Float64Array(nr);
    this.rP = new Float64Array(nr); // absorbed power accumulator
    for (let i = 0; i < nr; i++) {
      const n = this.res[i];
      this.rR[i] = d.nodeP[n * 4];
      this.rK[i] = d.nodeP[n * 4 + 1];
      this.rDyn[i] = d.nodeP[n * 4 + 2] | 0;
      this.rIdx[i] = d.nodeP[n * 4 + 3] | 0;
    }
    this.rClosedK = new Float64Array(nr);
    for (let i = 0; i < nr; i++) this.rClosedK[i] = this.closedK[this.res[i]] || 3e8;

    this.nlAdv = new Float64Array(L);
    // (g+1)/(2g p0) per Pa of wave pressure, derated for the large-amplitude
    // overshoot of the linearised form and for wall friction smearing fronts.
    this.nlBeta = hot ? (0.55 * 2.33) / (2 * 1.33 * P_AMB) : 0;
    // Turbulence and cycle-to-cycle gas temperature swings make each pipe's
    // transit time wander by a fraction of a percent. Inaudible for the low
    // harmonics, it keeps the highs from repeating identically every cycle.
    this.wOff = new Float64Array(L);
    this.wA = new Float64Array(S);
    this.wB = new Float64Array(S);
    this.wAmt = hot ? 0.0025 : 0.001;
    this.t = 1 << 20;
    this.setGasTemp(hot ? 700 : T_AMB);
  }

  // Transit-time wander (control rate): an Ornstein-Uhlenbeck process per
  // segment, ~12 ms correlation, smoothed so the read heads glide.
  wander(dtc) {
    const S = this.S, a = this.wA, b = this.wB, dl = this.delay, wo = this.wOff;
    const k = dtc / 0.012;
    const g = this.wAmt * Math.sqrt(2 * k);
    const kb = Math.min(1, dtc * 400);
    for (let s = 0; s < S; s++) {
      a[s] += -a[s] * k + g * gauss();
      b[s] += (a[s] - b[s]) * kb;
      const D = dl[2 * s];
      let o = b[s] * D;
      if (o > 0.05 * D) o = 0.05 * D;
      else if (o < -0.05 * D) o = -0.05 * D;
      wo[2 * s] = o;
      wo[2 * s + 1] = o;
    }
  }

  // Update sound speed per segment from the gas temperature (EGT for exhaust).
  setGasTemp(Tgas) {
    const fs = this.fs;
    const gam = this.hot ? 1.33 : 1.4;
    for (let k = 0; k < this.S; k++) {
      const T = this.hot ? T_AMB + (Tgas - T_AMB) * this.temp[k] : Tgas;
      const c = Math.sqrt(gam * R * T);
      this.segC[k] = c;
      let D = (this.len[k] / c) * fs;
      if (D < 1.05) D = 1.05;
      const Z = c / this.area[k];
      this.delay[2 * k] = D;
      this.delay[2 * k + 1] = D;
      this.Zm[2 * k] = Z;
      this.Zm[2 * k + 1] = Z;
      this.Y[2 * k] = 1 / Z;
      this.Y[2 * k + 1] = 1 / Z;
    }
    // Open-end reflection filters depend on c and radius.
    for (let i = 0; i < this.opens.length; i++) {
      const n = this.opens[i];
      const e = this.ends[this.es[n]];
      const k = e >> 1;
      const a = this.np[n * 4 + 1];
      const fc = (0.5 * this.segC[k]) / (TAU * a);
      this.oAl[i] = lpCoef(fc, fs);
      this.oR[i] = 0.9;
    }
  }

  // Read the wave arriving at every pipe end (fractional delay + losses).
  // Losses leave the mean (DC) untouched so no mass leaks out of the pipes.
  read() {
    const t = this.t, buf = this.buf, lo = this.lineOff, lm = this.lineMask, dl = this.delay;
    const la1 = this.la1, lz = this.lz, lg = this.lg, ld = this.ld, ldA = this.ldA, inW = this.inW;
    const nl = this.nlLines, adv = this.nlAdv, wo = this.wOff, B = this.nlBeta;
    // Finite-amplitude steepening: the crest of a strong pulse travels faster
    // than its foot, so the front arrives early and sharpens toward a shock.
    for (let j = 0; j < nl.length; j++) {
      const l = nl[j];
      const D = dl[l];
      const o = lo[l], m = lm[l];
      let sh = (buf[o + ((t - D) & m)] - ld[l]) * B * D;
      const lim = 0.3 * D;
      if (sh > lim) sh = lim;
      else if (sh < -lim) sh = -lim;
      // a front may steepen into a shock but never overturn
      if (sh < adv[l] - 0.98) sh = adv[l] - 0.98;
      adv[l] = sh;
    }
    for (let l = 0, LL = this.L; l < LL; l++) {
      const pos = t - dl[l] + adv[l] + wo[l];
      const i0 = pos | 0;
      const fr = pos - i0;
      const o = lo[l], m = lm[l];
      const a = buf[o + (i0 & m)];
      const x = a + (buf[o + ((i0 + 1) & m)] - a) * fr;
      const z = lz[l] + la1[l] * (x - lz[l]);
      lz[l] = z;
      const d = ld[l] + ldA * (z - ld[l]);
      ld[l] = d;
      inW[l ^ 1] = d + (z - d) * lg[l];
    }
    // a closed valve reflects: default outgoing wave at port ends
    const pe = this.portEnds, outW = this.outW;
    for (let i = 0; i < pe.length; i++) outW[pe[i]] = inW[pe[i]];
  }

  // Push the outgoing waves into the delay lines and advance time.
  write() {
    const t = this.t, buf = this.buf, lo = this.lineOff, lm = this.lineMask, outW = this.outW;
    for (let l = 0, LL = this.L; l < LL; l++) buf[lo[l] + (t & lm[l])] = outW[l];
    this.t = t + 1 > 0x3fffffff ? t + 1 - 0x20000000 : t + 1;
  }

  // Scattering at junctions, resistors (mufflers, turbine, wastegate, valve),
  // closed ends and radiating open ends. Radiated d(mdot)/dt goes to src[ch].
  scatter(src, turbP, fs) {
    const inW = this.inW, outW = this.outW, Y = this.Y, Zm = this.Zm;
    const es = this.es, ec = this.ec, ends = this.ends, nsrc = this.src;
    const junc = this.junc;
    for (let j = 0; j < junc.length; j++) {
      const nd = junc[j];
      const st = es[nd], cnt = ec[nd];
      let sy = 0, sya = 0;
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        sy += Y[e];
        sya += Y[e] * inW[e];
      }
      const pj = (2 * sya) / sy + nsrc[nd];
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        outW[e] = pj - inW[e];
      }
    }
    const res = this.res, rR = this.rR, rK = this.rK, rU = this.rU, rDyn = this.rDyn, rIdx = this.rIdx;
    for (let i = 0; i < res.length; i++) {
      const nd = res[i];
      const e1 = ends[es[nd]], e2 = ends[es[nd] + 1];
      const a1 = inW[e1], a2 = inW[e2];
      const Z1 = Zm[e1], Z2 = Zm[e2];
      const B = rR[i] + Z1 + Z2;
      const D = 2 * (a1 - a2);
      const K = rK[i];
      let Uf;
      if (K > 0) {
        const ad = D < 0 ? -D : D;
        Uf = (2 * ad) / (B + Math.sqrt(B * B + 4 * K * ad));
        if (D < 0) Uf = -Uf;
      } else Uf = D / B;
      outW[e1] = a1 - Z1 * Uf;
      outW[e2] = a2 + Z2 * Uf;
      rU[i] = Uf;
      if (rDyn[i] === DYN_TURBINE) turbP[rIdx[i]] += (D - (Z1 + Z2) * Uf) * Uf;
    }
    const cl = this.closeds;
    for (let i = 0; i < cl.length; i++) {
      const e = ends[es[cl[i]]];
      outW[e] = inW[e];
    }
    src[0] = 0;
    src[1] = 0;
    src[2] = 0;
    const op = this.opens, oLp = this.oLp, oAl = this.oAl, oR = this.oR, oQ = this.oQ, oCh = this.oCh;
    for (let i = 0; i < op.length; i++) {
      const e = ends[es[op[i]]];
      const a = inW[e];
      const lp = oLp[i] + oAl[i] * (a - oLp[i]);
      oLp[i] = lp;
      const b = -oR[i] * lp;
      outW[e] = b;
      const q = (a - b) * Y[e];
      src[oCh[i]] += (q - oQ[i]) * fs;
      oQ[i] = q;
    }
  }

  // Sample the pressure distribution along segment k at nPts points (viz).
  sampleSeg(k, nPts, out, o) {
    const D = this.delay[2 * k];
    const t = this.t - 1;
    const buf = this.buf;
    for (let i = 0; i < nPts; i++) {
      const f = (i + 0.5) / nPts;
      // forward wave (A->B) written f*D ago at end A; backward f from B
      let pos = t - f * D;
      let i0 = pos | 0;
      let off = this.lineOff[2 * k], m = this.lineMask[2 * k];
      const fw = buf[off + (i0 & m)];
      pos = t - (1 - f) * D;
      i0 = pos | 0;
      off = this.lineOff[2 * k + 1];
      m = this.lineMask[2 * k + 1];
      const bw = buf[off + (i0 & m)];
      out[o + i] = fw + bw;
    }
  }
}

// ---------------------------------------------------------------------------
// Listener / spatial renderer
// ---------------------------------------------------------------------------

const N_SRC = 6; // exL, exR, exC, intake, mech, chassis
const SRC_BUF = 1 << 17;
const SRC_MASK = SRC_BUF - 1;

class Listener {
  constructor(fs) {
    this.fs = fs;
    this.buf = new Float32Array(N_SRC * SRC_BUF);
    this.w = 0;
    const T = N_SRC * 4; // src x ear x (direct, ground)
    this.dCur = new Float64Array(T);
    this.dInc = new Float64Array(T);
    this.gCur = new Float64Array(T);
    this.gInc = new Float64Array(T);
    this.al = new Float64Array(T);
    this.z1 = new Float64Array(T);
    this.z2 = new Float64Array(T);
    this.active = new Uint8Array(N_SRC);
    this.cabin = 0;
    this.moving = false;
    this.boom1 = 0;
    this.boom2 = 0;
    this.first = true;
  }
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

class EngineSim {
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
    this.cP2 = new Float64Array(n);
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
      this.cP2[c] = P_AMB;
    }

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
    this.mdThPrev = 0;
    this.runnerFlow = 0;
    this.runnerFlowPrev = 0;
    this.Ath = cfg.throttleArea;

    // Boost system
    const ind = cfg.induction;
    this.fiType = ind.type;
    this.isTurbo = ind.type === 'turbo';
    this.isSC = ind.type === 'roots' || ind.type === 'twinscrew';
    this.isCentri = ind.type === 'centrifugal';
    this.pB = P_AMB;
    this.Vb = this.isTurbo || this.isCentri ? 0.004 + cfg.dispLitres * 0.0012 : 0.003 + cfg.dispLitres * 0.0006;
    this.TB = T_AMB;
    this.boostTarget = ind.boost * 1e5;
    this.nT = this.isTurbo ? Math.max(1, ind.count) : this.isCentri ? 1 : 0;
    this.wt = 0; // turbo shaft speed (rad/s), aggregated over turbos
    this.mc = 0; // compressor mass flow (Greitzer state)
    this.mcPrev = 0;
    this.mcLp = 0;
    this.pBrate = 0;
    this.pBprev = P_AMB;
    this.wg = 0; // wastegate opening 0..1
    this.bov = 0;
    this.mdBov = 0;
    this.turbP = new Float64Array(Math.max(this.nT, 1));
    this.turbPs = 0;
    this.scBypass = 1;
    this.scPower = 0;
    const size = ind.size;
    // turbo sizing (per turbo) scaled from displacement per turbo
    const dPer = cfg.dispLitres / Math.max(this.nT, 1);
    this.tJ = 4e-5 * Math.pow(dPer, 1.1) * size * size;
    this.tRtip = 0.024 * Math.sqrt(dPer / 2) * Math.sqrt(size);
    this.tChokeK = 0.00045 * Math.pow(dPer, 0.85) * size; // kg/s per (m/s) tip speed
    this.tA = 9e-4 * Math.pow(dPer / 2, 0.8) * size; // turbine effective area
    this.tRestr = 4e5 / Math.pow(Math.max(this.nT, 1) * size, 2);
    this.wgI = 0;
    this.blades = ind.blades;
    this.bovType = ind.bov;
    this.tPhase = 0;
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

    // ECU
    const e = cfg.ecu;
    this.ecu = e;
    this.ignition = false;
    this.starter = false;
    this.starterT = 0;
    this.crankRevs = 99;
    this.syncRevs = 0;
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
    this.shiftCut = 0;
    this.flare = 0;
    this.coldT = 0;
    this.camHi = false;
    this.camSwitch = cfg.camSwitchRpm;
    this.valveOpen = 0; // exhaust bypass valve 0..1
    this.valveMode = 'auto';
    this.sinceStart = 0;

    // Requested inputs
    this.pedal = 0;
    this.thrCmd = 0;
    this.thr = 0;
    this.thrArea = 0;
    this.brake = 0;
    this.clutchPedal = 0; // 1 = pressed (disengaged)
    this.blip = 0;

    this.kLeak = 1.5e-10 * (cfg.vd / 5e-4);
    // Friction constants
    this.fricK = (cfg.displacement / (4 * PI)) * 1e5 * cfg.friction;
    this.fric = 0;

    // Feed-forward idle air
    const needed = 1.18 * cfg.displacement * (e.idle / 120) * 0.092;
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
    this.gearPhase = 0;
    this.dynoLoad = 0;
    this.dynoI = 0;
    this.dyno = null;

    // Sound bits
    this.snd = cfg.sound;
    this.valvetrain = new ResBank(
      cfg.sound.valvetrain === 'ohv' ? [2300, 3900, 6100] : cfg.sound.valvetrain === 'pneumatic' ? [3400, 5600, 8800] : [3100, 5200, 8200],
      [9, 12, 14],
      [1, 0.7, 0.45],
      fs
    );
    this.block = new ResBank([780, 1350, 2150, 3300], [6, 7, 8, 9], [1, 0.8, 0.55, 0.35], fs);
    this.vtExc = 0;
    this.combExc = 0;
    this.srcBuf = new Float64Array(N_SRC);
    this.ibLp1 = 0;
    this.ibLp2 = 0;
    this.ibRes1 = 0;
    this.ibRes2 = 0;
    this.itbLp = 0;
    this.hissLp = 0;
    this.nzState = new Float64Array(8);
    this.starterPhase = 0;
    this.roadLp = 0;
    this.windLp1 = 0;
    this.windLp2 = 0;
    this.sqPhase = 0;
    this.sqLp = 0;
    this.clunk = 0;

    // EGT & temps
    this.egt = 500;
    this.egtInst = 500;
    this.egtAcc = 0;
    this.egtW = 0;
    this.tempCounter = 0;
    this.coolant = 0;

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
    this.ibA = lpCoef(cfg.airbox === 'open' ? 5200 : cfg.airbox === 'ram' ? 2600 : 900, fs);
    this.itbA = lpCoef(6500, fs);
    this.itb = cfg.itb ? 1 : 0;
    this.rasp26 = 26 * cfg.sound.rasp;
    this.exG = INV4PI * cfg.sound.exhaust;
    const vtt = cfg.sound.valvetrain;
    this.vtK = vtt === 'ohv' ? 1.5 : vtt === 'pneumatic' ? 0.6 : vtt === 'none' ? 0 : 1;
    this.gearK = cfg.sound.gear * (cfg.vehicle.straightCut ? 1 : 0.2);
    // big single cylinders need a strong starter to crank past compression
    this.starterTq = 55 * cfg.dispLitres + 40 + 160 * (cfg.dispLitres / cfg.nCyl);
    this.boosted = this.isTurbo || this.isSC || this.isCentri;
    const vh = cfg.vehicle;
    this.axleLoad = vh.mass * 9.81 * (vh.drive === 'awd' ? 1 : vh.rearBias);
    this.loadTransfer = vh.drive === 'awd' ? 0 : vh.mass * 0.2;
    this.brakeK = vh.brakeK ?? vh.mass * 9.81 * 0.95;
    this.dragK = 0.5 * 1.2 * vh.cd * vh.area;
    this.rollK = vh.mass * 9.81 * 0.012;
    this.vtExcS = 0;
    this.combExcS = 0;
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
  // Per-cycle cylinder events
  // -------------------------------------------------------------------------

  onIVC(c, rpm) {
    const m = this.cm[c];
    const mb = this.cMb[c];
    const fresh = Math.max(0, m - mb);
    const xr = mb / m;
    const load = fresh / (1.18 * this.vd);
    this.cAirIn[c] = fresh;
    this.telAir += fresh;

    const cranking = rpm < 350;
    let fuelOn = this.ignition && !this.dfco && this.crankRevs >= this.syncRevs;
    if (this.limCut && this.limiterType === 'fuel') fuelOn = false;
    let afr = this.afrTarget;
    if (cranking) afr = 11;
    if (load < 0.6) afr = 14.7 + (afr - 14.7) * Math.max(0, load - 0.35) / 0.25;
    if (this.dfco && this.burbleActive) {
      fuelOn = this.ignition;
      afr = 11.5;
    }
    if (this.alsActive) {
      fuelOn = this.ignition;
      afr = 10.5;
    }
    if (this.launchCut) afr = 11.5;
    if (this.tcCut > 0.45 && rnd() < (this.tcCut - 0.45) * 1.6) fuelOn = false; // TC cuts fuel
    const fuel = fuelOn ? fresh / afr : 0;
    const burnable = Math.min(fuel, fresh / AFR_ST);
    this.cFuel[c] = fuel;
    this.cBurnable[c] = burnable;
    this.telFuel += fuel;

    // add fuel vapour to charge
    if (fuel > 0) {
      const T = this.cU[c] / (m * CV);
      this.cm[c] = m + fuel;
      this.cU[c] += fuel * CV * T;
    }

    let spark = this.ignition && fuel > 0;
    if (this.limCut && this.limiterType === 'spark') spark = false;
    if (this.shiftCut > 0) spark = false;
    if (this.launchCut && rnd() < 0.55) spark = false;


    // Combustion variability grows with residual gas and light load.
    const sig = 0.016 + 0.45 * Math.max(0, xr - 0.14) + 0.04 * Math.max(0, 0.4 - load);
    let misfire = false;
    if (xr > 0.3 && rnd() < (xr - 0.3) * 1.6) misfire = true;
    if (load < 0.08 && rnd() < (0.08 - load) * 5) misfire = true;
    if (cranking && rnd() < 0.25) misfire = true;

    if (!spark || misfire || burnable <= 0) {
      this.cBurn[c] = 0;
      this.cQ[c] = 0;
      return;
    }
    const rpmF = Math.min(rpm, 16000) / 7000;
    let dur =
      50 * this.cfg.burnScale * (0.82 + 0.3 * rpmF) * (1 + 2.2 * Math.max(0, xr - 0.06)) * (1 + 0.7 * Math.max(0, 0.55 - load));
    dur *= 1 + 0.45 * sig * gauss();
    if (dur < 20) dur = 20;
    // Spark advance for best torque (CA50 around 8-10 deg ATDC).
    let adv = 0.5 * dur - 9 + this.sparkTrim + this.ecu.sparkBase;
    if (cranking) adv = 5;
    if (this.dfco && this.burbleActive) adv = -18 - 22 * rnd() * this.burble;
    if (this.alsActive) adv = -38 - 16 * rnd();
    if (this.launchCut) adv = -15 - 10 * rnd();
    if (this.shiftRetard > 0) adv -= 25 * this.shiftRetard;
    if (this.tcCut > 0) adv -= 28 * Math.min(1, this.tcCut * 2);
    // A flame lit after TDC burns into an expanding, cooling charge: slower.
    if (adv < 0) dur *= 1 + -adv / 16;
    const q = burnable * LHV * this.cfg.combustion * Math.max(0.2, 1 + sig * gauss());
    this.cQ[c] = q;
    this.cDur[c] = dur;
    let sp = this.tdcFire - adv;
    sp = ((sp % this.cycle) + this.cycle) % this.cycle;
    this.cSpark[c] = sp;
    this.cBurn[c] = 1;
    this.cXb[c] = 0;
  }

  onEVO(c) {
    const fuel = this.cFuel[c];
    const burnable = this.cBurnable[c];
    let xb = 0;
    const st = this.cBurn[c];
    if (st === 2) xb = this.cXb[c];
    else if (st === 3) xb = 1;
    // Unburned fuel leaves with the exhaust; late combustion keeps burning.
    const unburnt = fuel - burnable * xb;
    const fresh = this.cAirIn[c];
    const airLeft = Math.max(0, fresh - burnable * xb * AFR_ST);
    const node = this.cAf[c];
    if (node >= 0) {
      this.afFuel[node] += unburnt;
      this.afAir[node] += airLeft + (this.alsActive ? fresh * 0.8 : 0); // ALS secondary air
      const T = this.cU[c] / (this.cm[c] * CV);
      // a charge still burning at EVO carries flame into the pipe
      const heat = st === 2 ? 1 : st === 3 ? 0.12 : 0.05;
      this.afHeat[node] = Math.max(this.afHeat[node] * 0.9, heat * clamp((T - 700) / 900, 0, 1) + (st === 2 ? 0.5 : 0));
    }
    if (st >= 2) {
      this.cMb[c] = this.cm[c] * (0.6 + 0.4 * xb);
      this.cFired[c] = Math.min(1.5, this.cQ[c] * xb / (1.18 * this.vd * 3.0e6));
    }
    this.cBurn[c] = 0;
    this.cFuel[c] = 0;
    this.cExB[c] = this.cMb[c] / this.cm[c];
    // EGT estimate weighted by mass
    const T = this.cU[c] / (this.cm[c] * CV);
    this.egtAcc += T * this.cm[c];
    this.egtW += this.cm[c];
  }

  // -------------------------------------------------------------------------
  // Control-rate logic (ECU, gearbox automation, boost control)
  // -------------------------------------------------------------------------

  control(dtc) {
    const rpm = this.rpm;
    const e = this.ecu;
    this.sinceStart += dtc;

    // Starter & running detection
    if (this.starter) {
      this.starterT += dtc;
      this.crankRevs += (rpm / 60) * dtc;
      if (!this.ignition || (this.running && rpm > e.idle * 0.7) || this.starterT > 4) {
        this.starter = false;
      }
    }
    // cycle-averaged speed: cranking a big twin swings the instantaneous rpm
    // far more than the threshold
    this.rpmAvg += (rpm - this.rpmAvg) * Math.min(1, dtc * 6);
    if (!this.running && this.ignition && this.rpmAvg > Math.min(500, e.idle * 0.6)) {
      this.running = true;
      this.flare = e.startFlare;
      this.idleI = 0;
      this.sinceStart = 0;
    }
    if (this.running && (rpm < 120 || !this.ignition)) this.running = false;

    // Idle target with start flare & cold fast idle
    this.flare *= Math.exp(-dtc / 1.4);
    this.coldT = Math.max(0, this.coldT - dtc / 25);
    this.idleTarget = e.idle + this.flare + 250 * this.coldT;

    // Idle speed control (bypass air PI + fast spark trim)
    const idleActive = this.ignition && this.pedal < 0.03;
    // rpm rate for predictive fuel resume / dashpot
    const dRpm = (rpm - this.lastRpm) / dtc;
    this.lastRpm = rpm;
    this.rpmRate += (dRpm - this.rpmRate) * Math.min(1, dtc * 20);
    if (idleActive && this.running) {
      // integrate unless coasting down fast (anti-windup)
      // act on where the revs are heading, not just where they are
      const errP = this.idleTarget - (rpm + this.rpmRate * 0.25);
      // Learn only once the revs have landed: integrating the overshoot of a
      // blip or lift-off would leave the idle sagging for seconds afterwards.
      if (!this.dfco && this.landing < 0.15 && this.liftT > 1.2) {
        const ei = clamp(errP, -250, 400);
        this.idleI = clamp(this.idleI + ei * (ei > 60 ? 9e-4 : 4e-4) * dtc, -0.9, 2.5);
      }
      if (this.dfco) {
        // dashpot: hold air proportional to speed while coasting down
        this.bypass = this.bypassFF * clamp(0.9 + this.idleI, 0.5, 2.5) * clamp((0.8 * rpm) / this.idleTarget, 1, 4);
      } else {
        const pe = clamp(errP, -500, 800);
        this.landing *= Math.exp(-dtc / 0.5);
        this.bypass = clamp(this.bypassFF * (1 + this.idleI + pe * 7e-4 + 1.2 * this.landing), this.bypassFF * 0.1, this.bypassFF * 5);
      }
      this.sparkTrim = clamp(errP * 0.05, -12, 18);
    } else {
      this.bypass += (this.bypassFF * (1 + this.idleI) - this.bypass) * Math.min(1, dtc * 3);
      this.sparkTrim *= 0.9;
    }
    if (!this.running) this.bypass = this.bypassFF * 1.6;

    // Decel fuel cut / burble
    // Coast (decel fuel cut) vs idle regulation. Fuel resumes early when the
    // revs are falling fast so the engine lands softly on its idle speed.
    const resume = this.idleTarget + 250 + clamp(-this.rpmRate * 0.15, 0, 900);
    if (this.pedal < 0.03 && this.running && !this.launch) {
      if (this.dfco) {
        if (rpm < resume) {
          this.dfco = false;
          // extra air for a soft landing, in proportion to how fast the revs fall
          this.landing = clamp(-this.rpmRate / 2500, 0, 1);
        }
      } else if (rpm > this.idleTarget + 700 && (this.liftT < 2 || rpm > this.idleTarget + 1400)) this.dfco = true;
    } else this.dfco = false;
    // Overrun burble: a burst of crackles for a couple of seconds after lift-off.
    if (this.pedal > 0.25) this.liftT = 0;
    else this.liftT += dtc;
    const win = 0.6 + 3.2 * this.burble;
    this.burbleActive =
      this.burble > 0 && this.dfco && rpm > 1900 && rpm < this.limitRpm * 0.85 && this.liftT < win && rnd() < 0.25 + 0.5 * this.burble * (1 - this.liftT / win);

    // Anti-lag: keep air & fuel flowing, retard spark massively
    this.alsActive =
      this.antilag && this.isTurbo && this.pedal < 0.15 && rpm > 3000 && this.running && this.gear > 0 && (this.mode === 'drive' || this.mode === 'flyby');

    // Rev limiter with hysteresis
    const lim = this.launch && this.v < 1 ? this.launchRpm : this.limitRpm;
    if (rpm > lim) this.limCut = true;
    else if (rpm < lim - (this.launch ? 250 : e.hyst)) this.limCut = false;
    this.launchCut = this.launch && this.v < 1 && this.limCut;
    if (this.launchCut) this.limCut = false;

    // VTEC-style cam switch
    if (this.camSwitch > 0) {
      if (!this.camHi && rpm > this.camSwitch && this.thr > 0.35) this.camHi = true;
      else if (this.camHi && (rpm < this.camSwitch - 300 || this.thr < 0.2)) this.camHi = false;
    }

    // Traction control: trims torque with spark cuts when the driven wheels
    // spin (the classic stuttering 'brap').
    if (this.tc && this.gear > 0 && (this.mode === 'drive' || this.mode === 'flyby')) {
      const allow = 1.6 + 0.12 * this.v;
      const ex = this.slip - allow;
      this.tcCut = clamp(this.tcCut + (ex > 0 ? ex * 0.25 : -0.8) * dtc * 10, 0, rpm < 2500 ? 0.2 : 0.7);
    } else this.tcCut = 0;

    // Shift ignition cut timers
    if (this.shiftCut > 0) this.shiftCut -= dtc;
    if (this.shiftRetard > 0) this.shiftRetard = Math.max(0, this.shiftRetard - dtc * 8);

    // Exhaust bypass valve
    let vt = 0;
    if (this.valveMode === 'open') vt = 1;
    else if (this.valveMode === 'auto') vt = rpm > 3800 && this.thr > 0.35 ? 1 : this.thr > 0.8 ? 1 : 0;
    this.valveOpen += (vt - this.valveOpen) * Math.min(1, dtc * 6);

    // Throttle command (pedal, blips, ALS)
    let cmd = this.pedal;
    if (this.blip > 0) {
      cmd = Math.max(cmd, 0.55);
      this.blip -= dtc;
    }
    if (this.alsActive) cmd = Math.max(cmd, 0.11);
    if (!this.ignition) cmd = this.pedal;
    this.thrCmd = cmd;
    // butterfly area vs opening (evaluated at control rate)
    this.thrArea = this.Ath * 0.82 * (this.thr < 1 ? Math.pow(Math.max(0, this.thr), 1.75) : 1);

    // Boost control
    if (this.isTurbo || this.isCentri) {
      // Electronic boost control: PI on wastegate duty.
      const over = this.pB - P_AMB - this.boostTarget;
      this.pBrate += ((this.pB - this.pBprev) / dtc - this.pBrate) * Math.min(1, dtc * 40);
      this.pBprev = this.pB;
      this.wgI = clamp(this.wgI + over * 1.2e-4 * dtc, 0, 1);
      // derivative action catches the spool-up surge before it overshoots
      const near = this.pB - P_AMB > 0.55 * this.boostTarget ? 1 : 0;
      let wgT = clamp(this.wgI + over / 30000 + near * Math.max(0, this.pBrate) * 2.5e-6, 0, 1);
      if (this.alsActive) wgT = Math.max(0, wgT - 0.1);
      this.wg += (wgT - this.wg) * Math.min(1, dtc * 25);
      // Blow-off valve opens on closed throttle with pressure in the pipes
      // Blow-off valve opens on closed throttle with pressure in the pipes; with
      // anti-lag it doubles as a pressure relief above the boost target.
      const relief = this.alsActive && this.pB - P_AMB > this.boostTarget * 0.9;
      const bovT = (this.bovType !== 'none' && this.thr < 0.18 && this.pB - this.pPl > 30000 && !this.alsActive) || relief ? 1 : 0;
      if (bovT) this.bov = Math.min(1, this.bov + dtc * 120);
      else if (this.pB - P_AMB < 12000 || this.thr > 0.3) this.bov = Math.max(0, this.bov - dtc * 25);
    }
    if (this.isSC) {
      const byT = this.pedal > 0.55 ? 0 : 1;
      this.scBypass += (byT - this.scBypass) * Math.min(1, dtc * 12);
    }

    // Friction torque (FMEP from mean piston speed)
    const sp = (2 * this.cfg.stroke * rpm) / 60;
    this.fric = this.fricK * (0.72 + 0.024 * sp + 0.0019 * sp * sp);

    this.vehicleControl(dtc, rpm);

    // Temperatures -> pipe sound speed
    if (this.egtW > 0) {
      this.egtInst = (this.egtAcc / this.egtW) * 0.78;
      this.egtAcc = 0;
      this.egtW = 0;
    } else if (!this.running) {
      this.egtInst += (T_AMB + 40 - this.egtInst) * dtc * 0.3;
    }
    this.egt += (this.egtInst - this.egt) * Math.min(1, dtc * 1.3);
    this.ex.wander(dtc);
    this.inn.wander(dtc);
    if (++this.tempCounter >= 8) {
      this.tempCounter = 0;
      this.ex.setGasTemp(clamp(this.egt, 320, 1250));
      this.inn.setGasTemp(this.Tpl);
    }
    this.updateResistors();
  }

  updateResistors() {
    const ex = this.ex;
    for (let i = 0; i < ex.res.length; i++) {
      const d = ex.rDyn[i];
      if (d === DYN_VALVE) {
        const o = this.valveOpen;
        const A = 0.0022 * o + 1e-6;
        const K = 1 / (2 * 0.6 * A * A);
        ex.rK[i] = Math.min(ex.rClosedK[i], K * 0.15);
      } else if (d === DYN_TURBINE) {
        const rho = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
        ex.rK[i] = 1 / (2 * rho * this.tA * this.tA);
      } else if (d === DYN_WASTEGATE) {
        const rho = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
        const A = this.tA * 1.6 * this.wg + 1e-7;
        ex.rK[i] = Math.min(ex.rClosedK[i], 1 / (2 * rho * A * A));
      }
    }
  }

  vehicleControl(dtc, rpm) {
    const v = this.veh;
    if (this.mode === 'dyno') {
      this.gear = 0;
      this.clutchCap = 0;
      if (this.dyno && this.dyno.active) {
        const d = this.dyno;
        d.t += dtc;
        if (d.phase === 'settle') {
          d.target = d.start;
          this.pedal = 1;
          if (d.t > 1.2) {
            d.phase = 'sweep';
            d.t = 0;
          }
        } else if (d.phase === 'sweep') {
          d.target = d.start + d.rate * d.t;
          this.pedal = 1;
          if (d.target >= d.end) {
            d.phase = 'done';
            d.active = false;
            this.pedal = 0;
            this.posts.push({ type: 'dyno-done' });
          }
        }
        // PI absorber
        const errW = rpm - d.target;
        this.dynoI = clamp(this.dynoI + errW * 25 * dtc, 0, 6000);
        this.dynoLoad = Math.max(0, errW * 4 + this.dynoI);
        if (d.phase === 'sweep' && d.t > 0.05 && this.telN > 0) {
          // record brake torque vs rpm
        }
      } else {
        this.dynoLoad = Math.max(0, this.dynoLoad - dtc * 2000);
        this.dynoI = 0;
      }
      return;
    }
    this.dynoLoad = 0;
    if (this.mode === 'rev') {
      this.gear = 0;
      this.clutchCap = 0;
      this.v *= Math.max(0, 1 - dtc * 2);
      this.ww = this.v / v.tire;
      return;
    }
    // drive / flyby
    const maxT = 1.5 * this.peakTorqueGuess();
    const G = this.gear > 0 ? v.gears[this.gear - 1] * v.final : 0;
    const wIn = this.ww * G;

    if (this.shift) {
      const s = this.shift;
      s.t += dtc;
      const T = v.shiftTime;
      if (s.phase === 'out') {
        this.clutch = Math.max(0, 1 - s.t / (T * 0.3));
        if (s.t >= T * 0.3) {
          this.gear = s.to;
          s.phase = 'in';
          s.t = 0;
          if (s.dir < 0) this.blip = T * 0.9;
        }
      } else {
        this.clutch = Math.min(1, s.t / (T * 0.7));
        if (s.t >= T * 0.7) {
          this.clutch = 1;
          this.shift = null;
        }
      }
    } else if (this.gear > 0) {
      // Auto-clutch for pulling away and stopping.
      const stall = Math.max(900, this.ecu.idle * 1.15);
      if (this.launch && this.v < 1 && this.pedal > 0.5) {
        this.clutch = 0;
      } else if (wIn * 9.549 < stall && this.pedal < 0.05) {
        // creeping / stopping: let the clutch slip to avoid stalling
        this.clutch += (0 - this.clutch) * Math.min(1, dtc * 10);
      } else if (wIn * 9.549 < rpm - 150 && this.v < 14) {
        // pull-away: slip the clutch to hold the engine near a launch speed
        // that rises with pedal (DCT-style launch).
        const tgt = stall + 250 + this.pedal * Math.max(0, this.launchRpm - stall - 250) * 0.85;
        this.clutch = clamp(this.clutch + (rpm - tgt) * 0.0009 * dtc * 60, 0, 1);
      } else {
        this.clutch = Math.min(1, this.clutch + dtc * 6);
      }
      if (this.clutchPedal > 0.5) this.clutch = 0;
    } else {
      this.clutch = 0;
    }
    this.clutchCap = maxT * this.clutch;

    // Automatic gear selection (sporty DCT logic: holds the gear on lift-off,
    // blips down when slowing). Decisions use road speed, not wheel speed, so
    // wheelspin doesn't confuse it.
    this.shiftCool = Math.max(0, this.shiftCool - dtc);
    if (this.autoShift && !this.shift && this.gear > 0 && this.shiftCool <= 0) {
      const red = this.limitRpm;
      const roadRpm = (this.v / v.tire) * G * 9.549;
      const up = this.pedal > 0.6 ? red - 250 : 2600 + 3200 * this.pedal;
      const down = this.pedal > 0.8 ? red * 0.52 : this.pedal > 0.1 ? 1500 + 900 * this.pedal : 1450 + 350 * this.brake;
      if (this.pedal > 0.12 && rpm > up && roadRpm > up * 0.8 && this.gear < v.gears.length && this.clutch > 0.95) this.requestShift(1);
      else if (roadRpm < down && this.gear > 1 && this.v > 3) {
        const G2 = v.gears[this.gear - 2] * v.final;
        if ((this.v / v.tire) * G2 * 9.549 < red - 600) this.requestShift(-1);
      }
    }
    if (this.gear > 1 && this.v < 1.5 && !this.shift && this.pedal < 0.05) this.gear = 1;
  }

  peakTorqueGuess() {
    const boost = this.isTurbo || this.isSC || this.isCentri ? 1 + this.boostTarget / P_AMB : 1;
    return 110 * this.cfg.dispLitres * boost + 50;
  }

  requestShift(dir) {
    const v = this.veh;
    if (this.mode !== 'drive' && this.mode !== 'flyby') return;
    if (this.shift) return;
    const to = clamp(this.gear + dir, 0, v.gears.length);
    if (to === this.gear) return;
    if (this.gear === 0) {
      this.gear = to;
      this.clutch = 0;
      return;
    }
    if (to === 0) {
      this.gear = 0;
      return;
    }
    this.shift = { dir, to, t: 0, phase: 'out' };
    this.shiftCool = dir > 0 ? 1.2 : 0.6;
    if (dir > 0 && this.pedal > 0.3) {
      this.shiftCut = v.shiftTime * 0.45;
      this.shiftRetard = 1;
    }
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

  // One time step of every cylinder: volume change, combustion, valve flows
  // (coupled implicitly to the pipe waves), blow-by. Returns gas torque.
  stepCylinders(crank, rpm) {
    const dt = this.dt;
    const n = this.n;
    const cycle = this.cycle;
    const tabScale = this.tabScale;
    const vol = this.vol, dvd = this.dvd, off = this.off;
    const cm = this.cm, cU = this.cU, cMb = this.cMb, cV = this.cV, cCA = this.cCA, cP = this.cP;
    const cP1 = this.cP1, cP2 = this.cP2;
    const cBurn = this.cBurn, cXb = this.cXb, cQ = this.cQ, cSpark = this.cSpark, cDur = this.cDur;
    const cExEnd = this.cExEnd, cInEnd = this.cInEnd, cRunB = this.cRunB, cExB = this.cExB;
    const ex = this.ex, inn = this.inn;
    const exIn = ex.inW, exOut = ex.outW, exZ = ex.Zm;
    const inIn = inn.inW, inOut = inn.outW, inZ = inn.Zm;
    const hi = this.camHi;
    const exTab = hi ? this.exTabHi : this.exTabLo;
    const inTab = hi ? this.inTabHi : this.inTabLo;
    const ivc = hi ? this.cfg.ivcHi : this.cfg.ivc;
    const evo = hi ? this.cfg.evoHi : this.cfg.evo;
    const evc = this.cfg.evc;
    const rasp = this.rasp26;
    const kLeak = this.kLeak;
    const Tint = this.Tpl;
    const sqTint = Math.sqrt(Tint);
    const Tex = Math.max(450, this.egt * 0.85);
    const sqTex = Math.sqrt(Tex);
    let torque = 0;
    let vtExc = 0;
    let combExc = 0;
    for (let c = 0; c < n; c++) {
      let ca = crank + off[c];
      if (ca >= cycle) ca -= cycle;
      const caPrev = cCA[c];
      cCA[c] = ca;
      const fi = ca * tabScale;
      const i0 = fi | 0;
      const fr = fi - i0;
      const V = vol[i0] + (vol[i0 + 1] - vol[i0]) * fr;
      const dvdth = dvd[i0] + (dvd[i0 + 1] - dvd[i0]) * fr;

      if (caPrev !== ca) {
        if (crossed(caPrev, ca, ivc)) {
          this.onIVC(c, rpm);
          vtExc += 1;
        }
        if (cBurn[c] === 1 && crossed(caPrev, ca, cSpark[c])) cBurn[c] = 2;
        if (crossed(caPrev, ca, evo)) this.onEVO(c);
        if (crossed(caPrev, ca, evc)) vtExc += 1;
      }

      let m = cm[c];
      let U = cU[c];
      const Vo = cV[c];
      const dV = V - Vo;
      U = (U * (1 - (GM1 * 0.5 * dV) / Vo)) / (1 + (GM1 * 0.5 * dV) / V);

      if (cBurn[c] === 2) {
        let ph = ca - cSpark[c];
        if (ph < 0) ph += cycle;
        const x = ph / cDur[c];
        let xb;
        if (x >= 1) {
          xb = 1;
          cBurn[c] = 3;
        } else {
          xb = 1 - Math.exp(-5 * x * x * x);
        }
        U += cQ[c] * (xb - cXb[c]);
        cXb[c] = xb;
        if (xb === 1) cMb[c] = m;
      }

      let T = U / (m * CV);
      let p = (GM1 * U) / V;

      // exhaust valve
      const ae = exTab[i0] + (exTab[i0 + 1] - exTab[i0]) * fr;
      if (ae > 1e-9) {
        const e = cExEnd[c];
        const zm = exZ[e];
        const zc = (GAM * R * T * dt) / V;
        const D = p - P_AMB - 2 * exIn[e];
        let md;
        if (D >= 0) {
          const rho = p / (R * T);
          md = orifice(ae, D, rho, zm + zc, p, Math.sqrt(T), CHOKE);
          // turbulent jet noise through the valve gap
          const vj = md / (rho * ae);
          exOut[e] += (rnd() - 0.5) * md * (vj < 600 ? vj : 600) * rasp;
        } else {
          const pp = P_AMB + 2 * exIn[e];
          md = -orifice(ae, -D, pp / (R * Tex), zm + zc, pp, sqTex, CHOKE);
        }
        exOut[e] += zm * md;
        const dm = md * dt;
        if (dm > 0) {
          U -= dm * CP * T;
          cMb[c] -= (cMb[c] * dm) / m;
        } else {
          // backflow from the port: only as 'burned' as what went out
          U -= dm * CP * Tex;
          cMb[c] -= dm * cExB[c];
        }
        m -= dm;
        if (m < 1e-7) m = 1e-7;
        T = U / (m * CV);
        p = (GM1 * U) / V;
      }

      // intake valve
      const ai = inTab[i0] + (inTab[i0 + 1] - inTab[i0]) * fr;
      if (ai > 1e-9) {
        const e = cInEnd[c];
        const zm = inZ[e];
        const zc = (GAM * R * T * dt) / V;
        const pu = P_AMB + 2 * inIn[e];
        const D = pu - p;
        let md;
        if (D >= 0) md = orifice(ai, D, pu / (R * Tint), zm + zc, pu, sqTint, CHOKE_AIR);
        else md = -orifice(ai, -D, p / (R * T), zm + zc, p, Math.sqrt(T), CHOKE);
        inOut[e] -= zm * md;
        const dm = md * dt;
        if (dm > 0) {
          U += dm * CP * Tint;
          // reverted exhaust gas comes back first and stays burned gas
          const rb = cRunB[c];
          if (rb > 0) {
            const b = dm < rb ? dm : rb;
            cMb[c] += b;
            cRunB[c] = rb - b;
          }
        } else {
          U += dm * CP * T;
          const bOut = (cMb[c] * -dm) / m;
          cMb[c] -= bOut;
          cRunB[c] += bOut;
        }
        m += dm;
        if (m < 1e-7) m = 1e-7;
      }

      // ring leakage (blow-by) toward crankcase
      const leak = (p - P_AMB) * kLeak;
      if (leak > 0 && leak * dt < m * 0.01) {
        U -= leak * dt * CP * T;
        m -= leak * dt;
      }

      const Tmin = m * CV * 180;
      if (U < Tmin) U = Tmin;
      cm[c] = m;
      cU[c] = U;
      cV[c] = V;
      p = (GM1 * U) / V;
      // combustion noise excitation: positive jerk of cylinder pressure
      const jerk = p - 2 * cP1[c] + cP2[c];
      if (jerk > 0) combExc += jerk;
      cP2[c] = cP1[c];
      cP1[c] = p;
      cP[c] = p;
      torque += (p - P_AMB) * dvdth;
    }
    this.torqueGas = torque;
    this.vtExcS = vtExc;
    this.combExcS = combExc;
    return torque;
  }

  // Afterfire pressure sources at exhaust junctions (decaying bangs).
  stepAfterfireSources() {
    const afNodes = this.afNodes;
    const exSrc = this.ex.src;
    for (let k = 0; k < afNodes.length; k++) {
      const nd = afNodes[k];
      let src0 = 0;
      const env = this.afEnv[nd];
      if (env > 1e-4) {
        this.afRise[nd] += (1 - this.afRise[nd]) * 0.35;
        src0 = this.afAmp[nd] * env * this.afRise[nd] * (1 + 0.6 * (rnd() - 0.5));
        this.afEnv[nd] = env * this.afDecay[nd];
      }
      exSrc[nd] = src0;
    }
  }

  // Unburned fuel pools in the exhaust: random ignition -> bang.
  stepAfterfirePools() {
    const afNodes = this.afNodes;
    const dt = this.dt;
    const thresh = this.alsActive ? this.afMin * 4 : this.afMin;
    for (let k = 0; k < afNodes.length; k++) {
      const nd = afNodes[k];
      const f = this.afFuel[nd];
      if (f > thresh) {
        const heat = this.afHeat[nd];
        const air = this.afAir[nd];
        const mix = air / (f * AFR_ST + 1e-9);
        const rate = heat * 90 * (mix > 0.25 ? 1 : mix * 4) * (this.egt > 650 ? 1 : 0.3);
        if (rnd() < rate * dt) {
          const frac = 0.35 + 0.65 * rnd();
          const burnt = Math.min(f, air / AFR_ST + f * 0.3) * frac;
          const E = burnt * LHV;
          this.afFuel[nd] -= burnt;
          this.afAir[nd] = Math.max(0, air - burnt * AFR_ST);
          const amp = Math.min(60000, 36 * Math.pow(E, 0.8)) * (0.7 + 0.6 * rnd());
          this.afAmp[nd] = Math.max(this.afAmp[nd] * this.afEnv[nd], amp);
          this.afEnv[nd] = 1;
          this.afRise[nd] = 0;
          this.afDecay[nd] = Math.exp(-1 / (this.fs * (0.0006 + 0.0022 * rnd())));
          this.afEvents++;
          this.afIntensity = Math.max(this.afIntensity, amp / 30000);
          if (this.isTurbo && this.alsActive) this.wt += (0.07 * E) / (this.tJ * this.nT * Math.max(this.wt, 2000));
        }
        this.afFuel[nd] = f * (1 - dt * 7);
        this.afHeat[nd] = heat * (1 - dt * 3);
      } else if (this.afAir[nd] > 0) {
        this.afAir[nd] *= 1 - dt * 7;
      }
    }
  }

  // Intake runner junctions, plenum boundary and throttle flow.
  stepIntake() {
    const inn = this.inn;
    const inIn = inn.inW, inOut = inn.outW, inY = inn.Y;
    const es = inn.es, ec = inn.ec, ends = inn.ends;
    const junc = inn.junc;
    for (let j = 0; j < junc.length; j++) {
      const nd = junc[j];
      const st = es[nd], cnt = ec[nd];
      let sy = 0, sya = 0;
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        sy += inY[e];
        sya += inY[e] * inIn[e];
      }
      const pj = (2 * sya) / sy;
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        inOut[e] = pj - inIn[e];
      }
    }
    const pg = this.pPl - P_AMB;
    let qr = 0;
    const pls = inn.plenums;
    for (let i = 0; i < pls.length; i++) {
      const nd = pls[i];
      const st = es[nd], cnt = ec[nd];
      for (let k = 0; k < cnt; k++) {
        const e = ends[st + k];
        inOut[e] = pg - inIn[e];
        qr += (pg - 2 * inIn[e]) * inY[e];
      }
    }
    this.runnerFlow = qr;
    // throttle (implicit against plenum compliance)
    const dt = this.dt;
    const boosted = this.boosted;
    const pUp = boosted ? this.pB : P_AMB;
    const Tup = boosted ? this.TB : T_AMB;
    const kpl = (R * this.Tpl * dt) / this.Vpl;
    const pPred = this.pPl - kpl * qr;
    const A = this.thrArea + this.bypass + 2e-6;
    const D = pUp - pPred;
    let md;
    if (D >= 0) md = orifice(A, D, pUp / (R * Tup), kpl, pUp, Math.sqrt(Tup), CHOKE_AIR);
    else md = -orifice(A, -D, this.pPl / (R * this.Tpl), kpl, this.pPl, Math.sqrt(this.Tpl), CHOKE_AIR);
    this.mdTh = md;
    this.mPl += (md - qr) * dt;
    if (this.mPl < 1e-6) this.mPl = 1e-6;
    this.pPl = (this.mPl * R * this.Tpl) / this.Vpl;
  }

  // Turbocharger / supercharger dynamics and their sounds. Returns the torque
  // the crank spends driving a supercharger.
  stepBoost(omega) {
    this.turboSnd = 0;
    if (this.isTurbo || this.isCentri) return this.stepTurbo(omega);
    if (this.isSC) return this.stepBlower(omega);
    return 0;
  }

  stepTurbo(omega) {
    const dt = this.dt, fs = this.fs;
    let scTorque = 0;
    // Greitzer compressor + plenum model; compressor map is a speed line with
    // a peak (surge on its left), scaled with tip speed squared.
    const Ut = this.wt * this.tRtip;
    const mChoke = this.tChokeK * Math.max(Ut, 80) * this.nT;
    const x = this.mc / mChoke;
    const PRm = Math.pow(1 + 2.17e-6 * Ut * Ut, 3.5);
    // Speed line with a peak (positive slope on its left = surge region). In
    // reverse flow the spinning wheel resists like a restriction, so the
    // pressure needed to push air backwards rises: that closes the deep-surge
    // cycle (the "flutter").
    let g;
    if (x >= 1) g = Math.max(-0.6, -2 * (x - 1));
    else if (x >= 0.32) {
      const y = (x - 0.32) / 0.68;
      g = 1 - y * y;
    } else if (x >= 0) {
      const y = (0.32 - x) / 0.32;
      g = 1 - 0.28 * y * y;
    } else g = 0.72 + 3.5 * x * x;
    let pc = P_AMB * (1 + (PRm - 1) * g) - this.tRestr * this.mc * Math.abs(this.mc);
    if (pc < 0.4 * P_AMB) pc = 0.4 * P_AMB;
    const Lc = 0.35, Ac = 0.0016 * this.nT;
    this.mc += (Ac / Lc) * (pc - this.pB) * dt;
    // BOV vent
    let mb = 0;
    if (this.bov > 0.01 && this.pB > P_AMB) {
      const Ab = 4.5e-4 * this.bov;
      mb = orifice(Ab, this.pB - P_AMB, this.pB / (R * this.TB), 0, this.pB, Math.sqrt(this.TB), CHOKE_AIR);
    }
    this.mdBov = mb;
    this.pB += ((R * this.TB) / this.Vb) * (this.mc - this.mdTh - mb) * dt;
    if (!(this.pB > 0.3 * P_AMB)) {
      this.pB = 0.3 * P_AMB;
      if (this.mc < 0) this.mc = 0;
    }
    if (this.pB > 4.5 * P_AMB) this.pB = 4.5 * P_AMB;
    if (!(Math.abs(this.mc) < 5)) this.mc = 0;
    // shaft
    const PR = this.pB / P_AMB;
    const Pc = this.mc > 0 ? (this.mc * 1005 * T_AMB * (Math.pow(PR, 0.2857) - 1)) / 0.7 : -this.mc * 1005 * 25;
    if (this.isTurbo) {
      // smoothed turbine power from the exhaust network's turbine resistor
      let tp = 0;
      for (let i = 0; i < this.turbP.length; i++) {
        tp += this.turbP[i];
        this.turbP[i] = 0;
      }
      const rhoT = (P_AMB * 1.6) / (R * Math.max(600, this.egt));
      this.turbPs += (tp / rhoT - this.turbPs) * 0.002;
      this.turbPsm = Math.max(0, this.turbPs) * 1.5;
      const w = Math.max(this.wt, 300);
      this.wt += ((this.turbPsm * 0.72 - Pc) / (this.tJ * this.nT * w) - this.wt * 0.08) * dt;
      if (this.wt < 0) this.wt = 0;
      const wMax = 560 / this.tRtip;
      if (this.wt > wMax) this.wt = wMax;
    } else {
      // centrifugal supercharger: gear-driven impeller
      this.wt = omega * this.scRatio * 3.2;
      scTorque = Pc / Math.max(omega, 30);
    }
    const Tc = T_AMB * (1 + (Math.pow(Math.max(PR, 1), 0.2857) - 1) / 0.7);
    this.TB = Tc - 0.72 * (Tc - T_AMB);
    this.Tpl = this.TB;
    // sound: blade-pass whistle, shaft whine, inlet whoosh, BOV hiss
    const fShaft = this.wt / TAU;
    this.tPhase += (fShaft * this.blades) / fs;
    this.tPhase -= Math.floor(this.tPhase);
    this.tPhase2 += fShaft / fs;
    this.tPhase2 -= Math.floor(this.tPhase2);
    const flow = Math.abs(this.mc);
    const whistle = Math.sin(TAU * this.tPhase) * (fShaft * this.blades < 17000 ? 1 : 0.3);
    const whine = Math.sin(TAU * this.tPhase2) + 0.3 * Math.sin(2 * TAU * this.tPhase2);
    const nz = rnd() - 0.5;
    this.nzState[0] += (nz - this.nzState[0]) * 0.35;
    const whoosh = nz - this.nzState[0];
    const Utn = Ut / 400;
    let snd =
      (whistle * 0.6 + whine * 0.25) * Utn * Utn * (0.15 + 3 * flow) * 0.8 +
      whoosh * flow * Utn * 5 +
      (rnd() - 0.5) * mb * Math.sqrt(Math.max(0, this.pB - P_AMB)) * 0.3;
    // surge: flow reversal chuffs + the inlet 'thump' of each reversal
    if (this.mc < 0) snd += (rnd() - 0.5) * -this.mc * 90 * (0.3 + Utn);
    const dmc = (this.mc - this.mcPrev) * fs;
    this.mcPrev = this.mc;
    this.mcLp += 0.05 * (dmc - this.mcLp);
    this.turboSnd = snd + this.mcLp * INV4PI * 0.6;
    return scTorque;
  }

  stepBlower(omega) {
    const dt = this.dt, fs = this.fs;
    const wb = omega * this.scRatio;
    const PR = this.pB / P_AMB;
    const ev = clamp(1 - 0.12 * (PR - 1), 0.5, 1);
    const vflow = ((this.scDisp * wb) / TAU) * ev;
    const msc = (P_AMB / (R * T_AMB)) * vflow;
    let mby = 0;
    const Aby = 0.0018 * this.scBypass + 1e-6;
    if (this.pB > P_AMB) mby = orifice(Aby, this.pB - P_AMB, this.pB / (R * this.TB), 0, this.pB, Math.sqrt(this.TB), CHOKE_AIR);
    else mby = -orifice(Aby, P_AMB - this.pB, P_AMB / (R * T_AMB), 0, P_AMB, Math.sqrt(T_AMB), CHOKE_AIR);
    this.pB += ((R * this.TB) / this.Vb) * (msc - this.mdTh - mby) * dt;
    if (this.pB < 0.4 * P_AMB) this.pB = 0.4 * P_AMB;
    const eta = this.fiType === 'twinscrew' ? 0.7 : 0.55;
    const P = (msc * 1005 * T_AMB * (Math.pow(Math.max(PR, 1), 0.2857) - 1)) / eta + msc * 2000;
    const Tc = T_AMB * (1 + (Math.pow(Math.max(PR, 1), 0.2857) - 1) / eta);
    this.TB = Tc - 0.65 * (Tc - T_AMB);
    this.Tpl = this.TB;
    // rotor whine at the lobe-passing frequency
    this.scPhase += ((wb / TAU) * this.scLobes) / fs;
    this.scPhase -= Math.floor(this.scPhase);
    const ph = TAU * this.scPhase;
    const wv = Math.sin(ph) + 0.45 * Math.sin(2 * ph + 0.3) + 0.2 * Math.sin(3 * ph + 1.1);
    this.turboSnd = wv * (wb / 1000) * (0.25 + 1.5 * Math.max(0, PR - 1) + 0.6 * msc) * 0.18;
    return P / Math.max(omega, 30);
  }

  // Crank, clutch, wheels and car. Returns the new crank speed.
  stepDrivetrain(omega, torque, scTorque) {
    const dt = this.dt;
    let tq = torque - this.fric * ftanh(omega * 0.5) - scTorque;
    if (this.starter) tq += this.starterTq * Math.max(0, 1 - omega / 32);
    let load = 0;
    if (this.mode === 'dyno') {
      load = this.dynoLoad;
    } else if (this.gear > 0 && this.clutchCap > 0) {
      const v = this.veh;
      const G = v.gears[this.gear - 1] * v.final;
      const slipW = omega - this.ww * G;
      const Jwe = this.Jw + 0.04 * G * G;
      const kmax = 0.45 / (this.clutchCap * dt * (1 / this.J + (G * G) / Jwe) + 1e-9);
      const k = kmax < 0.6 ? kmax : 0.6;
      load = this.clutchCap * ftanh(slipW * k);
      this.clutchT = load;
      // wheel & car
      const vv = this.v;
      const slipV = this.ww * v.tire - vv;
      const Nz = this.axleLoad + this.loadTransfer * Math.max(0, this.accel);
      const as = slipV < 0 ? -slipV : slipV;
      const mu = v.mu * ftanh(slipV / 0.55) * (1 - 0.22 * clamp((as - 1.5) / 8, 0, 1));
      const Fx = Nz * mu;
      const brakeT = this.brake * this.brakeK * v.tire * 0.45 * ftanh(this.ww * 4);
      this.ww += ((load * G * 0.92 - Fx * v.tire - brakeT) / Jwe) * dt;
      const drag = this.dragK * vv * vv + this.rollK * ftanh(vv * 2);
      const brakeF = this.brake * this.brakeK * 0.55 * ftanh(vv * 3);
      const acc = (Fx - drag - brakeF) / v.mass;
      this.accel = acc;
      this.v = vv + acc * dt;
      if (this.v < 0 && this.brake > 0.05) this.v = 0;
      this.slip = slipV;
      this.gearTorque = load;
    } else if (this.mode === 'drive' || this.mode === 'flyby') {
      // coasting in neutral / clutch open
      const v = this.veh;
      const vv = this.v;
      const drag = this.dragK * vv * vv + this.rollK * ftanh(vv * 2);
      const brakeF = this.brake * this.brakeK * ftanh(vv * 3);
      this.accel = (-drag - brakeF) / v.mass;
      this.v = Math.max(0, vv + this.accel * dt);
      this.ww = this.v / v.tire;
      this.slip = 0;
      this.clutchT = 0;
      this.gearTorque = 0;
    }
    this.pos += this.v * dt;
    const net = torque - this.fric - scTorque;
    this.telTq += net;
    this.telN++;
    this.cycTq += net;
    this.cycN++;
    const w = omega + ((tq - load) / this.J) * dt;
    return w > 0 ? w : 0;
  }

  // Intake, mechanical and chassis sources; write all sources (Pa at 1 m)
  // into the listener's delay lines; scope capture.
  stepSources(rpm, omega, lis) {
    const fs = this.fs;
    const snd = this.snd;
    const src = this.srcBuf;

    // Snorkel/airbox: d/dt of throttle mass flow through a low-pass airbox;
    // ITB/velocity stacks radiate the runner mouths directly.
    const dq = (this.mdTh - this.mdThPrev) * fs;
    this.mdThPrev = this.mdTh;
    const ibA = this.ibA;
    this.ibLp1 += ibA * (dq - this.ibLp1);
    this.ibLp2 += ibA * (this.ibLp1 - this.ibLp2);
    let intake = this.ibLp2 * (1 - this.itb * 0.6);
    if (this.itb) {
      const dr = (this.runnerFlow - this.runnerFlowPrev) * fs;
      this.itbLp += this.itbA * (dr - this.itbLp);
      intake += this.itbLp * 0.55;
    }
    this.runnerFlowPrev = this.runnerFlow;
    // throttle hiss at part throttle (high velocity across the plate)
    if (this.pPl < P_AMB * 0.8 && this.mdTh > 0) {
      const nz = rnd() - 0.5;
      this.hissLp += 0.5 * (nz - this.hissLp);
      intake += (nz - this.hissLp) * this.mdTh * 30 * (1 - this.pPl / P_AMB);
    }
    intake = intake * INV4PI * snd.intake + this.turboSnd;

    // mechanical: valve seating ticks + combustion knock through the block
    if (rpm > 30 && this.vtExcS > 0) {
      const r6 = rpm / 6000;
      this.vtExc += this.vtExcS * r6 * (r6 + 0.15) * this.vtK * (0.7 + 0.6 * rnd());
    }
    const vtOut = this.valvetrain.tick(this.vtExc * (rnd() * 0.5 + 0.75));
    this.vtExc *= 0.2;
    const cb = this.block.tick(this.combExcS * 1e-4);
    let mech = (vtOut * 7 + cb * 0.04) * snd.mech;
    // straight-cut / gearbox whine
    if (this.gear > 0 && this.clutch > 0.5) {
      const fin = (this.ww * this.veh.final) / TAU;
      this.gearPhase += (fin * 29) / fs;
      this.gearPhase -= Math.floor(this.gearPhase);
      const amp = this.gearK * (0.02 + Math.abs(this.gearTorque) / 400) * Math.min(1, fin / 20);
      mech += Math.sin(TAU * this.gearPhase) * amp + Math.sin(2 * TAU * this.gearPhase + 1) * amp * 0.4;
    }
    // starter motor
    if (this.starter) {
      const fr = (omega / TAU) * 138;
      this.starterPhase += (fr + 40) / fs;
      this.starterPhase -= Math.floor(this.starterPhase);
      const ph = this.starterPhase;
      mech += ((ph < 0.5 ? 1 : -1) * 0.35 + Math.sin(TAU * ph * 3) * 0.25 + (rnd() - 0.5) * 0.3) * 0.8;
    }

    // chassis: road, wind, tyre squeal
    let chassis = 0;
    if (this.v > 0.3) {
      const vv = this.v;
      const nz = rnd() - 0.5;
      this.roadLp += 0.02 * (nz - this.roadLp);
      this.windLp1 += 0.15 * (nz - this.windLp1);
      this.windLp2 += 0.03 * (this.windLp1 - this.windLp2);
      chassis += this.roadLp * vv * 0.35 + (this.windLp1 - this.windLp2) * vv * vv * 0.0025;
    }
    const sl = Math.abs(this.slip);
    if (sl > 1.2 && this.gear > 0) {
      this.sqPhase += (820 + 180 * Math.sin(this.pos * 3 + sl) + (rnd() - 0.5) * 300) / fs;
      this.sqPhase -= Math.floor(this.sqPhase);
      chassis += Math.sin(TAU * this.sqPhase) * Math.min(1, (sl - 1.2) / 4) * 1.4;
    }

    // assemble sources (Pa at 1 m)
    const exG = this.exG;
    const buf = lis.buf;
    const w = lis.w;
    buf[w] = src[0] * exG;
    buf[SRC_BUF + w] = src[1] * exG;
    buf[2 * SRC_BUF + w] = src[2] * exG;
    buf[3 * SRC_BUF + w] = intake;
    buf[4 * SRC_BUF + w] = mech;
    buf[5 * SRC_BUF + w] = chassis;
    lis.w = (w + 1) & SRC_MASK;

    // scope capture (tail pipe sum, cylinder 1 pressure & volume)
    const sw = this.scopeW;
    this.scopeBuf[sw] = (src[0] + src[1] + src[2]) * exG;
    this.scopeP[sw] = this.cP[0];
    this.scopeV[sw] = this.cV[0];
    this.scopeW = (sw + 1) & 16383;
    const ca0 = this.cCA[0];
    if (crossed(this.scopePrevCA, ca0, this.tdcFire)) this.onScopeCycle();
    this.scopePrevCA = ca0;
  }

  // Snapshot of cylinders + pressure along every exhaust pipe (visualiser).
  captureSnap() {
    const n = this.n;
    const ex = this.ex;
    const P = 10;
    const a = new Float32Array(8 + n * 4 + ex.S * P);
    a[0] = this.crank;
    a[1] = this.rpm;
    a[2] = this.egt;
    a[3] = this.pPl;
    a[4] = this.pB;
    a[5] = this.valveOpen;
    a[6] = this.wg;
    a[7] = this.bov;
    let o = 8;
    const exT = this.camHi ? this.exTabHi : this.exTabLo;
    const inT = this.camHi ? this.inTabHi : this.inTabLo;
    if (!this.maxAe) {
      let me = 1e-9, mi = 1e-9;
      for (let i = 0; i < exT.length; i++) {
        if (exT[i] > me) me = exT[i];
        if (inT[i] > mi) mi = inT[i];
      }
      this.maxAe = me;
      this.maxAi = mi;
    }
    for (let c = 0; c < n; c++) {
      const i0 = (this.cCA[c] * this.tabScale) | 0;
      a[o++] = this.cP[c] / 1e5;
      a[o++] = exT[i0] / this.maxAe;
      a[o++] = inT[i0] / this.maxAi;
      a[o++] = this.cBurn[c] === 2 ? this.cXb[c] + 0.01 : 0;
    }
    for (let k = 0; k < ex.S; k++) {
      ex.sampleSeg(k, P, a, o);
      o += P;
    }
    return a;
  }

  onScopeCycle() {
    const end = this.scopeW;
    let len = (end - this.scopeStart) & 16383;
    this.scopeStart = end;
    if (len < 64 || len > 16000) return;
    if (this.scopeReady) return; // previous not yet posted
    const N = 360;
    const sig = new Float32Array(N);
    const pr = new Float32Array(N);
    const vo = new Float32Array(N);
    const st = (end - len) & 16383;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * len;
      const i0 = a | 0;
      const idx = (st + i0) & 16383;
      sig[i] = this.scopeBuf[idx];
      pr[i] = this.scopeP[idx];
      vo[i] = this.scopeV[idx];
    }
    this.scopeReady = { sig, pr, vo };
  }

  // Render all sources for both ears; returns [L, R] (normalised).
  listen(L) {
    const buf = L.buf;
    const w = (L.w - 1) & SRC_MASK;
    let l = 0, r = 0;
    const dC = L.dCur, dI = L.dInc, gC = L.gCur, gI = L.gInc, al = L.al, z1 = L.z1, z2 = L.z2;
    for (let s = 0; s < N_SRC; s++) {
      if (!L.active[s]) continue;
      const base = s * SRC_BUF;
      for (let k = 0; k < 4; k++) {
        const t = s * 4 + k;
        const g = gC[t];
        gC[t] = g + gI[t];
        const d = dC[t];
        dC[t] = d + dI[t];
        if (g === 0) continue;
        const pos = w - d;
        const fl = Math.floor(pos);
        const f = pos - fl;
        const i1 = fl & SRC_MASK;
        const y1 = buf[base + i1];
        const y2 = buf[base + ((i1 + 1) & SRC_MASK)];
        let x;
        if (L.moving) {
          // cubic Hermite for clean Doppler
          const y0 = buf[base + ((i1 - 1) & SRC_MASK)];
          const y3 = buf[base + ((i1 + 2) & SRC_MASK)];
          const c1 = 0.5 * (y2 - y0);
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
          x = ((c3 * f + c2) * f + c1) * f + y1;
        } else x = y1 + (y2 - y1) * f;
        let y = z1[t] + al[t] * (x - z1[t]);
        z1[t] = y;
        y = z2[t] + al[t] * (y - z2[t]);
        z2[t] = y;
        if (k & 1) r += y * g;
        else l += y * g;
      }
    }
    if (L.cabin) {
      // body boom resonance
      const m = (l + r) * 0.5;
      L.boom1 += 0.012 * (m - L.boom1);
      L.boom2 += 0.012 * (L.boom1 - L.boom2);
      const b = (L.boom1 - L.boom2) * 2.2;
      l += b;
      r += b;
    }
    const k = 0.02 * this.snd.trim * this.fade;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + 1 / 2400);
    this.telSpl += l * l + r * r;
    this.telSplN++;
    const o = this._o || (this._o = [0, 0]);
    o[0] = softclip(l * k);
    o[1] = softclip(r * k);
    return o;
  }
}

function softclip(x) {
  const a = x < 0 ? -x : x;
  if (a < 0.75) return x;
  const y = 0.75 + 0.25 * ftanh((a - 0.75) * 4);
  return x < 0 ? -y : y;
}

// ---------------------------------------------------------------------------
// Scene: camera / source geometry -> listener tap parameters
// ---------------------------------------------------------------------------

const CAMERAS = {
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
  return [
    [-0.5, 0.35, -2.3], // exL
    [0.5, 0.35, -2.3], // exR
    [0.0, 0.35, -2.3], // exC
    [0.0, intY, intZ], // intake
    [0.0, 0.7, engZ], // mech
    [0.0, 0.3, 0.0], // chassis
  ];
}

// ---------------------------------------------------------------------------
// AudioWorkletProcessor
// ---------------------------------------------------------------------------

class EngineProcessor extends AudioWorkletProcessor {
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
        if (m.pedal != null) this.sim.pedal = clamp(m.pedal, 0, 1);
        if (m.brake != null) this.sim.brake = clamp(m.brake, 0, 1);
        if (m.clutch != null) this.sim.clutchPedal = m.clutch;
        if (m.launch != null) this.sim.launch = !!m.launch;
        break;
      case 'ignition':
        if (!this.sim) return;
        this.sim.ignition = !!m.on;
        if (m.on && m.crank) {
          this.sim.starter = true;
          this.sim.starterT = 0;
          this.sim.coldT = m.cold ? 1 : 0;
          // the ECU fires only once it has seen the cam and crank signals
          if (!this.sim.running) {
            this.sim.crankRevs = 0;
            this.sim.syncRevs = 1.6 + 1.4 * rnd();
          }
        }
        if (!m.on) this.sim.starter = false;
        break;
      case 'shift':
        this.sim?.requestShift(m.dir);
        break;
      case 'mode':
        if (!this.sim) return;
        this.sim.mode = m.mode;
        if (m.mode !== 'drive' && m.mode !== 'flyby') {
          this.sim.gear = 0;
          this.sim.v = 0;
        } else if (this.sim.gear === 0) this.sim.gear = 1;
        if (m.mode !== 'flyby') this.flyby = null;
        this.updateScene(0);
        break;
      case 'camera':
        this.camera = m.camera;
        this.updateScene(0);
        break;
      case 'tune':
        if (this.sim) this.applyTune(this.sim, m.tune);
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
        } else if (this.sim.dyno) {
          this.sim.dyno.active = false;
          this.sim.pedal = 0;
        }
        break;
      case 'flyby':
        this.startFlyby(m);
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
    if (t.bov != null) sim.bovType = t.bov;
    if (t.tc != null) sim.tc = !!t.tc;
  }

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
    s.ww = w / G;
    s.v = s.ww * v.tire;
    s.omega = w;
    s.autoShift = true;
    const dist = m.distance ?? 220;
    this.flyby = { t: 0, style: m.style ?? 'wot', start: -dist, x: -dist, done: false, lifted: false };
    s.pos = 0;
    this.updateScene(0);
  }

  // Compute listener tap targets for the current camera and car pose.
  updateScene(blockLen) {
    const sim = this.sim;
    const L = this.L;
    if (!sim) return;
    const cam = CAMERAS[this.camera] ?? CAMERAS.rear;
    const flyby = sim.mode === 'flyby' && this.flyby;
    const srcs = sourcePositions(sim.cfg);
    const fs = sim.fs;
    let carX = 0, carZ = 0;
    let lisPos, lisRight;
    if (flyby) {
      carZ = this.flyby.x;
      carX = 0;
      lisPos = [CAMERAS.flyby.lateral, 1.4, 0];
      lisRight = [0, 0, 1]; // facing the road (-x): right ear toward +z
    } else {
      lisPos = cam.pos;
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
    const active = [
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 0),
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 1),
      sim.ex.opens.some((_, i) => sim.ex.oCh[i] === 2),
      true,
      true,
      sim.mode === 'drive' || sim.mode === 'flyby',
    ];
    const n = blockLen || 1;
    const layout = sim.cfg.vehicle.layout;
    for (let s = 0; s < N_SRC; s++) {
      L.active[s] = active[s] ? 1 : 0;
      const sp = srcs[s];
      const wx = carX + sp[0], wy = sp[1], wz = carZ + sp[2];
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
          gain = 1 / Math.max(r, 0.35);
          // air absorption + ground impedance
          fc = 18000 / (1 + r / 70);
          if (path === 1) {
            gain *= 0.62;
            fc = Math.min(fc, 5200);
          }
          // tail pipes radiate backwards: brighter on axis
          if (s <= 2) {
            const cosA = dz / (r || 1); // +1 when the listener is right behind the pipes
            fc *= 0.35 + 0.65 * (0.5 + 0.5 * cosA);
            gain *= 0.8 + 0.35 * cosA;
          }
          // head shadow
          const dot = (dx * lisRight[0] + dz * lisRight[2]) / (r || 1);
          const facing = sgn * dot;
          if (facing < 0) {
            fc *= 0.55 + 0.45 * (1 + facing);
            gain *= 0.8 + 0.2 * (1 + facing);
          }
          if (cabin) {
            if (path === 1) {
              gain = 0;
            } else if (s <= 2) {
              gain *= 0.3;
              fc = 520;
            } else if (s === 3) {
              gain *= layout === 'front' ? 0.35 : 0.9;
              fc = layout === 'front' ? 1500 : 3200;
            } else if (s === 4) {
              gain *= 0.45;
              fc = 1800;
            } else {
              gain *= 1.3;
              fc = 900;
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
        }
      }
    }
    L.first = false;
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
      sim.strobeOn = old.strobeOn;
      sim.tc = old.tc;
      sim.strobeStep = old.strobeStep;
      for (const k of ['limitRpm', 'limiterType', 'burble', 'antilag', 'boostTarget', 'launchRpm', 'bovType']) if (!tune) sim[k] = old[k];
    }
    if (tune) this.applyTune(sim, tune);
    if (hot && old) {
      // Same car, new hardware: carry the running state across.
      for (const k of ['omega', 'ignition', 'running', 'gear', 'v', 'ww', 'pos', 'clutch', 'pedal', 'thr', 'thrCmd', 'brake', 'idleI', 'egt', 'egtInst', 'launch', 'dyno', 'dynoI', 'dynoLoad', 'mode', 'flare', 'coldT', 'accel'])
        sim[k] = old[k];
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
    // flyby script
    if (sim.mode === 'flyby' && this.flyby) this.flybyStep(nF / this.fs);
    if (sim.mode === 'flyby') this.updateScene(sim.fs === this.fs ? nF : nF >> 1);
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
    };
    s.afEvents = 0;
    s.afIntensity = 0;
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

registerProcessor('engine-processor', EngineProcessor);
