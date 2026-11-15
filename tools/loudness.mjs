// Each preset's loudness and the trim that brings it to the common target.
// The measure is ITU-R BS.1770-4 integrated loudness (js/audio/worklet/
// loudness.js) of the last 3 s of a full-load dyno sweep (full throttle
// near the rev limit) heard by the rear camera's mic, at the worklet's
// output: the same measure the virtual dyno uses for a builder's engine. Also printed: a settled idle's loudness (5-8 s after
// the start), as a contrast against it.
//   node tools/loudness.mjs [id ...] [--write]
// --write puts the suggested trims into js/engine/presets.js.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from './render.mjs';
import { momentary } from './bs1770.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
const { LOUDNESS_TARGET, integratedLoudness } = await import(pathToFileURL(path.join(root, 'js/audio/worklet/loudness.js')).href);
const args = process.argv.slice(2);
const write = args.includes('--write');
const ids = args.filter((a) => !a.startsWith('--'));
const list = ids.length ? PRESETS.filter((p) => ids.includes(p.id)) : PRESETS;

const out = {};
for (const p of list) {
  const d = await render(p.id, 'dyno', { duration: 16, camera: 'rear' });
  const sweep = d.tel.filter((m) => m.dyno);
  const fs = d.fs;
  const b = Math.floor((sweep.length ? sweep[sweep.length - 1].t : 12) * fs), a = b - 3 * fs;
  const I = integratedLoudness(d.L.subarray(a, b), d.R.subarray(a, b), fs);
  // a settled idle: 5 to 8 s after the start (past the start flare)
  const id = await render(p.id, 'idle', { duration: 8, camera: 'rear' });
  const m = momentary(id.L.subarray(5 * fs), id.R.subarray(5 * fs));
  const idle = 10 * Math.log10(m.reduce((s, x) => s + Math.pow(10, x / 10), 0) / m.length);
  const trimNow = p.sound?.trim ?? 1;
  const trim = +(trimNow * Math.pow(10, (LOUDNESS_TARGET - I) / 20)).toFixed(3);
  out[p.id] = trim;
  console.log(`${p.id.padEnd(12)} sweep ${I.toFixed(1).padStart(5)} LUFS  idle ${idle.toFixed(1).padStart(5)} LUFS (${(idle - I).toFixed(1)} LU)  trim ${trimNow} -> ${trim}`);
}
if (write) {
  const file = path.join(root, 'js/engine/presets.js');
  let src = readFileSync(file, 'utf8');
  for (const [id, trim] of Object.entries(out)) {
    const at = src.indexOf(`id: '${id}'`);
    const next = src.indexOf("id: '", at + 5);
    const seg = src.slice(at, next < 0 ? undefined : next);
    if (!/trim: [0-9.]+/.test(seg)) throw new Error('no trim for ' + id);
    src = src.slice(0, at) + seg.replace(/trim: [0-9.]+/, `trim: ${trim}`) + (next < 0 ? '' : src.slice(next));
  }
  writeFileSync(file, src);
  console.log('written to js/engine/presets.js');
} else console.log(JSON.stringify(out));
