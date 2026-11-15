// The weather: the air the engine breathes and the thermal masses cool in.
// One shared ambient (ambT, which sim/thermal.js uses too); the pipe
// network's gas dynamics stay at the reference P_AMB and T_AMB.

import { P_AMB, T_AMB } from '../constants.js';

// Three kinds of day. Dry is the reference every calibration is made at: 25
// degrees, 1013 hPa and about 1 kPa of water vapour, which is the standard
// day of SAE J1349 (power correction: 99 kPa of dry air, 1 kPa of vapour, 25
// C). Damp is the overcast day after rain and rain a steady moderate rain:
// cooler, near saturation and, with the low that brings it, a little lower
// pressure. These are typical mid-latitude figures, not measurements (T in
// kelvin, p in pascals, rh 0..1).
const WEATHER = {
  dry: { T: T_AMB, p: P_AMB, rh: 0.32 },
  damp: { T: 288, p: 101000, rh: 0.88 },
  rain: { T: 285, p: 100200, rh: 0.96 },
};

// Saturation vapour pressure of water over a flat surface, Pa, at t degrees
// C (the Magnus form, Alduchov and Eskridge, J. Appl. Meteor. 35, 1996).
function pSat(t) {
  return 610.94 * Math.exp((17.625 * t) / (t + 243.04));
}

// The air on a given day: its dry air's partial pressure (Pa) and its water,
// grams per kilogram of dry air.
function air(w) {
  const pv = w.rh * pSat(w.T - 273.15);
  const pd = w.p - pv;
  return { pd, g: (622 * pv) / pd };
}
const REF = air(WEATHER.dry);

export class WeatherMethods {
  setWeather(name) {
    const w = WEATHER[name] ?? WEATHER.dry;
    this.weather = WEATHER[name] ? name : 'dry';
    const a = air(w);
    // The charge is drawn at the day's temperature (sim/nitrous.js and the
    // compressors in sim/induction.js read ambT), so cool air packs more of
    // itself into the cylinders. The pipe network still runs at P_AMB, so
    // the day's pressure, and the water vapour that takes the place of some
    // of the air, act on the oxygen a charge carries: in proportion to the
    // dry air's partial pressure (as SAE J1349 corrects power).
    this.ambT = w.T;
    this.airO2 = a.pd / REF.pd;
    // Damp air knocks less: the water soaks up heat in the end gas. Road
    // and engine knock ratings have measured the effect since the 1930s (SAE
    // 370152, 540247); the usual rule from them is that an engine's octane
    // requirement falls by 0.25 to 0.32 octane numbers per gram of water per
    // kilogram of dry air. The knock model reads the fuel as that much
    // better (0.28: an estimate in the middle of the range).
    this.humON = 0.28 * (a.g - REF.g);
    this.setOctane(this.octane);
  }
}
