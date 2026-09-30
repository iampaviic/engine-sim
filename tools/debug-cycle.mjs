// Dump one cylinder's thermodynamic cycle at a held rpm/throttle.
//   node tools/debug-cycle.mjs <preset> <rpm> <pedal>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorklet } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { compileEngine, workletConfig } = await import(pathToFileURL(path.join(root, 'js/engine/compile.js')).href);
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);

const [id = 'v8-ls', rpmS = '4000', pedS = '1'] = process.argv.slice(2);
const spec = PRESETS.find((p) => p.id === id);
const { Proc } = await loadWorklet(48000);
const proc = new Proc();
const cfg = workletConfig(compileEngine(spec));
proc.port.onmessage({ data: { type: 'config', cfg } });
const sim = proc.sim;
sim.ignition = true;
sim.running = true;
sim.pedal = +pedS;
sim.thrCmd = +pedS;
sim.thr = +pedS;
const w = +rpmS / 9.5493;
const L = new Float32Array(128), R = new Float32Array(128);
// hold rpm by resetting omega each block (infinite-inertia dyno)
for (let i = 0; i < 48000 * 1.5 / 128; i++) {
  sim.omega = w;
  proc.process([], [[L, R]]);
}
// Now sample one full cycle of cylinder 0 at every sample
const rows = [];
const n = Math.round((sim.cycle / 360) * (60 / +rpmS) * 48000);
const e = sim.cExEnd[0];
let torqueSum = 0;
for (let i = 0; i < n; i++) {
  sim.omega = w;
  sim.render(L.subarray(0, 1), R.subarray(0, 1), 1, proc.L);
  const T = sim.cU[0] / (sim.cm[0] * 287 / 0.34);
  rows.push([sim.cCA[0], sim.cP[0] / 1e5, T, sim.cm[0] * 1e6, sim.cV[0] * 1e6, sim.cBurn[0], sim.cXb[0], (101325 + sim.ex.inW[e] + sim.ex.outW[e]) / 1e5]);
  torqueSum += sim.torqueGas;
}
console.log('ca    p(bar)   T(K)   m(mg)   V(cc)  burn  xb   pPort(bar)');
for (let i = 0; i < rows.length; i += Math.max(1, Math.floor(rows.length / 90))) {
  const r = rows[i];
  console.log(r[0].toFixed(1).padStart(6), r[1].toFixed(3).padStart(8), r[2].toFixed(0).padStart(6), r[3].toFixed(1).padStart(7), r[4].toFixed(1).padStart(7), String(r[5]).padStart(4), r[6].toFixed(2).padStart(5), r[7].toFixed(3).padStart(8));
}
const avgT = torqueSum / n;
console.log('avg gas torque (Nm):', avgT.toFixed(1), ' friction:', sim.fric.toFixed(1), ' net:', (avgT - sim.fric).toFixed(1), ' MAP:', (sim.pPl / 1e5).toFixed(3), 'EGT', sim.egt.toFixed(0));
console.log('power (kW):', (((avgT - sim.fric) * w) / 1000).toFixed(1), ' hp:', (((avgT - sim.fric) * w) / 745.7).toFixed(0));
