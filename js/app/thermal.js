// The engine's temperature between visits. The worklet has no clock and no
// storage, so the app keeps each engine's last thermal state with the time
// it was saved, cools it down by the time it was away (with the worklet's
// own equations, worklet/sim/thermal.js) when the engine comes back, and
// sends it over. An engine never run before starts cold through.

import { soakThermal } from '../audio/worklet/sim/thermal.js';
import { T_AMB } from '../audio/worklet/constants.js';
import { app, store } from './state.js';
import { toast } from './ui.js';

const key = (id) => 'thermal.' + id;
let lastSave = 0;

// The thermal message for engine id: its saved state cooled down to now, or
// cold through at the ambient temperature.
export function thermalFor(id, compiled) {
  const saved = store.get(key(id), null);
  if (!saved?.s || !(saved.t > 0)) return { type: 'thermal', preset: 'cold', ambient: T_AMB };
  const s = { ...saved.s };
  const secs = Math.max(0, (Date.now() - saved.t) / 1000);
  soakThermal(compiled.thermal, s, secs, T_AMB);
  return { type: 'thermal', state: s, ambient: T_AMB };
}

// Send the current engine's temperatures (after its config).
export function sendThermal() {
  if (!app.started) return;
  app.audio.post(thermalFor(app.presetId, app.compiled));
  lastSave = Date.now();
}

// Keep the running engine's state, every few seconds and when the page goes
// away. (Not while A/B plays another engine: its temperatures are this car's.)
export function saveThermal(force = false) {
  const t = app.tel;
  if (!app.started || !t?.th || !t.id || app.abActive) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  store.set(key(t.id), { s: t.th, t: now });
}

// Force the engine cold through (a night outside) or fully warm.
app.setEngineTemp = (preset) => {
  if (!app.started) return;
  app.audio.post({ type: 'thermal', preset, ambient: T_AMB });
  lastSave = 0;
  toast(preset === 'cold' ? `Engine cold through, ${Math.round(T_AMB - 273.15)} °C` : 'Engine at running temperature');
};
app.toggleEngineTemp = () => app.setEngineTemp(app.tel && app.tel.coolant > 333.15 ? 'cold' : 'warm');
