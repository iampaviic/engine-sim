// Engine temperature against time: start a preset cold, idle it or drive it
// at a steady speed, then switch off and let it soak. The running part is the
// real worklet (at 24 kHz, for speed); the soak after it is the same thermal
// step the worklet takes when the engine is stopped, run in big steps.
//   node tools/warmup.mjs <preset> <idle|drive> [minutes running] [minutes off] [out.csv]
// drive holds 80 km/h on a level road.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { soakThermal } = await import(pathToFileURL(path.join(root, 'js/audio/worklet/sim/thermal.js')).href);

const [id = 'v8-ls', how = 'idle', runMin = '10', offMin = '60', out] = process.argv.slice(2);
const runS = +runMin * 60;
const rows = [['min', 'rpm', 'kmh', 'coolant', 'oil', 'block', 'manifold', 'exhaust', 'thermostat', 'fan']];
const C = (k) => (k - 273.15).toFixed(1);
const row = (t, rpm, v, s) => rows.push([(t / 60).toFixed(2), rpm.toFixed(0), (v * 3.6).toFixed(0), C(s.h), C(s.o), C(s.b), C(s.m), C(s.x), s.th.toFixed(2), s.fan ? 1 : 0]);

const scen = [[0, { type: 'ignition', on: true, crank: true }]];
if (how === 'drive') scen.push([2, { type: 'mode', mode: 'drive' }]);
let next = 0;
let iTerm = 0;
const r = await render(id, scen, {
  fs: 24000,
  thermal: 'cold',
  duration: runS,
  onBlock: (proc, t) => {
    const s = proc.sim;
    if (how === 'drive' && t > 2.5) {
      // a driver holding 80 km/h: PI on the pedal, every block
      const e = 80 / 3.6 - s.v;
      iTerm = Math.max(0, Math.min(0.6, iTerm + e * 0.0004));
      s.pedal = Math.max(0, Math.min(1, 0.08 * e + iTerm));
    }
    if (t >= next) {
      row(t, s.rpm, s.v, s.th);
      next += 10;
    }
  },
});
// switch off, then soak
const sim = r.proc.sim;
const st = { ...sim.th };
for (let t = 0; t < +offMin * 60; t += 10) {
  soakThermal(sim.thP, st, 10);
  if (t % 60 === 0) row(runS + t + 10, 0, 0, st);
}
const csv = rows.map((x) => x.join(',')).join('\n');
if (out) writeFileSync(out, csv);
for (const x of rows.filter((_, i) => i === 0 || i % 6 === 1)) console.log(x.map((v) => String(v).padStart(9)).join(''));
