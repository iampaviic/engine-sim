// Preferences the user sets: camera, environment, quality, volume, units,
// sharing the speaker with other apps, keeping the screen awake.

import { sprint, units } from '../ui/units.js';
import { call, EngineAudio } from '../platform/native.js';
import { $, app, store } from './state.js';
import { applyAudioSessionType, screenAwake } from './platform.js';

app.setCamera = (c) => {
  app.camera = c;
  store.set('camera', c);
  $('camSel').value = c;
  if (app.started && app.mode !== 'flyby') app.audio.post({ type: 'camera', camera: c });
  if (app.scene) app.scene.cache.cam = c;
};
app.setEnv = (e) => {
  app.env = e;
  store.set('env', e);
  $('envSel').value = e;
  app.audio.setEnvironment(e);
};
app.quality = store.get('quality', 'auto');
app.setQuality = (q) => {
  app.quality = q;
  store.set('quality', q);
  if (app.started) app.audio.post({ type: 'quality', quality: q });
};
app.setVolume = (v) => {
  app.volume = v;
  store.set('volume', v);
  $('vol').value = v;
  app.audio.setVolume(v);
};

// ---------------------------------------------------------------- settings
app.setUnits = (u) => {
  units.speed = u;
  store.set('units', u);
  app.timer.result = null;
  syncUnitsUI();
};
export function syncUnitsUI() {
  $('roTimeLbl').textContent = sprint().label;
}
app.setMixAudio = (on) => {
  app.mixAudio = on;
  store.set('mixAudio', on);
  if (app.started) applyAudioSessionType();
  call(EngineAudio, 'configure', { mixWithOthers: on });
};
app.setKeepAwake = (on) => {
  app.keepAwake = on;
  store.set('keepAwake', on);
  if (!on) screenAwake(false);
};
