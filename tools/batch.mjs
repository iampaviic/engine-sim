// Run every preset through the rev + dyno scenarios and print a summary.
//   node tools/batch.mjs [id ...]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render, writeWav } from './render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outDir = process.env.OUT || '/tmp';
const list = ids.length ? PRESETS.filter((p) => ids.includes(p.id)) : PRESETS;

for (const p of list) {
  const r = await render(p.id, 'rev');
  writeWav(`${outDir}/${p.id}-rev.wav`, r.L, r.R, r.fs);
  const tail = r.tel.filter((m) => m.t > 10.5);
  const rpms = tail.map((m) => m.rpm);
  const mean = rpms.reduce((a, b) => a + b, 0) / (rpms.length || 1);
  const sd = Math.sqrt(rpms.reduce((a, b) => a + (b - mean) ** 2, 0) / (rpms.length || 1));
  const stall = r.tel.some((m) => m.t > 1 && m.rpm < 150);
  const maxRpm = Math.max(...r.tel.map((m) => m.rpm));
  let nan = 0, peak = 0;
  for (let i = 0; i < r.L.length; i++) {
    const a = Math.abs(r.L[i]);
    if (!(a === a)) nan++;
    else if (a > peak) peak = a;
  }
  const map = tail.reduce((a, m) => a + m.map, 0) / (tail.length || 1) / 1e5;
  const spl = tail.reduce((a, m) => a + m.spl, 0) / (tail.length || 1);
  // dyno
  const d = await render(p.id, 'dyno', { duration: 16 });
  writeWav(`${outDir}/${p.id}-dyno.wav`, d.L, d.R, d.fs);
  let pk = { tq: 0, rpm: 0 }, pp = { kw: 0, rpm: 0 };
  for (const m of d.tel) {
    if (!m.dyno) continue;
    if (m.dyno.tq > pk.tq) pk = { tq: m.dyno.tq, rpm: m.dyno.rpm };
    const kw = (m.dyno.tq * m.dyno.rpm) / 9549;
    if (kw > pp.kw) pp = { kw, rpm: m.dyno.rpm };
  }
  const boost = Math.max(...d.tel.map((m) => m.boost)) / 1e5;
  console.log(
    `${p.id.padEnd(12)} idle ${mean.toFixed(0).padStart(5)}±${sd.toFixed(0).padEnd(4)} tgt ${p.ecu.idle}  map ${map.toFixed(2)}  max ${maxRpm.toFixed(0).padStart(5)}  ` +
      `${stall ? 'STALL ' : ''}tq ${pk.tq.toFixed(0)}@${pk.rpm.toFixed(0)}  ${(pp.kw * 1.341).toFixed(0)}hp@${pp.rpm.toFixed(0)}  boost ${boost.toFixed(2)}  ` +
      `idleSPL ${spl.toFixed(3)}  peak ${peak.toFixed(2)} nan ${nan}  cpu ${(r.cpu * 100).toFixed(0)}%/${(d.cpu * 100).toFixed(0)}%`
  );
}
