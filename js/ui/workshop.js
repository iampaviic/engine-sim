// Tuning drawer. Some settings are live ECU parameters ("tune"); others change
// the hardware and recompile the engine ("rebuild").

export const CAMERAS = [
  ['rear', 'Behind the car'],
  ['exhaust', 'At the tail pipes'],
  ['side', 'Pit wall'],
  ['front', 'In front'],
  ['bay', 'Engine bay'],
  ['cockpit', 'Cockpit'],
];

const clone = (o) => JSON.parse(JSON.stringify(o));

function camShift(cam, deg, lift) {
  if (!cam) return cam;
  return {
    in: [cam.in[0] + deg, cam.in[1] + deg, cam.in[2] + lift],
    ex: [cam.ex[0] + deg, cam.ex[1] + deg, cam.ex[2] + lift],
  };
}

export class Workshop {
  constructor({ root, body, close, reset, app }) {
    this.root = root;
    this.body = body;
    this.app = app;
    close.addEventListener('click', () => this.hide());
    reset.addEventListener('click', () => app.resetEngine());
  }

  show() {
    this.render();
    this.root.hidden = false;
  }
  hide() {
    this.root.hidden = true;
  }
  get open() {
    return !this.root.hidden;
  }

  render() {
    const app = this.app;
    const spec = app.spec;
    const factory = app.factory;
    const tune = app.tune;
    const b = this.body;
    b.innerHTML = '';
    const group = (title) => {
      const g = document.createElement('section');
      g.className = 'ws-group';
      g.innerHTML = `<h3>${title}</h3>`;
      b.appendChild(g);
      return g;
    };
    const seg = (g, label, opts, value, onSet, hint) => {
      const f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = `<label>${label}</label>`;
      const s = document.createElement('div');
      s.className = 'seg';
      for (const [v, text] of opts) {
        const bt = document.createElement('button');
        bt.textContent = text;
        bt.setAttribute('aria-pressed', String(v === value));
        bt.addEventListener('click', () => {
          onSet(v);
          this.render();
        });
        s.appendChild(bt);
      }
      f.appendChild(s);
      if (hint) f.insertAdjacentHTML('beforeend', `<div class="hint">${hint}</div>`);
      g.appendChild(f);
    };
    const range = (g, label, min, max, step, value, fmt, onSet, hint, onCommit) => {
      const f = document.createElement('div');
      f.className = 'field';
      const id = 'ws-' + label.replace(/\W+/g, '-').toLowerCase();
      f.innerHTML = `<label for="${id}">${label}</label><output>${fmt(value)}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
      const inp = f.querySelector('input');
      const out = f.querySelector('output');
      inp.addEventListener('input', () => {
        out.textContent = fmt(+inp.value);
        onSet(+inp.value);
      });
      if (onCommit) inp.addEventListener('change', () => onCommit(+inp.value));
      if (hint) f.insertAdjacentHTML('beforeend', `<div class="hint">${hint}</div>`);
      g.appendChild(f);
    };

    // --- listening
    let g = group('Listening');
    seg(g, 'Microphone', CAMERAS, app.camera, (v) => app.setCamera(v));
    seg(
      g,
      'Place',
      Object.entries(app.environments).map(([k, e]) => [k, e.label]),
      app.env,
      (v) => app.setEnv(v)
    );
    range(g, 'Volume', 0, 1, 0.01, app.volume, (v) => `${Math.round(v * 100)}%`, (v) => app.setVolume(v));

    // --- exhaust
    g = group('Exhaust');
    const ex = spec.exhaust;
    seg(
      g,
      'Silencer',
      [
        ['none', 'Straight pipes'],
        ['sport', 'Sport'],
        ['glasspack', 'Glasspack'],
        ['chambered', 'Chambered'],
        ['valved', 'Valved'],
        ['stock', 'Road'],
      ],
      ex.muffler ?? 'sport',
      (v) => app.rebuild((s) => (s.exhaust.muffler = v)),
      'Straight-through cores absorb highs. Chambers reflect sound back up the pipe. A valve opens a straight path.'
    );
    if ((ex.muffler ?? '') === 'valved') {
      seg(
        g,
        'Exhaust valve',
        [
          ['auto', 'Auto'],
          ['open', 'Open'],
          ['closed', 'Shut'],
        ],
        tune.valve,
        (v) => app.setTune({ valve: v })
      );
    }
    const dualBank = (spec.banks?.length ?? 1) > 1 && spec.kind !== 'rotary' && !(spec.induction?.type === 'turbo' && (spec.induction.count ?? 1) === 1);
    if (dualBank) {
      seg(
        g,
        'Bank crossover',
        [
          ['dual', 'True dual'],
          ['h', 'H-pipe'],
          ['x', 'X-pipe'],
          ['y', 'Merged'],
        ],
        ex.merge ?? 'dual',
        (v) => app.rebuild((s) => (s.exhaust.merge = v)),
        'An X-pipe lets the banks cancel their odd pulses: smoother, higher, raspier. True duals keep each bank separate.'
      );
    }
    seg(
      g,
      'Catalytic converters',
      [
        [true, 'Fitted'],
        [false, 'Removed'],
      ],
      !!ex.cat,
      (v) => app.rebuild((s) => (s.exhaust.cat = v))
    );
    if (spec.exhaust.headers?.lens) {
      seg(
        g,
        'Header lengths',
        [
          ['unequal', 'Unequal'],
          ['equal', 'Equal'],
        ],
        spec.exhaust.headers.equalize ? 'equal' : 'unequal',
        (v) =>
          app.rebuild((s) => {
            s.exhaust.headers.equalize = v === 'equal';
          }),
        'Even firing, uneven arrival: unequal primaries are what make a boxer rumble.'
      );
    }
    range(
      g,
      'Primary pipe length',
      0.25,
      1.3,
      0.05,
      ex.headers?.len ?? 0.6,
      (v) => `${v.toFixed(2)} m`,
      () => {},
      'Longer primaries move the tuned scavenging peak to lower rpm and lower the pipe resonances.',
      (v) => app.rebuild((s) => (s.exhaust.headers = { ...(s.exhaust.headers ?? {}), len: v }))
    );

    // --- engine hardware
    g = group('Engine');
    seg(
      g,
      'Camshafts',
      [
        [0, 'Stock'],
        [1, 'Fast road'],
        [2, 'Race'],
      ],
      app.camLevel,
      (v) =>
        app.rebuild((s) => {
          const [deg, lift] = v === 0 ? [0, 0] : v === 1 ? [11, 1] : [26, 2];
          s.cam = camShift(factory.cam, deg, lift);
          if (factory.camHigh) s.camHigh = camShift(factory.camHigh, deg, lift);
          app.camLevel = v;
        }),
      'More duration means more overlap: exhaust gas backs into the intake at idle, combustion gets ragged, and the idle lopes.'
    );
    seg(
      g,
      'Flywheel',
      [
        [0.6, 'Light'],
        [1, 'Stock'],
        [1.7, 'Heavy'],
      ],
      app.flyLevel,
      (v) =>
        app.rebuild((s) => {
          s.inertia = factory.inertia * v;
          app.flyLevel = v;
        })
    );
    const indType = spec.induction?.type ?? 'na';
    const indKey = indType === 'turbo' ? ((spec.induction.count ?? 1) > 1 ? 'twin' : 'turbo') : indType === 'na' ? 'na' : 'sc';
    if (spec.kind !== 'rotary') {
      seg(
        g,
        'Induction',
        [
          ['na', 'Atmospheric'],
          ['turbo', 'Turbo'],
          ['twin', 'Twin-turbo'],
          ['sc', 'Supercharger'],
        ],
        indKey,
        (v) =>
          app.rebuild((s) => {
            const L = app.compiled.dispLitres;
            if (v === 'na') s.induction = { type: 'na' };
            else if (v === 'sc') s.induction = { type: 'twinscrew', displacement: +(L * 0.4).toFixed(2), ratio: 2.4, lobes: 5 };
            else {
              const twin = v === 'twin';
              const keep = factory.induction?.type === 'turbo' ? factory.induction : {};
              s.induction = { type: 'turbo', count: twin ? 2 : 1, size: keep.size ?? 1, boost: keep.boost ?? 1.0, blades: keep.blades ?? 7, bov: tune.bov ?? 'atm' };
            }
          })
      );
    }
    if (indType === 'turbo') {
      range(g, 'Boost target', 0.3, 2.5, 0.05, tune.boost, (v) => `${v.toFixed(2)} bar`, (v) => app.setTune({ boost: v }));
      seg(
        g,
        'Blow-off valve',
        [
          ['atm', 'Vent to air'],
          ['none', 'Delete (flutter)'],
        ],
        tune.bov,
        (v) => app.setTune({ bov: v }),
        'Without a blow-off valve the trapped charge surges back through the compressor. That surge is the flutter.'
      );
      seg(
        g,
        'Anti-lag',
        [
          [false, 'Off'],
          [true, 'On'],
        ],
        !!tune.antilag,
        (v) => app.setTune({ antilag: v }),
        'Works in Drive and Flyby: fuel burns in the manifold off-throttle to keep the turbo spinning.'
      );
    }

    // --- ECU
    g = group('Engine control');
    range(
      g,
      'Rev limit',
      Math.round((factory.ecu.idle + 1500) / 100) * 100,
      Math.round((factory.ecu.limit * 1.15) / 100) * 100,
      100,
      tune.limit,
      (v) => `${v.toLocaleString('en-US')} rpm`,
      (v) => app.setTune({ limit: v })
    );
    seg(
      g,
      'Limiter',
      [
        ['fuel', 'Fuel cut'],
        ['spark', 'Spark cut'],
      ],
      tune.limiter,
      (v) => app.setTune({ limiter: v }),
      'Spark cut keeps injecting fuel, which then explodes in the hot exhaust.'
    );
    range(g, 'Overrun pops', 0, 1, 0.05, tune.burble, (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`), (v) => app.setTune({ burble: v }), 'Retarded spark and a little fuel on lift-off: crackle tune.');
    range(g, 'Launch control', 2000, Math.round(factory.ecu.limit * 0.8), 100, tune.launchRpm, (v) => `${v.toLocaleString('en-US')} rpm`, (v) => app.setTune({ launchRpm: v }));
    seg(
      g,
      'Traction control',
      [
        [true, 'On'],
        [false, 'Off'],
      ],
      tune.tc,
      (v) => app.setTune({ tc: v })
    );
    seg(
      g,
      'Gearbox',
      [
        [true, 'Automatic'],
        [false, 'Manual paddles'],
      ],
      tune.autoShift,
      (v) => app.setTune({ autoShift: v })
    );
  }
}

export function applyHeaderEqualize(spec) {
  const h = spec.exhaust?.headers;
  if (h?.equalize && h.lens) {
    const avg = h.lens.reduce((a, b) => a + b, 0) / h.lens.length;
    return { ...spec, exhaust: { ...spec.exhaust, headers: { ...h, lens: h.lens.map(() => avg) } } };
  }
  return spec;
}

export { clone };
