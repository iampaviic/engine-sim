// Factory knock calibration: run a WOT dyno sweep with a desensitised knock
// model, find the peak Livengood-Wu integral, and suggest the per-engine
// calibration that leaves the stock engine a fixed margin below knock.
//   node tools/knockcal.mjs [id ...]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
const ids = process.argv.slice(2);
const list = ids.length ? PRESETS.filter((p) => ids.includes(p.id)) : PRESETS;
const GENERIC = 0.35; // KNOCK_CAL in the worklet
const MARGIN = 0.8; // stock engines peak at 80% of the knock threshold
const out = {};
for (const p of list) {
  const spec = { ...p, ecu: { ...p.ecu, knockCal: GENERIC * 0.2 } };
  let peak = 0;
  const scen = [[0, { type: 'ignition', on: true, crank: true }], [2.0, { type: 'dyno', action: 'start' }]];
  await render(spec, scen, {
    duration: 13,
    fs: 24000,
    onBlock: (proc, t) => {
      const s = proc.sim;
      // steady full load only: the dyno sweep after its settle phase
      if (t < 3.6 || s.mode !== 'dyno') return;
      for (let c = 0; c < s.n; c++) if (s.cKi[c] > peak) peak = s.cKi[c];
    },
  });
  const unit = peak / (GENERIC * 0.2); // integral per unit calibration
  const cal = +((MARGIN / unit)).toFixed(3);
  out[p.id] = cal;
  console.log(`${p.id.padEnd(12)} peak ${peak.toFixed(3)} -> knockCal ${cal}`);
}
console.log(JSON.stringify(out));
