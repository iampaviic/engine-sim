// Nitrous oxide: the solenoid, bottle and purge, and their sounds.

import { NOS_LAT, NOS_PER_HP, T_AMB } from '../constants.js';
import { clamp, rnd } from '../dsp.js';

export class NitrousMethods {
  // Nitrous. A WOT switch and an rpm window gate the solenoids; with the
  // throttle shut the button opens the purge valve instead, which vents
  // the line to the air. The bottle drains with every second of either.
  nitrousControl(dtc, rpm) {
    const win = rpm > Math.max(2500, this.ecu.idle * 2) && rpm < this.limitRpm - 300;
    const spray = this.nosBtn && this.running && this.pedal > 0.85 && win && !this.limCut && this.bottle > 0;
    const purge = this.nosBtn && this.pedal < 0.1 && this.bottle > 0;
    if (spray !== this.nosOn) {
      this.nosOn = spray;
      this.nosClick += spray ? 1 : 0.6; // the solenoids snap
    }
    if (purge !== this.nosPurge) {
      this.nosPurge = purge;
      this.nosClick += purge ? 0.8 : 0.5;
    }
    // the last of the bottle comes out as a sputter of gas
    const full = this.nosShot * NOS_PER_HP;
    const left = clamp(this.bottle / (0.06 * this.nosBottle), 0, 1);
    this.nosFlow += ((spray ? full * left : 0) - this.nosFlow) * Math.min(1, dtc / 0.03);
    this.purgeFlow += ((purge ? 1.5 * full * left + 0.004 : 0) - this.purgeFlow) * Math.min(1, dtc / (purge ? 0.01 : 0.12));
    if (this.nosFlow < 1e-7) this.nosFlow = 0;
    if (this.purgeFlow < 1e-6) this.purgeFlow = 0;
    this.bottle = Math.max(0, this.bottle - (this.nosFlow + this.purgeFlow) * dtc);
    // the chill of it flashing to gas, for its share of the charge
    if (this.nosX > 0) {
      const cool = Math.min(40, (this.nosX * NOS_LAT) / 1005);
      this.nosCool += (cool - this.nosCool) * Math.min(1, dtc / 0.4);
      this.nosRet = 24 * this.nosX;
    } else if (this.nosCool > 0) {
      this.nosCool *= Math.exp(-dtc / 0.8);
      if (this.nosCool < 0.01) this.nosCool = 0;
    }
    if (!this.boosted) this.Tpl = T_AMB - this.nosCool;
  }

  // Nitrous sounds: the solenoids' snap, the purge valve's roar of gas and,
  // much quieter, the hiss of the nozzle while it sprays.
  nitrousSound() {
    let x = 0;
    const f = this.purgeFlow + 0.12 * this.nosFlow;
    if (f > 0) {
      const nz = rnd() - 0.5;
      this.hs1 += this.hsA * (nz - this.hs1);
      this.hs2 += this.hsB * (this.hs1 - this.hs2);
      // (level set against the engine's own loudness trim, so every car's
      // purge sits the same distance under its full-throttle roar)
      x = ((this.hs1 - this.hs2) * 60 * Math.sqrt(f)) / this.snd.trim;
    }
    const k = this.nosClick;
    this.nosClick = 0;
    if (k > 0) this.nosRing = this.fs * 0.06;
    if (this.nosRing > 0) {
      this.nosRing--;
      x += this.nosSol.tick(k);
    }
    return x;
  }
}
