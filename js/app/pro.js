// Free and Pro: locked engines and their preview, lock marks, the paywall.

import { pro } from '../platform/purchases.js';
import { FREE, PREVIEW_SECONDS } from '../config.js';
import { $, app, store } from './state.js';
import { builder, garage, paywall, phoneMQ, scope, selectTab, settings, workshop } from './ui.js';
import { engineById, loadEngine } from './engine.js';
import { abSwitch } from './ab.js';
import { setMode, toggleScenePick } from './modes.js';
import { start } from './actions.js';

// ---------------------------------------------------------------------- Pro
app.isPro = () => pro.active;
app.engineById = (id) => engineById(id);
app.isLockedEngine = (id) => !pro.active && !!id && !id.startsWith('my-') && !FREE.engines.has(id);
app.showPaywall = (opts) => paywall.show(opts);
// true when the feature may be used; otherwise the paywall explains why not
app.requirePro = (reason) => {
  if (pro.active) return true;
  paywall.show({ reason });
  return false;
};

// Locked engines play for a while before the paywall.
app.preview = null;
app.previewEngine = (id) => {
  if (!app.isLockedEngine(id)) {
    loadEngine(id, { autostart: true });
    return;
  }
  const keepFree = app.preview ? app.preview.backTo : app.presetId;
  // the preview plays on the main screen
  if (builder.open) builder.hide();
  workshop.hide();
  garage.hide();
  loadEngine(id, { autostart: true });
  app.preview = { id, backTo: keepFree, until: performance.now() + PREVIEW_SECONDS * 1000 };
  $('previewBar').hidden = false;
  if (!app.started) start();
};
function endPreview(expired) {
  const p = app.preview;
  if (!p) return;
  app.preview = null;
  $('previewBar').hidden = true;
  if (!expired) return;
  const name = engineById(p.id).name;
  app.audio.post({ type: 'ignition', on: false });
  setTimeout(() => loadEngine(app.isLockedEngine(p.backTo) ? 'v12-65' : p.backTo, { keepOff: true }), 700);
  paywall.show({ reason: `That was ${name}. It's one of the Pro engines.` });
}
export function updatePreviewBar(now) {
  const p = app.preview;
  if (!p) return;
  const left = Math.max(0, Math.ceil((p.until - now) / 1000));
  $('previewText').textContent = `Preview · ${engineById(p.id).name} · 0:${String(left).padStart(2, '0')}`;
  if (left <= 0) endPreview(true);
}

// Lock marks on tabs, chips and scenes; leave anything Pro when Pro goes away.
export function syncPro() {
  const locked = !pro.active;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.classList.toggle('pro-lock', locked && !FREE.tabs.has(b.dataset.mode)));
  $('launchBtn').classList.toggle('pro-lock', locked);
  $('nosBtn').classList.toggle('pro-lock', locked);
  $('abBtn').classList.toggle('pro-lock', locked);
  if (pro.active) {
    if (app.preview) {
      // bought during a preview: keep the engine
      const id = app.preview.id;
      endPreview(false);
      store.set('engine', id);
    }
  } else {
    if (app.factory && app.isLockedEngine(app.presetId) && !app.preview) loadEngine('v12-65');
    if (app.scene && !FREE.scenes.has(app.scene.id)) setMode('rev');
    if (!FREE.tabs.has(phoneMQ.matches && app.view === 'engine' ? 'engine' : scope.mode)) selectTab('wave');
    if (app.abLatched || app.abActive) {
      app.abLatched = false;
      abSwitch(false);
    }
  }
  if (garage.open) garage.render();
  if (workshop.open) workshop.render();
  if (settings.open) settings.render();
  if (!$('scenePick').hidden) toggleScenePick(true);
}
