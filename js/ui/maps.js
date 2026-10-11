// Tuning maps editor: the ignition trim as a grid over rpm and manifold
// pressure, the full-load mixture and the boost target as curves over rpm,
// and the boost each gear may use. Every change goes straight to the running
// engine; the live cursor shows which cells it is reading, and cells that
// knocked are marked.

import { defaultMaps, fitMaps, hasBoostMap } from '../engine/maps.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const clampV = (x, a, b) => Math.min(b, Math.max(a, x));

const TABS = {
  spark: {
    min: -15,
    max: 15,
    step: 1,
    help: 'Degrees of advance added to the factory map, by rpm and manifold pressure. More advance builds cylinder pressure sooner and makes more torque, until the unburned end gas autoignites: knock, the metallic ping. Cells that knocked get an orange mark. Drag across cells to select a block, then nudge it.',
  },
  afr: {
    min: 10,
    max: 17,
    step: 0.1,
    help: 'Air-fuel ratio at full load (light load still leans out to 14.7). Richer, about 12.5 to 13, makes the most torque; richer still cools the charge and the exhaust and holds knock off, for a little less. Toward 14.7 the flame runs hotter and pings sooner; leaner, power falls away. Draw the curve with a finger or the mouse.',
  },
  boost: {
    min: 0.2,
    max: 2.5,
    step: 0.05,
    help: 'Boost the wastegate controller aims for at each rpm, and the share of it each gear may use: less in the low gears keeps the tyres hooked up. Draw the curve; past the cylinder pressure the fuel can take, it knocks.',
  },
};

export class MapEditor {
  constructor({ root, app }) {
    this.root = root;
    this.app = app;
    this.$ = (id) => root.querySelector('#' + id);
    this.tab = 'spark';
    this.sel = null; // [c0, r0, c1, r1] on the ignition grid
    this.knocks = new Map(); // "r,c" -> count
    this.tel = null;
    this.dirty = false;
    this.canvas = this.$('mCanvas');
    this.$('mClose').addEventListener('click', () => this.hide());
    this.$('mReset').addEventListener('click', () => this.resetTab());
    root.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.map)));
    this.$('mDyno').addEventListener('change', () => this.syncDyno());
    this.$('mThr').addEventListener('input', () => {
      this.$('mThrOut').textContent = `${Math.round(+this.$('mThr').value * 100)}%`;
      if (this.$('mDyno').checked) app.holdGas(+this.$('mThr').value);
    });
    this.wirePointer();
    root.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.draw()).observe(this.$('mWrap'));
  }

  get open() {
    return !this.root.hidden;
  }

  show(tab) {
    const app = this.app;
    if (!app.tune.maps) app.setTune({ maps: defaultMaps(app.spec, app.compiled, app.tune) });
    else {
      const fit = fitMaps(app.tune.maps, app.spec, app.compiled, app.tune);
      if (fit !== app.tune.maps) app.setTune({ maps: fit });
    }
    this.knocks.clear();
    this.sel = null;
    this.root.hidden = false;
    this.setTab(tab ?? this.tab);
  }

  hide() {
    if (this.$('mDyno').checked) {
      this.$('mDyno').checked = false;
      this.syncDyno();
    }
    this.root.hidden = true;
    this.app.holdGas?.(0);
  }

  get maps() {
    return this.app.tune.maps;
  }
  get turbo() {
    return hasBoostMap(this.app.spec);
  }

  setTab(t) {
    this.tab = t;
    this.root.querySelectorAll('[data-map]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.map === t)));
    this.render();
  }

  // Replace the maps (never edit them in place: A/B keeps a reference).
  commit(mut) {
    const m = clone(this.maps);
    mut(m);
    this.app.setTune({ maps: m });
    this.draw();
  }

  render() {
    const t = this.tab;
    const tools = this.$('mTools');
    tools.innerHTML = '';
    const btn = (label, fn, title) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    const noBoost = t === 'boost' && !this.turbo;
    this.$('mWrap').hidden = noBoost;
    this.$('mHelp').textContent = noBoost
      ? (this.app.spec.induction?.type ?? 'na') === 'na'
        ? 'This engine breathes the atmosphere: there is no boost to map. Fit a turbo in the workshop to get a wastegate to control.'
        : 'A crank-driven blower makes the boost its pulley gives it; there is no wastegate to map. Change the pulley in the workshop.'
      : TABS[t].help;
    if (t === 'spark') {
      btn('−1°', () => this.nudge(-1), 'Retard the selected cells (−)');
      btn('+1°', () => this.nudge(1), 'Advance the selected cells (+)');
      btn('Smooth', () => this.smooth(), 'Average the selected cells with their neighbours');
      btn('Zero', () => this.nudge(null), 'Back to the factory timing in the selected cells');
      btn('Clear knock marks', () => {
        this.knocks.clear();
        this.draw();
      });
    } else if (!noBoost) {
      const s = TABS[t].step;
      const f = (x) => (t === 'afr' ? x.toFixed(1) : x.toFixed(2));
      btn(t === 'afr' ? `Richer −${f(s * 2)}` : `−${f(s * 2)} bar`, () => this.shiftCurve(-s * 2));
      btn(t === 'afr' ? `Leaner +${f(s * 2)}` : `+${f(s * 2)} bar`, () => this.shiftCurve(s * 2));
      btn('Smooth', () => this.smooth());
    }
    this.renderGears();
    this.updateLive();
    this.draw();
  }

  renderGears() {
    const g = this.$('mGears');
    g.innerHTML = '';
    g.hidden = !(this.tab === 'boost' && this.turbo && this.maps?.gear);
    if (g.hidden) return;
    const h = document.createElement('h4');
    h.textContent = 'Boost by gear';
    g.appendChild(h);
    this.maps.gear.forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'm-gear';
      row.innerHTML = `<span>${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'}</span><button class="btn" aria-label="Less boost in gear ${i + 1}">−</button><output>${Math.round(v * 100)}%</output><button class="btn" aria-label="More boost in gear ${i + 1}">+</button>`;
      const [minus, plus] = row.querySelectorAll('button');
      const set = (d) => {
        this.commit((m) => (m.gear[i] = Math.round(clampV(m.gear[i] + d, 0.3, 1) * 100) / 100));
        this.renderGears();
      };
      minus.addEventListener('click', () => set(-0.05));
      plus.addEventListener('click', () => set(0.05));
      g.appendChild(row);
    });
  }

  // --- edits
  cells(fn) {
    const [c0, r0, c1, r1] = this.sel ?? [0, 0, this.maps.rpm.length - 1, this.maps.kpa.length - 1];
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) fn(r, c);
  }
  nudge(d) {
    if (!this.sel) this.app.toast?.('Select cells first: tap one, or drag across a block');
    if (!this.sel) return;
    this.commit((m) => this.cells((r, c) => (m.spark[r][c] = d == null ? 0 : clampV(m.spark[r][c] + d, TABS.spark.min, TABS.spark.max))));
  }
  shiftCurve(d) {
    const t = this.tab;
    this.commit((m) => (m[t] = m[t].map((x) => Math.round(clampV(x + d, TABS[t].min, TABS[t].max) / TABS[t].step) * TABS[t].step)));
  }
  smooth() {
    const t = this.tab;
    if (t === 'spark') {
      const g = this.maps.spark;
      const R = g.length, C = g[0].length;
      this.commit((m) =>
        this.cells((r, c) => {
          let s = g[r][c] * 2, n = 2;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (r + dr >= 0 && r + dr < R && c + dc >= 0 && c + dc < C) {
              s += g[r + dr][c + dc];
              n++;
            }
          }
          m.spark[r][c] = Math.round(s / n);
        })
      );
    } else {
      const a = this.maps[t];
      const st = TABS[t].step;
      this.commit((m) => (m[t] = a.map((x, i) => Math.round(((a[Math.max(0, i - 1)] + 2 * x + a[Math.min(a.length - 1, i + 1)]) / 4) / st) * st)));
    }
  }
  resetTab() {
    const app = this.app;
    const d = defaultMaps(app.spec, app.compiled, app.tune);
    this.commit((m) => {
      if (this.tab === 'spark') m.spark = d.spark.map((r) => r.slice());
      else if (this.tab === 'afr') m.afr = d.afr;
      else if (this.turbo) {
        m.boost = d.boost;
        m.gear = d.gear;
      }
    });
    this.renderGears();
    app.toast?.(`${this.tab === 'spark' ? 'Ignition' : this.tab === 'afr' ? 'Fuel' : 'Boost'} map back to factory`);
  }

  onKey(e) {
    if (this.tab !== 'spark' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const C = this.maps.rpm.length, R = this.maps.kpa.length;
    if (e.key === '+' || e.key === '=') this.nudge(1);
    else if (e.key === '-' || e.key === '_') this.nudge(-1);
    else if (e.key.startsWith('Arrow') && e.altKey) {
      const s = this.sel ?? [0, 0, 0, 0];
      const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const dr = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
      const c = clampV(s[0] + dc, 0, C - 1), r = clampV(s[1] + dr, 0, R - 1);
      this.sel = [c, r, c, r];
      this.syncDynoRpm();
      this.draw();
    } else return;
    e.preventDefault();
  }

  // --- dyno hold: steady state at the selected column's rpm
  syncDyno() {
    const on = this.$('mDyno').checked;
    this.$('mThrWrap').hidden = !on;
    this.$('mRev').hidden = on;
    const app = this.app;
    if (on) {
      if (!app.requirePro('The dyno is part of Pro')) {
        this.$('mDyno').checked = false;
        this.$('mThrWrap').hidden = true;
        this.$('mRev').hidden = false;
        return;
      }
      app.dynoHold(this.holdRpm());
      app.holdGas(+this.$('mThr').value);
    } else {
      app.holdGas(0);
      app.dynoHold(null);
    }
  }
  holdRpm() {
    const rpm = this.maps.rpm;
    const c = this.sel ? Math.min(this.sel[0], this.sel[2]) : this.liveCol ?? Math.round(rpm.length / 3);
    return Math.max(rpm[c], this.app.factory.ecu.idle * 1.6);
  }
  syncDynoRpm() {
    if (this.$('mDyno').checked) this.app.dynoHold(this.holdRpm());
  }

  // --- live data
  onTel(t) {
    this.tel = t;
    const m = this.maps;
    if (!m) return;
    this.liveCol = Math.round(axisPos(m.rpm, t.rpm));
    if (t.knockN > 0 && t.running) {
      const c = Math.round(axisPos(m.rpm, t.rpm)), r = Math.round(axisPos(m.kpa, t.map / 1000));
      const k = `${r},${c}`;
      this.knocks.set(k, (this.knocks.get(k) ?? 0) + t.knockN);
    }
    this.updateLive();
    if (!this.dirty) {
      this.dirty = true;
      requestAnimationFrame(() => {
        this.dirty = false;
        this.draw();
      });
    }
  }

  updateLive() {
    const t = this.tel;
    const dl = this.$('mLive');
    const run = t?.running;
    const boosted = (this.app.spec.induction?.type ?? 'na') !== 'na';
    const rows = [
      ['Engine', run ? `${Math.round(t.rpm).toLocaleString('en-US')} rpm` : 'off'],
      ['Manifold', t ? `${Math.round(t.map / 1000)} kPa${boosted ? ` · ${(t.boost / 1e5).toFixed(2)} bar` : ''}` : '—'],
      ['Spark', run && t.afr > 0 ? `${t.adv.toFixed(1)}° BTDC` : '—'],
      ['Mixture', run && t.afr > 0 ? `${t.afr.toFixed(1)} AFR · λ ${(t.afr / 14.7).toFixed(2)}` : run ? 'fuel cut' : '—'],
      ['Knock retard', t ? `${t.knockRet.toFixed(1)}°` : '—'],
      ['Exhaust gas', t ? `${Math.round(t.egt - 273)} °C` : '—'],
      ['Torque', run ? `${Math.round(t.tq)} Nm` : '—'],
    ];
    if (this.turbo) rows.push(['Boost target', t ? `${(t.boostTgt / 1e5).toFixed(2)} bar` : '—']);
    const html = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    if (dl.innerHTML !== html) dl.innerHTML = html;
  }

  // --- drawing
  layout() {
    const cv = this.canvas;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const narrow = r.width < 420;
    const L = (narrow ? 42 : 50) * dpr, B = 26 * dpr, T = 10 * dpr, Rr = 8 * dpr;
    return { W, H, dpr, x0: L, x1: W - Rr, y0: T, y1: H - B, narrow };
  }

  draw() {
    if (!this.open || !this.maps || this.$('mWrap').hidden) return;
    const g = this.canvas.getContext('2d');
    const Lo = this.layout();
    this.lo = Lo;
    g.clearRect(0, 0, Lo.W, Lo.H);
    if (this.tab === 'spark') this.drawGrid(g, Lo);
    else this.drawCurve(g, Lo);
  }

  drawGrid(g, Lo) {
    const { dpr, x0, x1, y0, y1, narrow } = Lo;
    const m = this.maps;
    const C = m.rpm.length, R = m.kpa.length;
    const cw = (x1 - x0) / C, ch = (y1 - y0) / R;
    const font = (px, w = 500) => `${w} ${Math.round(px * dpr)}px "B612 Mono", monospace`;
    // cells: row 0 (lowest pressure) at the bottom
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const v = m.spark[r][c];
        const x = x0 + c * cw, y = y1 - (r + 1) * ch;
        const a = Math.min(1, Math.abs(v) / 10);
        g.fillStyle = '#1f1c18';
        g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        if (v) {
          g.fillStyle = v > 0 ? `rgba(255,95,31,${0.18 + 0.62 * a})` : `rgba(88,174,224,${0.18 + 0.62 * a})`;
          g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        }
        g.fillStyle = v ? '#f3efe4' : 'rgba(235,227,208,0.35)';
        g.font = font(narrow ? 9.5 : 11, v ? 700 : 500);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(v > 0 ? `+${v}` : String(v), x + cw / 2, y + ch / 2);
        const k = this.knocks.get(`${r},${c}`);
        if (k) {
          g.fillStyle = '#ffb54a';
          g.beginPath();
          g.moveTo(x + cw - 1, y + 1);
          g.lineTo(x + cw - 1, y + 1 + Math.min(ch, cw) * 0.38);
          g.lineTo(x + cw - 1 - Math.min(ch, cw) * 0.38, y + 1);
          g.fill();
        }
      }
    }
    // selection
    if (this.sel) {
      const [c0, r0, c1, r1] = this.sel;
      const ca = Math.min(c0, c1), cb = Math.max(c0, c1), ra = Math.min(r0, r1), rb = Math.max(r0, r1);
      g.strokeStyle = '#ebe3d0';
      g.lineWidth = 2 * dpr;
      g.strokeRect(x0 + ca * cw + 1, y1 - (rb + 1) * ch + 1, (cb - ca + 1) * cw - 2, (rb - ra + 1) * ch - 2);
    }
    // axes
    g.fillStyle = 'rgba(235,227,208,0.6)';
    g.font = font(narrow ? 8.5 : 10);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    m.rpm.forEach((v, c) => {
      if (narrow && c % 2) return;
      g.fillText(v >= 10000 ? `${(v / 1000).toFixed(0)}k` : `${(v / 1000).toFixed(1)}k`, x0 + (c + 0.5) * cw, y1 + 6 * dpr);
    });
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    m.kpa.forEach((v, r) => g.fillText(String(v), x0 - 5 * dpr, y1 - (r + 0.5) * ch));
    g.save();
    g.translate(7 * dpr, (y0 + y1) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillStyle = 'rgba(235,227,208,0.4)';
    g.fillText('kPa', 0, 0);
    g.restore();
    // live cursor: where the engine is reading the map
    const t = this.tel;
    if (t?.running) {
      const pc = axisPos(m.rpm, t.rpm), pr = axisPos(m.kpa, t.map / 1000);
      const cx = x0 + (pc + 0.5) * cw, cy = y1 - (pr + 0.5) * ch;
      g.strokeStyle = 'rgba(255,181,74,0.5)';
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.moveTo(cx, y0);
      g.lineTo(cx, y1);
      g.moveTo(x0, cy);
      g.lineTo(x1, cy);
      g.stroke();
      g.fillStyle = '#ffb54a';
      g.beginPath();
      g.arc(cx, cy, 5 * dpr, 0, Math.PI * 2);
      g.fill();
    }
  }

  drawCurve(g, Lo) {
    const { dpr, x0, x1, y0, y1, narrow } = Lo;
    const t = this.tab;
    const m = this.maps;
    const a = m[t];
    const spec = TABS[t];
    const lo = t === 'boost' ? 0 : spec.min, hi = t === 'boost' ? Math.max(1.5, ...a) * 1.15 : spec.max;
    const C = a.length;
    const X = (c) => x0 + ((c + 0.5) / C) * (x1 - x0);
    const Y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    this.curveY = { lo, hi };
    const font = (px, w = 500) => `${w} ${Math.round(px * dpr)}px "B612 Mono", monospace`;
    g.fillStyle = '#1a1815';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    // grid lines and labels
    g.font = font(narrow ? 8.5 : 10);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const step = t === 'afr' ? 1 : hi > 2 ? 0.5 : 0.25;
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      g.strokeStyle = 'rgba(235,227,208,0.08)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x0, Y(v));
      g.lineTo(x1, Y(v));
      g.stroke();
      g.fillStyle = 'rgba(235,227,208,0.55)';
      g.fillText(t === 'afr' ? v.toFixed(0) : v.toFixed(2), x0 - 5 * dpr, Y(v));
    }
    g.save();
    g.translate(7 * dpr, (y0 + y1) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillStyle = 'rgba(235,227,208,0.4)';
    g.fillText(t === 'afr' ? 'AFR' : 'bar', 0, 0);
    g.restore();
    if (t === 'afr') {
      // best torque band and stoichiometric
      g.fillStyle = 'rgba(123,216,143,0.1)';
      g.fillRect(x0, Y(13.1), x1 - x0, Y(12.5) - Y(13.1));
      g.strokeStyle = 'rgba(88,174,224,0.6)';
      g.setLineDash([5 * dpr, 4 * dpr]);
      g.beginPath();
      g.moveTo(x0, Y(14.7));
      g.lineTo(x1, Y(14.7));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(88,174,224,0.8)';
      g.textAlign = 'left';
      g.fillText('stoich 14.7', x0 + 6 * dpr, Y(14.7) - 8 * dpr);
      g.fillStyle = 'rgba(123,216,143,0.75)';
      g.fillText('best torque', x0 + 6 * dpr, Y(12.8));
      g.fillStyle = 'rgba(235,227,208,0.4)';
      g.fillText('lean ↑   rich ↓', x0 + 6 * dpr, y0 + 10 * dpr);
    }
    // factory line
    const fac = t === 'afr' ? this.app.compiled.ecu.afr : this.app.tune.boost;
    g.strokeStyle = 'rgba(235,227,208,0.3)';
    g.setLineDash([2 * dpr, 4 * dpr]);
    g.beginPath();
    g.moveTo(x0, Y(fac));
    g.lineTo(x1, Y(fac));
    g.stroke();
    g.setLineDash([]);
    // the curve
    g.strokeStyle = '#ff5f1f';
    g.lineWidth = 2.5 * dpr;
    g.lineJoin = 'round';
    g.beginPath();
    a.forEach((v, c) => (c ? g.lineTo(X(c), Y(v)) : g.moveTo(X(c), Y(v))));
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    a.forEach((v, c) => {
      g.fillStyle = '#ff5f1f';
      g.beginPath();
      g.arc(X(c), Y(v), 4.5 * dpr, 0, Math.PI * 2);
      g.fill();
      if (!narrow || c % 2 === 0) {
        g.fillStyle = 'rgba(243,239,228,0.85)';
        g.font = font(narrow ? 8.5 : 9.5);
        g.fillText(t === 'afr' ? v.toFixed(1) : v.toFixed(2), X(c), Y(v) - 7 * dpr);
      }
    });
    // rpm axis
    g.fillStyle = 'rgba(235,227,208,0.6)';
    g.font = font(narrow ? 8.5 : 10);
    g.textBaseline = 'top';
    m.rpm.forEach((v, c) => {
      if (narrow && c % 2) return;
      g.fillText(v >= 10000 ? `${(v / 1000).toFixed(0)}k` : `${(v / 1000).toFixed(1)}k`, X(c), y1 + 6 * dpr);
    });
    // live: rpm line, and what the engine actually gets
    const tl = this.tel;
    if (tl?.running) {
      const p = axisPos(m.rpm, tl.rpm);
      const cx = x0 + ((p + 0.5) / C) * (x1 - x0);
      g.strokeStyle = 'rgba(255,181,74,0.5)';
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.moveTo(cx, y0);
      g.lineTo(cx, y1);
      g.stroke();
      const v = t === 'afr' ? (tl.afr > 0 ? tl.afr : null) : tl.boost / 1e5;
      if (v != null) {
        g.fillStyle = '#ffb54a';
        g.beginPath();
        g.arc(cx, Y(clampV(v, lo, hi)), 5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // --- pointer: select cells on the grid, draw the curves
  wirePointer() {
    const cv = this.canvas;
    let drag = null;
    const at = (e) => {
      const r = cv.getBoundingClientRect();
      const dpr = this.lo?.dpr ?? 1;
      return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
    };
    const cell = ([x, y]) => {
      const { x0, x1, y0, y1 } = this.lo;
      const m = this.maps;
      const C = m.rpm.length, R = m.kpa.length;
      const c = clampV(Math.floor(((x - x0) / (x1 - x0)) * C), 0, C - 1);
      const r = clampV(Math.floor(((y1 - y) / (y1 - y0)) * R), 0, R - 1);
      return [c, r, x >= x0 && x <= x1 && y >= y0 && y <= y1];
    };
    const paint = ([x, y], prev) => {
      const { x0, x1, y0, y1 } = this.lo;
      const t = this.tab;
      const C = this.maps[t].length;
      const { lo, hi } = this.curveY;
      const st = TABS[t].step;
      const val = (yy) => Math.round(clampV(lo + ((y1 - yy) / (y1 - y0)) * (hi - lo), TABS[t].min, TABS[t].max) / st) * st;
      const col = (xx) => clampV(Math.round(((xx - x0) / (x1 - x0)) * C - 0.5), 0, C - 1);
      const c1 = col(x), v1 = val(y);
      const [c0, v0] = prev ?? [c1, v1];
      this.commit((m) => {
        const a = Math.min(c0, c1), b = Math.max(c0, c1);
        for (let c = a; c <= b; c++) {
          const f = b === a ? 1 : (c - c0) / (c1 - c0);
          m[t][c] = Math.round((v0 + (v1 - v0) * f) / st) * st;
        }
      });
      return [c1, v1];
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!this.lo) return;
      cv.setPointerCapture(e.pointerId);
      cv.focus({ preventScroll: true });
      const p = at(e);
      if (this.tab === 'spark') {
        const [c, r, inside] = cell(p);
        if (!inside) return;
        this.sel = [c, r, c, r];
        drag = { kind: 'sel' };
        this.syncDynoRpm();
      } else drag = { kind: 'paint', last: paint(p, null) };
      this.draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = at(e);
      if (drag.kind === 'sel') {
        const [c, r] = cell(p);
        if (c !== this.sel[2] || r !== this.sel[3]) {
          this.sel[2] = c;
          this.sel[3] = r;
          this.draw();
        }
      } else drag.last = paint(p, drag.last);
    });
    const end = () => {
      if (drag?.kind === 'sel') this.syncDynoRpm();
      drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
}

// position on an axis as index plus fraction, held at the ends
function axisPos(a, x) {
  const n = a.length;
  if (!(x > a[0])) return 0;
  if (x >= a[n - 1]) return n - 1;
  let i = 0;
  while (x > a[i + 1]) i++;
  return i + (x - a[i]) / (a[i + 1] - a[i]);
}
