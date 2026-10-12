// Checks for the car-following code: the ELM327 reply parser, a whole
// adapter session against tools/fake-obd.js, and the GPS source's fusion.
//   node tools/test-car.mjs
import assert from 'node:assert/strict';
globalThis.performance ??= { now: () => Date.now() };
const { parseReply, Elm327 } = await import('../js/car/elm.js');
const { fakeElm } = await import('./fake-obd.js');

let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

// --- parser
assert.deepEqual(parseReply('410C1AF8\r\r'), { 12: 1726 });
assert.deepEqual(parseReply('41 0C 1A F8 \r'), { 12: 1726 });
assert.deepEqual(parseReply('SEARCHING...\r4100BE3EB813\r'), { 0: 0xbe3eb813 });
assert.deepEqual(parseReply('410C1AF8490F\r'), { 12: 1726, 73: (15 * 100) / 255 });
assert.deepEqual(parseReply('00A\r0:410C1AF80D32\r1:0B650000000000\r'), { 12: 1726, 13: 50, 11: 101 });
assert.deepEqual(parseReply('410D32\r410D33\r'), { 13: 50 }, 'first control unit wins');
assert.deepEqual(parseReply('NO DATA\r'), {});
assert.deepEqual(parseReply('010C\r410C0FA0\r'), { 12: 1000 }, 'echo ignored');
assert.deepEqual(parseReply('CAN ERROR\r'), {});
ok('parser');

// --- a session against the fake adapter, with and without the shortcuts
for (const opts of [{}, { multi: false }, { oneShot: false }, { multi: false, oneShot: false }]) {
  const link = fakeElm({ ...opts, latency: 5 });
  const elm = new Elm327(link);
  const info = await elm.init();
  assert.match(info.proto, /15765/);
  assert.equal(elm.multi, opts.multi !== false, 'multi detected');
  assert.ok(elm.supports(0x0c) && elm.supports(0x49) && !elm.supports(0x5a), 'supported PIDs');
  const t0 = Date.now();
  let reads = 0;
  while (Date.now() - t0 < 1500) {
    const { values } = await elm.read([0x0c, 0x49]);
    assert.ok(values[0x0c] >= 0 && values[0x0c] < 6000, 'rpm read');
    assert.ok(values[0x49] != null, 'pedal read');
    reads++;
  }
  ok(`session ${JSON.stringify(opts)}: ${(reads / 1.5).toFixed(0)} reads/s`);
}

// --- GPS + motion: a phone at an odd angle, a car pulling away and stopping
const { GpsSource } = await import('../js/car/gps.js');
for (const fusedSensor of [true, false]) {
  const listeners = {};
  globalThis.window = { addEventListener: (t, f) => (listeners[t] = f), removeEventListener() {}, DeviceMotionEvent: function () {} };
  let watchCb;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: { watchPosition: (cb) => ((watchCb = cb), 1), clearWatch() {} } } });
  const realSet = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  let clock = 0;
  globalThis.performance = { now: () => clock };
  const realNow = Date.now;
  const epoch = realNow();
  Date.now = () => epoch + clock;
  const samples = [];
  const src = new GpsSource((s) => samples.push(s), () => {});
  const start = src.start();
  const date0 = epoch;
  watchCb({ timestamp: date0, coords: { speed: 0, latitude: 0, longitude: 0 } });
  await start;
  // phone frame: forward mostly -z and tilted; up a mix of y and z
  const nrm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const F = nrm([0.2, -0.3, -0.93]), U = nrm([0, 0.95, -0.31]);
  let v = 0, lastFix = 0, aTrue = 0;
  const plan = (t) => { const c = t % 20; return c < 6 ? 2.5 : c < 9 ? -0.35 : c < 13 ? -3 : 0; }; // pull, coast, brake, wait
  const hist = [];
  for (let t = 0; t < 120; t += 0.01) {
    clock = t * 1000;
    aTrue = v <= 0 && plan(t) < 0 ? 0 : plan(t);
    v = Math.max(0, v + aTrue * 0.01);
    hist.push([t, v]);
    const noise = () => (Math.random() - 0.5) * 0.6;
    const lin = F.map((x) => x * aTrue + noise());
    const ag = lin.map((x, i) => x + U[i] * 9.81);
    listeners.devicemotion({ accelerationIncludingGravity: { x: ag[0], y: ag[1], z: ag[2] }, acceleration: fusedSensor ? { x: lin[0], y: lin[1], z: lin[2] } : null });
    if (t - lastFix >= 1) {
      lastFix = t;
      // GPS speed: the speed half a second ago, reported now
      const old = hist[Math.max(0, hist.length - 51)][1];
      watchCb({ timestamp: date0 + clock - 500, coords: { speed: old, latitude: 0, longitude: 0 } });
    }
    if (Math.round(t * 100) % 5 === 0) src.tick();
  }
  globalThis.setInterval = realSet;
  Date.now = realNow;
  if (process.env.DBG) for (const s of samples.filter((x, i) => i % 4 === 0 && x.t > 66000 && x.t < 69000)) console.log((s.t / 1000).toFixed(1), s.speed.toFixed(1), s.accel.toFixed(2), s.pedal.toFixed(2), s.brake.toFixed(2));
  assert.ok(src.calibrated, 'learned which way is forward');
  const dotp = src.fwd.reduce((s, x, i) => s + x * F[i], 0);
  assert.ok(dotp > 0.9, `forward axis close (dot ${dotp.toFixed(2)})`);
  const late = samples.filter((s) => s.t > 60000);
  const inPhase = (s, a, b) => s.t % 20000 > a && s.t % 20000 < b;
  assert.ok(late.filter((s) => inPhase(s, 1500, 5500)).every((s) => s.pedal > 0.3), 'pedal down while pulling away');
  assert.ok(late.filter((s) => inPhase(s, 9500, 12500)).every((s) => s.pedal === 0 && s.brake > 0.2), 'braking seen');
  assert.ok(late.filter((s) => inPhase(s, 6500, 8500)).every((s) => s.pedal < 0.15 && s.brake < 0.1), 'coasting seen');
  const err = Math.max(...late.map((s) => Math.abs(s.speed - hist[Math.min(hist.length - 1, Math.round(s.t / 10))][1])));
  assert.ok(err < 3, `speed within 3 m/s (worst ${err.toFixed(2)})`);
  ok(`gps fusion (${fusedSensor ? 'sensor gives acceleration' : 'gravity split here'}): forward dot ${dotp.toFixed(3)}, worst speed error ${err.toFixed(2)} m/s`);
}
console.log(`${n} checks passed`);
