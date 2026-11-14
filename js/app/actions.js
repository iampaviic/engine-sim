// What the controls do: every key, button and gamepad action lands in
// action(); start() brings up the audio and startStop() turns the key.

import { workletConfig } from '../engine/compile.js';
import { ENVIRONMENTS } from '../audio/audio.js';
import { CAMERAS } from '../ui/workshop.js';
import { call, EngineAudio, isNative } from '../platform/native.js';
import { $, app } from './state.js';
import { builder, carPanel, garage, mapEd, settings, toast, workshop } from './ui.js';
import { applyAudioSessionType } from './platform.js';
import { mixGains } from './mixer.js';
import { abSwitch } from './ab.js';
import { runDyno, sceneGo, setMode, stopDyno, toggleScenePick } from './modes.js';
import { onMessage } from './telemetry.js';
import { sendThermal } from './thermal.js';

// ---------------------------------------------------------------- actions
const CAM_IDS = CAMERAS.map((c) => c[0]);
const ENV_IDS = Object.keys(ENVIRONMENTS).filter((k) => !ENVIRONMENTS[k].scene);
export function action(a, v) {
  switch (a) {
    case 'shift':
      if (app.started) app.audio.post({ type: 'shift', dir: v });
      break;
    case 'startstop':
      if (app.scene?.staging) sceneGo();
      else startStop();
      break;
    case 'scene-menu':
      toggleScenePick();
      break;
    case 'launch':
      if (app.started) app.audio.post({ type: 'input', launch: v });
      $('launchBtn').classList.toggle('held', !!v);
      if (v && app.mode !== 'drive' && app.started) setMode('drive');
      break;
    case 'nos':
      if (app.started) app.audio.post({ type: 'input', nos: !!v });
      $('nosBtn').classList.toggle('held', !!v);
      break;
    case 'garage':
      garage.open ? garage.hide() : garage.show(app.presetId);
      break;
    case 'workshop':
      workshop.open ? workshop.hide() : workshop.show();
      break;
    case 'maps':
      mapEd.open ? mapEd.hide() : app.openMaps();
      break;
    case 'car':
      carPanel.open ? carPanel.hide() : app.openCar();
      break;
    case 'camera': {
      const i = (CAM_IDS.indexOf(app.camera) + 1) % CAM_IDS.length;
      app.setCamera(CAM_IDS[i]);
      toast(CAMERAS[i][1]);
      if (workshop.open) workshop.render();
      break;
    }
    case 'env': {
      const i = (ENV_IDS.indexOf(app.env) + 1) % ENV_IDS.length;
      app.setEnv(ENV_IDS[i]);
      toast(ENVIRONMENTS[ENV_IDS[i]].label);
      if (workshop.open) workshop.render();
      break;
    }
    case 'mode':
      setMode(v);
      break;
    case 'dyno':
      app.dynoActive ? stopDyno() : runDyno();
      break;
    case 'ab':
      abSwitch(!!v);
      break;
    case 'builder':
      app.openBuilder({ from: 'current' });
      break;
    case 'temp':
      app.toggleEngineTemp();
      if (workshop.open) workshop.render();
      break;
    case 'escape':
      settings.hide();
      garage.hide();
      workshop.hide();
      if (builder.open) builder.hide();
      if (mapEd.open) mapEd.hide();
      carPanel.hide();
      $('scenePick').hidden = true;
      break;
  }
}

app.start = () => start();
export async function start() {
  if (app.started || app.starting) return;
  app.starting = true;
  applyAudioSessionType();
  if (isNative) {
    await call(EngineAudio, 'configure', { mixWithOthers: app.mixAudio });
    await call(EngineAudio, 'setActive', { on: true });
  }
  try {
    await app.audio.init();
  } catch (err) {
    console.error(err);
    app.starting = false;
    $('intro').querySelector('small').textContent = 'Audio could not start in this browser. Try Chrome, Edge, Firefox or Safari 15+.';
    return;
  }
  app.audio.onMessage = onMessage;
  app.audio.setVolume(app.volume);
  app.audio.setEnvironment(app.env);
  app.started = true;
  app.starting = false;
  app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune });
  sendThermal();
  app.audio.post({ type: 'camera', camera: app.camera });
  app.audio.post({ type: 'mix', gains: mixGains() });
  if (app.quality !== 'auto') app.audio.post({ type: 'quality', quality: app.quality });
  app.crank();
  $('intro').hidden = true;
}

// Key on, then crank: the fuel pump primes the rail for a moment first, as a
// push-button start does. (A kick-started or carburetted engine has no pump.)
app.crank = () => {
  clearTimeout(app.primeT);
  const c = app.compiled;
  if (c.starter.type === 'kick' || !c.thermal.injected) {
    app.audio.post({ type: 'ignition', on: true, crank: true });
    return;
  }
  app.audio.post({ type: 'ignition', on: true });
  app.priming = true;
  app.primeT = setTimeout(() => {
    app.priming = false;
    app.audio.post({ type: 'ignition', on: true, crank: true });
  }, 900);
};

export function startStop() {
  if (!app.started) {
    start();
    return;
  }
  const t = app.tel;
  if (app.priming || (t && (t.running || t.starter))) {
    clearTimeout(app.primeT);
    app.priming = false;
    app.audio.post({ type: 'ignition', on: false });
  } else app.crank();
}
