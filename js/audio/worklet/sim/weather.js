// The weather: the air the engine breathes and the thermal masses cool in.
// One shared ambient (ambT, which sim/thermal.js uses too); the pipe
// network's gas dynamics stay at the reference P_AMB and T_AMB.

import { P_AMB, T_AMB } from '../constants.js';
import { lpCoef, Struck } from '../dsp.js';

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
// rain is what falls, mm/h: 6 is a steady moderate rain.
const WEATHER = {
  dry: { T: T_AMB, p: P_AMB, rh: 0.32, grip: 1, wet: 0, film: 0, rain: 0 },
  damp: { T: 288, p: 101000, rh: 0.88, grip: 0.85, wet: 0.5, film: 0.05, rain: 0 },
  rain: { T: 285, p: 100200, rh: 0.96, grip: 0.7, wet: 1, film: 0.5, rain: 6 },
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

// Rain on the roof, heard from the driver's seat. Drops of every size fall
// in natural rain, many small and few large, more of the large the harder
// it rains: Marshall and Palmer (J. Meteor. 5, 1948), N(D) = 8000
// exp(-4.1 R^-0.21 D) per m^3 per mm of diameter D (mm) at R mm/h. Each
// falls at its terminal speed, 9.65 - 10.3 exp(-0.6 D) m/s (Atlas et al.,
// Rev. Geophys. 11, 1973). They arrive on the roof as a Poisson stream, in
// six size classes.
//   A drop hits with a force that jumps to rho_w pi a^2 v^2 (a its radius)
// and dies away as the water spreads out, giving up all its momentum m v
// (Petersson, J. Sound Vib. 1995; Griffin and Ballagh, Building Acoustics
// 19, 2012): here an exponential with that peak and that impulse.
//   The roof is a steel panel, 0.75 mm thick and 1.8 m^2 (a saloon's),
// damped a little by its seams, the foam pads on its bows and the headliner
// (loss factor 0.02, an estimate: car body panels without a damping sheet
// sit at 0.01 to 0.03). Far below its coincidence frequency (17 kHz) a
// force on it is heard two ways (Cremer, Heckl and Petersson, Structure-
// Borne Sound; Griffin and Ballagh). Round the drop the panel's near field
// moves air as though the force pushed the panel's mass alone: a volume
// acceleration F / m'', so p = rho0 F / (2 pi r m'') at r below it, the
// sound following the force. And the bending waves it sets off ring the
// whole panel in its modes, which radiate from the panel's edges (radiation
// efficiency, Maidanik and Leppington, about 2 P c0 sqrt(f / fc) / (pi^2 S
// fc) for a clamped edge of perimeter P), so their share of the power
// against the near field's is 2 pi c0^2 sigma Y m'' / (omega eta), with Y
// the panel's point mobility 1 / (8 sqrt(B m'')): nearly twice the near
// field's at 1 kHz. The ears sit 0.3 m under the roof: about 0.5 m from the
// nearer half on average, 0.8 m from the other. The cabin's reverberation
// and the headliner's loss are taken to cancel (an estimate). Below the
// roof's lowest modes (about 100 Hz) its edges hold it still, so the near
// field is high-passed there.
const ROOF_S = 1.8;
const ROOF_P = 5.4;
const ROOF_M = 7850 * 0.75e-3;
const ROOF_B = (2.1e11 * Math.pow(0.75e-3, 3)) / (12 * (1 - 0.09));
const ROOF_ETA = 0.02;
const ROOF_FC = (343 * 343) / (1.8 * 5100 * 0.75e-3);
const RAIN_EDGES = [0.3, 0.6, 1, 1.5, 2.2, 3.2, 5.5];
const RAIN_K = 6;
const ROOF_MODES = 18;

// terminal speed of a drop of diameter D mm (Atlas et al.), m/s
function vDrop(D) {
  const v = 9.65 - 10.3 * Math.exp(-0.6 * D);
  return v > 0.3 ? v : 0.3;
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
    this.setRain(w.rain);
  }

  // The rain's drop classes (per half roof: rate, peak force, decay), and
  // the roof's modes, for R mm/h.
  setRain(R) {
    this.rainOn = R > 0 && this.veh.mass >= 500; // (a motorcycle has no roof)
    if (!this.rainOn) return;
    const fs = this.fs;
    const lam = 4.1 * Math.pow(R, -0.21);
    for (let k = 0; k < RAIN_K; k++) {
      // flux through the class (per m^2 per s) and its flux-weighted size
      let n = 0, nd = 0;
      const d0 = RAIN_EDGES[k], d1 = RAIN_EDGES[k + 1];
      for (let j = 0; j < 40; j++) {
        const D = d0 + ((j + 0.5) * (d1 - d0)) / 40;
        const f = 8000 * Math.exp(-lam * D) * vDrop(D) * ((d1 - d0) / 40);
        n += f;
        nd += f * D;
      }
      const D = nd / n, a = D * 0.5e-3, v = vDrop(D);
      this.rnP[k] = Math.min(1, (n * ROOF_S * 0.5) / fs);
      this.rnF[k] = 1000 * Math.PI * a * a * v * v;
      // impulse m v = F0 tau: tau = (4/3) a / v
      this.rnD[k] = Math.exp(-1 / (((4 / 3) * a * fs) / v));
    }
    this.rnNear = 1.2 / (2 * Math.PI * 0.5 * ROOF_M);
    this.rnFar = 1.2 / (2 * Math.PI * 0.8 * ROOF_M);
    this.rnHp = lpCoef(100, fs);
    // The modes: spread from 120 Hz to 6 kHz, a little irregularly, each
    // standing for the many real ones in its share of the band and ringing
    // with the power the edges radiate there (relative to the near field at
    // the roof's mean distance, 0.53 m). The Struck bank's own gain, mean
    // |H|^2 over the band, is measured and divided out.
    const fr = new Float64Array(ROOF_MODES), q = new Float64Array(ROOF_MODES), g = new Float64Array(ROOF_MODES).fill(1);
    const step = Math.pow(6000 / 120, 1 / (ROOF_MODES - 1));
    for (let i = 0; i < ROOF_MODES; i++) {
      fr[i] = 120 * Math.pow(step, i) * (1 + 0.07 * Math.sin(i * 2.4));
      q[i] = 1 / ROOF_ETA;
    }
    const bank = new Struck(fr, q, g, fs);
    const Y = 1 / (8 * Math.sqrt(ROOF_B * ROOF_M));
    const cNr = 1.2 / (2 * Math.PI * 0.53 * ROOF_M);
    for (let i = 0; i < ROOF_MODES; i++) {
      const f = Math.min(fr[i], 0.45 * fs);
      const sigma = (2 * ROOF_P * 343 * Math.sqrt(f / ROOF_FC)) / (Math.PI * Math.PI * ROOF_S * ROOF_FC);
      const share = (2 * Math.PI * 343 * 343 * sigma * Y * ROOF_M) / (2 * Math.PI * f * ROOF_ETA);
      const band = (f * (Math.sqrt(step) - 1 / Math.sqrt(step)) * 2) / fs;
      // the bank's mean power gain for this mode
      let h2 = 0;
      for (let j = 0; j < 2048; j++) {
        const w = (Math.PI * (j + 0.5)) / 2048;
        const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        const nr = 1 - c1, ni = s1;
        const dr = 1 - bank.a1[i] * c1 - bank.a2[i] * c2, di = bank.a1[i] * s1 + bank.a2[i] * s2;
        h2 += (bank.g[i] * bank.g[i] * (nr * nr + ni * ni)) / (dr * dr + di * di);
      }
      h2 /= 2048;
      bank.g[i] *= cNr * Math.sqrt((share * band) / h2);
    }
    this.roofBank = bank;
  }

  // Per sample, in the cabin while it rains: the drops on each half of the
  // roof, the near field under them, and the ringing of the whole panel
  // (Pa at the ears, in rainL and rainR).
  roofRain() {
    const P = this.rnP, F = this.rnF, D = this.rnD, yl = this.rnYL, yr = this.rnYR;
    let fl = 0, fr = 0;
    for (let k = 0; k < RAIN_K; k++) {
      // (each drop in a class is a little bigger or smaller than its mean:
      // the force goes as its area)
      let a = yl[k] * D[k];
      if (this.wrnd() + 0.5 < P[k]) a += F[k] * (1 + 0.6 * this.wrnd());
      yl[k] = a;
      fl += a;
      let b = yr[k] * D[k];
      if (this.wrnd() + 0.5 < P[k]) b += F[k] * (1 + 0.6 * this.wrnd());
      yr[k] = b;
      fr += b;
    }
    const res = this.roofBank.tick(fl + fr);
    const xl = this.rnNear * fl + this.rnFar * fr, xr = this.rnNear * fr + this.rnFar * fl;
    this.rnHl += this.rnHp * (xl - this.rnHl);
    this.rnHr += this.rnHp * (xr - this.rnHr);
    this.rainL = xl - this.rnHl + res;
    this.rainR = xr - this.rnHr + res;
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
