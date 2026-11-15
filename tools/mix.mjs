// Render through the app's real Web Audio graph and measure what comes out.
// Chromium (Playwright) runs the page; an OfflineAudioContext is handed to
// AudioEngine.init(), so the engine worklet, the reverbs, the dynamics and the
// limiter are exactly the app's, and the scenario's messages arrive at their
// times (ctx.suspend). The tool starts its own static server.
//
//   node tools/mix.mjs [id ...] [--scen rev|drive] [--env open] [--camera rear]
//                      [--weather rain] [--dur 11] [--wav dir] [--json out.json]
//
// Per engine it prints the integrated loudness (ITU-R BS.1770-4), the
// momentary loudness at idle (1.4-2.6 s) and at full throttle (6.2-7.4 s) of
// the rev scenario, their difference (the contrast), and the true peak (4x
// oversampled) and sample peak.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, FS, integrated, momentary, truePeak } from './bs1770.mjs';
import { writeWav } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const SCEN = {
  rev: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [3.0, { type: 'input', pedal: 0.35 }],
    [3.18, { type: 'input', pedal: 0 }],
    [4.2, { type: 'input', pedal: 0.6 }],
    [4.45, { type: 'input', pedal: 0 }],
    [5.6, { type: 'input', pedal: 1 }],
    [7.6, { type: 'input', pedal: 0 }],
  ],
  drive: [
    [0.0, { type: 'ignition', on: true, crank: true }],
    [1.5, { type: 'mode', mode: 'drive' }],
    [2.0, { type: 'input', pedal: 1 }],
    [14.0, { type: 'input', pedal: 0 }],
  ],
};

let server = null, browser = null, base = null;
export async function openMix() {
  if (browser) return;
  const port = 18000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, [path.join(here, 'serve.mjs'), String(port)], { stdio: 'ignore' });
  base = `http://localhost:${port}/`;
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch();
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + 'index.html')).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
export async function closeMix() {
  await browser?.close();
  server?.kill();
  browser = server = null;
}

// opts: { id, scen (name or [[t, message]...]), dur, camera, env, weather,
// extra (messages sent before the scenario) } -> { L, R, meter }
export async function renderMix(opts) {
  await openMix();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(base + 'index.html?mix-test');
  const scen = typeof opts.scen === 'string' ? SCEN[opts.scen] : opts.scen ?? SCEN.rev;
  const r = await page.evaluate(
    async ({ id, scen, dur, camera, env, weather, extra }) => {
      const fs = 48000;
      const ctx = new OfflineAudioContext(2, Math.ceil((dur * fs) / 128) * 128, fs);
      const { AudioEngine } = await import('/js/audio/audio.js');
      const { compileEngine, workletConfig } = await import('/js/engine/compile.js');
      const { PRESETS } = await import('/js/engine/presets.js');
      const eng = new AudioEngine();
      eng.env = env ?? 'open';
      const meter = [];
      await eng.init(ctx);
      eng.onMeter = (m) => meter.push(m);
      eng.post({ type: 'quality', quality: 'full' });
      if (weather) eng.post({ type: 'weather', weather });
      eng.post({ type: 'config', cfg: workletConfig(compileEngine(PRESETS.find((p) => p.id === id))) });
      if (camera) eng.setCamera?.(camera);
      if (camera) eng.post({ type: 'camera', camera });
      for (const m of extra ?? []) eng.post(m);
      // messages go out at their render quantum
      const byT = new Map();
      for (const [t, m] of scen) {
        if (t >= dur - 0.01) continue;
        const q = Math.max(128, Math.round((t * fs) / 128) * 128) / fs;
        if (!byT.has(q)) byT.set(q, []);
        byT.get(q).push(m);
      }
      for (const [q, ms] of byT)
        ctx.suspend(q).then(() => {
          for (const m of ms) eng.post(m);
          ctx.resume();
        });
      const buf = await ctx.startRendering();
      const enc = (a) => {
        const u = new Uint8Array(a.buffer);
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return { L: enc(buf.getChannelData(0)), R: enc(buf.getChannelData(1)), meter };
    },
    { id: opts.id, scen, dur: opts.dur ?? 11, camera: opts.camera, env: opts.env, weather: opts.weather, extra: opts.extra }
  );
  await page.close();
  const dec = (s) => {
    const b = Buffer.from(s, 'base64');
    return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  };
  return { L: dec(r.L), R: dec(r.R), meter: r.meter };
}

// The rev scenario's numbers (see the header).
export function measure(L, R) {
  const m = momentary(L, R);
  const seg = (a, b) => {
    const v = m.slice(Math.round(a * 10), Math.round(b * 10));
    return 10 * Math.log10(v.reduce((s, x) => s + Math.pow(10, x / 10), 0) / v.length);
  };
  let sp = 0;
  for (let i = 0; i < L.length; i++) sp = Math.max(sp, Math.abs(L[i]), Math.abs(R[i]));
  return { I: integrated(L, R), idle: seg(1.4, 2.6), wot: seg(6.2, 7.4), tp: db(Math.max(truePeak(L), truePeak(R))), sp: db(sp) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flags = {};
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else ids.push(args[i]);
  }
  const { PRESETS } = await import(pathToFileURL(path.join(root, 'js/engine/presets.js')).href);
  const list = ids.length ? ids : PRESETS.map((p) => p.id);
  const out = {};
  for (const id of list) {
    const r = await renderMix({ id, scen: flags.scen ?? 'rev', dur: flags.dur ? +flags.dur : undefined, env: flags.env, camera: flags.camera, weather: flags.weather });
    const m = (out[id] = measure(r.L, r.R));
    console.log(
      `${id.padEnd(12)} I ${m.I.toFixed(1).padStart(5)} LUFS  idle ${m.idle.toFixed(1).padStart(5)}  WOT ${m.wot.toFixed(1).padStart(5)}  contrast ${(m.wot - m.idle).toFixed(1).padStart(4)} LU  TP ${m.tp.toFixed(2).padStart(5)} dBTP  sample ${m.sp.toFixed(2)} dBFS`
    );
    if (flags.wav) writeWav(path.join(flags.wav, `${id}-${flags.scen ?? 'rev'}-${flags.env ?? 'open'}${flags.camera ? '-' + flags.camera : ''}.wav`), r.L, r.R, FS);
  }
  if (flags.json) writeFileSync(flags.json, JSON.stringify(out, null, 1));
  await closeMix();
}
