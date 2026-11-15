// Virtual dyno in a worker: runs the real engine simulation (the audio
// worklet's own code) faster than real time, at half the audio rate, to
// measure a build's torque and power curves, knock and loudness.

const posted = [];
globalThis.sampleRate = 24000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: (m) => posted.push(m) };
  }
};
let Proc = null;
globalThis.registerProcessor = (_name, cls) => {
  Proc = cls;
};
const ready = import('../audio/engine-worklet.js');
// the app's one definition of loudness (BS.1770) and the level every engine
// is trimmed to
const loudness = import('../audio/worklet/loudness.js');

const FS = 24000;
const BLOCK = 128;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'analyze') return;
  await ready;
  const lo = await loudness;
  try {
    self.postMessage(run(m, lo));
  } catch (err) {
    self.postMessage({ type: 'result', id: m.id, error: String(err?.message ?? err) });
  }
};

function run({ id, cfg, tune }, { LOUDNESS_TARGET, integratedLoudness }) {
  const t0 = performance.now();
  posted.length = 0;
  const proc = new Proc();
  const send = (data) => proc.port.onmessage({ data });
  send({ type: 'quality', quality: 'full' }); // never fall back to half rate here
  send({ type: 'config', cfg, tune });
  send({ type: 'camera', camera: 'rear' });
  send({ type: 'ignition', on: true, crank: true });
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const curve = [];
  // the output during the sweep, for its loudness
  const sweepL = [], sweepR = [];
  let knockN = 0, knockMax = 0, knockRet = 0, boostMax = 0, floatMax = 0;
  let idleSum = 0, idleN = 0, nan = false, started = false, done = false, sweeping = false;
  const maxT = 32;
  let t = 0;
  let lastProgress = 0;
  while (t < maxT && !done) {
    if (!started && t >= 2.2) {
      started = true;
      send({ type: 'dyno', action: 'start' });
    }
    proc.process([], [[L, R]]);
    t += BLOCK / FS;
    let en = 0;
    for (let i = 0; i < BLOCK; i++) en += L[i] + R[i];
    if (!(en === en)) {
      nan = true;
      break;
    }
    while (posted.length) {
      const p = posted.shift();
      if (p.type === 'tel') {
        if (t > 1.2 && t < 2.2) {
          idleSum += p.rpm;
          idleN++;
        }
        if (p.dyno) {
          sweeping = true;
          const last = curve[curve.length - 1];
          if (!last || p.dyno.rpm > last.rpm + 40) curve.push({ rpm: p.dyno.rpm, tq: p.dyno.tq });
        }
        if (started) {
          knockN += p.knockN;
          knockMax = Math.max(knockMax, p.knock);
          knockRet = Math.max(knockRet, p.knockRet);
          floatMax = Math.max(floatMax, p.float);
        }
        boostMax = Math.max(boostMax, p.boost);
      } else if (p.type === 'dyno-done') done = true;
    }
    if (sweeping) {
      sweepL.push(L.slice());
      sweepR.push(R.slice());
    }
    if (t - lastProgress > 1) {
      lastProgress = t;
      self.postMessage({ type: 'progress', id, f: Math.min(1, t / 14) });
    }
  }
  if (nan) return { type: 'result', id, error: 'The simulation became unstable with this combination.' };
  // the integrated loudness (BS.1770) of the sweep's last 3 s, as
  // tools/loudness.mjs measures the presets, and the trim that brings it to
  // the common level
  const join = (a) => {
    a = a.slice(-Math.round((3 * FS) / BLOCK));
    const out = new Float32Array(a.length * BLOCK);
    a.forEach((b, i) => out.set(b, i * BLOCK));
    return out;
  };
  const I = sweepL.length ? integratedLoudness(join(sweepL), join(sweepR), FS) : -Infinity;
  const trimNow = cfg.sound.trim || 1;
  const pts = curve.filter((p) => p.rpm > 900).map((p) => ({ rpm: p.rpm, tq: p.tq, hp: (p.tq * p.rpm) / 7121 }));
  let pkT = { tq: 0, rpm: 0 }, pkP = { hp: 0, rpm: 0 };
  for (const p of pts) {
    if (p.tq > pkT.tq) pkT = p;
    if (p.hp > pkP.hp) pkP = p;
  }
  return {
    type: 'result',
    id,
    curve: pts,
    peakTq: pkT.tq,
    peakTqRpm: pkT.rpm,
    peakHp: pkP.hp,
    peakHpRpm: pkP.rpm,
    trim: I > -70 ? +(trimNow * Math.pow(10, (LOUDNESS_TARGET - I) / 20)).toFixed(3) : trimNow,
    knockN,
    knockMax,
    knockRet,
    boostMax,
    floatMax,
    idleRpm: idleN ? idleSum / idleN : 0,
    ms: performance.now() - t0,
  };
}
