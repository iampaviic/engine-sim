import { PRESETS, presetById } from './engine/presets.js';
import { compileEngine, workletConfig } from './engine/compile.js';
import { AudioEngine, ENVIRONMENTS } from './audio/audio.js';
import { Tach } from './ui/tach.js';
import { Schematic } from './ui/schematic.js';
import { Scope } from './ui/scope.js';
import { Controls } from './ui/controls.js';
import { Garage } from './ui/garage.js';
import { Workshop, CAMERAS, clone, applyHeaderEqualize } from './ui/workshop.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('firing-order.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('firing-order.' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

const app = {
  presetId: store.get('engine', 'v12-65'),
  factory: null,
  spec: null,
  compiled: null,
  tune: {},
  camLevel: 0,
  flyLevel: 1,
  camera: store.get('camera', 'rear'),
  env: store.get('env', 'open'),
  volume: store.get('volume', 0.8),
  mode: 'rev',
  environments: ENVIRONMENTS,
  audio: new AudioEngine(),
  started: false,
  starting: false,
  tel: null,
  lastGear: 0,
  dynoPts: [],
  dynoActive: false,
  lastRun: null,
  timer: { state: 'idle', t0: 0, result: null },
};

// ---------------------------------------------------------------- UI objects
const tach = new Tach($('tach'));
const schem = new Schematic($('schem'));
const scope = new Scope($('scope'));
const toastEl = $('toast');
let toastT = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastT = 1.6;
}

const controls = new Controls({
  gas: $('gas'),
  brake: $('brake'),
  gasVal: $('gasVal'),
  onAction: (a, v) => action(a, v),
});

const garage = new Garage({
  root: $('garage'),
  cards: $('garageCards'),
  filters: $('garageFilters'),
  close: $('garageClose'),
  presets: PRESETS,
  onPick: (id) => loadEngine(id, { autostart: true }),
});

const workshop = new Workshop({ root: $('workshop'), body: $('wsBody'), close: $('wsClose'), reset: $('wsReset'), app });

// ------------------------------------------------------------ engine / tune
function defaultTune(f) {
  return {
    limit: f.ecu.limit,
    limiter: f.ecu.limiter ?? 'fuel',
    burble: f.ecu.burble ?? 0,
    boost: f.induction?.boost ?? 1,
    bov: f.induction?.bov ?? 'atm',
    antilag: !!f.ecu.antilag,
    launchRpm: f.ecu.launchRpm ?? 4000,
    tc: true,
    autoShift: true,
    valve: 'auto',
  };
}

function compile(spec) {
  return compileEngine(applyHeaderEqualize(spec));
}

function describeMods() {
  const f = app.factory, s = app.spec;
  const d = [];
  if ((s.exhaust.muffler ?? '') !== (f.exhaust.muffler ?? '')) d.push(s.exhaust.muffler === 'none' ? 'straight pipes' : `${s.exhaust.muffler} silencer`);
  if ((s.exhaust.merge ?? 'dual') !== (f.exhaust.merge ?? 'dual')) d.push(`${s.exhaust.merge}-merge`);
  if (!!s.exhaust.cat !== !!f.exhaust.cat) d.push(s.exhaust.cat ? 'cats' : 'decat');
  if (app.camLevel) d.push(app.camLevel === 1 ? 'fast-road cams' : 'race cams');
  if ((s.induction?.type ?? 'na') !== (f.induction?.type ?? 'na')) d.push(s.induction.type);
  if (s.exhaust.headers?.len !== f.exhaust.headers?.len) d.push(`${s.exhaust.headers.len.toFixed(2)} m primaries`);
  return d.length ? d.join(', ') : 'factory';
}

function updateEngineUI() {
  const f = app.factory;
  $('epName').textContent = f.name;
  $('epTag').textContent = f.tagline;
  $('engineNote').innerHTML = `<b>Listen</b> ${f.listen}`;
  tach.configure({ limit: app.tune.limit, idle: f.ecu.idle, label: f.family === 'Rotary' ? 'ROTARY' : `${f.family} · ${app.compiled.dispLitres.toFixed(1)} L`, camSwitch: f.camSwitchRpm });
  schem.setEngine(app.compiled, app.spec);
  scope.setEngine(app.compiled, app.spec);
  const hasBoost = (app.spec.induction?.type ?? 'na') !== 'na';
  $('roMapLbl').textContent = hasBoost ? 'Boost' : 'Manifold';
  document.title = `${f.name} · Firing Order`;
  $('intro').querySelector('.fo').textContent = f.kind === 'rotary' ? 'rotor · rotor · every 180°' : f.firingOrder.join(' · ');
}

function loadEngine(id, { autostart = false } = {}) {
  const wasRunning = app.tel?.running;
  app.presetId = id;
  app.factory = presetById(id);
  app.spec = clone(app.factory);
  app.tune = defaultTune(app.factory);
  app.camLevel = 0;
  app.flyLevel = 1;
  app.compiled = compile(app.spec);
  app.dynoPts = [];
  scope.dyno = [];
  scope.dynoPrev = null;
  store.set('engine', id);
  updateEngineUI();
  if (app.started) {
    app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune });
    app.audio.post({ type: 'camera', camera: app.mode === 'flyby' ? 'flyby' : app.camera });
    if (autostart || wasRunning) setTimeout(() => app.audio.post({ type: 'ignition', on: true, crank: true, cold: true }), 350);
  }
  if (workshop.open) workshop.render();
}

app.rebuild = (mutate) => {
  const s = clone(app.spec);
  mutate(s);
  // keep unequal-length ratios when the base length changes
  const h = s.exhaust.headers;
  const old = app.spec.exhaust.headers;
  if (h?.lens && old?.len && h.len !== old.len) h.lens = h.lens.map((x) => (x * h.len) / old.len);
  app.spec = s;
  app.compiled = compile(s);
  updateEngineUI();
  if (app.started) app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune, hot: true });
  toast('Rebuilt: ' + describeMods());
};

app.resetEngine = () => {
  app.spec = clone(app.factory);
  app.tune = defaultTune(app.factory);
  app.camLevel = 0;
  app.flyLevel = 1;
  app.compiled = compile(app.spec);
  updateEngineUI();
  if (app.started) app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune, hot: true });
  workshop.render();
  toast('Factory spec');
};

app.setTune = (t) => {
  Object.assign(app.tune, t);
  if (app.started) app.audio.post({ type: 'tune', tune: t });
  if (t.limit != null) tach.configure({ limit: t.limit, idle: app.factory.ecu.idle, label: tach.label, camSwitch: app.factory.camSwitchRpm });
  if (t.tc != null) $('tcBtn').setAttribute('aria-pressed', String(t.tc));
};

app.setCamera = (c) => {
  app.camera = c;
  store.set('camera', c);
  $('camSel').value = c;
  if (app.started && app.mode !== 'flyby') app.audio.post({ type: 'camera', camera: c });
};
app.setEnv = (e) => {
  app.env = e;
  store.set('env', e);
  $('envSel').value = e;
  app.audio.setEnvironment(e);
};
app.setVolume = (v) => {
  app.volume = v;
  store.set('volume', v);
  $('vol').value = v;
  app.audio.setVolume(v);
};

// ------------------------------------------------------------------ modes
function setMode(m) {
  if (!app.started) return;
  if (app.dynoActive) stopDyno();
  app.mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  if (m === 'flyby') {
    app.audio.post({ type: 'camera', camera: 'flyby' });
    app.audio.post({ type: 'flyby', style: 'wot' });
    $('flybyStrip').hidden = false;
    toast('Roadside mic, 7.5 m from the kerb');
  } else {
    app.audio.post({ type: 'mode', mode: m });
    app.audio.post({ type: 'camera', camera: app.camera });
    $('flybyStrip').hidden = true;
    if (m === 'drive') toast('First gear. Floor it');
  }
  app.timer = { state: 'idle', t0: 0, result: app.timer.result };
}

function runDyno() {
  if (!app.started) {
    start().then(() => setTimeout(runDyno, 1500));
    return;
  }
  if (app.dynoPts.length > 4) {
    scope.dynoPrev = app.dynoPts;
    scope.dynoPrevLabel = app.lastRun ?? 'previous run';
  }
  app.dynoPts = [];
  scope.dyno = app.dynoPts;
  app.dynoActive = true;
  app.lastRun = `${app.factory.name}, ${describeMods()}`;
  app.mode = 'dyno';
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  if (!app.tel?.running) app.audio.post({ type: 'ignition', on: true, crank: true });
  app.audio.post({ type: 'dyno', action: 'start' });
  $('dynoRun').textContent = 'Stop';
  selectTab('dyno');
}
function stopDyno() {
  app.dynoActive = false;
  app.audio.post({ type: 'dyno', action: 'stop' });
  $('dynoRun').textContent = 'Run dyno';
}

// ---------------------------------------------------------------- actions
const CAM_IDS = CAMERAS.map((c) => c[0]);
const ENV_IDS = Object.keys(ENVIRONMENTS);
function action(a, v) {
  switch (a) {
    case 'shift':
      if (app.started) app.audio.post({ type: 'shift', dir: v });
      break;
    case 'startstop':
      startStop();
      break;
    case 'launch':
      if (app.started) app.audio.post({ type: 'input', launch: v });
      $('launchBtn').classList.toggle('held', !!v);
      if (v && app.mode !== 'drive' && app.started) setMode('drive');
      break;
    case 'garage':
      garage.open ? garage.hide() : garage.show(app.presetId);
      break;
    case 'workshop':
      workshop.open ? workshop.hide() : workshop.show();
      break;
    case 'camera': {
      const i = (CAM_IDS.indexOf(app.camera) + 1) % CAM_IDS.length;
      app.setCamera(CAM_IDS[i]);
      toast(CAMERAS[i][1]);
      if (workshop.open) workshop.render();
      break;
    }
    case 'env': {
      const i = (ENV_IDS.indexOf(app.env) + 1) % ENV_IDS.length;
      app.setEnv(ENV_IDS[i]);
      toast(ENVIRONMENTS[ENV_IDS[i]].label);
      if (workshop.open) workshop.render();
      break;
    }
    case 'mode':
      setMode(v);
      break;
    case 'dyno':
      app.dynoActive ? stopDyno() : runDyno();
      break;
    case 'escape':
      garage.hide();
      workshop.hide();
      break;
  }
}

async function start() {
  if (app.started || app.starting) return;
  app.starting = true;
  try {
    await app.audio.init();
  } catch (err) {
    console.error(err);
    app.starting = false;
    $('intro').querySelector('small').textContent = 'Audio could not start in this browser. Try Chrome, Edge, Firefox or Safari 15+.';
    return;
  }
  app.audio.onMessage = onMessage;
  app.audio.setVolume(app.volume);
  app.audio.setEnvironment(app.env);
  app.started = true;
  app.starting = false;
  app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune });
  app.audio.post({ type: 'camera', camera: app.camera });
  app.audio.post({ type: 'ignition', on: true, crank: true, cold: true });
  $('intro').hidden = true;
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    /* optional */
  }
}

function startStop() {
  if (!app.started) {
    start();
    return;
  }
  const t = app.tel;
  if (t && (t.running || t.starter)) app.audio.post({ type: 'ignition', on: false });
  else app.audio.post({ type: 'ignition', on: true, crank: true });
}

// --------------------------------------------------------------- messages
function onMessage(m) {
  switch (m.type) {
    case 'tel':
      onTelemetry(m);
      break;
    case 'snap':
      schem.onSnap(m.data, performance.now() / 1000);
      break;
    case 'scope':
      scope.onScope(m);
      break;
    case 'dyno-done':
      app.dynoActive = false;
      $('dynoRun').textContent = 'Run dyno';
      app.mode = 'rev';
      document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'rev')));
      app.audio.post({ type: 'mode', mode: 'rev' });
      break;
    case 'flyby-done':
      setTimeout(() => {
        if (app.mode === 'flyby') setMode('rev');
      }, 2500);
      break;
  }
}

function onTelemetry(t) {
  app.tel = t;
  tach.target = t.rpm;
  tach.lim = t.lim;
  tach.camHi = t.camHi;
  const inGear = t.mode === 'drive' || t.mode === 'flyby';
  tach.gear = inGear ? (t.gear ? String(t.gear) : 'N') : t.mode === 'dyno' ? 'D' : 'N';
  tach.speedText = inGear ? `${Math.round(t.speed * 3.6)} km/h` : t.mode === 'dyno' ? 'DYNO' : t.running ? 'NEUTRAL' : t.starter ? 'CRANKING' : 'OFF';
  if (inGear && t.gear !== app.lastGear && app.lastGear) navigator.vibrate?.(12);
  app.lastGear = t.gear;
  if (t.af > 0 && t.afI > 0.12) {
    schem.flame(Math.min(1.2, t.afI * 1.5));
    if (t.afI > 0.35) navigator.vibrate?.(8);
  }
  $('startBtn').classList.toggle('on', !!t.running);
  if (t.dyno && app.dynoActive) {
    const last = app.dynoPts[app.dynoPts.length - 1];
    if (!last || t.dyno.rpm > last.rpm + 25) app.dynoPts.push({ rpm: t.dyno.rpm, tq: t.dyno.tq });
  }
  // 0-100 km/h timer
  const tm = app.timer;
  const now = performance.now() / 1000;
  if (inGear) {
    if (t.speed < 0.3) {
      tm.state = 'armed';
    } else if (tm.state === 'armed') {
      tm.state = 'running';
      tm.t0 = now;
    } else if (tm.state === 'running' && t.speed >= 100 / 3.6) {
      tm.state = 'done';
      tm.result = now - tm.t0;
      toast(`0–100 km/h in ${tm.result.toFixed(2)} s`);
    }
  }
}

let roT = 0;
function updateReadouts(dt) {
  roT -= dt;
  if (roT > 0) return;
  roT = 0.1;
  const t = app.tel;
  if (!t) return;
  const set = (id, v, unit) => {
    $(id).innerHTML = `${v}<small> ${unit}</small>`;
  };
  set('roTq', t.running ? Math.round(t.mode === 'rev' ? Math.max(0, t.tq) : t.tq) : '—', 'Nm');
  set('roHp', t.running && t.tq > 0 ? Math.round((t.tq * t.rpm) / 7121) : '—', 'hp');
  const hasBoost = (app.spec.induction?.type ?? 'na') !== 'na';
  if (hasBoost) {
    const b = t.boost / 1e5;
    set('roMap', (b >= 0 ? '+' : '') + b.toFixed(2), 'bar');
  } else set('roMap', (t.map / 1e5).toFixed(2), 'bar');
  set('roEgt', Math.round(t.egt - 273), '°C');
  set('roSpl', t.spl > 1e-4 ? Math.round(20 * Math.log10(t.spl / 2e-5)) : '—', 'dB');
  const tm = app.timer;
  if (tm.state === 'running') set('roTime', (performance.now() / 1000 - tm.t0).toFixed(1), 's');
  else set('roTime', tm.result ? tm.result.toFixed(2) : '—', 's');
}

// --------------------------------------------------------------- flyby map
function drawFlyby() {
  const c = $('flybyStrip');
  if (c.hidden) return;
  const r = c.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const x0 = -260, x1 = 280;
  const X = (x) => ((x - x0) / (x1 - x0)) * W;
  g.fillStyle = 'rgba(15,14,12,0.85)';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(235,227,208,0.25)';
  g.setLineDash([8 * dpr, 8 * dpr]);
  g.beginPath();
  g.moveTo(0, H * 0.4);
  g.lineTo(W, H * 0.4);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#58aee0';
  g.beginPath();
  g.arc(X(0), H * 0.82, 4 * dpr, 0, Math.PI * 2);
  g.fill();
  const t = app.tel;
  if (t?.flyX != null) {
    const x = X(t.flyX);
    g.fillStyle = '#ff5f1f';
    g.fillRect(x - 9 * dpr, H * 0.4 - 4 * dpr, 18 * dpr, 8 * dpr);
    g.font = `500 ${Math.round(10 * dpr)}px "B612 Mono", monospace`;
    g.fillStyle = 'rgba(235,227,208,0.8)';
    g.textAlign = 'left';
    const d = Math.hypot(t.flyX, 7.5);
    g.fillText(`${Math.round(d)} m · ${Math.round(t.speed * 3.6)} km/h`, 8 * dpr, H * 0.3);
  }
}

// ------------------------------------------------------------------- loop
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  controls.update(dt);
  if (app.started) {
    const p = +controls.pedal.toFixed(3), b = +controls.brake.toFixed(3);
    if (p !== app.sentPedal || b !== app.sentBrake) {
      app.audio.post({ type: 'input', pedal: p, brake: b });
      app.sentPedal = p;
      app.sentBrake = b;
    }
  }
  tach.update(dt);
  tach.draw();
  schem.draw(now / 1000, app.tel);
  scope.draw(app.audio.analyser, app.tel);
  updateReadouts(dt);
  drawFlyby();
  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0) toastEl.classList.remove('show');
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ wiring
function selectTab(mode) {
  scope.mode = mode;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('dynoRun').hidden = mode !== 'dyno';
  store.set('tab', mode);
}

function wire() {
  const camSel = $('camSel');
  for (const [k, label] of CAMERAS) camSel.add(new Option(label, k));
  camSel.value = app.camera;
  camSel.addEventListener('change', () => app.setCamera(camSel.value));
  const envSel = $('envSel');
  for (const [k, e] of Object.entries(ENVIRONMENTS)) envSel.add(new Option(e.label, k));
  envSel.value = app.env;
  envSel.addEventListener('change', () => app.setEnv(envSel.value));
  $('vol').value = app.volume;
  $('vol').addEventListener('input', (e) => app.setVolume(+e.target.value));
  $('pickEngine').addEventListener('click', () => garage.show(app.presetId));
  $('workshopBtn').addEventListener('click', () => (workshop.open ? workshop.hide() : workshop.show()));
  $('menuBtn').addEventListener('click', () => (workshop.open ? workshop.hide() : workshop.show()));
  $('keyBtn').addEventListener('click', start);
  $('startBtn').addEventListener('click', startStop);
  $('shiftUp').addEventListener('click', () => action('shift', 1));
  $('shiftDown').addEventListener('click', () => action('shift', -1));
  $('blipBtn').addEventListener('click', () => controls.blip());
  const lb = $('launchBtn');
  lb.addEventListener('pointerdown', (e) => {
    lb.setPointerCapture(e.pointerId);
    controls.setLaunch(true);
  });
  const lu = () => controls.setLaunch(false);
  lb.addEventListener('pointerup', lu);
  lb.addEventListener('pointercancel', lu);
  $('tcBtn').addEventListener('click', () => {
    app.setTune({ tc: !app.tune.tc });
    toast(app.tune.tc ? 'Traction control on' : 'Traction control off: burnouts allowed');
  });
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.mode)));
  $('dynoRun').addEventListener('click', () => action('dyno'));
  $('strobeBtn').addEventListener('click', () => {
    const on = $('strobeBtn').getAttribute('aria-pressed') !== 'true';
    $('strobeBtn').setAttribute('aria-pressed', String(on));
    $('strobeBtn').textContent = on ? 'Slow-mo' : 'Real time';
    $('schemLbl').innerHTML = on ? 'Exhaust pressure · <b>strobe</b>' : 'Exhaust pressure · <b>live</b>';
    app.audio.post({ type: 'strobe', on, step: 3 });
  });
  document.querySelector('.stage').addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.instr-panel')) return;
      e.preventDefault();
      controls.wheel(e.deltaY);
    },
    { passive: false }
  );
  document.addEventListener('visibilitychange', () => {
    if (!app.started) return;
    if (document.hidden) app.audio.suspend();
    else app.audio.resume();
  });
  selectTab(store.get('tab', 'wave'));
  document.fonts?.ready.then(() => {
    tach.face = null;
  });
}

wire();
loadEngine(app.presetId);
requestAnimationFrame(frame);
