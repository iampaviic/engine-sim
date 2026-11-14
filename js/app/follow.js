// Follow my car: the engine tracks a real car's revs or speed.

import { CarFollow } from '../car/follow.js';
import { $, app, store } from './state.js';
import { carPanel, toast, workshop } from './ui.js';
import { endScene, stopDyno } from './modes.js';
import { start } from './actions.js';

// ------------------------------------------------------------- follow car
// The engine follows a real car: its revs (OBD adapter), or its speed (GPS).
app.carSettings = { source: 'demo', carIdle: 800, carRed: 4800, stretch: true, ...store.get('car', {}) };
app.setCarSettings = (p) => {
  Object.assign(app.carSettings, p);
  store.set('car', app.carSettings);
};
app.follow = new CarFollow(
  {
    post: (m) => app.started && app.audio.post(m),
    engine: () => ({ idle: app.factory.ecu.idle, limit: app.tune.limit }),
    running: () => !!(app.tel?.running || app.tel?.starter),
    crank: () => {
      // once, and not again while the starter is still at it (nor before
      // the first report: starting the sound cranks it anyway)
      if (!app.tel || performance.now() - (app.crankT ?? 0) < 4000) return;
      app.crankT = performance.now();
      app.audio.post({ type: 'ignition', on: true, crank: true });
    },
    off: () => app.audio.post({ type: 'ignition', on: false }),
    onStatus: (t, bad) => {
      carPanel.setStatus(t, bad);
      if (bad) toast(t);
    },
    onStop: () => followStopped(),
  },
  app.carSettings
);
Object.defineProperty(app, 'following', { get: () => app.follow.on });
app.openCar = () => {
  if (!app.requirePro('Following your car is part of Pro')) return;
  workshop.hide();
  $('scenePick').hidden = true;
  carPanel.show();
};
app.startFollow = (kind) => {
  if (!app.requirePro('Following your car is part of Pro')) return;
  // Bluetooth and motion permissions have to be asked for inside the tap,
  // so the source starts first; the sound starts alongside
  const p = app.follow.start(kind);
  if (!app.started) start();
  if (app.dynoActive) stopDyno();
  if (app.dynoHolding) app.dynoHold(null);
  endScene();
  carPanel.setStatus(kind === 'obd' ? 'Choose your adapter' : kind === 'gps' ? 'Waiting for the GPS' : 'Starting the demo drive');
  carPanel.render();
  p.then((info) => {
    if (!info) return;
    app.mode = 'follow';
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', 'false'));
    $('flybyStrip').className = 'flyby-strip scene-hud follow-hud';
    $('flybyStrip').hidden = false;
    if (kind === 'gps' && app.tel && !app.tel.running && !app.tel.starter) app.audio.post({ type: 'ignition', on: true, crank: true });
    carPanel.setStatus(`${info.label}${info.detail ? '. ' + info.detail : ''}`);
    carPanel.render();
    toast(kind === 'demo' ? 'Following the demo drive' : 'Following your car');
  }).catch((e) => {
    const cancelled = e?.name === 'NotFoundError' && kind === 'obd';
    carPanel.setStatus(cancelled ? 'No adapter chosen' : e?.message ?? String(e), !cancelled);
    carPanel.render();
  });
};
app.stopFollow = () => app.follow.stop();
function followStopped() {
  app.mode = 'rev';
  app.audio.post({ type: 'mode', mode: 'rev' });
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'rev')));
  $('flybyStrip').hidden = true;
  $('flybyStrip').className = 'flyby-strip';
  if (carPanel.open) carPanel.render();
}
