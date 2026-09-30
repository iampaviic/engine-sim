// Engine library. Dimensions in mm, angles in crank degrees.
//
// cam: [open, close, lift] — intake opens BTDC / closes ABDC, exhaust opens
// BBDC / closes ATDC (seat timing), lift in mm.

export const PRESETS = [
  {
    id: 'v12-65',
    name: 'Berlinetta V12',
    tagline: '6.5 L 65° V12 · naturally aspirated',
    origin: 'Italy',
    blurb:
      'Front-mid V12 with a 65° vee: the banks fire 65°/55° apart, so the scream has a faint gallop inside it. Long 6-into-1 headers, valved mufflers.',
    cylinders: 12,
    bore: 94,
    stroke: 78,
    rod: 152,
    compression: 13.5,
    firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
    intervals: [65, 55],
    banks: [
      [1, 2, 3, 4, 5, 6],
      [7, 8, 9, 10, 11, 12],
    ],
    valves: { inCount: 2, exCount: 2, inDia: 37, exDia: 31 },
    cam: { in: [22, 62, 11.5], ex: [60, 22, 10.5] },
    intake: { runnerLen: 0.36, runnerDia: 46, plenum: 9, throttleDia: 80, throttleCount: 2, airbox: 'ram' },
    exhaust: {
      headers: { style: 'n-1', len: 0.62, dia: 40 },
      cat: true,
      midLen: 1.1,
      pipeDia: 70,
      merge: 'x',
      muffler: 'valved',
      tips: 4,
      tailLen: 0.3,
      tailDia: 76,
    },
    induction: { type: 'na' },
    ecu: { idle: 900, limit: 8900, limiter: 'fuel', afr: 12.6, burble: 0.25, launchRpm: 3500 },
    inertia: 0.28,
    combustion: 0.72,
    vehicle: {
      mass: 1630,
      gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.63],
      final: 3.9,
      tire: 0.35,
      cd: 0.3,
      area: 2.0,
      rearBias: 0.53,
      layout: 'front',
      shiftTime: 0.1,
    },
    sound: { exhaust: 1, intake: 1.2, mech: 0.8, valvetrain: 'dohc' },
  },
  {
    id: 'v8-ls',
    name: 'Small-Block V8',
    tagline: '6.2 L cross-plane OHV · naturally aspirated',
    origin: 'USA',
    blurb:
      'Pushrod cross-plane V8. Each bank fires at uneven 90/180/270° gaps, which is where the burble comes from. Long-tube headers, X-pipe, chambered mufflers.',
    cylinders: 8,
    bore: 103.25,
    stroke: 92,
    rod: 154,
    compression: 10.7,
    firingOrder: [1, 8, 7, 2, 6, 5, 4, 3],
    intervals: 90,
    banks: [
      [1, 3, 5, 7],
      [2, 4, 6, 8],
    ],
    valves: { inCount: 1, exCount: 1, inDia: 55, exDia: 40.4 },
    cam: { in: [13, 67, 13.5], ex: [72, 18, 13.5] },
    intake: { runnerLen: 0.42, runnerDia: 52, plenum: 6, throttleDia: 90, airbox: 'stock' },
    exhaust: {
      headers: { style: 'n-1', len: 0.85, dia: 44 },
      cat: false,
      midLen: 1.6,
      pipeDia: 63,
      merge: 'x',
      muffler: 'chambered',
      tips: 2,
      tailLen: 0.6,
    },
    induction: { type: 'na' },
    ecu: { idle: 700, limit: 6600, limiter: 'fuel', afr: 12.8, burble: 0 },
    inertia: 0.32,
    combustion: 0.7,
    vehicle: {
      mass: 1550,
      gears: [2.66, 1.78, 1.3, 1.0, 0.74, 0.5],
      final: 3.42,
      tire: 0.34,
      cd: 0.33,
      area: 2.1,
      rearBias: 0.5,
      layout: 'front',
      shiftTime: 0.22,
    },
    sound: { exhaust: 1, intake: 0.8, mech: 1, valvetrain: 'ohv' },
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
