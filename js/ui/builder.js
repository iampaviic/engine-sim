// Engine builder workbench. Every change is heard at once (the build
// hot-swaps into the running simulation) and is measured on a virtual dyno
// running the same physics in a worker.

import {
  LAYOUTS,
  COUNTS,
  CAMS,
  CARS,
  VALVETRAINS,
  crankOptions,
  crankNote,
  firingOptions,
  evenPinOffset,
  normalize,
  designToSpec,
  defaultDesign,
  specToDesign,
  derived,
  bankIntervals,
  loadBuilds,
  saveBuilds,
} from '../engine/builder.js';
import { compileEngine, workletConfig } from '../engine/compile.js';
import { headerStyles, FUELS } from './workshop.js';

const STEPS = [
  ['block', 'Block'],
  ['crank', 'Crank & firing'],
  ['heads', 'Heads & cams'],
  ['air', 'Intake & boost'],
  ['exhaust', 'Exhaust'],
  ['ecu', 'ECU & car'],
];
const BANK_COL = ['#ffb54a', '#58aee0', '#7bd88f', '#e58cff'];
const fmt = (v) => Math.round(v).toLocaleString('en-US');

export class Builder {
  constructor({ root, app, presets }) {
    this.root = root;
    this.app = app;
    this.presets = presets;
    this.$ = (id) => root.querySelector('#' + id);
    this.d = null;
    this.step = 'block';
    this.live = true;
    this.result = null;
    this.progress = 0;
    this.jobId = 0;
    this.worker = null;
    this.auditionT = null;
    this.analyzeT = null;
    this.dirty = false;
    this.$('bClose').addEventListener('click', () => this.hide());
    this.$('bSave').addEventListener('click', () => this.save());
    this.$('bLive').addEventListener('click', () => {
      this.live = !this.live;
      this.$('bLive').setAttribute('aria-pressed', String(this.live));
      if (this.live) this.audition(true);
    });
    this.$('bName').addEventListener('input', (e) => {
      this.d.name = e.target.value.slice(0, 40);
      this.dirty = true;
      this.renderSheet();
    });
    const from = this.$('bFrom');
    from.addEventListener('change', () => {
      const v = from.value;
      from.value = '';
      if (!v) return;
      const spec = v === 'default' ? null : presets.find((p) => p.id === v);
      const d = spec ? specToDesign(spec) : defaultDesign();
      d.id = this.d.id;
      if (spec) d.name = `My ${spec.name}`;
      this.load(d);
    });
    const rev = this.$('bRev');
    const down = (e) => {
      e.preventDefault();
      rev.setPointerCapture?.(e.pointerId);
      if (!app.started) {
        app.start().then(() => this.audition(true));
      }
      app.holdGas(1);
      rev.classList.add('held');
    };
    const up = () => {
      app.holdGas(0);
      rev.classList.remove('held');
    };
    rev.addEventListener('pointerdown', down);
    rev.addEventListener('pointerup', up);
    rev.addEventListener('pointercancel', up);
    rev.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  get open() {
    return !this.root.hidden;
  }

  show({ from = 'current', design = null } = {}) {
    const app = this.app;
    let d;
    if (design) d = normalize(design);
    else if (from === 'new') d = defaultDesign();
    else d = app.factory.custom && app.factory.design ? normalize(app.factory.design) : specToDesign(app.spec);
    if (from === 'current' && app.factory.custom && app.factory.id?.startsWith('my-') && app.factory.id !== 'my-draft') d.id = app.factory.id;
    // starting from a factory engine keeps its sound until the first change
    this.root.hidden = false;
    this.load(d, from !== 'current' || !!app.factory.custom);
    const sel = this.$('bFrom');
    if (sel.options.length <= 2) for (const p of this.presets) sel.add(new Option(p.name, p.id));
    this.$('bName').focus({ preventScroll: true });
  }

  hide() {
    this.root.hidden = true;
    this.app.holdGas(0);
    clearTimeout(this.auditionT);
    if (this.live && this.pendingAudition) this.audition(true);
    this.app.onBuilderClosed?.();
  }

  load(d, audition = true) {
    this.d = normalize(d);
    this.result = null;
    this.dirty = false;
    this.$('bName').value = this.d.name;
    this.renderSteps();
    this.renderForm();
    this.renderSheet();
    if (audition) this.scheduleAudition(0);
    this.scheduleAnalysis(150);
  }

  // Apply a change. `form`: re-render the form (discrete choices); sliders
  // only refresh the spec sheet while they move.
  set(patch, form = true) {
    const d = this.d;
    const next = { ...d, ...patch };
    for (const k of ['induction', 'intake', 'exhaust', 'ecu']) if (patch[k]) next[k] = { ...d[k], ...patch[k] };
    this.d = normalize(next);
    // default names follow the layout ("My V8" -> "My V12")
    if ((patch.layout || patch.cylinders) && /^My (V\d+|I\d+|flat-\d+|\d-rotor|engine)$/.test(d.name)) {
      const n = this.d.cylinders;
      this.d.name = { v: `My V${n}`, inline: `My I${n}`, flat: `My flat-${n}`, rotary: `My ${n}-rotor` }[this.d.layout];
      this.$('bName').value = this.d.name;
    }
    this.dirty = true;
    if (form) this.renderForm();
    this.renderSheet();
    this.scheduleAudition();
    this.scheduleAnalysis();
  }

  // ------------------------------------------------------------- audition
  scheduleAudition(ms = 220) {
    this.pendingAudition = true;
    clearTimeout(this.auditionT);
    this.auditionT = setTimeout(() => this.audition(), ms);
  }

  audition(force = false) {
    this.pendingAudition = false;
    if (!this.live && !force) return;
    const spec = this.spec();
    this.app.loadSpec(spec, { hot: true, quiet: true });
  }

  spec() {
    const s = designToSpec(this.d);
    s.design = JSON.parse(JSON.stringify(this.d));
    s.id = this.d.id ?? 'my-draft';
    return s;
  }

  // ------------------------------------------------------------ analysis
  scheduleAnalysis(ms = 900) {
    clearTimeout(this.analyzeT);
    this.analyzeT = setTimeout(() => this.analyze(), ms);
  }

  analyze() {
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('../engine/analyze-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this.onWorker(e.data);
        this.worker.onerror = () => {
          this.workerFailed = true;
          this.renderSheet();
        };
      } catch {
        this.workerFailed = true;
        this.renderSheet();
        return;
      }
    }
    if (this.busy) {
      // one run at a time: restart once the current one reports back
      this.again = true;
      return;
    }
    const spec = this.spec();
    const cfg = workletConfig(compileEngine(spec));
    this.busy = true;
    this.again = false;
    this.progress = 0;
    this.worker.postMessage({ type: 'analyze', id: ++this.jobId, cfg, tune: { limit: spec.ecu.limit, octane: spec.ecu.octane } });
    this.renderDynoStatus();
  }

  onWorker(m) {
    if (m.type === 'progress') {
      if (m.id === this.jobId) {
        this.progress = m.f;
        this.renderDynoStatus();
      }
      return;
    }
    if (m.type !== 'result') return;
    this.busy = false;
    if (this.again) {
      this.analyze();
      return;
    }
    if (m.id !== this.jobId) return;
    this.result = m;
    if (!m.error && m.trim) {
      // loudness calibrated: the next audition plays at the preset level
      const old = this.d.calib?.trim;
      this.d.calib = { trim: m.trim };
      if (this.live && this.open && (!old || Math.abs(old - m.trim) / m.trim > 0.15)) this.audition();
    }
    this.renderSheet();
  }

  // -------------------------------------------------------------- saving
  save() {
    const d = this.d;
    if (!d.id || d.id === 'my-draft') d.id = 'my-' + Date.now().toString(36);
    const list = loadBuilds();
    const i = list.findIndex((x) => x.id === d.id);
    if (i >= 0) list[i] = d;
    else list.push(d);
    if (!saveBuilds(list)) {
      this.app.toast('This browser is blocking storage here, so the build could not be saved');
      return;
    }
    this.dirty = false;
    this.app.loadSpec(this.spec(), { hot: true, quiet: true, remember: true });
    this.app.toast(`Saved to My garage: ${d.name}`);
    this.renderSheet();
  }

  // ------------------------------------------------------------- render
  renderSteps() {
    const nav = this.$('bSteps');
    nav.innerHTML = '';
    for (const [k, label] of STEPS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === this.step));
      b.addEventListener('click', () => {
        this.step = k;
        this.renderSteps();
        this.renderForm();
        this.$('bForm').scrollTop = 0;
      });
      nav.appendChild(b);
    }
  }

  renderForm() {
    const f = this.$('bForm');
    const keepScroll = f.scrollTop;
    f.innerHTML = '';
    const d = this.d;
    const H = this.helpers(f);
    switch (this.step) {
      case 'block':
        this.formBlock(H, d);
        break;
      case 'crank':
        this.formCrank(H, d);
        break;
      case 'heads':
        this.formHeads(H, d);
        break;
      case 'air':
        this.formAir(H, d);
        break;
      case 'exhaust':
        this.formExhaust(H, d);
        break;
      case 'ecu':
        this.formEcu(H, d);
        break;
    }
    const idx = STEPS.findIndex((s) => s[0] === this.step);
    const nav = document.createElement('div');
    nav.className = 'b-next';
    if (idx > 0) {
      const p = document.createElement('button');
      p.className = 'btn';
      p.textContent = `← ${STEPS[idx - 1][1]}`;
      p.addEventListener('click', () => this.go(STEPS[idx - 1][0]));
      nav.appendChild(p);
    }
    if (idx < STEPS.length - 1) {
      const n = document.createElement('button');
      n.className = 'btn btn-accent';
      n.textContent = `${STEPS[idx + 1][1]} →`;
      n.addEventListener('click', () => this.go(STEPS[idx + 1][0]));
      nav.appendChild(n);
    }
    f.appendChild(nav);
    f.scrollTop = keepScroll;
  }

  go(step) {
    this.step = step;
    this.renderSteps();
    this.renderForm();
    this.$('bForm').scrollTop = 0;
  }

  helpers(f) {
    const field = (label, hint) => {
      const el = document.createElement('div');
      el.className = 'field';
      el.innerHTML = `<label>${label}</label>`;
      f.appendChild(el);
      if (hint) el.dataset.hint = hint;
      return el;
    };
    const addHint = (el, hint) => {
      if (hint) el.insertAdjacentHTML('beforeend', `<div class="hint">${hint}</div>`);
    };
    return {
      title: (t, sub) => {
        const h = document.createElement('div');
        h.className = 'b-sec';
        h.innerHTML = `<h3>${t}</h3>${sub ? `<p>${sub}</p>` : ''}`;
        f.appendChild(h);
      },
      seg: (label, opts, value, onSet, hint) => {
        const el = field(label);
        const s = document.createElement('div');
        s.className = 'seg';
        for (const [v, text, disabled] of opts) {
          const bt = document.createElement('button');
          bt.textContent = text;
          bt.setAttribute('aria-pressed', String(String(v) === String(value)));
          if (disabled) bt.disabled = true;
          bt.addEventListener('click', () => onSet(v));
          s.appendChild(bt);
        }
        el.appendChild(s);
        addHint(el, hint);
      },
      range: (label, min, max, step, value, show, onInput, hint, onCommit) => {
        const el = field(label);
        const id = 'b-' + label.replace(/\W+/g, '-').toLowerCase();
        el.querySelector('label').setAttribute('for', id);
        el.insertAdjacentHTML('beforeend', `<output>${show(value)}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">`);
        const inp = el.querySelector('input');
        const out = el.querySelector('output');
        inp.addEventListener('input', () => {
          out.textContent = show(+inp.value);
          onInput(+inp.value);
        });
        if (onCommit) inp.addEventListener('change', () => onCommit(+inp.value));
        addHint(el, hint);
        return el;
      },
      toggle: (label, value, onSet, hint, labels = ['Off', 'On']) => {
        const el = field(label);
        const s = document.createElement('div');
        s.className = 'seg';
        [false, true].forEach((v, i) => {
          const bt = document.createElement('button');
          bt.textContent = labels[i];
          bt.setAttribute('aria-pressed', String(v === !!value));
          bt.addEventListener('click', () => onSet(v));
          s.appendChild(bt);
        });
        el.appendChild(s);
        addHint(el, hint);
      },
      note: (html) => {
        const p = document.createElement('p');
        p.className = 'b-note';
        p.innerHTML = html;
        f.appendChild(p);
      },
      el: (node) => f.appendChild(node),
    };
  }

  formBlock(H, d) {
    H.title('Block', 'The layout, the size of each cylinder and how hard it squeezes the charge.');
    H.seg(
      'Layout',
      LAYOUTS,
      d.layout,
      (v) => {
        const c = { inline: 4, v: 8, flat: 6, rotary: 2 }[v];
        this.set({ layout: v, cylinders: c, crank: null, order: null, splitPin: false, induction: { count: 1 } });
      },
      d.layout === 'rotary' ? 'A Wankel has no pistons or valves: a triangular rotor orbits in an epitrochoid housing and uncovers ports.' : null
    );
    H.seg(
      d.layout === 'rotary' ? 'Rotors' : 'Cylinders',
      COUNTS[d.layout].map((n) => [n, String(n)]),
      d.cylinders,
      (v) => this.set({ cylinders: v, crank: null, order: null, splitPin: false })
    );
    if (d.layout === 'v') {
      H.range(
        'Bank angle',
        15,
        135,
        1,
        d.bankAngle,
        (v) => `${v}°`,
        (v) => this.set({ bankAngle: v, splitPin: false, order: null }, false),
        `The angle between the banks moves bank B's firing relative to bank A. Even firing for a V${d.cylinders} with shared crankpins needs ${evenAngle(d)}°.`,
        () => this.renderForm()
      );
    }
    if (d.layout === 'rotary') {
      H.range('Chamber displacement', 300, 900, 10, d.chamber, (v) => `${v} cc`, (v) => this.set({ chamber: v }, false), 'Per rotor face. A 13B has 654 cc.');
    } else {
      H.range('Bore', 50, 130, 0.5, d.bore, (v) => `${v.toFixed(1)} mm`, (v) => this.set({ bore: v }, false), 'Bigger bores fit bigger valves (more top-end breathing) but the flame has further to travel, and the chamber rings lower when it knocks.');
      H.range('Stroke', 35, 140, 0.5, d.stroke, (v) => `${v.toFixed(1)} mm`, (v) => this.set({ stroke: v }, false), 'A short stroke lets the engine rev: piston speed is what limits it.');
      H.range('Rod length', 1.4, 2.2, 0.01, d.rodRatio, (v) => `${v.toFixed(2)} × stroke`, (v) => this.set({ rodRatio: v }, false));
    }
    H.range(
      'Compression ratio',
      7,
      15,
      0.1,
      d.compression,
      (v) => `${v.toFixed(1)}:1`,
      (v) => this.set({ compression: v }, false),
      'Higher compression extracts more work from each bang, until the end gas autoignites and knocks. Boost adds to the effective compression.'
    );
  }

  formCrank(H, d) {
    H.title('Crank & firing', 'Where the crankpins sit decides when each cylinder reaches top dead centre. The builder lists every firing order this crank can produce.');
    if (d.layout === 'rotary') {
      H.note('Each rotor has three faces, so every rotor fires three times per three turns of the eccentric shaft. The rotors are phased evenly.');
    } else {
      H.seg(
        'Crankshaft',
        crankOptions(d),
        d.crank,
        (v) => this.set({ crank: v, order: null, splitPin: false }),
        crankNote(d)
      );
      if (d.layout === 'v') {
        const off = evenPinOffset({ ...d, splitPin: false });
        const opts = firingOptions({ ...d, splitPin: false }, 1)[0];
        if (off != null && off !== 0 && opts.spread > 0.5) {
          H.toggle(
            'Split crankpins',
            d.splitPin,
            (v) => this.set({ splitPin: v, pinOffset: v ? off : 0, order: null }),
            `Offsetting each pair of pins by ${off > 0 ? '+' : ''}${off}° makes this V${d.cylinders} fire evenly.`,
            ['Shared pins', `Offset ${off > 0 ? '+' : ''}${off}°`]
          );
        }
      }
    }
    const opts = firingOptions(d, 8);
    const list = document.createElement('div');
    list.className = 'fire-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Firing order');
    const banks = bankGroups(d);
    for (const o of opts) {
      const b = document.createElement('button');
      b.className = 'fire-opt';
      b.setAttribute('role', 'radio');
      const on = o.order.join() === d.order.join();
      b.setAttribute('aria-checked', String(on));
      const bi = banks.length > 1 && d.layout !== 'rotary' ? bankIntervals(d, o.angles, banks) : null;
      b.innerHTML = `<span class="fo-name">${o.name}</span><span class="fo-order">${o.order.join('-')}</span>
        <span class="fo-iv">${o.intervals.map((v) => Math.round(v)).join(' · ')}°${bi ? `<br>banks: ${bi.map((x) => x.join('-')).join(' | ')}` : ''}</span>`;
      b.appendChild(miniStrip(o, d, banks));
      b.addEventListener('click', () => this.set({ order: o.order.slice() }));
      list.appendChild(b);
    }
    H.el(list);
    if (d.layout !== 'rotary') H.note('Uneven orders bunch the pulses: <b>big bang</b> and <b>twin pulse</b> engines sound lumpy, like a V-twin. Within one bank, uneven gaps are what make a V8 burble.');
  }

  formHeads(H, d) {
    if (d.layout === 'rotary') {
      H.title('Ports', 'A rotary has no valves: the rotor flanks open and close the ports.');
      H.seg(
        'Port timing',
        CAMS.map(([k], i) => [k, ['Street', 'Street+', 'Bridge', 'Big bridge', 'Peripheral'][i]]),
        d.cam,
        (v) => this.set({ cam: v }),
        'Bigger ports open earlier and close later: more power up top, more overlap, and the brap-brap idle.'
      );
      return;
    }
    H.title('Heads & cams', 'How the engine breathes.');
    H.seg(
      'Valvetrain',
      VALVETRAINS,
      d.valvetrain,
      (v) => this.set({ valvetrain: v, valves: v === 'ohv' ? 2 : d.valves === 2 ? 4 : d.valves }),
      `Heavier valvetrains float sooner: pushrods near 7,000 rpm, twin cams past 9,000, pneumatic springs never. This one floats near ${fmt(derived(d).floatRpm)} rpm.`
    );
    H.seg(
      'Valves per cylinder',
      [2, 3, 4, 5].map((n) => [n, String(n), d.valvetrain === 'ohv' && n > 2]),
      d.valves,
      (v) => this.set({ valves: v }),
      'More, smaller valves give more curtain area and lighter parts.'
    );
    H.seg(
      'Camshafts',
      CAMS.map(([k, label]) => [k, label]),
      d.cam,
      (v) => this.set({ cam: v }),
      camHint(d)
    );
    H.toggle('Second cam profile', d.vtec, (v) => this.set({ vtec: v }), 'Switch to a wilder lobe at high rpm, VTEC style.');
    if (d.vtec) {
      H.range('Switch-over', 2500, Math.max(3000, d.ecu.limit - 500), 100, d.vtecRpm, (v) => `${fmt(v)} rpm`, (v) => this.set({ vtecRpm: v }, false));
    }
  }

  formAir(H, d) {
    H.title('Intake & boost', 'What feeds the cylinders.');
    const ind = d.induction;
    const multi = d.layout === 'v' || d.layout === 'flat';
    const opts = [
      ['na', 'Atmospheric'],
      ['turbo', 'Turbo'],
    ];
    if (multi) opts.push(['twin', 'Twin-turbo']);
    if (d.layout !== 'rotary') opts.push(['twinscrew', 'Twin-screw'], ['roots', 'Roots'], ['centrifugal', 'Centrifugal']);
    const key = ind.type === 'turbo' && ind.count > 1 ? 'twin' : ind.type;
    H.seg(
      'Induction',
      opts,
      key,
      (v) => {
        if (v === 'twin') this.set({ induction: { type: 'turbo', count: 2, size: 0.7 } });
        else if (v === 'turbo') this.set({ induction: { type: 'turbo', count: 1, size: 1 } });
        else this.set({ induction: { type: v, count: 1 } });
      },
      'Turbos are driven by exhaust gas: they lag, then whistle and soak up pulses. Blowers are belt-driven: instant boost and a whine.'
    );
    if (ind.type === 'turbo') {
      H.seg(
        'Turbo size',
        [
          [0.7, 'Small'],
          [1, 'Medium'],
          [1.3, 'Large'],
        ],
        ind.size <= 0.8 ? 0.7 : ind.size >= 1.2 ? 1.3 : 1,
        (v) => this.set({ induction: { size: v } }),
        'Small turbines spool early and choke up top; large ones lag, then hit hard.'
      );
    }
    if (ind.type === 'turbo' || ind.type === 'centrifugal') {
      H.range(ind.type === 'centrifugal' ? 'Boost at redline' : 'Boost', 0.3, 2.5, 0.05, ind.boost, (v) => `${v.toFixed(2)} bar`, (v) => this.set({ induction: { boost: v } }, false));
    }
    if (ind.type === 'twinscrew' || ind.type === 'roots') {
      H.range('Blower pulley', 1.4, 3.4, 0.1, ind.ratio, (v) => `${v.toFixed(1)}:1`, (v) => this.set({ induction: { ratio: v } }, false), 'Blower speed relative to the crank: more speed, more boost and whine.');
    }
    if (ind.type === 'turbo') {
      H.toggle('Screamer pipe', ind.screamer, (v) => this.set({ induction: { screamer: v } }), 'The wastegate dumps straight to the air.');
      H.toggle('Anti-lag', ind.antilag, (v) => this.set({ induction: { antilag: v } }), 'Bangs on the overrun in Drive and Flyby: fuel burns in the manifold to keep the turbo spinning.');
    }
    if (ind.type === 'turbo' || ind.type === 'centrifugal') {
      H.toggle('Blow-off valve', ind.bov !== 'none', (v) => this.set({ induction: { bov: v ? 'atm' : 'none' } }), 'Delete it for compressor flutter.', ['Deleted', 'Vent to air']);
    }
    H.seg(
      'Air intake',
      [
        ['stock', 'Airbox'],
        ['ram', 'Ram air'],
        ['open', 'Open filter'],
      ],
      d.intake.airbox,
      (v) => this.set({ intake: { airbox: v } })
    );
    if (d.layout !== 'rotary') H.toggle('Throttles', d.intake.itb, (v) => this.set({ intake: { itb: v } }), 'Individual throttle bodies: one per cylinder, right at the port.', ['Single', 'Individual (ITB)']);
    H.range(
      'Intake runner length',
      0.12,
      0.6,
      0.01,
      d.intake.runnerLen,
      (v) => `${v.toFixed(2)} m`,
      (v) => this.set({ intake: { runnerLen: v } }, false),
      'The runner is an organ pipe: its pressure waves help fill the cylinder at one speed. Long runners help low down, short ones help at the top.'
    );
  }

  formExhaust(H, d) {
    H.title('Exhaust', 'The pipes shape the pulses into the sound you hear.');
    if (d.layout !== 'rotary') {
      const styles = headerStyles(designToSpec(d));
      H.seg('Headers', styles, styles.some((s) => s[0] === d.exhaust.headers) ? d.exhaust.headers : 'n-1', (v) => this.set({ exhaust: { headers: v } }), styles.some((s) => s[0] === '180') ? '180° headers cross the pipes so each collector hears one pulse every 180°.' : null);
    }
    const dv = derived(d);
    H.range(
      'Primary length',
      0.2,
      1.4,
      0.01,
      d.exhaust.len,
      (v) => `${v.toFixed(2)} m`,
      (v) => this.set({ exhaust: { len: v } }, false),
      dv.headerRpm ? `Tuned for scavenging near ${fmt(dv.headerRpm)} rpm: the reflected rarefaction arrives during valve overlap and pulls the cylinder clear.` : null
    );
    if (d.layout !== 'rotary' && d.cylinders > 1) H.toggle('Primary lengths', d.exhaust.unequal, (v) => this.set({ exhaust: { unequal: v } }), 'Unequal primaries spread the pulses out: the boxer rumble.', ['Equal', 'Unequal']);
    if ((d.layout === 'v' || d.layout === 'flat') && d.exhaust.exit !== 'side' && !(d.induction.type === 'turbo' && d.induction.count === 1)) {
      H.seg(
        'Bank crossover',
        [
          ['dual', 'True dual'],
          ['h', 'H-pipe'],
          ['x', 'X-pipe'],
          ['y', 'Merged'],
        ],
        d.exhaust.merge,
        (v) => this.set({ exhaust: { merge: v } })
      );
    }
    H.toggle('Catalytic converters', d.exhaust.cat, (v) => this.set({ exhaust: { cat: v } }), null, ['None', 'Fitted']);
    H.toggle('Resonators', d.exhaust.resonator, (v) => this.set({ exhaust: { resonator: v } }), null, ['None', 'Fitted']);
    H.seg(
      'Silencer',
      [
        ['none', 'Straight'],
        ['sport', 'Sport'],
        ['glasspack', 'Glasspack'],
        ['chambered', 'Chambered'],
        ['valved', 'Valved'],
        ['stock', 'Road'],
      ],
      d.exhaust.muffler,
      (v) => this.set({ exhaust: { muffler: v } })
    );
    H.seg(
      'Exit',
      [
        ['rear', 'Rear'],
        ['side', 'Side pipes'],
      ],
      d.exhaust.exit,
      (v) => this.set({ exhaust: { exit: v } })
    );
    H.seg(
      'Tips',
      [1, 2, 3, 4].map((n) => [n, String(n)]),
      d.exhaust.tips,
      (v) => this.set({ exhaust: { tips: v } })
    );
  }

  formEcu(H, d) {
    H.title('ECU & car', 'Engine management and what the engine is bolted into.');
    const dv = derived(d);
    H.range(
      'Rev limit',
      3000,
      20000,
      100,
      d.ecu.limit,
      (v) => `${fmt(v)} rpm`,
      (v) => this.set({ ecu: { limit: v } }, false),
      d.layout === 'rotary' ? null : `Mean piston speed at this limit: ${dv.pistonSpeed.toFixed(1)} m/s.`,
      () => this.renderForm()
    );
    H.range(
      'Idle speed',
      0,
      2000,
      50,
      d.ecu.idle,
      (v) => (v === 0 ? 'auto' : `${fmt(v)} rpm`),
      (v) => this.set({ ecu: { idle: v < 450 ? 0 : v } }, false),
      'Auto picks a speed from the cam overlap and the number of cylinders.'
    );
    H.seg(
      'Limiter',
      [
        ['fuel', 'Fuel cut'],
        ['spark', 'Spark cut'],
      ],
      d.ecu.limiter,
      (v) => this.set({ ecu: { limiter: v } })
    );
    H.range('Overrun pops', 0, 1, 0.05, d.ecu.burble, (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`), (v) => this.set({ ecu: { burble: v } }, false));
    H.seg('Fuel', FUELS, d.ecu.octane, (v) => this.set({ ecu: { octane: v } }));
    H.seg(
      'Flywheel',
      [
        ['light', 'Light'],
        ['stock', 'Stock'],
        ['heavy', 'Heavy'],
      ],
      d.flywheel,
      (v) => this.set({ flywheel: v })
    );
    H.seg(
      'Car',
      Object.entries(CARS).map(([k, c]) => [k, c.label]),
      d.car,
      (v) => this.set({ car: v }),
      'Gearing is scaled to the rev limit so each gear covers a sensible speed range.'
    );
  }

  // --------------------------------------------------------- spec sheet
  renderSheet() {
    const d = this.d;
    if (!d) return;
    const spec = designToSpec(d);
    const dv = derived(d);
    this.$('bTitle2').textContent = d.name || 'My engine';
    this.$('bTag').textContent = spec.tagline;
    const figs = [];
    figs.push(['Displacement', `${dv.L.toFixed(2)} L`, `${fmt(dv.cc)} cc · ${dv.ci} ci`]);
    if (d.layout !== 'rotary') {
      const sq = dv.boreStroke;
      figs.push(['Bore × stroke', `${d.bore.toFixed(1)} × ${d.stroke.toFixed(1)}`, sq > 1.05 ? `oversquare ${sq.toFixed(2)}` : sq < 0.95 ? `undersquare ${sq.toFixed(2)}` : 'square']);
      figs.push(['Piston speed', `${dv.pistonSpeed.toFixed(1)} m/s`, 'mean, at the limit', dv.pistonSpeed > 26 ? 'bad' : dv.pistonSpeed > 22 ? 'warn' : '']);
    }
    figs.push(['Firing note', `${fmt(dv.fireHz)} Hz`, 'at the rev limit']);
    if (d.layout !== 'rotary') figs.push(['Valve float', isFinite(dv.floatRpm) ? `${fmt(dv.floatRpm)} rpm` : 'never', 'stock springs', dv.floatRpm < d.ecu.limit ? 'bad' : '']);
    if (dv.headerRpm) figs.push(['Headers tuned', `${fmt(dv.headerRpm)} rpm`, `${d.exhaust.len.toFixed(2)} m primaries`]);
    this.$('bFigs').innerHTML = figs
      .map(([k, v, s, lvl]) => `<div class="fig ${lvl ?? ''}"><dt>${k}</dt><dd>${v}</dd><small>${s}</small></div>`)
      .join('');
    this.drawFiring();
    this.renderDynoStatus();
    this.drawDyno();
    // notes
    const notes = [];
    notes.push(['', spec.blurb]);
    const r = this.result;
    if (r && !r.error) {
      if (r.knockN > 2) notes.push(['warn', `Knocks at full load on ${d.ecu.octane >= 108 ? 'E85' : d.ecu.octane + ' RON'}: the ECU pulled up to ${r.knockRet.toFixed(0)}° of timing. Lower the compression or the boost, or use better fuel.`]);
      if (r.floatMax > 0.05) notes.push(['bad', 'The valves float before the rev limit: power falls away and the sound goes ragged. Lower the limit, or use a lighter valvetrain.']);
    }
    if (r?.error) notes.push(['bad', r.error]);
    if (d.layout !== 'rotary' && dv.pistonSpeed > 26) notes.push(['bad', 'Piston speed past 26 m/s: Formula 1 territory. Shorten the stroke or lower the limit.']);
    if (this.workerFailed) notes.push(['warn', 'The virtual dyno is not available in this browser, so power figures are missing. The engine still runs and sounds the same.']);
    this.$('bNotes').innerHTML = notes.map(([lvl, t]) => `<li class="${lvl}">${t}</li>`).join('');
    const saved = d.id && d.id !== 'my-draft' && !this.dirty;
    this.$('bSave').textContent = saved ? 'Saved' : d.id && d.id !== 'my-draft' ? 'Save changes' : 'Save build';
    this.$('bSave').title = 'Keep this build in My garage (stored in this browser)';
  }

  renderDynoStatus() {
    const r = this.result;
    const el = this.$('bDynoHead');
    if (this.busy) el.innerHTML = `<b>Measuring on the virtual dyno…</b> ${Math.round(this.progress * 100)}%`;
    else if (r && !r.error) el.innerHTML = `<b>${fmt(r.peakHp)} hp</b> at ${fmt(r.peakHpRpm)} rpm · <b>${fmt(r.peakTq)} Nm</b> at ${fmt(r.peakTqRpm)} rpm${r.boostMax > 2e4 ? ` · ${(r.boostMax / 1e5).toFixed(2)} bar` : ''}`;
    else el.textContent = this.workerFailed ? 'Virtual dyno unavailable' : 'Virtual dyno';
  }

  drawFiring() {
    const c = this.$('bFire');
    const g = c.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    c.width = Math.max(10, Math.round(r.width * dpr));
    c.height = Math.max(10, Math.round(r.height * dpr));
    const W = c.width, Hh = c.height;
    g.clearRect(0, 0, W, Hh);
    const d = this.d;
    const fire = firingOptions(d, 64).find((o) => o.order.join() === d.order.join()) ?? firingOptions(d, 1)[0];
    const banks = bankGroups(d);
    const cyc = d.layout === 'rotary' ? 1080 : 720;
    const rows = banks.length > 1 && d.layout !== 'rotary' ? [['All', null], ...banks.map((b, i) => [`Bank ${'AB'[i]}`, b])] : [['All', null]];
    const l = 52 * dpr, rr = W - 10 * dpr, top = 8 * dpr;
    const rowH = (Hh - top - 18 * dpr) / rows.length;
    const X = (a) => l + (a / cyc) * (rr - l);
    g.font = `500 ${Math.round(9 * dpr)}px "B612 Mono", ui-monospace, monospace`;
    // grid
    g.strokeStyle = 'rgba(235,227,208,0.08)';
    g.lineWidth = 1;
    for (let a = 0; a <= cyc; a += 90) {
      g.beginPath();
      g.moveTo(X(a), top);
      g.lineTo(X(a), Hh - 16 * dpr);
      g.stroke();
    }
    g.fillStyle = 'rgba(235,227,208,0.45)';
    g.textAlign = 'center';
    for (let a = 0; a <= cyc; a += cyc === 720 ? 180 : 270) g.fillText(`${a}°`, X(a), Hh - 4 * dpr);
    const bankOf = new Map();
    banks.forEach((b, i) => b.forEach((cy) => bankOf.set(cy, i)));
    rows.forEach(([label, members], ri) => {
      const y0 = top + ri * rowH;
      const ym = y0 + rowH * 0.62;
      g.fillStyle = 'rgba(235,227,208,0.55)';
      g.textAlign = 'left';
      g.fillText(label, 4 * dpr, ym + 3 * dpr);
      g.strokeStyle = 'rgba(235,227,208,0.2)';
      g.beginPath();
      g.moveTo(l, ym);
      g.lineTo(rr, ym);
      g.stroke();
      fire.angles.forEach((a, i) => {
        const cy = i + 1;
        if (members && !members.includes(cy)) return;
        const col = BANK_COL[(bankOf.get(cy) ?? 0) % BANK_COL.length];
        const x = X(a);
        g.fillStyle = col;
        g.fillRect(x - 1.5 * dpr, ym - rowH * 0.42, 3 * dpr, rowH * 0.42);
        g.textAlign = 'center';
        g.fillStyle = 'rgba(235,227,208,0.85)';
        if (rowH > 20 * dpr || !members) g.fillText(String(cy), x, ym - rowH * 0.46);
      });
    });
  }

  drawDyno() {
    const c = this.$('bDyno');
    const g = c.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    c.width = Math.max(10, Math.round(r.width * dpr));
    c.height = Math.max(10, Math.round(r.height * dpr));
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const res = this.result;
    const pts = res && !res.error ? res.curve : null;
    const l = 34 * dpr, rr = W - 34 * dpr, t = 8 * dpr, b = H - 18 * dpr;
    g.strokeStyle = 'rgba(235,227,208,0.12)';
    g.strokeRect(l, t, rr - l, b - t);
    if (!pts || pts.length < 3) {
      g.fillStyle = 'rgba(235,227,208,0.4)';
      g.font = `500 ${Math.round(10 * dpr)}px "B612 Mono", monospace`;
      g.textAlign = 'center';
      g.fillText(this.busy ? 'running a full-throttle pull…' : '—', (l + rr) / 2, (t + b) / 2);
      if (this.busy) {
        g.fillStyle = '#ff5f1f';
        g.fillRect(l, b - 3 * dpr, (rr - l) * this.progress, 3 * dpr);
      }
      return;
    }
    const maxR = Math.max(...pts.map((p) => p.rpm));
    const maxT = Math.max(...pts.map((p) => p.tq)) * 1.12;
    const maxP = Math.max(...pts.map((p) => p.hp)) * 1.12;
    const X = (rpm) => l + (rpm / maxR) * (rr - l);
    const line = (key, max, col) => {
      g.strokeStyle = col;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      pts.forEach((p, i) => {
        const y = b - (p[key] / max) * (b - t);
        if (i === 0) g.moveTo(X(p.rpm), y);
        else g.lineTo(X(p.rpm), y);
      });
      g.stroke();
    };
    line('tq', maxT, '#ff5f1f');
    line('hp', maxP, '#ebe3d0');
    g.font = `500 ${Math.round(9 * dpr)}px "B612 Mono", monospace`;
    g.fillStyle = '#ff5f1f';
    g.textAlign = 'right';
    g.fillText('Nm', l - 4 * dpr, t + 8 * dpr);
    g.fillText(String(Math.round(maxT / 1.12)), l - 4 * dpr, t + 20 * dpr);
    g.fillStyle = '#ebe3d0';
    g.textAlign = 'left';
    g.fillText('hp', rr + 4 * dpr, t + 8 * dpr);
    g.fillText(String(Math.round(maxP / 1.12)), rr + 4 * dpr, t + 20 * dpr);
    g.fillStyle = 'rgba(235,227,208,0.5)';
    g.textAlign = 'center';
    const step = maxR > 12000 ? 4000 : 2000;
    for (let rpm = step; rpm < maxR; rpm += step) g.fillText(`${rpm / 1000}k`, X(rpm), H - 5 * dpr);
  }
}

function evenAngle(d) {
  const m = d.cylinders / 2;
  return { 1: '—', 2: '180 (or 90 with a 90° crank)', 3: '120 (or 60 with split pins)', 4: d.crank === 'cross' ? '90' : '180', 5: '72', 6: '60', 8: '45' }[m] ?? '—';
}

function bankGroups(d) {
  const n = d.cylinders;
  if (d.layout === 'inline') return [Array.from({ length: n }, (_, i) => i + 1)];
  if (d.layout === 'rotary') return Array.from({ length: n }, (_, r) => [r * 3 + 1, r * 3 + 2, r * 3 + 3]);
  const m = n / 2;
  return [Array.from({ length: m }, (_, i) => i + 1), Array.from({ length: m }, (_, i) => m + i + 1)];
}

function camHint(d) {
  const c = CAMS.find((x) => x[0] === d.cam);
  const icl = c[3] - 4;
  const ovl = Math.round(2 * (c[2] / 2 - icl) + 4);
  return `${c[2]}° duration, ${c[3]}° lobe separation, about ${Math.max(0, ovl)}° of overlap. More overlap: more top-end power, a choppier idle.`;
}

// Tiny firing strip for the option buttons.
function miniStrip(o, d, banks) {
  const c = document.createElement('canvas');
  c.className = 'fo-strip';
  c.width = 220;
  c.height = 14;
  const g = c.getContext('2d');
  const cyc = d.layout === 'rotary' ? 1080 : 720;
  const bankOf = new Map();
  banks.forEach((b, i) => b.forEach((cy) => bankOf.set(cy, i)));
  g.fillStyle = 'rgba(235,227,208,0.15)';
  g.fillRect(0, 12, 220, 1);
  o.angles.forEach((a, i) => {
    g.fillStyle = BANK_COL[(bankOf.get(i + 1) ?? 0) % BANK_COL.length];
    g.fillRect(2 + (a / cyc) * 214, 2, 2, 11);
  });
  return c;
}
