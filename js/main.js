import { PRESETS, presetById } from './engine/presets.js';
import { compileEngine, workletConfig } from './engine/compile.js';
import { AudioEngine, ENVIRONMENTS } from './audio/audio.js';
import { Tach } from './ui/tach.js';
import { Schematic } from './ui/schematic.js';
import { Scope } from './ui/scope.js';
import { Controls } from './ui/controls.js';
import { Garage } from './ui/garage.js';
import { Workshop, CAMERAS, clone, applyHeaderEqualize } from './ui/workshop.js';
import { Builder } from './ui/builder.js';
import { SCENES, drawSceneHud, timeSlip } from './ui/scenes.js';
import { Settings } from './ui/settings.js';
import { units, speedText, sprint, defaultSpeedUnit } from './ui/units.js';
import { buildSpecs, loadBuilds, saveBuilds } from './engine/builder.js';
import { isNative, platform, AppPlugin, StatusBar, EngineAudio, call } from './platform/native.js';
import { ready as storageReady, getItem, setItem } from './platform/storage.js';

// app storage on phones is read asynchronously, once, before anything uses it
await storageReady;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = getItem('firing-order.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    setItem('firing-order.' + k, JSON.stringify(v));
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
  warned: {},
  units,
  mixAudio: store.get('mixAudio', false),
  keepAwake: store.get('keepAwake', true),
  awake: false,
  // iOS (Safari and the app) can share the speaker with other apps; Android
  // apps share it through audio focus.
  canMixAudio: isNative || 'audioSession' in navigator,
  canKeepAwake: isNative || 'wakeLock' in navigator,
};
units.speed = store.get('units', defaultSpeedUnit());

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

// Factory engines plus the builds saved in this browser.
function allEngines() {
  return [...PRESETS, ...buildSpecs()];
}
function engineById(id) {
  if (id?.startsWith('my-')) return buildSpecs().find((s) => s.id === id) ?? presetById('v12-65');
  return presetById(id);
}

const garage = new Garage({
  root: $('garage'),
  cards: $('garageCards'),
  filters: $('garageFilters'),
  close: $('garageClose'),
  getEngines: allEngines,
  onPick: (id) => loadEngine(id, { autostart: true }),
  onBuild: () => app.openBuilder({ from: 'new' }),
  onEdit: (id) => {
    const s = engineById(id);
    if (s.custom) {
      loadEngine(id, { autostart: true });
      app.openBuilder({ design: s.design });
    }
  },
  onDelete: (id) => {
    saveBuilds(loadBuilds().filter((d) => d.id !== id));
    toast('Build deleted');
    if (app.presetId === id) loadEngine('v12-65', { autostart: true });
  },
});

const workshop = new Workshop({ root: $('workshop'), body: $('wsBody'), close: $('wsClose'), reset: $('wsReset'), app });
const settings = new Settings({ root: $('settings'), body: $('setBody'), close: $('setClose'), app });
const builder = new Builder({ root: $('builder'), app, presets: PRESETS });

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
    spark: 0,
    octane: f.ecu.octane ?? 98,
    knockCtl: true,
    springs: 'stock',
  };
}

function compile(spec) {
  return compileEngine(applyHeaderEqualize(spec));
}

function describeMods(s = app.spec, f = app.factory) {
  const d = [];
  if ((s.exhaust.muffler ?? '') !== (f.exhaust.muffler ?? '')) d.push(s.exhaust.muffler === 'none' ? 'straight pipes' : `${s.exhaust.muffler} silencer`);
  if ((s.exhaust.merge ?? 'dual') !== (f.exhaust.merge ?? 'dual')) d.push(`${s.exhaust.merge}-merge`);
  if ((s.exhaust.headers?.style ?? 'n-1') !== (f.exhaust.headers?.style ?? 'n-1')) d.push(s.exhaust.headers.style === '180' ? '180° headers' : `${s.exhaust.headers.style} headers`);
  if (!!s.exhaust.cat !== !!f.exhaust.cat) d.push(s.exhaust.cat ? 'cats' : 'decat');
  if (!!s.exhaust.resonator !== !!f.exhaust.resonator) d.push(s.exhaust.resonator ? 'resonators' : 'resonator delete');
  if ((s.exhaust.exit ?? 'rear') !== (f.exhaust.exit ?? 'rear')) d.push(s.exhaust.exit === 'side' ? 'side pipes' : 'rear exit');
  if ((s.intake?.airbox ?? 'stock') !== (f.intake?.airbox ?? 'stock')) d.push(s.intake.airbox === 'open' ? 'open filter' : s.intake.airbox === 'ram' ? 'ram air' : 'airbox');
  if (!!s.intake?.itb !== !!f.intake?.itb) d.push(s.intake.itb ? 'ITBs' : 'single throttle');
  if (s === app.spec && app.camLevel) d.push(app.camLevel === 1 ? 'fast-road cams' : 'race cams');
  if ((s.induction?.type ?? 'na') !== (f.induction?.type ?? 'na') || (s.induction?.count ?? 1) !== (f.induction?.count ?? 1)) d.push(s.induction.type === 'na' ? 'atmospheric' : s.induction.type === 'turbo' && s.induction.count > 1 ? 'twin-turbo' : s.induction.type);
  if (!!s.induction?.screamer !== !!f.induction?.screamer) d.push(s.induction.screamer ? 'screamer pipe' : 'wastegate plumbed back');
  if ((s.induction?.ratio ?? 0) !== (f.induction?.ratio ?? 0) && (s.induction?.type === 'twinscrew' || s.induction?.type === 'roots')) d.push(`${s.induction.ratio}:1 pulley`);
  if (s.exhaust.headers?.len !== f.exhaust.headers?.len) d.push(`${s.exhaust.headers.len.toFixed(2)} m primaries`);
  return d.length ? d.join(', ') : 'factory';
}

function updateEngineUI() {
  const f = app.factory;
  $('epName').textContent = f.name;
  $('epTag').textContent = f.tagline;
  $('engineNote').innerHTML = `<b>Listen</b> ${f.listen}`;
  tach.labelB = f.family === 'Rotary' ? 'ROTARY' : `${f.family} · ${app.compiled.dispLitres.toFixed(1)} L`;
  tach.configure({ limit: app.tune.limit, idle: f.ecu.idle, label: tach.labelB, camSwitch: f.camSwitchRpm });
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
  app.factory = engineById(id);
  if (app.ab && !app.ab.keep) app.ab = null;
  app.abCompiled = null;
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
  if (!app.ab) app.abCompiled = null;
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
  if (app.scene) app.scene.cache.cam = c;
};
app.setEnv = (e) => {
  app.env = e;
  store.set('env', e);
  $('envSel').value = e;
  app.audio.setEnvironment(e);
};
app.quality = store.get('quality', 'auto');
app.setQuality = (q) => {
  app.quality = q;
  store.set('quality', q);
  if (app.started) app.audio.post({ type: 'quality', quality: q });
};
app.setVolume = (v) => {
  app.volume = v;
  store.set('volume', v);
  $('vol').value = v;
  app.audio.setVolume(v);
};

// ---------------------------------------------------------------- settings
app.setUnits = (u) => {
  units.speed = u;
  store.set('units', u);
  app.timer.result = null;
  syncUnitsUI();
};
function syncUnitsUI() {
  $('roTimeLbl').textContent = sprint().label;
}
app.setMixAudio = (on) => {
  app.mixAudio = on;
  store.set('mixAudio', on);
  if (app.started) applyAudioSessionType();
  call(EngineAudio, 'configure', { mixWithOthers: on });
};
app.setKeepAwake = (on) => {
  app.keepAwake = on;
  store.set('keepAwake', on);
  if (!on) screenAwake(false);
};

// --------------------------------------------------------------- platform
// iOS: "playback" plays through the silent switch and pauses other audio;
// "ambient" mixes with it. WebKit's Audio Session API sets this for the page
// itself (Safari and the app's web view); the native plugin covers the rest.
function applyAudioSessionType() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = app.mixAudio ? 'ambient' : 'playback';
  } catch {
    /* older WebKit */
  }
}

async function screenAwake(on) {
  app.awake = on;
  if (isNative) {
    call(EngineAudio, 'setKeepAwake', { on });
    return;
  }
  try {
    if (on && !app.wakeLock) app.wakeLock = await navigator.wakeLock?.request('screen');
    else if (!on && app.wakeLock) {
      const lock = app.wakeLock;
      app.wakeLock = null;
      await lock.release();
    }
  } catch {
    app.wakeLock = null; // refused or already released by the browser
  }
}

// Resume the sound after an interruption. Browsers may want a tap first.
async function resumeSound() {
  if (!app.started || document.hidden) return;
  try {
    await app.audio.resume();
  } catch {
    /* handled below */
  }
  if (app.audio.ctx?.state !== 'running') armTapResume();
}
let tapResumeArmed = false;
function armTapResume(msg = 'Tap anywhere to bring the sound back') {
  if (tapResumeArmed) return;
  tapResumeArmed = true;
  toast(msg);
  document.addEventListener(
    'pointerdown',
    () => {
      tapResumeArmed = false;
      if (isNative) call(EngineAudio, 'setActive', { on: true });
      app.audio.resume();
    },
    { once: true, capture: true }
  );
}

// Android back button: close the top-most sheet, leave a scene, then exit.
function handleBack() {
  if (!$('slip').hidden) $('slipClose').click();
  else if (settings.open) settings.hide();
  else if (builder.open) builder.hide();
  else if (workshop.open) workshop.hide();
  else if (garage.open) garage.hide();
  else if (!$('scenePick').hidden) $('scenePick').hidden = true;
  else if (app.scene || app.mode !== 'rev') setMode('rev');
  else call(AppPlugin, 'exitApp');
}

async function initNative() {
  if (!isNative) return;
  if (platform === 'ios') call(StatusBar, 'setStyle', { style: 'DARK' });
  EngineAudio?.addListener('interruption', (e) => {
    if (!app.started) return;
    if (e.state === 'began') app.audio.suspend();
    else resumeSound();
  });
  EngineAudio?.addListener('route', (e) => {
    if (e.reason !== 'deviceLost' || !app.started || app.audio.ctx?.state !== 'running') return;
    // headphones out: don't suddenly play out loud
    app.audio.suspend();
    armTapResume('Headphones disconnected. Tap to play through the speaker');
  });
  AppPlugin?.addListener('appStateChange', ({ isActive }) => {
    if (!app.started) return;
    if (isActive) {
      call(EngineAudio, 'setActive', { on: true });
      resumeSound();
    } else {
      app.audio.suspend();
      screenAwake(false);
      call(EngineAudio, 'setActive', { on: false });
    }
  });
  AppPlugin?.addListener('backButton', handleBack);
  const info = await call(AppPlugin, 'getInfo');
  if (info) app.versionText = `Version ${info.version} (${info.build})`;
}

// Load an engine spec directly (the builder's live audition). hot: keep the
// engine running through the swap.
app.loadSpec = (spec, { hot = false, quiet = false, remember = false } = {}) => {
  const keep = app.tune;
  app.presetId = spec.id;
  app.factory = spec;
  app.spec = clone(spec);
  app.tune = defaultTune(spec);
  if (keep) for (const k of ['tc', 'autoShift', 'valve']) app.tune[k] = keep[k];
  app.camLevel = 0;
  app.flyLevel = 1;
  app.compiled = compile(app.spec);
  if (app.ab && !app.ab.keep) app.ab = null;
  app.abCompiled = null;
  if (remember) store.set('engine', spec.id);
  updateEngineUI();
  if (app.started) app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune, hot: hot && !!(app.tel?.running || app.tel?.starter) });
  if (!quiet) toast(spec.name);
  if (workshop.open) workshop.render();
};
app.holdGas = (v) => {
  controls.external = v;
  if (v > 0 && app.started && app.tel && !app.tel.running && !app.tel.starter) app.audio.post({ type: 'ignition', on: true, crank: true });
};
app.toast = (m) => toast(m);
app.openBuilder = (opts) => {
  workshop.hide();
  garage.hide();
  builder.show(opts);
};

// ------------------------------------------------------------------ mixer
// Gains per simulated source: left/right/centre tail pipes, intake (with the
// turbo or blower), mechanical, road, wastegate dump.
app.mix = { exL: 1, exR: 1, intake: 1, mech: 1, road: 1, solo: null, ...store.get('mix', {}) };
function mixGains() {
  const m = app.mix;
  const on = (k) => (m.solo == null || m.solo === k || (m.solo === 'ex' && (k === 'exL' || k === 'exR')) ? 1 : 0);
  const exL = m.exL * on('exL'), exR = m.exR * on('exR');
  return [exL, exR, (exL + exR) / 2, m.intake * on('intake'), m.mech * on('mech'), m.road * on('road'), (exL + exR) / 2];
}
app.setMix = (patch) => {
  Object.assign(app.mix, patch);
  store.set('mix', app.mix);
  if (app.started) app.audio.post({ type: 'mix', gains: mixGains() });
  syncMixTag();
};
// the "Mixer on" tag, also for a mix stored from an earlier visit
function syncMixTag() {
  $('mixTag').hidden = !(app.mix.solo || ['exL', 'exR', 'intake', 'mech', 'road'].some((k) => Math.abs(app.mix[k] - 1) > 0.01));
}
syncMixTag();

// -------------------------------------------------------------------- A/B
// Slot A is the current engine's factory spec unless something else was
// stored. Holding A/B hot-swaps the running engine for slot A.
app.ab = null;
app.abActive = false;
app.allEngines = () => allEngines();
app.abLabel = () => (app.ab ? app.ab.label : `${app.factory.name}, factory spec`);
app.setAB = (what) => {
  if (what == null) app.ab = null;
  else if (what === 'current') app.ab = { spec: clone(app.spec), tune: { ...app.tune }, label: `${app.factory.name}, ${describeMods()}` };
  else if (what.engine) {
    const f = engineById(what.engine);
    app.ab = { spec: clone(f), tune: defaultTune(f), label: `${f.name}, factory spec` };
  }
  app.abCompiled = null;
  toast('A: ' + app.abLabel());
};
app.abHold = (on) => abSwitch(on);
function abSwitch(on) {
  $('abBtn').classList.toggle('held', on);
  if (!app.started || on === app.abActive) return;
  app.abActive = on;
  const a = app.ab ?? { spec: app.factory, tune: defaultTune(app.factory) };
  if (on && !app.abCompiled) app.abCompiled = compile(a.spec);
  const spec = on ? a.spec : app.spec;
  const tune = on ? { ...a.tune, autoShift: app.tune.autoShift, tc: app.tune.tc } : app.tune;
  const compiled = on ? app.abCompiled : app.compiled;
  app.audio.post({ type: 'config', cfg: workletConfig(compiled), tune, hot: true });
  schem.setEngine(compiled, spec);
  scope.setEngine(compiled, spec);
  tach.configure({ limit: tune.limit, idle: spec.ecu.idle, label: on ? 'A' : tach.labelB, camSwitch: spec.camSwitchRpm });
  $('abTag').hidden = !on;
  $('abTag').textContent = on ? `A · ${app.abLabel()}` : '';
}

// ------------------------------------------------------------------ modes
function setMode(m) {
  if (!app.started) return;
  if (app.dynoActive) stopDyno();
  endScene();
  $('scenePick').hidden = true;
  app.mode = m;
  const scene = !!SCENES[m];
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m || (b.dataset.mode === 'scene' && scene))));
  if (scene && m !== 'flyby') {
    startScene(m);
  } else if (m === 'flyby') {
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

// ----------------------------------------------------------------- scenes
function startScene(id) {
  const def = SCENES[id];
  const wasRunning = app.tel?.running;
  if (!wasRunning) app.audio.post({ type: 'ignition', on: true, crank: true });
  app.scene = { id, leaveT: null, finished: false, cache: {}, staging: id === 'drag' };
  $('flybyStrip').className = 'flyby-strip scene-hud' + (id === 'mountain' ? ' scene-map' : '');
  $('flybyStrip').hidden = false;
  if (id === 'drag') {
    app.audio.post({ type: 'camera', camera: 'scene' });
    setTree(-1);
    $('treeGo').disabled = false;
    $('slip').hidden = true;
    $('tree').hidden = false;
  } else app.audio.post({ type: 'camera', camera: app.camera });
  const go = () => {
    if (app.scene?.id === id) app.audio.post({ type: 'scene', id, track: def.track, length: def.length, marks: def.marks });
  };
  if (wasRunning) go();
  else setTimeout(go, 1800);
  toast(id === 'drag' ? 'Staged on the launch limiter. GO on green' : `${def.title}: the car drives itself`);
}

function endScene() {
  if (!app.scene) return;
  app.scene = null;
  $('tree').hidden = true;
  $('flybyStrip').hidden = true;
  $('flybyStrip').className = 'flyby-strip';
  app.audio.setEnvironment(app.env, 0.6);
  app.audio.post({ type: 'scene-stop' });
}

function sceneGo() {
  if (!app.scene?.staging) return;
  app.scene.staging = false;
  $('treeGo').disabled = true;
  app.audio.post({ type: 'scene-go' });
}

function setTree(k, red) {
  // ambers light in turn, then green; red for a jump start
  document.querySelectorAll('#tree .lamp').forEach((el) => {
    const i = +el.dataset.k;
    el.classList.toggle('on', red ? i === 4 : i === k);
  });
}

function toggleScenePick(force) {
  const p = $('scenePick');
  const show = force ?? p.hidden;
  if (show) {
    p.innerHTML = '';
    for (const [id, def] of Object.entries(SCENES)) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<b>${def.title}</b><span>${def.sub}</span><kbd>${def.key}</kbd>`;
      b.addEventListener('click', () => {
        p.hidden = true;
        if (!app.started) start().then(() => setTimeout(() => setMode(id), 600));
        else setMode(id);
      });
      p.appendChild(b);
    }
  }
  p.hidden = !show;
}

function onScene(m) {
  const sc = app.scene;
  if (!sc && m.ev !== 'done') return;
  switch (m.ev) {
    case 'env':
      app.audio.setEnvironment(m.env, m.fade);
      break;
    case 'tree':
      setTree(m.light);
      if (m.light === 3) sc.greenAt = performance.now();
      break;
    case 'done': {
      if (!sc) return;
      sc.finished = true;
      if (sc.id === 'drag' && !m.aborted) {
        if (m.foul) setTree(-1, true);
        const key = 'best.' + app.presetId;
        const best = store.get(key, null);
        const et = m.times.quarter;
        if (et && !m.foul && (!best || et < best)) store.set(key, et);
        const slip = timeSlip(m, `${app.factory.name}`, store.get(key, null));
        $('slipSub').textContent = `${slip.head} · ${describeMods()}`;
        $('slipBody').textContent = slip.lines.join('\n');
        $('slip').hidden = false;
      } else if (!m.aborted) {
        toast(`${SCENES[sc.id].title} done`);
        setTimeout(() => {
          if (app.scene === sc) setMode('rev');
        }, 2500);
      }
      break;
    }
  }
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
      if (app.scene?.staging) sceneGo();
      else startStop();
      break;
    case 'scene-menu':
      toggleScenePick();
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
    case 'ab':
      abSwitch(!!v);
      break;
    case 'builder':
      app.openBuilder({ from: 'current' });
      break;
    case 'escape':
      settings.hide();
      garage.hide();
      workshop.hide();
      if (builder.open) builder.hide();
      $('scenePick').hidden = true;
      break;
  }
}

app.start = () => start();
async function start() {
  if (app.started || app.starting) return;
  app.starting = true;
  applyAudioSessionType();
  if (isNative) {
    await call(EngineAudio, 'configure', { mixWithOthers: app.mixAudio });
    await call(EngineAudio, 'setActive', { on: true });
  }
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
  app.audio.post({ type: 'mix', gains: mixGains() });
  if (app.quality !== 'auto') app.audio.post({ type: 'quality', quality: app.quality });
  app.audio.post({ type: 'ignition', on: true, crank: true, cold: true });
  $('intro').hidden = true;
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
    case 'quality':
      toast(m.eco ? 'Busy device: physics now runs at half rate' : 'Full-rate physics');
      break;
    case 'scene':
      onScene(m);
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
  const rpmText = t.running || t.starter ? `${Math.round(t.rpm).toLocaleString('en-US')} rpm` : 'engine off';
  if (builder.open) $('bRpm').textContent = rpmText;
  if (workshop.open) $('wsRpm').textContent = rpmText;
  tach.lim = t.lim;
  tach.camHi = t.camHi;
  const inGear = t.mode === 'drive' || t.mode === 'flyby';
  if (app.scene?.id === 'drag' && app.scene.leaveT == null && t.scene?.phase === 'run' && t.scene.x > 0.3) app.scene.leaveT = performance.now();
  if (app.scene?.staging && t.scene?.phase === 'run') {
    // the car launched itself after a slow reaction
    app.scene.staging = false;
    $('treeGo').disabled = true;
  }
  tach.gear = inGear ? (t.gear ? String(t.gear) : 'N') : t.mode === 'dyno' ? 'D' : 'N';
  tach.speedText = inGear ? speedText(t.speed) : t.mode === 'dyno' ? 'DYNO' : t.running ? 'NEUTRAL' : t.starter ? 'CRANKING' : 'OFF';
  if (inGear && t.gear !== app.lastGear && app.lastGear) navigator.vibrate?.(12);
  app.lastGear = t.gear;
  if (t.af > 0 && t.afI > 0.12) {
    schem.flame(Math.min(1.2, t.afI * 1.5));
    if (t.afI > 0.35) navigator.vibrate?.(8);
  }
  $('startBtn').classList.toggle('on', !!t.running);
  const wantAwake = app.keepAwake && !!t.running && !document.hidden;
  if (wantAwake !== app.awake) screenAwake(wantAwake);
  if (t.knockN > 0) {
    tach.knock = Math.max(tach.knock, Math.min(1, 0.3 + t.knock / 3e5));
    if (!app.warned.knock) {
      app.warned.knock = true;
      toast(app.tune.knockCtl ? 'Knock: the ECU hears it and pulls timing' : 'Knock, and the sensor is off: it keeps pinging');
    }
  }
  tach.float = t.float;
  if (t.float > 0.05 && !app.warned.float) {
    app.warned.float = true;
    toast('Valve float: the springs can no longer keep the valves on the cams');
  }
  if (t.dyno && app.dynoActive) {
    const last = app.dynoPts[app.dynoPts.length - 1];
    if (!last || t.dyno.rpm > last.rpm + 25) app.dynoPts.push({ rpm: t.dyno.rpm, tq: t.dyno.tq });
  }
  // 0–100 km/h (or 0–60 mph) timer
  const tm = app.timer;
  const now = performance.now() / 1000;
  if (inGear) {
    if (t.speed < 0.3) {
      tm.state = 'armed';
    } else if (tm.state === 'armed') {
      tm.state = 'running';
      tm.t0 = now;
    } else if (tm.state === 'running' && t.speed >= sprint().target) {
      tm.state = 'done';
      tm.result = now - tm.t0;
      toast(`${sprint().text} in ${tm.result.toFixed(2)} s`);
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
    g.fillText(`${Math.round(d)} m · ${speedText(t.speed)}`, 8 * dpr, H * 0.3);
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
  if (app.scene) drawSceneHud($('flybyStrip'), app.scene, app.tel, app.scene.cache);
  else drawFlyby();
  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0) toastEl.classList.remove('show');
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ wiring
// Phones in portrait show one lab panel at a time: the schematic ('engine')
// or the instruments. Elsewhere the schematic is always on screen and the
// tabs only pick the instrument. Matches the phone layout in style.css.
const phoneMQ = matchMedia('(max-width: 760px) and (min-height: 521px), (max-width: 760px) and (orientation: portrait)');
app.view = store.get('view', 'engine');
function selectTab(mode) {
  if (mode === 'engine') app.view = 'engine';
  else {
    app.view = 'scope';
    scope.mode = mode;
    store.set('tab', mode);
  }
  store.set('view', app.view);
  syncTabs();
}
function syncTabs() {
  const engine = phoneMQ.matches && app.view === 'engine';
  const active = engine ? 'engine' : scope.mode;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === active)));
  $('lab').dataset.view = app.view;
  $('dynoRun').hidden = engine || scope.mode !== 'dyno';
}
phoneMQ.addEventListener?.('change', syncTabs);

// Hold-to-rev buttons (builder and workshop): the pedal while the deck is covered.
function holdToRev(btn) {
  const down = (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    if (!app.started) start();
    app.holdGas(1);
    btn.classList.add('held');
  };
  const up = () => {
    app.holdGas(0);
    btn.classList.remove('held');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
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
  $('buildBtn').addEventListener('click', () => app.openBuilder({ from: 'current' }));
  // A/B: hold for a momentary listen to A; a quick tap latches A until the
  // next tap.
  const ab = $('abBtn');
  let abT = 0, unlatched = false;
  ab.addEventListener('pointerdown', (e) => {
    ab.setPointerCapture(e.pointerId);
    if (app.abLatched) {
      app.abLatched = false;
      unlatched = true;
      abSwitch(false);
      return;
    }
    abT = performance.now();
    abSwitch(true);
  });
  const abUp = () => {
    if (unlatched) {
      unlatched = false;
      return;
    }
    if (app.abActive && performance.now() - abT < 250) {
      app.abLatched = true;
      toast('A stays on: tap A/B again for B');
      return;
    }
    abSwitch(false);
  };
  ab.addEventListener('pointerup', abUp);
  ab.addEventListener('pointercancel', abUp);
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
  document.querySelectorAll('.modes button').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.mode === 'scene' ? toggleScenePick() : setMode(b.dataset.mode)))
  );
  $('treeGo').addEventListener('click', sceneGo);
  $('slipAgain').addEventListener('click', () => {
    $('slip').hidden = true;
    setMode('drag');
  });
  $('slipClose').addEventListener('click', () => {
    $('slip').hidden = true;
    setMode('rev');
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && app.scene?.staging) sceneGo();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('scenePick').hidden && !e.target.closest('#scenePick') && !e.target.closest('[data-mode="scene"]')) $('scenePick').hidden = true;
  });
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
      if (e.target.closest('.instr-panel, .tabs')) return;
      e.preventDefault();
      controls.wheel(e.deltaY);
    },
    { passive: false }
  );
  document.addEventListener('visibilitychange', () => {
    if (!app.started) return;
    if (document.hidden) {
      app.audio.suspend();
      screenAwake(false);
    } else resumeSound();
  });
  scope.mode = store.get('tab', 'wave');
  syncTabs();
  syncUnitsUI();
  holdToRev($('wsRev'));
  $('settingsBtn').addEventListener('click', () => settings.show());
  $('wsSettings').addEventListener('click', () => settings.show());
  initNative();
  document.fonts?.ready.then(() => {
    tach.face = null;
  });
}

wire();
loadEngine(app.presetId);
requestAnimationFrame(frame);
