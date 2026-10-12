// Tuning maps: the tables the map editor edits and the worklet reads.
//
//   rpm    column breakpoints, rpm
//   kpa    row breakpoints for ignition, manifold absolute pressure in kPa
//   spark  [row][col] ignition trim in degrees on top of the factory map
//   afr    [col] full-load air-fuel ratio (light load still leans out to 14.7)
//   boost  [col] boost target in bar (turbo engines only)
//   gear   [gear] share of that boost each gear may use (turbo engines only)
//
// A tune without maps runs the factory calibration; maps left as created
// here change nothing.

export const MAP_COLS = 12;

export const hasBoostMap = (spec) => spec.induction?.type === 'turbo';

export function defaultMaps(spec, compiled, tune) {
  const limit = spec.ecu?.limit ?? 6500;
  const lo = 1000;
  const top = Math.ceil((limit * 1.15) / 500) * 500;
  const rpm = Array.from({ length: MAP_COLS }, (_, i) => Math.round((lo + (i * (top - lo)) / (MAP_COLS - 1)) / 50) * 50);
  const boosted = (spec.induction?.type ?? 'na') !== 'na';
  const boost = tune.boost ?? spec.induction?.boost ?? 1;
  let kpa = [20, 35, 50, 65, 80, 100];
  if (boosted) {
    const hi = Math.round(100 + Math.max(0.5, boost) * 100 * 1.3);
    kpa = [20, 40, 60, 80, 100, Math.round(100 + (hi - 100) / 3), Math.round(100 + ((hi - 100) * 2) / 3), hi];
  }
  const turbo = hasBoostMap(spec);
  return {
    rpm,
    kpa,
    spark: kpa.map(() => rpm.map(() => 0)),
    afr: rpm.map(() => compiled.ecu.afr),
    boost: turbo ? rpm.map(() => boost) : null,
    gear: turbo ? compiled.vehicle.gears.map(() => 1) : null,
  };
}

// Has anything been changed from the factory calibration?
export function mapsEdited(maps, compiled, tune) {
  if (!maps) return false;
  if (maps.spark.some((r) => r.some((x) => x !== 0))) return true;
  if (maps.afr.some((x) => x !== compiled.ecu.afr)) return true;
  if (maps.boost?.some((x) => x !== tune.boost)) return true;
  if (maps.gear?.some((x) => x !== 1)) return true;
  return false;
}

// Do stored maps still fit this engine (same axes and gearbox)?
export function mapsFit(maps, spec, compiled, tune) {
  if (!maps) return false;
  const d = defaultMaps(spec, compiled, tune);
  const same = (a, b) => (a == null) === (b == null) && (!a || (a.length === b.length && a.every((x, i) => x === b[i])));
  return same(maps.rpm, d.rpm) && maps.spark?.length === d.kpa.length && maps.afr?.length === d.rpm.length && (maps.boost == null) === (d.boost == null) && (maps.gear?.length ?? 0) === (d.gear?.length ?? 0);
}

// Carry maps over to changed hardware: keep what still applies, interpolate
// the ignition rows onto the new pressure axis, start the rest from factory.
export function fitMaps(maps, spec, compiled, tune) {
  if (!maps || mapsFit(maps, spec, compiled, tune)) return maps;
  const d = defaultMaps(spec, compiled, tune);
  if (maps.rpm?.length !== d.rpm.length || !maps.rpm.every((x, i) => x === d.rpm[i])) return d;
  d.afr = maps.afr.slice();
  d.spark = d.kpa.map((k) => {
    const a = maps.kpa;
    let i = 0;
    while (i < a.length - 2 && k > a[i + 1]) i++;
    const f = Math.min(1, Math.max(0, (k - a[i]) / (a[i + 1] - a[i])));
    return maps.spark[i].map((x, c) => Math.round(x + (maps.spark[i + 1][c] - x) * f));
  });
  if (d.boost && maps.boost) d.boost = maps.boost.slice();
  if (d.gear && maps.gear?.length === d.gear.length) d.gear = maps.gear.slice();
  return d;
}
