// Loading and rebuilding the engine: the library, the default tune, hardware
// changes (recompile and hot swap), tune changes, saved tuning maps.

import { presetById, PRESETS } from '../engine/presets.js';
import { compileEngine, workletConfig } from '../engine/compile.js';
import { applyHeaderEqualize, clone } from '../ui/workshop.js';
import { fitMaps, mapsEdited, mapsFit } from '../engine/maps.js';
import { buildSpecs } from '../engine/builder.js';
import { $, app, store } from './state.js';
import { mapEd, schem, scope, tach, toast, view3d, workshop } from './ui.js';
import { setMode, stopDyno } from './modes.js';
import { saveThermal, sendThermal } from './thermal.js';

// Factory engines plus the builds saved in this browser.
export function allEngines() {
  return [...PRESETS, ...buildSpecs()];
}
export function engineById(id) {
  if (id?.startsWith('my-')) return buildSpecs().find((s) => s.id === id) ?? presetById('v12-65');
  return presetById(id);
}

// ------------------------------------------------------------ engine / tune
export function defaultTune(f) {
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
    maps: null,
  };
}

export function compile(spec) {
  return compileEngine(applyHeaderEqualize(spec));
}

export function describeMods(s = app.spec, f = app.factory) {
  const d = [];
  if ((s.exhaust.muffler ?? '') !== (f.exhaust.muffler ?? '')) d.push(s.exhaust.muffler === 'none' ? (s.kind === 'twostroke' ? 'open stinger' : 'straight pipes') : s.kind === 'twostroke' ? 'packed silencer' : `${s.exhaust.muffler} silencer`);
  if ((s.exhaust.chamber?.tune ?? 0) !== (f.exhaust.chamber?.tune ?? 0)) d.push(`pipe for ${s.exhaust.chamber.tune.toLocaleString('en-US')} rpm`);
  if (String(s.ports?.powerValve?.rpm) !== String(f.ports?.powerValve?.rpm)) d.push(s.ports.powerValve.rpm[0] > 20000 ? 'power valve shut' : 'power valve open');
  if ((s.exhaust.merge ?? 'dual') !== (f.exhaust.merge ?? 'dual')) d.push(`${s.exhaust.merge}-merge`);
  if ((s.exhaust.headers?.style ?? 'n-1') !== (f.exhaust.headers?.style ?? 'n-1')) d.push(s.exhaust.headers.style === '180' ? '180° headers' : `${s.exhaust.headers.style} headers`);
  if (!!s.exhaust.cat !== !!f.exhaust.cat) d.push(s.exhaust.cat ? 'cats' : 'decat');
  if (!!s.exhaust.resonator !== !!f.exhaust.resonator) d.push(s.exhaust.resonator ? 'resonators' : 'resonator delete');
  if ((s.exhaust.exit ?? 'rear') !== (f.exhaust.exit ?? 'rear')) d.push(s.exhaust.exit === 'side' ? 'side pipes' : 'rear exit');
  if ((s.intake?.airbox ?? 'stock') !== (f.intake?.airbox ?? 'stock')) d.push(s.intake.airbox === 'open' ? 'open filter' : s.intake.airbox === 'ram' ? 'ram air' : 'airbox');
  if (!!s.intake?.itb !== !!f.intake?.itb) d.push(s.intake.itb ? 'ITBs' : 'single throttle');
  if (s === app.spec && app.camLevel) d.push(app.camLevel === 1 ? 'fast-road cams' : 'race cams');
  if ((s.induction?.type ?? 'na') !== (f.induction?.type ?? 'na') || (s.induction?.count ?? 1) !== (f.induction?.count ?? 1)) d.push(s.induction.type === 'na' ? 'atmospheric' : s.induction.type === 'turbo' && s.induction.count > 1 ? (s.induction.count >= 4 ? 'quad-turbo' : 'twin-turbo') : s.induction.type);
  if (!!s.induction?.screamer !== !!f.induction?.screamer) d.push(s.induction.screamer ? 'screamer pipe' : 'wastegate plumbed back');
  if ((s.induction?.ratio ?? 0) !== (f.induction?.ratio ?? 0) && (s.induction?.type === 'twinscrew' || s.induction?.type === 'roots')) d.push(`${s.induction.ratio}:1 pulley`);
  if (s.exhaust.headers?.len !== f.exhaust.headers?.len) d.push(`${s.exhaust.headers.len.toFixed(2)} m primaries`);
  if (s === app.spec && mapsEdited(app.tune.maps, app.compiled, app.tune)) d.push('tuned maps');
  return d.length ? d.join(', ') : 'factory';
}

function updateEngineUI() {
  const f = app.factory;
  $('epName').textContent = f.name;
  $('epTag').textContent = f.tagline;
  $('engineNote').innerHTML = `<b>Listen</b> ${f.listen}`;
  const L = app.compiled.dispLitres;
  tach.labelB = f.family === 'Rotary' ? 'ROTARY' : `${f.family} · ${L < 1 ? `${Math.round(L * 1000)} cc` : `${L.toFixed(1)} L`}`;
  tach.configure({ limit: app.tune.limit, idle: f.ecu.idle, label: tach.labelB, camSwitch: f.camSwitchRpm });
  schem.setEngine(app.compiled, app.spec);
  scope.setEngine(app.compiled, app.spec);
  view3d?.setEngine(app.compiled, app.spec);
  const hasBoost = (app.spec.induction?.type ?? 'na') !== 'na';
  $('roMapLbl').textContent = hasBoost ? 'Boost' : 'Manifold';
  document.title = `${f.name} · Firing Order`;
  $('intro').querySelector('.fo').textContent = f.kind === 'rotary' ? 'rotor · rotor · every 180°' : f.kind === 'twostroke' && f.cylinders === 1 ? 'bang · every turn' : f.firingOrder.join(' · ');
}

export function loadEngine(id, { autostart = false, keepOff = false } = {}) {
  const wasRunning = app.tel?.running && !keepOff;
  saveThermal(true);
  if (mapEd.open) mapEd.hide();
  app.factory = engineById(id);
  // an unsaved builder draft or a deleted build falls back to a real engine
  app.presetId = app.factory.id ?? id;
  if (app.ab && !app.ab.keep) app.ab = null;
  app.abCompiled = null;
  app.spec = clone(app.factory);
  app.tune = defaultTune(app.factory);
  app.camLevel = 0;
  app.flyLevel = 1;
  app.compiled = compile(app.spec);
  restoreMaps();
  app.dynoPts = [];
  scope.dyno = [];
  scope.dynoPrev = null;
  store.set('engine', app.presetId);
  updateEngineUI();
  if (app.started) {
    app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune });
    sendThermal();
    app.audio.post({ type: 'camera', camera: app.mode === 'flyby' ? 'flyby' : app.camera });
    if (autostart || wasRunning) setTimeout(() => app.crank(), 350);
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
  if (app.tune.maps) app.tune.maps = fitMaps(app.tune.maps, s, app.compiled, app.tune);
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
  store.set('maps.' + app.presetId, null);
  updateEngineUI();
  if (app.started) app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune, hot: true });
  workshop.render();
  toast('Factory spec');
};

app.setTune = (t) => {
  // the boost slider moves the whole boost curve with it
  if (t.boost != null && t.maps === undefined && app.tune.maps?.boost && app.tune.boost > 0) {
    const k = t.boost / app.tune.boost;
    t = { ...t, maps: { ...app.tune.maps, boost: app.tune.maps.boost.map((x) => Math.round(x * k * 100) / 100) } };
  }
  Object.assign(app.tune, t);
  if (app.started) app.audio.post({ type: 'tune', tune: t });
  if (t.maps !== undefined) saveMaps();
  if (t.limit != null) tach.configure({ limit: t.limit, idle: app.factory.ecu.idle, label: tach.label, camSwitch: app.factory.camSwitchRpm });
  if (t.tc != null) $('tcBtn').setAttribute('aria-pressed', String(t.tc));
};

// Tuning maps are kept per engine, until the workshop's Factory button.
let mapsSaveT = 0;
function saveMaps() {
  clearTimeout(mapsSaveT);
  const id = app.presetId;
  mapsSaveT = setTimeout(() => store.set('maps.' + id, mapsEdited(app.tune.maps, app.compiled, app.tune) ? app.tune.maps : null), 400);
}
function restoreMaps() {
  const m = store.get('maps.' + app.presetId, null);
  if (m && mapsFit(m, app.spec, app.compiled, app.tune)) app.tune.maps = m;
}
app.openMaps = () => {
  workshop.hide();
  mapEd.show();
};
// Steady-state dyno for the map editor: hold one rpm, the throttle is yours.
app.dynoHold = (rpm) => {
  if (rpm == null) {
    if (!app.dynoHolding) return;
    app.dynoHolding = false;
    app.audio.post({ type: 'dyno', action: 'stop' });
    app.mode = 'rev';
    app.audio.post({ type: 'mode', mode: 'rev' });
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'rev')));
    return;
  }
  if (!app.started) return;
  if (!app.dynoHolding) {
    if (app.scene || app.mode !== 'rev') setMode('rev');
    if (app.dynoActive) stopDyno();
    if (!app.tel?.running) app.audio.post({ type: 'ignition', on: true, crank: true });
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  }
  app.dynoHolding = true;
  app.mode = 'dyno';
  app.audio.post({ type: 'dyno', action: 'hold', rpm });
};

// Load an engine spec directly (the builder's live audition). hot: keep the
// engine running through the swap.
app.loadSpec = (spec, { hot = false, quiet = false, remember = false } = {}) => {
  const keep = app.tune;
  const swap = hot && !!(app.tel?.running || app.tel?.starter);
  if (!swap) saveThermal(true);
  app.presetId = spec.id;
  app.factory = spec;
  app.spec = clone(spec);
  app.tune = defaultTune(spec);
  if (keep) for (const k of ['tc', 'autoShift', 'valve']) app.tune[k] = keep[k];
  app.camLevel = 0;
  app.flyLevel = 1;
  app.compiled = compile(app.spec);
  restoreMaps();
  if (app.ab && !app.ab.keep) app.ab = null;
  app.abCompiled = null;
  if (remember) store.set('engine', spec.id);
  updateEngineUI();
  if (app.started) {
    app.audio.post({ type: 'config', cfg: workletConfig(app.compiled), tune: app.tune, hot: swap });
    if (!swap) sendThermal();
  }
  if (!quiet) toast(spec.name);
  if (workshop.open) workshop.render();
};
