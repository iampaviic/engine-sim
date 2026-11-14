// The device around the app: audio session, wake lock, interruptions and
// resuming, the Android back button, the native shells.

import { AppPlugin, call, EngineAudio, isNative, platform, StatusBar } from '../platform/native.js';
import { $, app } from './state.js';
import { builder, carPanel, garage, mapEd, paywall, settings, toast, workshop } from './ui.js';
import { setMode } from './modes.js';

// --------------------------------------------------------------- platform
// iOS: "playback" plays through the silent switch and pauses other audio;
// "ambient" mixes with it. WebKit's Audio Session API sets this for the page
// itself (Safari and the app's web view); the native plugin covers the rest.
export function applyAudioSessionType() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = app.mixAudio ? 'ambient' : 'playback';
  } catch {
    /* older WebKit */
  }
}

export async function screenAwake(on) {
  app.awake = on;
  if (isNative) {
    call(EngineAudio, 'setKeepAwake', { on });
    return;
  }
  try {
    if (on && !app.wakeLock) app.wakeLock = await navigator.wakeLock?.request('screen');
    else if (!on && app.wakeLock) {
      const lock = app.wakeLock;
      app.wakeLock = null;
      await lock.release();
    }
  } catch {
    app.wakeLock = null; // refused or already released by the browser
  }
}

// Resume the sound after an interruption. Browsers may want a tap first.
export async function resumeSound() {
  if (!app.started || document.hidden) return;
  try {
    await app.audio.resume();
  } catch {
    /* handled below */
  }
  if (app.audio.ctx?.state !== 'running') armTapResume();
}
let tapResumeArmed = false;
function armTapResume(msg = 'Tap anywhere to bring the sound back') {
  if (tapResumeArmed) return;
  tapResumeArmed = true;
  toast(msg);
  document.addEventListener(
    'pointerdown',
    () => {
      tapResumeArmed = false;
      if (isNative) call(EngineAudio, 'setActive', { on: true });
      app.audio.resume();
    },
    { once: true, capture: true }
  );
}

// Android back button: close the top-most sheet, leave a scene, then exit.
function handleBack() {
  if (paywall.open) paywall.hide();
  else if (!$('slip').hidden) $('slipClose').click();
  else if (settings.open) settings.hide();
  else if (builder.open) builder.hide();
  else if (mapEd.open) mapEd.hide();
  else if (carPanel.open) carPanel.hide();
  else if (workshop.open) workshop.hide();
  else if (garage.open) garage.hide();
  else if (!$('scenePick').hidden) $('scenePick').hidden = true;
  else if (app.scene || app.mode !== 'rev') setMode('rev');
  else call(AppPlugin, 'exitApp');
}

export async function initNative() {
  if (!isNative) return;
  if (platform === 'ios') call(StatusBar, 'setStyle', { style: 'DARK' });
  EngineAudio?.addListener('interruption', (e) => {
    if (!app.started) return;
    if (e.state === 'began') app.audio.suspend();
    else resumeSound();
  });
  EngineAudio?.addListener('route', (e) => {
    if (e.reason !== 'deviceLost' || !app.started || app.audio.ctx?.state !== 'running') return;
    // headphones out: don't suddenly play out loud
    app.audio.suspend();
    armTapResume('Headphones disconnected. Tap to play through the speaker');
  });
  AppPlugin?.addListener('appStateChange', ({ isActive }) => {
    if (!app.started) return;
    if (isActive) {
      call(EngineAudio, 'setActive', { on: true });
      resumeSound();
    } else {
      app.audio.suspend();
      screenAwake(false);
      call(EngineAudio, 'setActive', { on: false });
    }
  });
  AppPlugin?.addListener('backButton', handleBack);
  const info = await call(AppPlugin, 'getInfo');
  if (info) app.versionText = `Version ${info.version} (${info.build})`;
}
