// Audio graph: engine worklet -> (direct + the surroundings' reverberation,
// a convolution) -> master processor (leveller and true-peak limiter) ->
// master volume -> speakers. Each place's impulse response comes from its
// geometry and surfaces and the camera's position (rooms.js).

import { bundleWorklet } from './worklet-bundle.js';
import { roomIR } from './rooms.js';

const WORKLET_URL = new URL('./engine-worklet.js', import.meta.url);

// The places (their geometry is in rooms.js). The anechoic choice has no
// reverberation at all; the open road has a distant facade.
export const ENVIRONMENTS = {
  open: { label: 'Open road' },
  garage: { label: 'Garage' },
  tunnel: { label: 'Tunnel' },
  canyon: { label: 'Canyon' },
  dry: { label: 'Anechoic', none: true },
  // passing places in the scenes, not somewhere to park
  barrier: { label: 'Noise wall', scene: true },
  bridge: { label: 'Under a bridge', scene: true },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.onMessage = () => {};
    this.env = 'open';
    this.volume = 0.8;
    this.camera = 'rear';
    this.irCache = new Map();
    this.warm = null;
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
    // the reverberation depends on where the mic is
    if (msg.type === 'camera') this.setCamera(msg.camera);
  }

  // The master processor's meter (gain reduction, the leveller's gain and
  // its input loudness every 10 ms, in batches of 0.1 s): fn(message), or
  // null to stop. For the tools.
  setMeter(fn) {
    if (!this.dyn) return;
    this.dyn.port.onmessage = fn ? (e) => fn(e.data) : null;
    this.dyn.port.postMessage({ type: 'meter', on: !!fn });
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  // A place's impulse response for the current camera, built once (0.1 to
  // 0.3 s for the long tails on a desktop) and kept.
  ir(name) {
    const key = `${name}|${this.camera}`;
    let buf = this.irCache.get(key);
    if (!buf) {
      const r = roomIR(name, this.camera, this.ctx.sampleRate);
      buf = this.ctx.createBuffer(2, r.L.length, this.ctx.sampleRate);
      buf.copyToChannel(r.L, 0);
      buf.copyToChannel(r.R, 1);
      this.irCache.set(key, buf);
    }
    return buf;
  }

  // Switch the surroundings; fade (s) crossfades the two reverberations,
  // e.g. while a car drives through a tunnel portal. The direct sound is
  // never touched: the impulse response carries the balance.
  setEnvironment(name, fade = 0.15) {
    this.env = name;
    if (!this.ctx || name === this.envNow) return;
    this.envNow = name;
    this.crossfade(fade);
  }

  crossfade(fade) {
    const name = this.envNow;
    const e = ENVIRONMENTS[name] ?? ENVIRONMENTS.open;
    const t = this.ctx.currentTime;
    const tc = Math.max(0.01, fade / 3);
    const nxt = 1 - this.cur;
    if (!e.none) {
      this.wetG[nxt].gain.cancelScheduledValues(t);
      this.wetG[nxt].gain.setValueAtTime(0, t);
      this.conv[nxt].buffer = this.ir(name);
      this.wetG[nxt].gain.setTargetAtTime(1, t + 0.01, tc);
    }
    this.wetG[this.cur].gain.cancelScheduledValues(t);
    this.wetG[this.cur].gain.setTargetAtTime(0, t, tc);
    this.cur = nxt;
    this.prewarm();
  }

  // The mic moved: the same place, heard from the new spot.
  setCamera(camera) {
    if (camera === this.camera) return;
    this.camera = camera;
    // keep only this camera's responses (up to 1.5 MB a place)
    for (const k of this.irCache.keys()) if (!k.endsWith(`|${camera}`)) this.irCache.delete(k);
    if (this.ctx && this.envNow) this.crossfade(0.1);
  }

  // Build the other places' responses for this camera while the page is
  // idle, so a switch (a scene's tunnel portal) does not wait for one.
  prewarm() {
    if (this.warm) return;
    const next = () => {
      this.warm = null;
      const todo = Object.keys(ENVIRONMENTS).find((k) => !ENVIRONMENTS[k].none && !this.irCache.has(`${k}|${this.camera}`));
      if (!todo || !this.ctx) return;
      this.ir(todo);
      this.prewarm();
    };
    const ric = globalThis.requestIdleCallback;
    this.warm = ric ? ric(next, { timeout: 2000 }) : setTimeout(next, 200);
  }

  suspend() {
    return this.ctx?.suspend();
  }
  resume() {
    return this.ctx?.resume();
  }
}

// The graph after the engine: direct and two reverberations (so one place
// can fade into another at a tunnel portal), the master processor (the leveller and the
// true-peak limiter, worklet/master.js), master volume; and an analyser on
// the raw engine. The app (AudioEngine.init) and the test harness both build
// it here. The worklet module must already be loaded into ctx.
export function buildMix(ctx, node, volume) {
  const dry = ctx.createGain();
  // the responses are already scaled against the direct sound
  const conv = [new ConvolverNode(ctx, { disableNormalization: true }), new ConvolverNode(ctx, { disableNormalization: true })];
  const wetG = [ctx.createGain(), ctx.createGain()];
  wetG[0].gain.value = 0;
  wetG[1].gain.value = 0;
  const dyn = new AudioWorkletNode(ctx, 'master-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  dyn.onprocessorerror = (e) => console.error('master worklet error', e);
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
    wetG[i].connect(dyn);
  }
  dry.connect(dyn);
  dyn.connect(master);
  master.connect(ctx.destination);
  // analyse the raw engine (before reverb and dynamics)
  node.connect(analyser);
  return { dry, conv, wetG, dyn, master, analyser };
}
