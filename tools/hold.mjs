// Hold a preset at a fixed rpm/throttle (infinite-inertia dyno) and measure
// the output level, optionally with spec overrides. Writes a WAV.
//   node tools/hold.mjs <preset> <rpm> <pedal> [jsonOverrides] [out.wav]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorklet, writeWav } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { compileEngine, workletConfig } = await import(pathToFileURL(path.join(root, 'js/engine/compile.js')).href);
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);

function merge(a, b) {
  if (b === null || b === undefined) return a;
  if (typeof b !== 'object' || Array.isArray(b)) return b;
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = merge(a?.[k], b[k]);
  return o;
}

export async function hold(id, rpm, pedal, over = null, secs = 1.5, camera = 'rear') {
  const spec = merge(PRESETS.find((p) => p.id === id), over);
  const { Proc } = await loadWorklet(48000);
  const proc = new Proc();
  proc.port.onmessage({ data: { type: 'config', cfg: workletConfig(compileEngine(spec)) } });
  proc.port.onmessage({ data: { type: 'camera', camera } });
  const sim = proc.sim;
  sim.ignition = true;
  sim.running = true;
  sim.pedal = pedal;
  const w = rpm / 9.5493;
  const N = Math.round((48000 * (secs + 1)) / 128) * 128;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i += 128) {
    sim.omega = w;
    proc.process([], [[L.subarray(i, i + 128), R.subarray(i, i + 128)]]);
  }
  const a = 48000; // skip first second
  let s = 0;
  for (let i = a; i < N; i++) s += L[i] * L[i] + R[i] * R[i];
  const rms = Math.sqrt(s / (2 * (N - a)));
  return { rms, L: L.subarray(a), R: R.subarray(a), sim };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [id, rpm, pedal, overS, out] = process.argv.slice(2);
  const over = overS ? JSON.parse(overS) : null;
  const r = await hold(id, +rpm, +pedal, over);
  console.log(`${id} ${rpm}rpm pedal ${pedal} ${overS ?? ''} rms ${r.rms.toFixed(4)} (${(20 * Math.log10(r.rms)).toFixed(1)} dBFS)`);
  if (out) writeWav(out, r.L, r.R, 48000);
}
