// Audio graph: engine worklet -> (dry + convolution reverb) -> compressor ->
// limiter -> master volume -> speakers. Reverb impulse responses are
// generated procedurally for each environment.

import { bundleWorklet } from './worklet-bundle.js';

const WORKLET_URL = new URL('./engine-worklet.js', import.meta.url);

export const ENVIRONMENTS = {
  open: { label: 'Open road', wet: 0.1 },
  garage: { label: 'Garage', wet: 0.28 },
  tunnel: { label: 'Tunnel', wet: 0.5, boost: 1.25 },
  canyon: { label: 'Canyon', wet: 0.3 },
  dry: { label: 'Anechoic', wet: 0 },
  // passing places in the scenes, not somewhere to park
  barrier: { label: 'Noise wall', wet: 0.32, scene: true },
  bridge: { label: 'Under a bridge', wet: 0.45, boost: 1.1, scene: true },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.onMessage = () => {};
    this.env = 'open';
    this.volume = 0.8;
    this.irCache = {};
  }

  // ctxIn: a context to build on instead of the speakers' (the test harness,
  // tools/mix.mjs, passes an OfflineAudioContext, so it renders through
  // exactly this graph).
  async init(ctxIn) {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = ctxIn ?? new AC({ latencyHint: 'interactive' });
    if (!ctxIn && ctx.sampleRate > 50000) {
      // The physics runs once per sample; don't pay for 96 kHz.
      await ctx.close();
      ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    }
    this.ctx = ctx;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL.href);
    } catch (err) {
      // Some hosts refuse module URLs; retry from a blob. A blob cannot
      // resolve the worklet's relative imports, so join its modules first.
      const src = await bundleWorklet(WORKLET_URL.href, async (url) => (await fetch(url)).text());
      const blob = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(blob);
    }
    const node = new AudioWorkletNode(ctx, 'engine-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => this.onMessage(e.data);
    node.onprocessorerror = (e) => console.error('engine worklet error', e);
    this.node = node;
    Object.assign(this, buildMix(ctx, node, this.volume));
    this.cur = 0;
    this.envNow = null;
    this.setEnvironment(this.env);
    if (!ctxIn && ctx.state !== 'running') await ctx.resume();
  }

  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer ?? []);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  // Switch the surroundings; fade (s) crossfades the two reverbs, e.g. while
  // a car drives through a tunnel portal.
  setEnvironment(name, fade = 0.15) {
    this.env = name;
    if (!this.ctx || name === this.envNow) return;
    this.envNow = name;
    const e = ENVIRONMENTS[name] ?? ENVIRONMENTS.open;
    const t = this.ctx.currentTime;
    const tc = Math.max(0.01, fade / 3);
    const nxt = 1 - this.cur;
    if (e.wet > 0) {
      this.irCache[name] ??= makeIR(this.ctx, name);
      this.wetG[nxt].gain.cancelScheduledValues(t);
      this.wetG[nxt].gain.setValueAtTime(0, t);
      this.conv[nxt].buffer = this.irCache[name];
      this.wetG[nxt].gain.setTargetAtTime(e.wet, t + 0.01, tc);
    }
    this.wetG[this.cur].gain.cancelScheduledValues(t);
    this.wetG[this.cur].gain.setTargetAtTime(0, t, tc);
    this.dry.gain.setTargetAtTime((1 - e.wet * 0.35) * (e.boost ?? 1), t, tc);
    this.cur = nxt;
  }

  suspend() {
    return this.ctx?.suspend();
  }
  resume() {
    return this.ctx?.resume();
  }
}

// The graph after the engine: dry and two reverbs (so one place can fade into
// another at a tunnel portal), compressor, makeup, limiter, master volume;
// and an analyser on the raw engine. The app (AudioEngine.init) and the test
// harness both build it here.
export function buildMix(ctx, node, volume) {
  const dry = ctx.createGain();
  const conv = [ctx.createConvolver(), ctx.createConvolver()];
  const wetG = [ctx.createGain(), ctx.createGain()];
  wetG[0].gain.value = 0;
  wetG[1].gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 12;
  comp.ratio.value = 3.2;
  comp.attack.value = 0.008;
  comp.release.value = 0.25;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.9;
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -3;
  limit.knee.value = 0;
  limit.ratio.value = 20;
  limit.attack.value = 0.002;
  limit.release.value = 0.08;
  const master = ctx.createGain();
  master.gain.value = volume;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.55;
  analyser.minDecibels = -110;
  analyser.maxDecibels = -10;

  node.connect(dry);
  for (let i = 0; i < 2; i++) {
    node.connect(conv[i]);
    conv[i].connect(wetG[i]);
    wetG[i].connect(comp);
  }
  dry.connect(comp);
  comp.connect(makeup);
  makeup.connect(limit);
  limit.connect(master);
  master.connect(ctx.destination);
  // analyse the raw engine (before reverb/compression)
  node.connect(analyser);
  return { dry, conv, wetG, comp, makeup, limit, master, analyser };
}

// ---------------------------------------------------------------------------
// Procedural impulse responses
// ---------------------------------------------------------------------------

function makeIR(ctx, kind) {
  const fs = ctx.sampleRate;
  const spec = {
    open: { len: 0.9, rt: 0.35, lp0: 9000, lp1: 2500, early: [[0.019, 0.35], [0.043, 0.22], [0.071, 0.16], [0.13, 0.1]], pre: 0.012, level: 0.5 },
    garage: { len: 1.8, rt: 1.0, lp0: 12000, lp1: 3500, early: [[0.006, 0.5], [0.011, 0.42], [0.017, 0.35], [0.023, 0.3], [0.031, 0.22]], pre: 0.004, level: 0.7 },
    tunnel: { len: 4.0, rt: 3.1, lp0: 6000, lp1: 1200, early: [[0.012, 0.6], [0.024, 0.5]], pre: 0.008, level: 0.9, flutter: 0.034 },
    canyon: { len: 3.5, rt: 1.6, lp0: 7000, lp1: 1500, early: [[0.22, 0.45], [0.41, 0.32], [0.63, 0.22], [0.97, 0.14]], pre: 0.03, level: 0.45 },
    // a concrete wall one lane to the right: one hard reflection, mostly at the right ear
    barrier: { len: 0.7, rt: 0.28, lp0: 9000, lp1: 2500, early: [[0.021, 0.85], [0.046, 0.3]], pre: 0.012, level: 0.4, side: [0.35, 1] },
    // the deck a few metres overhead slaps the sound straight back down
    bridge: { len: 0.6, rt: 0.2, lp0: 7000, lp1: 2000, early: [[0.026, 0.9], [0.052, 0.4], [0.078, 0.18]], pre: 0.02, level: 0.45 },
  }[kind] ?? { len: 0.8, rt: 0.3, lp0: 9000, lp1: 3000, early: [], pre: 0.01, level: 0.5 };
  const N = Math.floor(spec.len * fs);
  const buf = ctx.createBuffer(2, N, fs);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const decay = Math.log(1000) / (spec.rt * fs); // -60 dB at rt
    let lp = 0;
    const pre = Math.floor(spec.pre * fs);
    for (let i = pre; i < N; i++) {
      const t = (i - pre) / fs;
      const fc = spec.lp1 + (spec.lp0 - spec.lp1) * Math.exp(-t / (spec.rt * 0.35));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / fs);
      lp += a * (rand() - lp);
      const env = Math.exp(-decay * (i - pre)) * (1 - Math.exp(-t / 0.004));
      d[i] = lp * env * spec.level * 1.6;
    }
    // early reflections (slightly different per ear; louder on a wall's side)
    const sg = spec.side ? spec.side[ch] : 1;
    for (const [tt, g] of spec.early) {
      const k = Math.floor((tt * (ch ? 1.07 : 0.95)) * fs);
      if (k < N) {
        for (let j = 0; j < 24 && k + j < N; j++) d[k + j] += g * sg * Math.exp(-j / 4) * (j === 0 ? 1 : rand() * 0.6);
      }
    }
    // flutter echo between parallel tunnel walls
    if (spec.flutter) {
      const D = Math.floor(spec.flutter * fs * (ch ? 1.03 : 1));
      for (let i = D; i < N; i++) d[i] += d[i - D] * 0.42;
      let m = 0;
      for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(d[i]));
      for (let i = 0; i < N; i++) d[i] *= spec.level / m;
    }
  }
  return buf;
}
