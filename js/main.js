// Firing Order: the app's entry point. Runs the frame loop, wires the page's
// buttons and boots. The rest of the app is in app/:
//
//   state.js      app, store, $
//   ui.js         tach, schematic, scope, panels, toast, tabs
//   engine.js     load, rebuild and tune the engine
//   actions.js    what each control does; start and stop
//   telemetry.js  worklet messages -> screen
//   modes.js      rev, drive, flyby, scenes, dyno run
//   thermal.js    the engine's temperatures between visits
//   mixer.js, ab.js, follow.js, prefs.js, platform.js
//
// These modules import each other freely, cycles included. That is safe as
// long as a module's top level only defines things and assigns to `app`;
// anything that calls into another module at load time belongs in the boot
// sequence at the bottom of this file.

import { ENVIRONMENTS } from './audio/audio.js';
import { CAMERAS } from './ui/workshop.js';
import { drawFollowHud } from './ui/carlink.js';
import { drawSceneHud } from './ui/scenes.js';
import { $, app, store } from './app/state.js';
import { hush, readSystemHaptics } from './platform/haptics.js';
import { carPanel, controls, garage, schem, scope, selectTab, settings, syncTabs, tach, tickToast, toast, view3d, workshop } from './app/ui.js';
import { loadEngine } from './app/engine.js';
import './app/follow.js';
import { syncGearboxUI, syncHaptics, syncUnitsUI } from './app/prefs.js';
import { initNative, resumeSound, screenAwake } from './app/platform.js';
import './app/mixer.js';
import { abSwitch } from './app/ab.js';
import { drawFlyby, sceneGo, setMode, toggleScenePick } from './app/modes.js';
import { action, start, startStop } from './app/actions.js';
import { updateReadouts } from './app/telemetry.js';
import { saveThermal } from './app/thermal.js';

// ------------------------------------------------------------------- loop
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  controls.update(dt);
  if (app.started) {
    const p = +controls.pedal.toFixed(3), b = +controls.brake.toFixed(3);
    const c = app.gearbox === 'manual' ? +controls.clutch.toFixed(3) : 0;
    if (p !== app.sentPedal || b !== app.sentBrake || c !== app.sentClutch) {
      app.audio.post({ type: 'input', pedal: p, brake: b, clutch: c });
      app.sentPedal = p;
      app.sentBrake = b;
      app.sentClutch = c;
    }
  }
  tach.update(dt);
  tach.draw();
  schem.draw(now / 1000, app.tel);
  if (scope.mode === '3d') {
    if (view3d && !$('view3d').hidden) view3d.draw(schem.crankAt(now / 1000));
  } else scope.draw(app.audio.analyser, app.tel);
  updateReadouts(dt);
  if (app.scene) drawSceneHud($('flybyStrip'), app.scene, app.tel, app.scene.cache);
  else if (app.following && !$('flybyStrip').hidden) drawFollowHud($('flybyStrip'), app.follow, app.tel, app.factory.name);
  else drawFlyby();
  tickToast(dt);
  requestAnimationFrame(frame);
}

// Hold-to-rev buttons (builder and workshop): the pedal while the deck is covered.
function holdToRev(btn) {
  const down = (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    if (!app.started) start();
    app.holdGas(1);
    btn.classList.add('held');
  };
  const up = () => {
    app.holdGas(0);
    btn.classList.remove('held');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function wire() {
  const camSel = $('camSel');
  for (const [k, label] of CAMERAS) camSel.add(new Option(label, k));
  camSel.value = app.camera;
  camSel.addEventListener('change', () => app.setCamera(camSel.value));
  const envSel = $('envSel');
  for (const [k, e] of Object.entries(ENVIRONMENTS)) if (!e.scene) envSel.add(new Option(e.label, k));
  envSel.value = app.env;
  envSel.addEventListener('change', () => app.setEnv(envSel.value));
  $('vol').value = app.volume;
  $('vol').addEventListener('input', (e) => app.setVolume(+e.target.value));
  $('pickEngine').addEventListener('click', () => garage.show(app.presetId));
  $('workshopBtn').addEventListener('click', () => (workshop.open ? workshop.hide() : workshop.show()));
  $('buildBtn').addEventListener('click', () => app.openBuilder({ from: 'current' }));
  // A/B: hold for a momentary listen to A; a quick tap latches A until the
  // next tap.
  const ab = $('abBtn');
  let abT = 0, unlatched = false;
  ab.addEventListener('pointerdown', (e) => {
    ab.setPointerCapture(e.pointerId);
    if (app.abLatched) {
      app.abLatched = false;
      unlatched = true;
      abSwitch(false);
      return;
    }
    abT = performance.now();
    abSwitch(true);
  });
  const abUp = () => {
    if (unlatched) {
      unlatched = false;
      return;
    }
    if (app.abActive && performance.now() - abT < 250) {
      app.abLatched = true;
      toast('A stays on: tap A/B again for B');
      return;
    }
    abSwitch(false);
  };
  ab.addEventListener('pointerup', abUp);
  ab.addEventListener('pointercancel', abUp);
  $('menuBtn').addEventListener('click', () => (workshop.open ? workshop.hide() : workshop.show()));
  $('keyBtn').addEventListener('click', start);
  $('startBtn').addEventListener('click', startStop);
  $('shiftUp').addEventListener('click', () => action('shift', 1));
  $('shiftDown').addEventListener('click', () => action('shift', -1));
  $('blipBtn').addEventListener('click', () => controls.blip());
  const lb = $('launchBtn');
  lb.addEventListener('pointerdown', (e) => {
    lb.setPointerCapture(e.pointerId);
    controls.setLaunch(true);
  });
  const lu = () => controls.setLaunch(false);
  lb.addEventListener('pointerup', lu);
  lb.addEventListener('pointercancel', lu);
  const nb = $('nosBtn');
  nb.addEventListener('pointerdown', (e) => {
    nb.setPointerCapture(e.pointerId);
    controls.setNos(true);
  });
  const nu = () => controls.setNos(false);
  nb.addEventListener('pointerup', nu);
  nb.addEventListener('pointercancel', nu);
  nb.addEventListener('contextmenu', (e) => e.preventDefault());
  $('tcBtn').addEventListener('click', () => {
    app.setTune({ tc: !app.tune.tc });
    toast(app.tune.tc ? 'Traction control on' : 'Traction control off: burnouts allowed');
  });
  document.querySelectorAll('.modes button').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.mode === 'scene' ? toggleScenePick() : setMode(b.dataset.mode)))
  );
  $('treeGo').addEventListener('click', sceneGo);
  $('slipAgain').addEventListener('click', () => {
    $('slip').hidden = true;
    setMode(app.slipScene ?? 'drag');
  });
  $('slipClose').addEventListener('click', () => {
    $('slip').hidden = true;
    setMode('rev');
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && app.scene?.staging) sceneGo();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('scenePick').hidden && !e.target.closest('#scenePick') && !e.target.closest('[data-mode="scene"]')) $('scenePick').hidden = true;
  });
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.mode)));
  $('dynoRun').addEventListener('click', () => action('dyno'));
  $('strobe3d').addEventListener('click', () => $('strobeBtn').click());
  $('view3d').addEventListener('pointerdown', () => ($('v3dHint').hidden = true), { once: true });
  $('strobeBtn').addEventListener('click', () => {
    const on = $('strobeBtn').getAttribute('aria-pressed') !== 'true';
    $('strobeBtn').setAttribute('aria-pressed', String(on));
    $('strobeBtn').textContent = on ? 'Slow-mo' : 'Real time';
    $('schemLbl').innerHTML = on ? 'Exhaust pressure · <b>strobe</b>' : 'Exhaust pressure · <b>live</b>';
    app.audio.post({ type: 'strobe', on, step: 3 });
    $('strobe3d').setAttribute('aria-pressed', String(on));
    $('strobe3d').textContent = on ? 'Slow-mo' : 'Real time';
  });
  document.querySelector('.stage').addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.instr-panel, .tabs')) return;
      e.preventDefault();
      controls.wheel(e.deltaY);
    },
    { passive: false }
  );
  // keep the engine's temperatures for next time
  window.addEventListener('pagehide', () => saveThermal(true));
  document.addEventListener('visibilitychange', () => {
    if (!app.started) return;
    if (document.hidden) {
      saveThermal(true);
      app.audio.suspend();
      screenAwake(false);
      hush();
    } else {
      readSystemHaptics();
      resumeSound();
    }
  });
  scope.mode = store.get('tab', 'wave');
  syncTabs();
  syncUnitsUI();
  syncGearboxUI();
  syncHaptics();
  holdToRev($('wsRev'));
  holdToRev($('mRev'));
  $('flybyStrip').addEventListener('click', () => {
    if (app.following) carPanel.show();
  });
  $('settingsBtn').addEventListener('click', () => settings.show());
  $('wsSettings').addEventListener('click', () => settings.show());
  initNative();
  document.fonts?.ready.then(() => {
    tach.face = null;
  });
}

wire();
loadEngine(app.presetId);
requestAnimationFrame(frame);
