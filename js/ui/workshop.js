// Tuning drawer. Some settings are live ECU parameters ("tune"); others change
// the hardware and recompile the engine ("rebuild").

import { firingAngles } from '../engine/compile.js';
import { FREE } from '../config.js';

export const CAMERAS = [
  ['rear', 'Behind the car'],
  ['exhaust', 'At the tail pipes'],
  ['side', 'Pit wall'],
  ['front', 'In front'],
  ['bay', 'Engine bay'],
  ['cockpit', 'Cockpit'],
];

export const FUELS = [
  [91, '91 RON'],
  [95, '95 RON'],
  [98, '98 RON'],
  [102, 'Race 102'],
  [108, 'E85'],
];

const clone = (o) => JSON.parse(JSON.stringify(o));

function camShift(cam, deg, lift) {
  if (!cam) return cam;
  return {
    in: [cam.in[0] + deg, cam.in[1] + deg, cam.in[2] + lift],
    ex: [cam.ex[0] + deg, cam.ex[1] + deg, cam.ex[2] + lift],
  };
}

// Firing intervals seen by each exhaust group (bank).
function bankIntervals(spec, groups) {
  const ang = firingAngles(spec);
  const cyc = spec.kind === 'rotary' ? 1080 : 720;
  return groups.map((g) => {
    const a = g.map((c) => ang[c - 1]).sort((x, y) => x - y);
    return a.map((v, i) => (i + 1 < a.length ? a[i + 1] - v : cyc - v + a[0]));
  });
}

// Header styles that make sense for this engine, as [value, label].
export function headerStyles(spec) {
  const banks = spec.banks ?? [spec.firingOrder];
  const per = Math.max(...banks.map((b) => b.length));
  const out = [['n-1', `${per}-into-1`]];
  if (per >= 4) out.push(['tri-y', 'Tri-Y']);
  if (spec.cylinders === 4 && banks.length === 1) out.push(['4-2-1', '4-2-1']);
  out.push(['log', 'Cast log']);
  // Regrouping across banks only helps when each bank fires unevenly but the
  // engine as a whole fires evenly (the cross-plane V8 case).
  if (banks.length === 2 && spec.cylinders >= 6 && spec.cylinders % 2 === 0) {
    const ang = firingAngles(spec).slice().sort((a, b) => a - b);
    const iv = ang.map((v, i) => (i + 1 < ang.length ? ang[i + 1] - v : 720 - v + ang[0]));
    const even = Math.max(...iv) - Math.min(...iv) < 1;
    const bi = bankIntervals(spec, banks).flat();
    const bankEven = Math.max(...bi) - Math.min(...bi) < 1;
    if (even && !bankEven) out.push(['180', '180° bundle of snakes']);
  }
  return out;
}

export function hasDualExits(compiled) {
  const ch = new Set(compiled.exNet.nodes.filter((n) => n.type === 2).map((n) => n.ch));
  return ch.has(0) && ch.has(1);
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
    this.app.holdGas?.(0);
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
    const scroll = b.scrollTop;
    b.innerHTML = '';
    const group = (title, note) => {
      const g = document.createElement('section');
      g.className = 'ws-group';
      g.innerHTML = `<h3>${title}</h3>${note ? `<p class="ws-note">${note}</p>` : ''}`;
      b.appendChild(g);
      return g;
    };
    // Pro-only settings stay visible but open the Pro screen when touched.
    const lockField = (f, label) => {
      if (app.isPro() || FREE.workshop.has(label)) return;
      f.classList.add('locked');
      const tag = document.createElement('span');
      tag.className = 'pro-tag';
      tag.textContent = 'PRO';
      f.querySelector('label')?.appendChild(tag);
      f.querySelectorAll('input').forEach((i) => (i.disabled = true));
      f.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          app.showPaywall({ reason: `${label} can be changed with Pro` });
        },
        true
      );
    };
    const lockedGroup = (g, what) => {
      const p = document.createElement('p');
      p.className = 'ws-note';
      p.textContent = `${what} is part of Pro.`;
      g.appendChild(p);
      const row = document.createElement('div');
      row.className = 'btn-row';
      const bt = document.createElement('button');
      bt.className = 'btn';
      bt.textContent = 'See Pro';
      bt.addEventListener('click', () => app.showPaywall({ reason: `${what} is part of Pro` }));
      row.appendChild(bt);
      g.appendChild(row);
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
      lockField(f, label);
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
      lockField(f, label);
      g.appendChild(f);
    };
    const button = (g, text, onClick, cls = 'btn') => {
      const bt = document.createElement('button');
      bt.className = cls;
      bt.textContent = text;
      bt.addEventListener('click', onClick);
      g.appendChild(bt);
      return bt;
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
    seg(
      g,
      'Physics rate',
      [
        ['auto', 'Auto'],
        ['full', 'Full'],
        ['eco', 'Half'],
      ],
      app.quality,
      (v) => app.setQuality(v),
      'The whole engine is simulated once per audio sample. Half rate halves the CPU cost on slow phones and loses the very top of the spectrum.'
    );

    // --- mixer
    g = group('Mixer', 'Each source is computed separately, so you can pull them apart. Solo plays one alone.');
    if (app.isPro()) this.renderMixer(g);
    else lockedGroup(g, 'The sound mixer');

    // --- A/B
    g = group('Compare A/B', 'Hold the A/B button (or the B key) to hear A. Let go to come back.');
    if (!app.isPro()) lockedGroup(g, 'A/B compare');
    else this.renderAB(g, button);

    this.renderHardware(group, seg, range, button);
    b.scrollTop = scroll;
  }

  renderAB(g, button) {
    const app = this.app;
    const factory = app.factory;
    const ab = document.createElement('div');
    ab.className = 'ab-row';
    ab.innerHTML = `<span class="ab-badge">A</span><span class="ab-label"></span>`;
    ab.querySelector('.ab-label').textContent = app.abLabel();
    g.appendChild(ab);
    const hold = document.createElement('button');
    hold.className = 'btn ab-hold';
    hold.textContent = 'Hold to hear A';
    hold.addEventListener('pointerdown', (e) => {
      hold.setPointerCapture(e.pointerId);
      hold.classList.add('held');
      app.abHold(true);
    });
    const release = () => {
      hold.classList.remove('held');
      app.abHold(false);
    };
    hold.addEventListener('pointerup', release);
    hold.addEventListener('pointercancel', release);
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    g.appendChild(hold);
    const abBtns = document.createElement('div');
    abBtns.className = 'btn-row';
    g.appendChild(abBtns);
    button(abBtns, 'A = factory', () => {
      app.setAB(null);
      this.render();
    });
    button(abBtns, 'A = this setup', () => {
      app.setAB('current');
      this.render();
    });
    const pick = document.createElement('select');
    pick.className = 'ab-pick';
    pick.setAttribute('aria-label', 'Compare with another engine');
    pick.add(new Option('A = another engine…', ''));
    for (const p of app.allEngines()) if (p.id !== factory.id) pick.add(new Option(p.name, p.id));
    pick.addEventListener('change', () => {
      if (pick.value) app.setAB({ engine: pick.value });
      this.render();
    });
    abBtns.appendChild(pick);
  }

  // Exhaust, intake, engine and ECU settings.
  renderHardware(group, seg, range, button) {
    const app = this.app;
    const spec = app.spec;
    const factory = app.factory;
    const tune = app.tune;

    // --- exhaust
    let g = group('Exhaust');
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
    if (spec.kind !== 'rotary') {
      const styles = headerStyles(spec);
      const cur = ex.headers?.style ?? 'n-1';
      seg(
        g,
        'Headers',
        styles,
        styles.some((s) => s[0] === cur) ? cur : 'n-1',
        (v) => app.rebuild((s) => (s.exhaust.headers = { ...(s.exhaust.headers ?? {}), style: v })),
        styles.some((s) => s[0] === '180')
          ? '180° headers cross the pipes over the engine so each collector gets one pulse every 180°. The cross-plane burble turns into a flat-plane scream.'
          : 'How the primaries meet. Longer separate runs before the merge give stronger scavenging and a cleaner note.'
      );
    }
    const turboOneBank = spec.induction?.type === 'turbo' && (spec.induction.count ?? 1) === 1;
    const dualBank = (spec.banks?.length ?? 1) > 1 && spec.kind !== 'rotary' && !turboOneBank;
    if (dualBank && (ex.exit ?? 'rear') !== 'side') {
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
    seg(
      g,
      'Resonators',
      [
        [true, 'Fitted'],
        [false, 'Deleted'],
      ],
      !!ex.resonator,
      (v) => app.rebuild((s) => (s.exhaust.resonator = v)),
      'Straight-through cans with packing in the mid pipes. Deleting them brings back drone and rasp.'
    );
    seg(
      g,
      'Exit',
      [
        ['rear', 'Rear'],
        ['side', 'Side pipes'],
      ],
      ex.exit ?? 'rear',
      (v) => app.rebuild((s) => (s.exhaust.exit = v)),
      'Side pipes are short and leave under the doors: the pit-wall mic and the cockpit get the full blast.'
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

    // --- intake & boost
    g = group('Intake & boost');
    const it = spec.intake ?? {};
    seg(
      g,
      'Air intake',
      [
        ['stock', 'Airbox'],
        ['ram', 'Ram air'],
        ['open', 'Open filter'],
      ],
      it.airbox ?? 'stock',
      (v) => app.rebuild((s) => (s.intake = { ...(s.intake ?? {}), airbox: v })),
      'The airbox is a low-pass filter on the induction roar. An open cone lets the whole intake howl through.'
    );
    if (spec.kind !== 'rotary') {
      seg(
        g,
        'Throttles',
        [
          [false, 'Single throttle'],
          [true, 'Individual (ITB)'],
        ],
        !!it.itb,
        (v) =>
          app.rebuild((s) => {
            const fi = factory.intake ?? {};
            if (v) {
              const rd = s.intake?.runnerDia ?? 45;
              s.intake = { ...(s.intake ?? {}), itb: true, throttleCount: s.cylinders, throttleDia: Math.round(rd * 0.95), plenum: 0.8 };
            } else {
              s.intake = { ...(s.intake ?? {}), itb: false, throttleCount: fi.itb ? 1 : fi.throttleCount ?? 1, throttleDia: fi.itb ? 80 : fi.throttleDia ?? 80, plenum: fi.itb ? 5 : fi.plenum ?? 5 };
            }
          }),
        'One throttle per cylinder, right at the port: instant response, and you hear every runner gulp.'
      );
    }
    const indType = spec.induction?.type ?? 'na';
    const indKey = indType === 'turbo' ? ((spec.induction.count ?? 1) > 1 ? 'twin' : 'turbo') : indType;
    if (spec.kind !== 'rotary') {
      const opts = [
        ['na', 'Atmospheric'],
        ['turbo', 'Turbo'],
      ];
      if ((spec.banks?.length ?? 1) > 1) opts.push(['twin', 'Twin-turbo']);
      opts.push(['twinscrew', 'Twin-screw'], ['roots', 'Roots'], ['centrifugal', 'Centrifugal']);
      seg(
        g,
        'Induction',
        opts,
        indKey,
        (v) =>
          app.rebuild((s) => {
            const L = app.compiled.dispLitres;
            const keep = factory.induction ?? {};
            if (v === 'na') s.induction = { type: 'na' };
            else if (v === 'twinscrew') s.induction = { type: 'twinscrew', displacement: +(L * 0.4).toFixed(2), ratio: 2.4, lobes: 5 };
            else if (v === 'roots') s.induction = { type: 'roots', displacement: +(L * 0.45).toFixed(2), ratio: 2.1, lobes: 3 };
            else if (v === 'centrifugal') s.induction = { type: 'centrifugal', boost: 0.7, size: 1, blades: 10, bov: tune.bov ?? 'atm' };
            else {
              const twin = v === 'twin';
              const k = keep.type === 'turbo' ? keep : {};
              s.induction = { type: 'turbo', count: twin ? 2 : 1, size: k.size ?? (twin ? 0.7 : 1), boost: k.boost ?? 1.0, blades: k.blades ?? 7, bov: tune.bov ?? 'atm' };
            }
            if (v !== 'na' && app.tune.boost == null) app.tune.boost = s.induction.boost ?? 1;
          }),
        'A twin-screw or Roots blower is driven by the crank and whines at its lobe frequency. A centrifugal blower is a belt-driven compressor: its boost and whistle climb with rpm.'
      );
    }
    if (indType === 'turbo' || indType === 'centrifugal') {
      range(
        g,
        indType === 'centrifugal' ? 'Boost at redline' : 'Boost target',
        0.3,
        2.5,
        0.05,
        tune.boost,
        (v) => `${v.toFixed(2)} bar`,
        (v) => app.setTune({ boost: v })
      );
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
    }
    if (indType === 'twinscrew' || indType === 'roots') {
      range(
        g,
        'Blower pulley',
        1.4,
        3.4,
        0.1,
        spec.induction.ratio ?? 2.4,
        (v) => `${v.toFixed(1)}:1`,
        () => {},
        'Blower speed relative to the crank. A smaller pulley spins it faster: more boost, more whine.',
        (v) => app.rebuild((s) => (s.induction.ratio = v))
      );
    }
    if (indType === 'turbo') {
      seg(
        g,
        'Wastegate',
        [
          [false, 'Plumbed back'],
          [true, 'Screamer pipe'],
        ],
        !!spec.induction.screamer,
        (v) => app.rebuild((s) => (s.induction.screamer = v)),
        'A screamer pipe dumps the wastegate straight to the air: every time boost is reached it rasps.'
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
    if ((spec.sound?.valvetrain ?? 'dohc') !== 'pneumatic' && spec.kind !== 'rotary') {
      seg(
        g,
        'Valve springs',
        [
          ['stock', 'Stock'],
          ['race', 'Race'],
        ],
        tune.springs,
        (v) => app.setTune({ springs: v }),
        `Stock springs lose control of the valves near ${Math.round((app.compiled.floatRpm * (tune.springs === 'race' ? 1.12 : 1)) / 100) * 100} rpm: the valves float and bounce, power falls away and the sound turns ragged. Raise the rev limit to try it.`
      );
    }
    const edit = document.createElement('div');
    edit.className = 'btn-row';
    g.appendChild(edit);
    button(edit, 'Open in engine builder', () => app.openBuilder({ from: 'current' }), 'btn btn-accent');

    // --- ECU
    g = group('Engine control');
    range(
      g,
      'Rev limit',
      Math.round((factory.ecu.idle + 1500) / 100) * 100,
      Math.round((factory.ecu.limit * 1.25) / 100) * 100,
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
    range(
      g,
      'Ignition timing',
      -10,
      15,
      1,
      tune.spark,
      (v) => (v === 0 ? 'factory' : `${v > 0 ? '+' : ''}${v}°`),
      (v) => app.setTune({ spark: v }),
      'More advance builds pressure earlier, until the unburned end gas autoignites: knock. It rings the combustion chamber at its acoustic resonance, a metallic ping.'
    );
    seg(g, 'Fuel', FUELS, tune.octane, (v) => app.setTune({ octane: v }), 'Lower octane fuel autoignites sooner.');
    seg(
      g,
      'Knock sensor',
      [
        [true, 'On'],
        [false, 'Off'],
      ],
      tune.knockCtl,
      (v) => app.setTune({ knockCtl: v }),
      'With the sensor on, the ECU hears the ping and pulls timing. Off, the engine keeps knocking.'
    );
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
      (v) => app.setTune({ autoShift: v }),
      'With manual paddles nothing stops you from shifting down too early: the wheels drag the engine past redline.'
    );
  }

  renderMixer(g) {
    const app = this.app;
    const mix = app.mix;
    const dual = hasDualExits(app.compiled);
    const rows = dual
      ? [
          ['exL', 'Left pipe'],
          ['exR', 'Right pipe'],
        ]
      : [['ex', 'Exhaust']];
    rows.push(['intake', 'Intake & blower'], ['mech', 'Mechanical'], ['road', 'Road & tyres']);
    const grid = document.createElement('div');
    grid.className = 'mixer';
    for (const [k, label] of rows) {
      const row = document.createElement('div');
      row.className = 'mix-row';
      const v = k === 'ex' ? (mix.exL + mix.exR) / 2 : mix[k];
      const id = 'mix-' + k;
      row.innerHTML = `<label for="${id}">${label}</label><input id="${id}" type="range" min="0" max="2" step="0.05" value="${v}"><output>${Math.round(v * 100)}%</output>`;
      const inp = row.querySelector('input');
      const out = row.querySelector('output');
      inp.addEventListener('input', () => {
        out.textContent = `${Math.round(+inp.value * 100)}%`;
        app.setMix(k === 'ex' ? { exL: +inp.value, exR: +inp.value } : { [k]: +inp.value });
      });
      const solo = document.createElement('button');
      solo.className = 'solo';
      solo.textContent = 'S';
      solo.title = `Solo ${label.toLowerCase()}`;
      solo.setAttribute('aria-pressed', String(mix.solo === k));
      solo.addEventListener('click', () => {
        app.setMix({ solo: mix.solo === k ? null : k });
        this.render();
      });
      row.appendChild(solo);
      grid.appendChild(row);
    }
    g.appendChild(grid);
    const r = document.createElement('div');
    r.className = 'btn-row';
    const reset = document.createElement('button');
    reset.className = 'link-btn';
    reset.textContent = 'Reset mixer';
    reset.addEventListener('click', () => {
      app.setMix({ exL: 1, exR: 1, intake: 1, mech: 1, road: 1, solo: null });
      this.render();
    });
    r.appendChild(reset);
    g.appendChild(r);
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
