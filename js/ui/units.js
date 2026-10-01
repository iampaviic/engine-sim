// Speed units for everything the driver reads. Distances stay metric, and the
// drag strip keeps its feet and mph like a real time slip.

const MPH = 2.236936;
const KMH = 3.6;

export const units = { speed: 'kmh' };

export function speedValue(mps) {
  return mps * (units.speed === 'mph' ? MPH : KMH);
}

export function speedText(mps) {
  return `${Math.round(speedValue(mps))} ${units.speed === 'mph' ? 'mph' : 'km/h'}`;
}

// The standing-start sprint: 0–100 km/h, or 0–60 mph.
export function sprint() {
  return units.speed === 'mph' ? { label: '0–60', text: '0–60 mph', target: 60 / MPH } : { label: '0–100', text: '0–100 km/h', target: 100 / KMH };
}

// mph where road signs use it, km/h elsewhere
export function defaultSpeedUnit() {
  const lang = typeof navigator === 'undefined' ? '' : (navigator.languages?.[0] ?? navigator.language ?? '');
  return /-(US|GB|LR|MM)$/i.test(lang) ? 'mph' : 'kmh';
}
