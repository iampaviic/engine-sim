// The objects on screen: the tach, schematic, scope and 3D view, the pedals,
// the panels (garage, workshop, settings, builder, map editor, car), the
// toast and the instrument tabs.

import { PRESETS } from '../engine/presets.js';
import { Tach } from '../ui/tach.js';
import { Schematic } from '../ui/schematic.js';
import { Scope } from '../ui/scope.js';
import { createView3D } from '../ui/view3d.js';
import { Controls } from '../ui/controls.js';
import { Garage } from '../ui/garage.js';
import { Workshop } from '../ui/workshop.js';
import { Builder } from '../ui/builder.js';
import { MapEditor } from '../ui/maps.js';
import { CarPanel } from '../ui/carlink.js';
import { Settings } from '../ui/settings.js';
import { loadBuilds, saveBuilds } from '../engine/builder.js';
import { Paywall } from '../ui/paywall.js';
import { FREE } from '../config.js';
import { $, app, store } from './state.js';
import { allEngines, engineById, loadEngine } from './engine.js';
import { action } from './actions.js';

// ---------------------------------------------------------------- UI objects
export const tach = new Tach($('tach'));
export const schem = new Schematic($('schem'));
export const scope = new Scope($('scope'));
// the 3D engine, built the first time its tab opens
export let view3d = null;
let view3dLoading = null;
function ensureView3D() {
  view3dLoading ??= createView3D($('view3d'))
    .then((v) => {
      view3d = v;
      v.setEngine(app.compiled, app.spec);
    })
    .catch((e) => {
      console.warn('3D view', e);
      toast('This device cannot show the 3D engine');
      view3dLoading = null;
    });
}
const toastEl = $('toast');
let toastT = 0;
export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastT = 1.6;
}

// Called every frame: hides the toast when its time is up.
export function tickToast(dt) {
  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0) toastEl.classList.remove('show');
  }
}

export const controls = new Controls({
  gas: $('gas'),
  brake: $('brake'),
  gasVal: $('gasVal'),
  onAction: (a, v) => action(a, v),
});

export const garage = new Garage({
  root: $('garage'),
  cards: $('garageCards'),
  filters: $('garageFilters'),
  close: $('garageClose'),
  getEngines: allEngines,
  isLocked: (id) => app.isLockedEngine(id),
  onPick: (id) => (app.isLockedEngine(id) ? app.previewEngine(id) : loadEngine(id, { autostart: true })),
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

export const paywall = new Paywall({ root: $('paywall'), app });
export const workshop = new Workshop({ root: $('workshop'), body: $('wsBody'), close: $('wsClose'), reset: $('wsReset'), app });
export const settings = new Settings({ root: $('settings'), body: $('setBody'), close: $('setClose'), app });
export const builder = new Builder({ root: $('builder'), app, presets: PRESETS });
export const mapEd = new MapEditor({ root: $('maps'), app });
export const carPanel = new CarPanel({ root: $('car'), body: $('carBody'), close: $('carClose'), app });

app.holdGas = (v) => {
  controls.external = v;
  if (v > 0 && app.started && app.tel && !app.tel.running && !app.tel.starter) app.audio.post({ type: 'ignition', on: true, crank: true });
};
app.toast = (m) => toast(m);
app.openBuilder = (opts) => {
  if ((opts?.from ?? 'current') === 'current' && !opts?.design && app.factory.kind === 'twostroke') {
    toast('The builder makes four-strokes and rotaries. Tune this one in the workshop.');
    return;
  }
  if ((opts?.from ?? 'current') === 'current' && !opts?.design && app.isLockedEngine(app.presetId)) {
    app.requirePro(`Building on ${app.factory.name} is part of Pro`);
    return;
  }
  workshop.hide();
  garage.hide();
  builder.show(opts);
};

// ------------------------------------------------------------------ wiring
// Phones in portrait show one lab panel at a time: the schematic ('engine')
// or the instruments. Elsewhere the schematic is always on screen and the
// tabs only pick the instrument. Matches the phone layout in style.css.
export const phoneMQ = matchMedia('(max-width: 760px) and (min-height: 521px), (max-width: 760px) and (orientation: portrait)');
app.view = store.get('view', 'engine');
const TAB_NAMES = { spec: 'The spectrum', pv: 'The p–V diagram', dyno: 'The dyno', '3d': 'The 3D engine' };
export function selectTab(mode) {
  if (!FREE.tabs.has(mode) && !app.requirePro(`${TAB_NAMES[mode] ?? 'This instrument'} is part of Pro`)) return;
  if (mode === 'engine') app.view = 'engine';
  else {
    app.view = 'scope';
    scope.mode = mode;
    store.set('tab', mode);
  }
  store.set('view', app.view);
  syncTabs();
}
export function syncTabs() {
  const engine = phoneMQ.matches && app.view === 'engine';
  const active = engine ? 'engine' : scope.mode;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === active)));
  $('lab').dataset.view = app.view;
  $('dynoRun').hidden = engine || scope.mode !== 'dyno';
  const three = scope.mode === '3d';
  $('scope').hidden = three;
  $('view3d').hidden = !three;
  $('v3dBar').hidden = !three;
  if (three && !engine) ensureView3D();
}
phoneMQ.addEventListener?.('change', syncTabs);
