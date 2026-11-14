// Level of each sound source on its own, before the listener: dB SPL at 1 m,
// with the engine held at a fixed rpm and throttle (as tools/hold.mjs does).
// Use it to balance a source against the others and against measured levels.
//   node tools/sources.mjs <preset|all> <rpm|idle|limit> <pedal> [jsonOverrides]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hold } from './hold.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
const SRC_BUF = 1 << 17;
const NAMES = ['exhaust L', 'exhaust R', 'exhaust C', 'intake', 'mech', 'chassis', 'wastegate'];
const P_REF = 2e-5;

// RMS (Pa at 1 m) of each source over the last `secs` of the listener's delay lines.
export function sourceLevels(lis, fs, secs = 1) {
  const n = Math.min(SRC_BUF - 1, Math.round(secs * fs));
  const out = [];
  for (let s = 0; s < NAMES.length; s++) {
    let sum = 0;
    for (let i = 1; i <= n; i++) {
      const x = lis.buf[s * SRC_BUF + ((lis.w - i) & (SRC_BUF - 1))];
      sum += x * x;
    }
    out.push(Math.sqrt(sum / n));
  }
  return out;
}
export const dB = (pa) => (pa > 0 ? 20 * Math.log10(pa / P_REF) : -Infinity);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [id = 'v8-ls', rpmS = 'idle', pedal = '0', overS] = process.argv.slice(2);
  const over = overS ? JSON.parse(overS) : null;
  const list = id === 'all' ? PRESETS : PRESETS.filter((p) => p.id === id);
  for (const p of list) {
    const rpm = rpmS === 'idle' ? p.ecu.idle : rpmS === 'limit' ? p.ecu.limit - 200 : +rpmS;
    const r = await hold(p.id, rpm, +pedal, over);
    const pa = sourceLevels(r.lis, 48000);
    const ex = Math.hypot(pa[0], pa[1], pa[2]);
    const f = (x) => (Number.isFinite(dB(x)) ? dB(x).toFixed(1).padStart(6) : '     -');
    console.log(`${p.id.padEnd(12)} ${String(rpm).padStart(5)} rpm pedal ${pedal}  exhaust ${f(ex)}  intake ${f(pa[3])}  mech ${f(pa[4])}  chassis ${f(pa[5])}  wastegate ${f(pa[6])}  dB SPL at 1 m`);
  }
}
