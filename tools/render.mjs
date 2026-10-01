// Offline renderer: runs the real AudioWorklet code in Node and writes a WAV
// plus a telemetry CSV. Used for tuning and regression checks.
//
//   node tools/render.mjs <presetId> <scenario> [out.wav] [--camera rear]

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let loadCount = 0;
export async function loadWorklet(fs = 48000) {
  const posted = [];
  globalThis.sampleRate = fs;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = {
        postMessage: (m) => posted.push(m),
        onmessage: null,
      };
    }
  };
  let Proc = null;
  globalThis.registerProcessor = (name, cls) => {
    Proc = cls;
  };
  await import(pathToFileURL(path.join(root, 'js/audio/engine-worklet.js')).href + '?n=' + ++loadCount);
  return { Proc, posted };
}

export const SCENARIOS = {
  // start, idle, blips, WOT rev to limiter, lift, idle
  rev: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [3.0, { type: 'input', pedal: 0.35 }],
    [3.18, { type: 'input', pedal: 0 }],
    [4.2, { type: 'input', pedal: 0.6 }],
    [4.45, { type: 'input', pedal: 0 }],
    [5.6, { type: 'input', pedal: 1 }],
    [7.6, { type: 'input', pedal: 0 }],
    [10.0, { type: 'input', pedal: 0 }],
  ],
  idle: [[0.0, { type: 'ignition', on: true, crank: true }]],
  dyno: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [2.0, { type: 'dyno', action: 'start' }],
  ],
  drive: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [1.5, { type: 'mode', mode: 'drive' }],
    [2.0, { type: 'input', pedal: 1 }],
    [14.0, { type: 'input', pedal: 0 }],
  ],
  boost: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [1.5, { type: 'mode', mode: 'drive' }],
    [2.0, { type: 'input', pedal: 1 }],
    [9.0, { type: 'input', pedal: 0 }],
    [11.0, { type: 'input', pedal: 1 }],
    [13.5, { type: 'input', pedal: 0 }],
  ],
  flyby: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [1.5, { type: 'camera', camera: 'flyby' }],
    [1.5, { type: 'flyby', style: 'wot' }],
  ],
};

export async function render(presetId, scenarioName, opts = {}) {
  const { compileEngine, workletConfig } = await import(pathToFileURL(path.join(root, 'js/engine/compile.js')).href);
  const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
  const spec = typeof presetId === 'object' ? presetId : PRESETS.find((p) => p.id === presetId);
  if (!spec) throw new Error('no preset ' + presetId);
  const fs = opts.fs ?? 48000;
  const { Proc, posted } = await loadWorklet(fs);
  const proc = new Proc();
  const cfg = workletConfig(compileEngine(spec));
  const send = (m) => proc.port.onmessage({ data: m });
  send({ type: 'config', cfg, tune: opts.tune });
  if (opts.camera) send({ type: 'camera', camera: opts.camera });
  const scen = SCENARIOS[scenarioName] ?? scenarioName;
  const dur = opts.duration ?? Math.max(...scen.map((e) => e[0])) + 3;
  const N = Math.ceil((dur * fs) / 128) * 128;
  const L = new Float32Array(N), R = new Float32Array(N);
  let ev = 0;
  const tel = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i += 128) {
    const t = i / fs;
    while (ev < scen.length && scen[ev][0] <= t) send(scen[ev++][1]);
    const l = L.subarray(i, i + 128), r = R.subarray(i, i + 128);
    proc.process([], [[l, r]]);
    if (opts.onBlock) opts.onBlock(proc, t);
    while (posted.length) {
      const m = posted.shift();
      if (m.type === 'tel') tel.push({ t, ...m });
      if (opts.onMsg) opts.onMsg(m, t);
    }
  }
  const ms = performance.now() - t0;
  return { L, R, fs, tel, cpu: ms / 1000 / dur, dur, proc };
}

export function writeWav(file, L, R, fs) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(fs, 24);
  buf.writeUInt32LE(fs * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  writeFileSync(file, buf);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  const [id = 'v8-ls', scen = 'rev', out = `/tmp/${id}-${scen}.wav`] = pos;
  const r = await render(id, scen, { camera: flags.camera, duration: flags.dur ? +flags.dur : undefined, tune: flags.tune ? JSON.parse(flags.tune) : undefined });
  let peak = 0, nan = 0;
  for (let i = 0; i < r.L.length; i++) {
    const a = Math.abs(r.L[i]);
    if (!(a === a)) nan++;
    else if (a > peak) peak = a;
  }
  writeWav(out, r.L, r.R, r.fs);
  const csv = ['t,rpm,tq,thr,map,boost,egt,gear,speed,spl,lim,af,turbo,bov'];
  for (const m of r.tel)
    csv.push([m.t.toFixed(3), m.rpm.toFixed(0), m.tq.toFixed(1), m.thr.toFixed(2), (m.map / 1e5).toFixed(3), (m.boost / 1e5).toFixed(3), m.egt.toFixed(0), m.gear, (m.speed * 3.6).toFixed(1), m.spl.toFixed(4), m.lim ? 1 : 0, m.af, (m.turbo / 1000).toFixed(0), m.bov.toFixed(2)].join(','));
  writeFileSync(out.replace(/\.wav$/, '.csv'), csv.join('\n'));
  console.log(`${id}/${scen}: ${r.dur.toFixed(1)}s rendered, cpu ${(r.cpu * 100).toFixed(1)}% realtime, peak ${peak.toFixed(3)}, NaN ${nan}`);
}
