// Preferences the user sets: camera, environment, quality, volume, units,
// the gearbox, the weather, sharing the speaker with other apps, keeping the
// screen awake.

import { sprint, units } from '../ui/units.js';
import { call, EngineAudio } from '../platform/native.js';
import { $, app, store } from './state.js';
import { toast } from './ui.js';
import { weatherAmbient } from '../audio/worklet/sim/weather.js';
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

// The gearbox, the same for every engine: 'auto' (it shifts, its clutch),
// 'paddles' (you shift, its clutch) or 'manual' (you shift, your clutch).
app.gearbox = store.get('gearbox', 'auto');
app.setGearbox = (g) => {
  app.gearbox = g;
  store.set('gearbox', g);
  app.setTune({ autoShift: g === 'auto', manual: g === 'manual' });
  syncGearboxUI();
  if (g === 'manual' && app.started && app.mode === 'drive') {
    const t = app.tel;
    if (!t?.gear) toast('Neutral. Clutch in, then shift up for first');
  }
};
// The weather, the same for every engine and kept between visits: 'dry',
// 'damp' or 'rain' (worklet/sim/weather.js has what each means).
const WEATHERS = ['dry', 'damp', 'rain'];
app.weather = WEATHERS.includes(store.get('weather', 'dry')) ? store.get('weather', 'dry') : 'dry';
app.setWeather = (w) => {
  if (!WEATHERS.includes(w)) w = 'dry';
  app.weather = w;
  store.set('weather', w);
  if (app.started) app.audio.post({ type: 'weather', weather: w });
  toast(weatherText(w));
};
app.cycleWeather = () => app.setWeather(WEATHERS[(WEATHERS.indexOf(app.weather) + 1) % WEATHERS.length]);
export function weatherText(w) {
  const t = Math.round(weatherAmbient(w) - 273.15);
  return w === 'rain' ? `Rain, ${t} °C: a wet road, less grip` : w === 'damp' ? `Damp road, ${t} °C` : `Dry, ${t} °C`;
}

// the third pedal shows only with a manual gearbox
export function syncGearboxUI() {
  const man = app.gearbox === 'manual';
  document.body.classList.toggle('manual', man);
  $('clutch').hidden = !man;
}

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
