// Modes and scenes: free revving, driving, the flyby, the scripted scenes
// with their time slips, and the dyno run.

import { SCENES, timeSlip, vmaxSlip } from '../ui/scenes.js';
import { speedText } from '../ui/units.js';
import { $, app, store } from './state.js';
import { carPanel, mapEd, scope, selectTab, toast } from './ui.js';
import { describeMods } from './engine.js';
import { start } from './actions.js';

// ------------------------------------------------------------------ modes
export function setMode(m) {
  if (!app.started) return;
  if (app.dynoActive) stopDyno();
  if (app.dynoHolding && mapEd.open) mapEd.hide();
  app.dynoHolding = false;
  if (app.following) {
    app.follow.stop(true);
    if (carPanel.open) carPanel.render();
  }
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
  $('flybyStrip').className = 'flyby-strip scene-hud' + (id === 'mountain' ? ' scene-map' : id === 'autobahn' ? ' scene-trace' : '');
  $('flybyStrip').hidden = false;
  if (id === 'drag') {
    app.audio.post({ type: 'camera', camera: 'scene' });
    setTree(-1);
    $('treeGo').disabled = false;
    $('slip').hidden = true;
    $('tree').hidden = false;
  } else app.audio.post({ type: 'camera', camera: app.camera });
  const go = () => {
    if (app.scene?.id === id) app.audio.post({ type: 'scene', id, track: def.track, length: def.length, marks: def.marks, trucks: def.trucks, joints: def.joints, derest: def.derest });
  };
  if (wasRunning) go();
  else setTimeout(go, 1800);
  toast(id === 'drag' ? 'Staged on the launch limiter. GO on green' : id === 'autobahn' ? 'Autobahn: flat out once the speed limit ends. C moves the mic' : `${def.title}: the car drives itself`);
}

export function endScene() {
  if (!app.scene) return;
  app.scene = null;
  $('tree').hidden = true;
  $('flybyStrip').hidden = true;
  $('flybyStrip').className = 'flyby-strip';
  app.audio.setEnvironment(app.env, 0.6);
  app.audio.post({ type: 'scene-stop' });
}

export function sceneGo() {
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

export function toggleScenePick(force) {
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
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.className = 'pick-car';
    b.innerHTML = `<b>Follow my car</b><span>Your own car drives this engine: its revs, pedal and speed from an OBD adapter, or its speed from GPS. Or try the demo drive.</span><kbd>8</kbd>`;
    b.addEventListener('click', () => app.openCar());
    p.appendChild(b);
  }
  p.hidden = !show;
}

export function onScene(m) {
  const sc = app.scene;
  if (!sc && m.ev !== 'done') return;
  switch (m.ev) {
    case 'env':
      app.audio.setEnvironment(m.env, m.fade);
      break;
    case 'vmax':
      toast(`Top speed ${speedText(m.vmax)}. Lifting off`);
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
        showSlip(sc.id, 'Firing Order Dragway', slip);
      } else if (sc.id === 'autobahn' && !m.aborted && m.times?.vmax) {
        const key = 'vmax.' + app.presetId;
        const best = store.get(key, null);
        if (!best || m.times.vmax > best) store.set(key, m.times.vmax);
        showSlip(sc.id, 'Top speed', vmaxSlip(m, app.factory.name, store.get(key, null)));
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

function showSlip(id, title, slip) {
  app.slipScene = id;
  $('slipTitle').textContent = title;
  $('slipSub').textContent = `${slip.head} · ${describeMods()}`;
  $('slipBody').textContent = slip.lines.join('\n');
  $('slip').hidden = false;
}

export function runDyno() {
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
export function stopDyno() {
  app.dynoActive = false;
  app.audio.post({ type: 'dyno', action: 'stop' });
  $('dynoRun').textContent = 'Run dyno';
}

// --------------------------------------------------------------- flyby map
export function drawFlyby() {
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
