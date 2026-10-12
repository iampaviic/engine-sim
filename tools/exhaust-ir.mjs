// Impulse response of a preset's exhaust network: a mass-flow impulse into one
// port -> radiated pressure at the tail pipes. Writes a CSV of the magnitude
// response (dB) for plotting.
//   node tools/exhaust-ir.mjs <preset> [egtK] [cyl]
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorklet } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { compileEngine, workletConfig } = await import(pathToFileURL(path.join(root, 'js/engine/compile.js')).href);
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);

const [id = 'v8-ls', egtS = '900', cylS = '0'] = process.argv.slice(2);
const spec = PRESETS.find((p) => p.id === id);
const fs = 48000;
const { Proc } = await loadWorklet(fs);
const proc = new Proc();
proc.port.onmessage({ data: { type: 'config', cfg: workletConfig(compileEngine(spec)) } });
const Net = proc.sim.ex.constructor;
const net = new Net(proc.sim.cfg.ex, fs, true);
net.setGasTemp(+egtS);
const e0 = proc.sim.cExEnd[+cylS];
const N = 1 << 15;
const out = new Float64Array(N);
const { inW, outW, Zm, Y } = net;
let qPrev = new Float64Array(net.opens.length);
for (let n = 0; n < N; n++) {
  const t = net.t;
  for (let l = 0; l < net.L; l++) {
    const pos = t - net.delay[l];
    const i0 = pos | 0, fr = pos - i0;
    const o = net.lineOff[l], m = net.lineMask[l];
    const a = net.buf[o + (i0 & m)];
    const x = a + (net.buf[o + ((i0 + 1) & m)] - a) * fr;
    const z = net.lz[l] + net.la1[l] * (x - net.lz[l]);
    net.lz[l] = z;
    const d = net.ld[l] + net.ldA * (z - net.ld[l]);
    net.ld[l] = d;
    inW[l ^ 1] = d + (z - d) * net.lg[l];
  }
  for (const e of net.portEnds) outW[e] = inW[e];
  if (n === 0) outW[e0] += Zm[e0] * 1.0 * fs; // unit mass impulse (1 kg over one sample)
  for (const nd of net.junc) {
    const st = net.es[nd], cnt = net.ec[nd];
    let sy = 0, sya = 0;
    for (let k = 0; k < cnt; k++) {
      const e = net.ends[st + k];
      sy += Y[e];
      sya += Y[e] * inW[e];
    }
    const pj = (2 * sya) / sy;
    for (let k = 0; k < cnt; k++) {
      const e = net.ends[st + k];
      outW[e] = pj - inW[e];
    }
  }
  for (let i = 0; i < net.res.length; i++) {
    const nd = net.res[i];
    const e1 = net.ends[net.es[nd]], e2 = net.ends[net.es[nd] + 1];
    const a1 = inW[e1], a2 = inW[e2];
    const B = net.rR[i] + Zm[e1] + Zm[e2];
    const U = (2 * (a1 - a2)) / B; // linearised (K ignored for small signals)
    outW[e1] = a1 - Zm[e1] * U;
    outW[e2] = a2 + Zm[e2] * U;
  }
  let rad = 0;
  for (let i = 0; i < net.opens.length; i++) {
    const e = net.ends[net.es[net.opens[i]]];
    const a = inW[e];
    const lp = net.oLp[i] + net.oAl[i] * (a - net.oLp[i]);
    net.oLp[i] = lp;
    const b = -net.oR[i] * lp;
    outW[e] = b;
    const q = (a - b) * Y[e];
    rad += (q - qPrev[i]) * fs;
    qPrev[i] = q;
  }
  out[n] = rad / (4 * Math.PI);
  for (let l = 0; l < net.L; l++) net.buf[net.lineOff[l] + (t & net.lineMask[l])] = outW[l];
  net.t++;
}
// DFT magnitude on log-spaced frequencies
const rows = ['f,db'];
for (let k = 0; k < 400; k++) {
  const f = 20 * Math.pow(1000, k / 399);
  let re = 0, im = 0;
  const w = (2 * Math.PI * f) / fs;
  for (let n = 0; n < N; n++) {
    re += out[n] * Math.cos(w * n);
    im -= out[n] * Math.sin(w * n);
  }
  rows.push(`${f.toFixed(1)},${(10 * Math.log10(re * re + im * im + 1e-30)).toFixed(2)}`);
}
const file = process.argv[5] || `/tmp/ir-${id}.csv`;
writeFileSync(file, rows.join('\n'));
let e = 0;
for (let n = 0; n < N; n++) e += out[n] * out[n];
console.log('IR energy', e.toExponential(3), '->', file);
