// The waveguide pipe network: every intake runner and exhaust pipe is a pair
// of delay lines carrying travelling pressure waves, joined at scattering
// nodes (junctions, ports, open ends, resistors, plenums).

import { DYN_TURBINE, NODE_CLOSED, NODE_JUNCTION, NODE_OPEN, NODE_PLENUM, NODE_PORT, NODE_RESISTOR, P_AMB, PI, R, T_AMB, TAU } from './constants.js';
import { clamp, gauss, lpCoef } from './dsp.js';

export class Net {
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
    this.rKstep = new Float64Array(nr).fill(1); // per-sample ramp toward a new K
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

    // Jet noise: the gas leaving a tail pipe tears into the still air and
    // the mixing layer roars, broadband, louder the faster it goes.
    this.jet = hot && no > 0;
    this.jD = new Float64Array(no); // tail pipe bore, m
    this.jU = new Float64Array(no); // exit velocity per unit of outflow
    this.jUs = new Float64Array(no); // exit velocity, the turbulence's view
    this.jUm = new Float64Array(no); // mean exit velocity
    this.jHp = new Float64Array(no);
    this.jHp2 = new Float64Array(no);
    this.jLp = new Float64Array(no);
    this.jA1 = new Float64Array(no);
    this.jA2 = new Float64Array(no);
    this.jG = new Float64Array(no);
    for (let i = 0; i < no; i++) {
      const n = this.opens[i];
      this.jD[i] = 2 * this.np[n * 4 + 1];
    }
    this.jUa = lpCoef(1500, fs);
    this.jMa = lpCoef(4, fs);
    this.jRs = 0x6d2b79f5; // its own random stream: the rest is unchanged
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
      if (this.jet) this.jetTune(i, k);
    }
  }

  // Jet noise for open end i (tail segment k), control rate. Mixing noise
  // peaks at a Strouhal number of about 0.2 (f = 0.2 U/D) and falls away
  // either side. A hot jet at low Mach makes acoustic power ~ U^6 D^2, so
  // pressure ~ U^3 D: about 0.5 Pa at 1 m for 100 m/s out of a 70 mm pipe
  // (Lighthill, plus the excess noise of a hot jet).
  jetTune(i, k) {
    const fs = this.fs;
    const c = this.segC[k];
    // outflow is mass flow; the gas leaving is at ambient pressure
    this.jU[i] = (c * c) / (1.33 * P_AMB * this.area[k]);
    const D = this.jD[i];
    const fp = clamp((0.2 * Math.max(this.jUm[i], 20)) / D, 80, 0.15 * fs);
    const f1 = 0.5 * fp, f2 = 2 * fp;
    this.jA1[i] = lpCoef(f1, fs);
    this.jA2[i] = lpCoef(f2, fs);
    // band-passed uniform noise -> unit rms, then Pa at 1 m per (m/s)^3,
    // scaled to the source units (d(mdot)/dt; the listener divides by 4π)
    let pw = 0;
    for (let j = 0; j < 48; j++) {
      const f = f1 * Math.pow(2, (j - 12) / 4);
      const h = (f / f1) ** 4 / (1 + (f / f1) ** 2) ** 2 / (1 + (f / f2) ** 2);
      pw += h * f * 0.1733; // 1/4-octave steps: df = f ln2 / 4
    }
    const rms = Math.sqrt(pw / (6 * fs)); // uniform noise: σ² = 1/12 over fs/2
    this.jG[i] = ((0.5 * (D / 0.07)) / 1e6 / rms) * 4 * PI;
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
    const res = this.res, rR = this.rR, rK = this.rK, rU = this.rU, rDyn = this.rDyn, rIdx = this.rIdx, rKstep = this.rKstep;
    for (let i = 0; i < res.length; i++) {
      const nd = res[i];
      const e1 = ends[es[nd]], e2 = ends[es[nd] + 1];
      const a1 = inW[e1], a2 = inW[e2];
      const Z1 = Zm[e1], Z2 = Zm[e2];
      const B = rR[i] + Z1 + Z2;
      const D = 2 * (a1 - a2);
      const K = (rK[i] *= rKstep[i]);
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
    src[6] = 0;
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
      if (this.jet) {
        // gas drawn back in makes a much weaker jet (inside the pipe)
        let u = q * this.jU[i];
        if (u < 0) u *= -0.3;
        if (u > 300) u = 300;
        const us = (this.jUs[i] += this.jUa * (u - this.jUs[i]));
        this.jUm[i] += this.jMa * (us - this.jUm[i]);
        if (us > 4) {
          let r = this.jRs;
          r ^= r << 13;
          r ^= r >>> 17;
          r ^= r << 5;
          this.jRs = r;
          // turbulence as strong as the gas is fast at this instant, so it
          // chuffs with every pulse; band-passed after that, since the far
          // field hears the stresses' second time derivative (no rumble):
          // two high-pass poles below the peak, one low-pass above it
          const x = ((r >>> 0) * 2.3283064365386963e-10 - 0.5) * us * us * us;
          const a1 = this.jA1[i];
          const h1 = x - (this.jHp[i] += a1 * (x - this.jHp[i]));
          const h2 = h1 - (this.jHp2[i] += a1 * (h1 - this.jHp2[i]));
          src[oCh[i]] += (this.jLp[i] += this.jA2[i] * (h2 - this.jLp[i])) * this.jG[i];
        }
      }
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
