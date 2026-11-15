// Messages from the worklet, and what the telemetry does to the screen.

import { speedText, sprint } from '../ui/units.js';
import { $, app } from './state.js';
import { builder, carPanel, controls, mapEd, schem, scope, tach, toast, view3d, workshop } from './ui.js';
import { screenAwake } from './platform.js';
import { onScene, setMode } from './modes.js';
import { saveThermal } from './thermal.js';
import { shake, tap, taps } from '../platform/haptics.js';

// --------------------------------------------------------------- messages
export function onMessage(m) {
  switch (m.type) {
    case 'tel':
      onTelemetry(m);
      break;
    case 'snap':
      schem.onSnap(m.data, performance.now() / 1000);
      view3d?.onSnap(m.data);
      break;
    case 'scope':
      scope.onScope(m);
      break;
    case 'dyno-done':
      app.dynoActive = false;
      $('dynoRun').textContent = 'Run dyno';
      app.mode = 'rev';
      document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'rev')));
      app.audio.post({ type: 'mode', mode: 'rev' });
      break;
    case 'quality':
      toast(m.eco ? 'Busy device: physics now runs at half rate' : 'Full-rate physics');
      break;
    case 'scene':
      onScene(m);
      break;
    case 'interlock':
      // a manual car's clutch switch
      toast('In gear: press the clutch to start');
      break;
    case 'flyby-done':
      setTimeout(() => {
        if (app.mode === 'flyby') setMode('rev');
      }, 2500);
      break;
  }
}

// Nitrous button: the bottle level as a bar, and a word when it runs dry
function nitrousTel(t) {
  if (t.bottle == null) return;
  const pct = Math.round(t.bottle * 100);
  if (pct !== app.nosPct) {
    app.nosPct = pct;
    $('nosBtn').style.setProperty('--fill', `${pct}%`);
    $('nosBtn').title = `Hold for nitrous: sprays at full throttle, purges with the throttle shut (N) · bottle ${pct}%`;
  }
  if (t.nos && !app.warned.nos) {
    app.warned.nos = true;
    toast(`Nitrous: a ${app.tune.nosShot ?? app.compiled.nitrous.shot} hp shot`);
  }
  if (controls.nosHeld && t.bottle <= 0 && !app.warned.nosEmpty) {
    app.warned.nosEmpty = true;
    toast('The bottle is empty. Refill it in the workshop');
  }
  if (t.bottle > 0.05) app.warned.nosEmpty = false;
}

function onTelemetry(t) {
  app.tel = t;
  saveThermal();
  tach.coolant = t.coolant;
  tach.fan = !!t.fan;
  if (workshop.open) workshop.onTel(t);
  tach.target = t.rpm;
  const rpmText = t.running || t.starter ? `${Math.round(t.rpm).toLocaleString('en-US')} rpm` : 'engine off';
  if (builder.open) $('bRpm').textContent = rpmText;
  if (workshop.open) $('wsRpm').textContent = rpmText;
  if (mapEd.open) {
    $('mRpm').textContent = rpmText;
    mapEd.onTel(t);
  }
  tach.lim = t.lim;
  tach.camHi = t.camHi;
  tach.onPipe = !!t.onPipe;
  tach.nos = !!t.nos;
  schem.purge(!!t.purge);
  nitrousTel(t);
  const inGear = t.mode === 'drive' || t.mode === 'flyby';
  if (app.scene?.id === 'drag' && app.scene.leaveT == null && t.scene?.phase === 'run' && t.scene.x > 0.3) app.scene.leaveT = performance.now();
  if (app.scene?.staging && t.scene?.phase === 'run') {
    // the car launched itself after a slow reaction
    app.scene.staging = false;
    $('treeGo').disabled = true;
  }
  tach.gear = inGear ? (t.gear ? String(t.gear) : 'N') : t.mode === 'dyno' ? 'D' : 'N';
  tach.speedText = inGear ? speedText(t.speed) : t.mode === 'dyno' ? 'DYNO' : t.running ? 'NEUTRAL' : t.starter ? (t.kick ? 'KICKING' : 'CRANKING') : 'OFF';
  if (t.follow === 'rpm') {
    // the car's gearbox is the car's: show its speed
    tach.gear = '';
    tach.speedText = t.running ? speedText(t.speed) : t.starter ? 'CRANKING' : 'OFF';
  }
  if (app.following && carPanel.open) carPanel.updateLive();
  app.lastGear = t.gear;
  if (t.af > 0 && t.afI > 0.12) schem.flame(Math.min(1.2, t.afI * 1.5));
  feel(t, inGear);
  $('startBtn').classList.toggle('on', !!t.running);
  const wantAwake = (app.keepAwake || app.following) && !!t.running && !document.hidden;
  if (wantAwake !== app.awake) screenAwake(wantAwake);
  if (t.knockN > 0) {
    tach.knock = Math.max(tach.knock, Math.min(1, 0.3 + t.knock / 3e5));
    if (!app.warned.knock) {
      app.warned.knock = true;
      toast(app.tune.knockCtl ? 'Knock: the ECU hears it and pulls timing' : 'Knock, and the sensor is off: it keeps pinging');
    }
  }
  // the manual gearbox
  if (t.stall) toast(app.gearbox === 'manual' && t.gear ? 'Stalled. Clutch in, then START' : 'Stalled. Press START');
  if (t.refused) toast('Refused: without the clutch a gear needs the load off and the revs matched');
  tach.float = t.float;
  if (t.float > 0.05 && !app.warned.float) {
    app.warned.float = true;
    toast('Valve float: the springs can no longer keep the valves on the cams');
  }
  if (t.dyno && app.dynoActive) {
    const last = app.dynoPts[app.dynoPts.length - 1];
    if (!last || t.dyno.rpm > last.rpm + 25) app.dynoPts.push({ rpm: t.dyno.rpm, tq: t.dyno.tq });
  }
  // 0–100 km/h (or 0–60 mph) timer
  const tm = app.timer;
  const now = performance.now() / 1000;
  if (inGear) {
    if (t.speed < 0.3) {
      tm.state = 'armed';
    } else if (tm.state === 'armed') {
      tm.state = 'running';
      tm.t0 = now;
    } else if (tm.state === 'running' && t.speed >= sprint().target) {
      tm.state = 'done';
      tm.result = now - tm.t0;
      toast(`${sprint().text} in ${tm.result.toFixed(2)} s`);
    }
  }
}

// ---------------------------------------------------------------- haptics
// What a hand on the car would feel, from the same telemetry (rendered as
// taps by js/platform/haptics.js; priority 5 cuts in over anything below).
// Not while following a real car: the phone is in one.
const fz = { gear: null, tq: 0, v: 0, starter: false, running: false, rip: 0, limT: 0, afT: 0 };
function feel(t, inGear) {
  if (app.following) return;
  const v = app.compiled.vehicle;
  const now = performance.now();
  // a stall: the engine stops dead and the car lurches on its mounts
  if (t.stall) taps([1, 0.7, 0.45, 0.25], 70, 5);
  // the engine catches: a kick as it fires and rocks on its mounts; before
  // that, the starter's pinion meeting the ring gear
  if (t.running && !fz.running && (t.starter || fz.starter)) taps([0.85, 0.4], 60, 4);
  else if (t.starter && !fz.starter && !t.running) tap(0.5, 3);
  // A shift jolts the car by the change in drive force: the engine's torque
  // just before it times the step in overall ratio, over wheel radius and
  // mass. Full strength at 4 m/s^2 (about a hard first-to-second shift: an
  // estimate), and a light click for even the gentlest.
  if (inGear && fz.gear !== null && t.gear !== fz.gear) {
    const G = (n) => (n > 0 ? v.gears[n - 1] * v.final : 0);
    const da = (Math.abs(fz.tq) * 0.92 * Math.abs(G(fz.gear) - G(t.gear))) / (v.tire * v.mass);
    tap(0.15 + 0.85 * Math.min(1, da / 4), 3);
  }
  // a grinding gear buzzes as long as it grinds, harder the bigger the
  // speed difference; a refused one is a single knock through the lever
  if (t.grind > 0) tap(0.3 + 0.7 * Math.min(1, t.grind / 1500), 3);
  else if (t.refused) tap(0.5, 3);
  // leaving the line: a kick as hard as the launch (8 m/s^2 is full)
  if (fz.v < 0.3 && t.speed >= 0.3 && t.accel > 2) tap(Math.min(1, t.accel / 8), 4);
  // Afterfire: afI is the bang's pressure pulse in the pipe over 30 kPa (it
  // tops out at 2), and the pipe and body are pushed in proportion; below 9
  // kPa it is felt only as sound. A run of pops comes as taps no closer
  // than 90 ms. Knock is a light, sharp tick.
  if (t.af > 0 && t.afI > 0.3 && now - fz.afT > 90) {
    fz.afT = now;
    tap(Math.min(1, t.afI / 2), 2);
  }
  if (t.knockN > 0) tap(0.2 + 0.4 * Math.min(1, t.knock / 3e5), 2);
  // The limiter's cuts stutter the engine (and the loaded drivetrain in
  // gear); the launch limiter bounces the car on its tyres.
  if (t.lim && now - fz.limT > 80) {
    fz.limT = now;
    tap(t.launch ? 0.55 : inGear ? 0.45 : 0.3, 1);
  }
  // The engine's shake, while it idles or cranks with the car standing.
  // The firing pulses swing the crank's torque (rip, N·m rms) at the firing
  // frequency, and the engine's mounts pass that on to the body. A car's
  // rubber mounts put the engine's roll mode near 10 Hz, damped at 15 % of
  // critical (estimates), so above it they pass on less and less: the
  // transmissibility sqrt((1 + (2 z r)^2) / ((1 - r^2)^2 + (2 z r)^2)), r =
  // f / 10 Hz. A motorcycle's engine is part of its frame and passes it all.
  // The torque rocks the body on a lever about half a metre long (the mounts'
  // spacing), so the body shakes at about T / (0.5 m x mass). Felt from 2
  // mm/s^2 (strength 0) to 0.5 m/s^2 (1), on a log scale: the range the
  // phone renders, an estimate. So a car rocks as it cranks (near the
  // mounts' resonance), barely shakes at idle, and a single or a twin
  // shakes the bike all the time.
  fz.rip += ((t.rip ?? 0) - fz.rip) * 0.15;
  if ((t.running || t.starter) && t.speed < 1 && t.thr < 0.2 && t.fire > 0) {
    const r = t.fire / 10, z = 0.15;
    const tr = v.mass < 500 ? 1 : Math.sqrt((1 + (2 * z * r) ** 2) / ((1 - r * r) ** 2 + (2 * z * r) ** 2));
    const s = Math.log10((fz.rip * tr) / (0.5 * v.mass) / 0.002) / Math.log10(250);
    if (s > 0.05) shake(Math.min(1, s), t.fire);
  }
  fz.gear = inGear ? t.gear : null;
  fz.tq = t.tq;
  fz.v = t.speed;
  fz.starter = !!t.starter;
  fz.running = !!t.running;
}

let roT = 0;
export function updateReadouts(dt) {
  roT -= dt;
  if (roT > 0) return;
  roT = 0.1;
  const t = app.tel;
  if (!t) return;
  const set = (id, v, unit) => {
    $(id).innerHTML = `${v}<small> ${unit}</small>`;
  };
  set('roTq', t.running ? Math.round(t.mode === 'rev' ? Math.max(0, t.tq) : t.tq) : '—', 'Nm');
  set('roHp', t.running && t.tq > 0 ? Math.round((t.tq * t.rpm) / 7121) : '—', 'hp');
  const hasBoost = (app.spec.induction?.type ?? 'na') !== 'na';
  if (hasBoost) {
    const b = t.boost / 1e5;
    set('roMap', (b >= 0 ? '+' : '') + b.toFixed(2), 'bar');
  } else set('roMap', (t.map / 1e5).toFixed(2), 'bar');
  set('roEgt', Math.round(t.egt - 273), '°C');
  set('roCool', t.coolant ? Math.round(t.coolant - 273.15) : '—', '°C');
  set('roOil', t.oil ? Math.round(t.oil - 273.15) : '—', '°C');
  set('roSpl', t.spl > 1e-4 ? Math.round(20 * Math.log10(t.spl / 2e-5)) : '—', 'dB');
  const tm = app.timer;
  if (tm.state === 'running') set('roTime', (performance.now() / 1000 - tm.t0).toFixed(1), 's');
  else set('roTime', tm.result ? tm.result.toFixed(2) : '—', 's');
}
