// Measure each preset's loudness (rear camera) at WOT and idle and suggest a
// trim so full-throttle RMS sits at a common target.
//   node tools/loudness.mjs [id ...]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
const ids = process.argv.slice(2);
const list = ids.length ? PRESETS.filter((p) => ids.includes(p.id)) : PRESETS;
const TARGET = 0.11;

function rms(L, R, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += L[i] * L[i] + R[i] * R[i];
  return Math.sqrt(s / (2 * (b - a)));
}
const out = {};
for (const p of list) {
  const d = await render(p.id, 'dyno', { duration: 15 });
  // find sweep end
  const sweep = d.tel.filter((m) => m.dyno);
  const tEnd = sweep.length ? sweep[sweep.length - 1].t : 12;
  const fs = d.fs;
  const wot = rms(d.L, d.R, Math.floor((tEnd - 3) * fs), Math.floor(tEnd * fs));
  const idle = rms(d.L, d.R, Math.floor(1.2 * fs), Math.floor(1.9 * fs));
  let peak = 0;
  for (let i = 0; i < d.L.length; i++) peak = Math.max(peak, Math.abs(d.L[i]));
  const trimNow = p.sound?.trim ?? 1;
  const trim = +((TARGET / wot) * trimNow).toFixed(2);
  out[p.id] = trim;
  console.log(`${p.id.padEnd(12)} wot ${wot.toFixed(4)} idle ${idle.toFixed(4)} (${(20 * Math.log10(idle / wot)).toFixed(1)} dB)  peak ${peak.toFixed(2)}  trim ${trimNow} -> ${trim}`);
}
console.log(JSON.stringify(out));
