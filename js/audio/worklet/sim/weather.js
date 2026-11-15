// The weather: the air the engine breathes and the thermal masses cool in.
// One shared ambient (ambT, which sim/thermal.js uses too); the pipe
// network's gas dynamics stay at the reference P_AMB and T_AMB.

import { P_AMB, T_AMB } from '../constants.js';
import { lpCoef } from '../dsp.js';

// Three kinds of day. Dry is the reference every calibration is made at: 25
// degrees, 1013 hPa and about 1 kPa of water vapour, which is the standard
// day of SAE J1349 (power correction: 99 kPa of dry air, 1 kPa of vapour, 25
// C). Damp is the overcast day after rain and rain a steady moderate rain:
// cooler, near saturation and, with the low that brings it, a little lower
// pressure. These are typical mid-latitude figures, not measurements (T in
// kelvin, p in pascals, rh 0..1).
//   The road: grip is the tyres' peak friction against the dry road's.
// Wong (Theory of Ground Vehicles, table of road adhesion) gives asphalt
// 0.8 to 0.9 dry and 0.5 to 0.7 wet, peak and sliding alike, so about 0.7
// in the rain; a damp road, its texture wet but not flooded, halfway
// (estimate). wet (0..1) is how far the water film has the say over the
// friction once the tyre slides (1 in rain, a thin film half that:
// estimate). film is the water standing on the road, mm: steady moderate
// rain keeps a few tenths of a millimetre over a dense asphalt's texture, a
// damp road a tenth of that held in the texture (estimates).
const WEATHER = {
  dry: { T: T_AMB, p: P_AMB, rh: 0.32, grip: 1, wet: 0, film: 0 },
  damp: { T: 288, p: 101000, rh: 0.88, grip: 0.85, wet: 0.5, film: 0.05 },
  rain: { T: 285, p: 100200, rh: 0.96, grip: 0.7, wet: 1, film: 0.5 },
};
// On a wet road friction falls as the tyre slides faster: the water has
// less time to be squeezed out of the contact. The PIARC friction index
// (ASTM E1960) writes it F(S) = F60 exp((60 - S) / Sp), with the speed
// constant Sp = 14.2 + 89 MPD km/h; a typical dense asphalt's texture depth
// (MPD) of 0.7 mm gives 76 km/h, 21 m/s.
const SP_WET = 21;

// Tyre spray. Each tread groove scoops up the water in its path, carries it
// through the contact patch and flings it off the back of the tyre, where
// the sheets and jets break up into drops: a broadband hiss above about 1
// kHz (Rathe measured it; Sakagami found wet rolling noise 10 to 20 dB above
// the dry above 600 Hz; both reviewed by Underwood, TRRL report LR 601,
// 1973). Its level, as pascals at 1 m for a car at 80 km/h in the rain:
// a car's tyres coast past at about 71 dB(A) at 7.5 m dry (the UNECE R117
// limits for car tyres, 70 to 72 dB(A) at common widths); Freitas et al.
// (Road Materials and Pavement Design, 2008) measured motorway traffic on
// dense asphalt 4 dB(A) louder wet, so the spray alone is 71 + 10 log(10^0.4
// - 1) = 72.8 dB(A). Back to 1 m: +17.5 dB, less the 3 dB the pass-by
// microphone gains from the road's reflection (the listener adds its own):
// 87.3 dB, 0.46 Pa. It grows as speed^1.3 (Underwood's wet roads gained 25.9
// dB(A) per tenfold speed, against 34.4 dry) and, since the power thrown off
// goes with the water thrown, as the square root of the film's depth.
const SPRAY_PA = 0.46;
const SPRAY_V = 80 / 3.6;
const SPRAY_FILM = 0.5;

// The mean power gain, from 0 to Nyquist, of two one-pole high-passes
// (coefficient h) after one low-pass (l): what white noise keeps of its
// power through the spray's band.
function bandGain(h, l) {
  const K = 2048;
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const c = Math.cos((Math.PI * (k + 0.5)) / K);
    const bh = 1 - h, bl = 1 - l;
    const hp = (bh * bh * (2 - 2 * c)) / (1 - 2 * bh * c + bh * bh);
    const lp = (l * l) / (1 - 2 * bl * c + bl * bl);
    sum += hp * hp * lp;
  }
  return sum / K;
}

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
    // the road (sim/drivetrain.js): traction and launch control see the
    // wheels spin sooner and act on it as they would on any slippery road
    this.gripK = w.grip;
    this.slideK = w.wet / SP_WET;
    // A water film lubricates the contact: the tread slides smoothly instead
    // of sticking and slipping, so a wet tyre hardly squeals (estimate).
    this.squealK = 1 - 0.95 * w.wet;
    // the spray's band and level (white noise of variance 1/12 in)
    this.film = w.film;
    this.spHa = lpCoef(1000, this.fs);
    this.spLa = lpCoef(10000, this.fs);
    this.sprayK = w.film > 0 ? (SPRAY_PA * Math.sqrt(w.film / SPRAY_FILM)) / Math.pow(SPRAY_V, 1.3) / Math.sqrt(bandGain(this.spHa, this.spLa) / 12) : 0;
    if (!(w.film > 0)) this.sprayA = 0;
  }

  // The weather's own random stream, centred on zero: rain and spray never
  // disturb the engine's cycle-to-cycle variation.
  wrnd() {
    let s = this.wRs;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.wRs = s;
    return (s >>> 0) * 2.3283064365386963e-10 - 0.5;
  }

  // Control rate: how hard the tyres throw the water. Each tyre throws as
  // its tread moves, so a spinning wheel throws more; the power adds up over
  // the axles, each as its surface speed^2.6.
  sprayCtl() {
    const v = this.v;
    const u = Math.abs(this.ww) * this.veh.tire;
    const m = this.veh.drive === 'awd' ? Math.pow(u, 2.6) : 0.5 * (Math.pow(v, 2.6) + Math.pow(u, 2.6));
    this.sprayA = this.sprayK * Math.sqrt(m);
  }

  // Per sample, Pa at 1 m: the spray's hiss.
  spraySound() {
    const x = this.wrnd();
    this.spL += this.spLa * (x - this.spL);
    let y = this.spL;
    this.spH1 += this.spHa * (y - this.spH1);
    y -= this.spH1;
    this.spH2 += this.spHa * (y - this.spH2);
    y -= this.spH2;
    return y * this.sprayA;
  }
}
