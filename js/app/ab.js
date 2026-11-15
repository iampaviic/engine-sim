// A/B compare: hot-swaps the running engine for a stored one and back.

import { workletConfig } from '../engine/compile.js';
import { clone } from '../ui/workshop.js';
import { $, app } from './state.js';
import { schem, scope, tach, toast } from './ui.js';
import { allEngines, compile, defaultTune, describeMods, engineById } from './engine.js';

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
export function abSwitch(on) {
  $('abBtn').classList.toggle('held', on);
  if (!app.started || on === app.abActive) return;
  app.abActive = on;
  const a = app.ab ?? { spec: app.factory, tune: defaultTune(app.factory) };
  if (on && !app.abCompiled) app.abCompiled = compile(a.spec);
  const spec = on ? a.spec : app.spec;
  const tune = on ? { ...a.tune, autoShift: app.tune.autoShift, manual: app.tune.manual, tc: app.tune.tc } : app.tune;
  const compiled = on ? app.abCompiled : app.compiled;
  app.audio.post({ type: 'config', cfg: workletConfig(compiled), tune, hot: true });
  schem.setEngine(compiled, spec);
  scope.setEngine(compiled, spec);
  tach.configure({ limit: tune.limit, idle: spec.ecu.idle, label: on ? 'A' : tach.labelB, camSwitch: spec.camSwitchRpm });
  $('abTag').hidden = !on;
  $('abTag').textContent = on ? `A · ${app.abLabel()}` : '';
}
