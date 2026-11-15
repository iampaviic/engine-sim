// Inputs: keyboard, touch/mouse pedals, mouse-wheel hand throttle, gamepad.
// Produces smoothed pedal/brake/clutch values and discrete actions.

export class Controls {
  constructor({ gas, brake, clutch, gasVal, onAction }) {
    this.gasEl = gas;
    this.brakeEl = brake;
    this.clutchEl = clutch;
    this.gasVal = gasVal;
    this.onAction = onAction;
    this.keys = new Set();
    this.touchGas = 0;
    this.touchBrake = 0;
    this.touchClutch = 0;
    this.clutch = 0; // 0 up (engaged), 1 floored
    this.hand = 0;
    this.external = 0; // e.g. the builder's hold-to-rev button
    this.blipT = 0;
    this.pedal = 0;
    this.brake = 0;
    this.launchHeld = false;
    this.nosHeld = false;
    this.padPrev = {};
    this.bindKeys();
    this.bindPedal(gas, (v) => (this.touchGas = v));
    this.bindPedal(brake, (v) => (this.touchBrake = v));
    this.bindPedal(clutch, (v) => (this.touchClutch = v));
  }

  bindKeys() {
    const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.code;
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      switch (k) {
        case 'Space':
          this.blip();
          break;
        case 'KeyE':
        case 'ArrowRight':
          this.onAction('shift', 1);
          break;
        case 'KeyQ':
        case 'ArrowLeft':
          this.onAction('shift', -1);
          break;
        case 'Enter':
          this.onAction('startstop');
          break;
        case 'KeyL':
          this.setLaunch(true);
          break;
        case 'KeyN':
          this.setNos(true);
          break;
        case 'KeyG':
          this.onAction('garage');
          break;
        case 'KeyT':
          this.onAction('workshop');
          break;
        case 'KeyM':
          this.onAction('maps');
          break;
        case 'KeyC':
          this.onAction('camera', 1);
          break;
        case 'KeyV':
          this.onAction('env', 1);
          break;
        case 'Digit1':
          this.onAction('mode', 'rev');
          break;
        case 'Digit2':
          this.onAction('mode', 'drive');
          break;
        case 'Digit3':
          this.onAction('mode', 'flyby');
          break;
        case 'Digit4':
          this.onAction('mode', 'tunnel');
          break;
        case 'Digit5':
          this.onAction('mode', 'drag');
          break;
        case 'Digit6':
          this.onAction('mode', 'mountain');
          break;
        case 'Digit7':
          this.onAction('mode', 'autobahn');
          break;
        case 'Digit8':
          this.onAction('car');
          break;
        case 'KeyD':
          this.onAction('dyno');
          break;
        case 'KeyH':
          this.onAction('temp');
          break;
        case 'KeyR':
          this.onAction('weather');
          break;
        case 'KeyB':
          this.onAction('ab', true);
          break;
        case 'Escape':
          this.onAction('escape');
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyL') this.setLaunch(false);
      if (e.code === 'KeyN') this.setNos(false);
      if (e.code === 'KeyB') this.onAction('ab', false);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touchGas = this.touchBrake = this.touchClutch = 0;
      this.setLaunch(false);
      this.setNos(false);
    });
  }

  setLaunch(on) {
    if (this.launchHeld === on) return;
    this.launchHeld = on;
    this.onAction('launch', on);
  }

  setNos(on) {
    if (this.nosHeld === on) return;
    this.nosHeld = on;
    this.onAction('nos', on);
  }

  bindPedal(el, set) {
    let id = null;
    const val = (e) => {
      const r = el.getBoundingClientRect();
      // top 18% of the pedal = full travel
      return Math.max(0, Math.min(1, (r.bottom - e.clientY) / (r.height * 0.82)));
    };
    el.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      el.setPointerCapture(id);
      set(Math.max(0.15, val(e)));
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) set(Math.max(0.05, val(e)));
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      set(0);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  wheel(dy) {
    this.hand = Math.max(0, Math.min(1, this.hand + (dy < 0 ? 0.05 : -0.05)));
    this.hand = Math.round(this.hand * 20) / 20;
  }

  blip() {
    this.blipT = 0.16;
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) pad = p;
    if (!pad) return { gas: 0, brake: 0, clutch: 0 };
    const b = (i) => pad.buttons[i]?.value ?? 0;
    const edge = (i, fn) => {
      const on = (pad.buttons[i]?.pressed ?? false);
      if (on && !this.padPrev[i]) fn();
      this.padPrev[i] = on;
    };
    edge(5, () => this.onAction('shift', 1));
    edge(4, () => this.onAction('shift', -1));
    edge(0, () => this.onAction('startstop'));
    edge(2, () => this.blip());
    edge(3, () => this.onAction('camera', 1));
    const l = pad.buttons[1]?.pressed ?? false;
    if (l !== !!this.padPrev.launch) {
      this.padPrev.launch = l;
      this.setLaunch(l);
    }
    const n = pad.buttons[11]?.pressed ?? false; // right stick click
    if (n !== !!this.padPrev.nos) {
      this.padPrev.nos = n;
      this.setNos(n);
    }
    // the clutch: the left stick pulled back
    const ly = pad.axes[1] ?? 0;
    return { gas: b(7), brake: b(6), clutch: Math.max(0, Math.min(1, (ly - 0.12) / 0.8)) };
  }

  update(dt) {
    const pad = this.pollGamepad();
    let gas = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) gas = 1;
    else if (this.keys.has('KeyA')) gas = 0.35;
    gas = Math.max(gas, this.touchGas, this.hand, pad.gas, this.external);
    if (this.blipT > 0) {
      gas = Math.max(gas, 0.75);
      this.blipT -= dt;
    }
    let brk = this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
    brk = Math.max(brk, this.touchBrake, pad.brake);
    // a right foot is fast but not instant
    const rise = 14, fall = 11;
    this.pedal += Math.max(-fall * dt, Math.min(rise * dt, gas - this.pedal));
    this.brake += Math.max(-8 * dt, Math.min(10 * dt, brk - this.brake));
    if (this.pedal < 0.002) this.pedal = 0;
    if (this.brake < 0.002) this.brake = 0;
    // The clutch: a thumb on the pedal or a stick goes where it is put,
    // about as fast as a foot. A key can only say down or up: down it goes
    // at once, and up at the pace of a foot on a brisk pull-away (full
    // travel in about two thirds of a second, a quarter of a second through
    // the bite: an estimate).
    const key = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0;
    const foot = Math.max(this.touchClutch, pad.clutch);
    if (foot >= key) this.clutch += Math.max(-14 * dt, Math.min(14 * dt, foot - this.clutch));
    else if (this.clutch < key) this.clutch = Math.min(1, this.clutch + 10 * dt);
    else this.clutch = Math.max(foot, this.clutch - 1.5 * dt);
    if (this.clutch < 0.002) this.clutch = 0;
    this.clutchEl.firstElementChild.style.height = `${(this.clutch * 100).toFixed(1)}%`;
    this.clutchEl.setAttribute('aria-valuenow', Math.round(this.clutch * 100));
    this.gasEl.firstElementChild.style.height = `${(this.pedal * 100).toFixed(1)}%`;
    this.brakeEl.firstElementChild.style.height = `${(this.brake * 100).toFixed(1)}%`;
    this.gasEl.setAttribute('aria-valuenow', Math.round(this.pedal * 100));
    this.brakeEl.setAttribute('aria-valuenow', Math.round(this.brake * 100));
    if (this.gasVal) this.gasVal.textContent = this.hand > 0 ? `HAND ${Math.round(this.hand * 100)}%` : '';
  }
}
