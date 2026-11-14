// The mixer: a gain for each simulated sound source.

import { $, app, store } from './state.js';

// ------------------------------------------------------------------ mixer
// Gains per simulated source: left/right/centre tail pipes, intake (with the
// turbo or blower), mechanical, road, wastegate dump.
app.mix = { exL: 1, exR: 1, intake: 1, mech: 1, road: 1, solo: null, ...store.get('mix', {}) };
export function mixGains() {
  const m = app.mix;
  const on = (k) => (m.solo == null || m.solo === k || (m.solo === 'ex' && (k === 'exL' || k === 'exR')) ? 1 : 0);
  const exL = m.exL * on('exL'), exR = m.exR * on('exR');
  return [exL, exR, (exL + exR) / 2, m.intake * on('intake'), m.mech * on('mech'), m.road * on('road'), (exL + exR) / 2];
}
app.setMix = (patch) => {
  Object.assign(app.mix, patch);
  store.set('mix', app.mix);
  if (app.started) app.audio.post({ type: 'mix', gains: mixGains() });
  syncMixTag();
};
// the "Mixer on" tag, also for a mix stored from an earlier visit
function syncMixTag() {
  $('mixTag').hidden = !(app.mix.solo || ['exL', 'exR', 'intake', 'mech', 'road'].some((k) => Math.abs(app.mix[k] - 1) > 0.01));
}
syncMixTag();
