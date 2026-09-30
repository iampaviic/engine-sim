// Audio graph: engine worklet -> (dry + convolution reverb) -> compressor ->
// limiter -> master volume -> speakers. Reverb impulse responses are
// generated procedurally for each environment.

const WORKLET_URL = new URL('./engine-worklet.js', import.meta.url);

export const ENVIRONMENTS = {
  open: { label: 'Open road', wet: 0.1 },
  garage: { label: 'Garage', wet: 0.28 },
  tunnel: { label: 'Tunnel', wet: 0.5 },
  canyon: { label: 'Canyon', wet: 0.3 },
  dry: { label: 'Anechoic', wet: 0 },
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

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = new AC({ latencyHint: 'interactive' });
    if (ctx.sampleRate > 50000) {
      // The physics runs once per sample; don't pay for 96 kHz.
      await ctx.close();
      ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    }
    this.ctx = ctx;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL.href);
    } catch (err) {
      // Some hosts refuse module URLs; retry from a blob.
      const src = await (await fetch(WORKLET_URL.href)).text();
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

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -22;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.25;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 1.9;
    this.limit = ctx.createDynamicsCompressor();
    this.limit.threshold.value = -3;
    this.limit.knee.value = 0;
    this.limit.ratio.value = 20;
    this.limit.attack.value = 0.002;
    this.limit.release.value = 0.08;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -10;

    node.connect(this.dry);
    node.connect(this.conv);
    this.conv.connect(this.wet);
    this.dry.connect(this.comp);
    this.wet.connect(this.comp);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.limit);
    this.limit.connect(this.master);
    this.master.connect(ctx.destination);
    // analyse the raw engine (before reverb/compression)
    node.connect(this.analyser);
    this.setEnvironment(this.env);
    if (ctx.state !== 'running') await ctx.resume();
  }

  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer ?? []);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setEnvironment(name) {
    this.env = name;
    if (!this.ctx) return;
    const e = ENVIRONMENTS[name] ?? ENVIRONMENTS.open;
    const t = this.ctx.currentTime;
    if (e.wet > 0) {
      this.irCache[name] ??= makeIR(this.ctx, name);
      this.conv.buffer = this.irCache[name];
    }
    this.wet.gain.setTargetAtTime(e.wet, t, 0.05);
    this.dry.gain.setTargetAtTime(1 - e.wet * 0.35, t, 0.05);
  }

  suspend() {
    return this.ctx?.suspend();
  }
  resume() {
    return this.ctx?.resume();
  }
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
    // early reflections (slightly different per ear)
    for (const [tt, g] of spec.early) {
      const k = Math.floor((tt * (ch ? 1.07 : 0.95)) * fs);
      if (k < N) {
        for (let j = 0; j < 24 && k + j < N; j++) d[k + j] += g * Math.exp(-j / 4) * (j === 0 ? 1 : rand() * 0.6);
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
