// "Follow my car": pick where the car's data comes from, start following,
// watch the readings, and say how far the car revs.

import { hasWebBluetooth } from '../car/obd.js';

const NOTES = {
  obd: () =>
    `A Bluetooth LE OBD-II adapter in the port under the dashboard (an OBDLink CX, or a BLE ELM327). Revs, pedal and speed come straight from the car, about a dozen times a second. ${
      hasWebBluetooth() ? '' : '<b>This browser has no Bluetooth.</b> '
    }On iPhone, open this page in the free Bluefy browser: Safari has no Bluetooth.`,
  gps: () => 'No adapter: road speed from GPS, the pedal read from how the car speeds up and slows down, and this engine’s own gearbox. Fix the phone in a holder: after a few pulls away and stops it knows which way is forward and follows the pedal at once. Speed itself runs about a second behind.',
  demo: () => 'A drive in a 2.0 TDI hatchback, played as an adapter would report it: hear what following sounds like before you take it on the road.',
};

export class CarPanel {
  constructor({ root, body, close, app }) {
    this.root = root;
    this.body = body;
    this.app = app;
    this.status = '';
    this.bad = false;
    close.addEventListener('click', () => this.hide());
  }

  get open() {
    return !this.root.hidden;
  }
  show() {
    this.render();
    this.root.hidden = false;
  }
  hide() {
    this.root.hidden = true;
  }

  setStatus(text, bad = false) {
    this.status = text;
    this.bad = bad;
    const el = this.body.querySelector('.car-status');
    if (el) {
      el.textContent = text;
      el.classList.toggle('bad', bad);
    }
  }

  render() {
    const app = this.app;
    const cs = app.carSettings;
    const on = app.following;
    const b = this.body;
    b.innerHTML = '';
    const group = (title) => {
      const g = document.createElement('section');
      g.className = 'ws-group';
      g.innerHTML = `<h3>${title}</h3>`;
      b.appendChild(g);
      return g;
    };
    const seg = (g, label, opts, value, onSet, disabled) => {
      const f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = `<label>${label}</label>`;
      const s = document.createElement('div');
      s.className = 'seg';
      for (const [v, text] of opts) {
        const bt = document.createElement('button');
        bt.textContent = text;
        bt.disabled = !!disabled;
        bt.setAttribute('aria-pressed', String(v === value));
        bt.addEventListener('click', () => {
          onSet(v);
          this.render();
        });
        s.appendChild(bt);
      }
      f.appendChild(s);
      g.appendChild(f);
      return f;
    };
    const range = (g, label, min, max, step, value, fmt, onSet) => {
      const f = document.createElement('div');
      f.className = 'field';
      const id = 'car-' + label.replace(/\W+/g, '-').toLowerCase();
      f.innerHTML = `<label for="${id}">${label}</label><output>${fmt(value)}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
      const inp = f.querySelector('input');
      inp.addEventListener('input', () => {
        f.querySelector('output').textContent = fmt(+inp.value);
        onSet(+inp.value);
      });
      g.appendChild(f);
    };

    let g = group('The car’s data');
    seg(
      g,
      'From',
      [
        ['obd', 'OBD adapter'],
        ['gps', 'GPS'],
        ['demo', 'Demo drive'],
      ],
      cs.source,
      (v) => app.setCarSettings({ source: v }),
      on
    );
    const note = document.createElement('p');
    note.className = 'ws-note';
    note.innerHTML = NOTES[cs.source]();
    g.appendChild(note);
    const row = document.createElement('div');
    row.className = 'btn-row';
    const go = document.createElement('button');
    go.className = on ? 'btn' : 'btn btn-accent';
    go.textContent = on ? 'Stop following' : cs.source === 'obd' ? 'Connect and follow' : 'Start following';
    // (Bluetooth and motion permissions must be asked for inside the tap)
    go.addEventListener('click', () => (on ? app.stopFollow() : app.startFollow(cs.source)));
    row.appendChild(go);
    g.appendChild(row);
    const st = document.createElement('p');
    st.className = 'car-status' + (this.bad ? ' bad' : '');
    st.textContent = this.status;
    g.appendChild(st);
    const dl = document.createElement('dl');
    dl.className = 'm-live car-live';
    g.appendChild(dl);
    this.updateLive();

    g = group('Your car');
    range(g, 'Idle', 500, 1200, 25, cs.carIdle, (v) => `${v.toLocaleString('en-US')} rpm`, (v) => app.setCarSettings({ carIdle: v }));
    range(g, 'Red line', 3500, 9500, 100, cs.carRed, (v) => `${v.toLocaleString('en-US')} rpm`, (v) => app.setCarSettings({ carRed: v }));
    seg(
      g,
      'Revs',
      [
        [true, 'Stretch to this engine'],
        [false, 'One to one'],
      ],
      cs.stretch,
      (v) => app.setCarSettings({ stretch: v })
    );
    const hint = document.createElement('p');
    hint.className = 'ws-note';
    hint.textContent = `Stretched, your idle is this engine’s idle and your red line its red line (${app.tune.limit.toLocaleString('en-US')} rpm), so a diesel can take a V12 all the way up. One to one keeps the real numbers.`;
    g.appendChild(hint);

    g = group('In the car');
    const tips = document.createElement('p');
    tips.className = 'ws-note';
    tips.innerHTML =
      'Set it up before you drive and leave the phone in its holder. The sound goes through the car like music: wired CarPlay has the least delay; Bluetooth audio adds about a quarter of a second. Keep this page open: the screen stays on while following. <b>Cockpit</b> (Microphone, in the workshop) puts you in the driver’s seat.';
    g.appendChild(tips);
  }

  updateLive() {
    const dl = this.body.querySelector('.car-live');
    if (!dl) return;
    const app = this.app;
    const f = app.follow;
    const x = f?.last;
    const t = app.tel;
    const rows = [];
    if (app.following && x) {
      if (x.rpm != null) rows.push(['Car', `${Math.round(x.rpm).toLocaleString('en-US')} rpm`]);
      rows.push(['Speed', `${Math.round((x.speed ?? 0) * 3.6)} km/h`]);
      rows.push(['Pedal', `${Math.round((x.pedal ?? 0) * 100)}%`]);
      if (x.map != null) rows.push(['Manifold', `${Math.round(x.map)} kPa`]);
      if (t) rows.push([app.factory.name, `${Math.round(t.rpm).toLocaleString('en-US')} rpm`]);
      rows.push(['Readings', `${f.hz.toFixed(1)} a second`]);
      if (f.kind === 'gps' && f.src) rows.push(['Forward', f.src.calibrated ? 'learned' : f.src.motion ? 'learning…' : 'no motion sensors']);
    }
    const html = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    if (dl.innerHTML !== html) dl.innerHTML = html;
  }
}

// Heads-up strip while following: the engine's revs, the car's readings,
// the pedal, and how often readings come in.
export function drawFollowHud(canvas, follow, tel, engineName) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.fillStyle = 'rgba(15,14,12,0.88)';
  g.fillRect(0, 0, W, H);
  const x = follow.last;
  const short = H / dpr < 60;
  const mono = (px, w = 500) => `${w} ${Math.round(px * dpr)}px "B612 Mono", monospace`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  // pedal bar on the right
  const bw = 8 * dpr, bx = W - 14 * dpr - bw, by = 8 * dpr, bh = H - 16 * dpr;
  g.fillStyle = 'rgba(235,227,208,0.12)';
  g.fillRect(bx, by, bw, bh);
  const ped = x?.pedal ?? 0;
  g.fillStyle = x?.brake > 0.05 ? '#e0302a' : '#ff5f1f';
  const pv = x?.brake > 0.05 ? x.brake : ped;
  g.fillRect(bx, by + bh * (1 - pv), bw, bh * pv);
  // the engine
  const rpm = tel?.running ? Math.round(tel.rpm).toLocaleString('en-US') : tel?.starter ? 'cranking' : 'off';
  g.fillStyle = '#f3efe4';
  g.font = mono(short ? 17 : 21, 600);
  const y1 = (short ? 21 : 27) * dpr;
  g.fillText(rpm, 10 * dpr, y1);
  const w1 = g.measureText(rpm).width;
  g.font = mono(10);
  g.fillStyle = 'rgba(235,227,208,0.6)';
  g.fillText(tel?.running ? `rpm · ${engineName}` : engineName, 10 * dpr + w1 + 6 * dpr, y1);
  // the car
  const parts = [];
  if (x?.rpm != null) parts.push(`car ${Math.round(x.rpm).toLocaleString('en-US')} rpm`);
  parts.push(`${Math.round((x?.speed ?? 0) * 3.6)} km/h`);
  parts.push(`pedal ${Math.round(ped * 100)}%`);
  const y2 = y1 + (short ? 15 : 18) * dpr;
  const line2 = parts.join(' · ');
  g.fillStyle = 'rgba(235,227,208,0.82)';
  g.fillText(line2, 10 * dpr, y2);
  // where the readings come from, on whichever line has room for it
  const src = follow.kind === 'obd' ? 'OBD' : follow.kind === 'gps' ? (follow.src?.calibrated ? 'GPS + motion' : 'GPS') : 'demo';
  const right = bx - 8 * dpr;
  const room = (y, used, txt) => right - g.measureText(txt).width > 10 * dpr + used + 12 * dpr;
  g.fillStyle = 'rgba(235,227,208,0.5)';
  g.textAlign = 'right';
  const long = `${src} · ${follow.hz.toFixed(0)}/s · tap for settings`, brief = `${src} · ${follow.hz.toFixed(0)}/s`;
  const w2 = g.measureText(line2).width;
  g.font = mono(10);
  const top = w1 + 6 * dpr + g.measureText(tel?.running ? `rpm · ${engineName}` : engineName).width;
  if (room(y2, w2, long)) g.fillText(long, right, y2);
  else if (room(y2, w2, brief)) g.fillText(brief, right, y2);
  else if (room(y1, top, brief)) g.fillText(brief, right, y1);
}
