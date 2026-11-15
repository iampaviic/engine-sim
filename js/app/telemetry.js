// Messages from the worklet, and what the telemetry does to the screen.

import { speedText, sprint } from '../ui/units.js';
import { $, app } from './state.js';
import { builder, carPanel, controls, mapEd, schem, scope, tach, toast, view3d, workshop } from './ui.js';
import { screenAwake } from './platform.js';
import { onScene, setMode } from './modes.js';
import { saveThermal } from './thermal.js';

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
  if (inGear && t.gear !== app.lastGear && app.lastGear) navigator.vibrate?.(12);
  app.lastGear = t.gear;
  if (t.af > 0 && t.afI > 0.12) {
    schem.flame(Math.min(1.2, t.afI * 1.5));
    if (t.afI > 0.35) navigator.vibrate?.(8);
  }
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
