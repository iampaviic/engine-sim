// The Pro screen: what Pro adds, a listen to a few Pro engines, the price
// from the store, buy and restore.

import { pro, buyPro, restorePro, unlockForTesting } from '../platform/purchases.js';
import { PAYWALL_SAMPLES, PREVIEW_SECONDS } from '../config.js';

const FEATURES = [
  ['All 19 engines', 'and every engine added later'],
  ['Every scene', 'tunnel run, quarter mile with time slips, mountain road'],
  ['The whole workshop', 'headers, X-pipes, turbos and blowers, cams, fuel and knock, launch control, nitrous'],
  ['All the instruments', 'spectrum, p–V diagram, dyno, A/B compare, sound mixer'],
  ['Unlimited builds', 'in My garage'],
];

export class Paywall {
  constructor({ root, app }) {
    this.root = root;
    this.app = app;
    this.busy = false;
    this.note = '';
    root.addEventListener('click', (e) => {
      if (e.target === root) this.hide();
    });
  }

  get open() {
    return !this.root.hidden;
  }

  // reason: the headline, e.g. "Tunnel run is part of Pro"
  show({ reason } = {}) {
    if (pro.active) return;
    this.reason = reason ?? 'Get the whole garage';
    this.note = '';
    this.busy = false;
    this.render();
    this.root.hidden = false;
    this.root.querySelector('.pw-buy')?.focus({ preventScroll: true });
  }

  hide() {
    this.root.hidden = true;
  }

  render() {
    const app = this.app;
    const r = this.root;
    r.innerHTML = '';
    const card = el('div', 'pw-card');
    card.setAttribute('role', 'document');
    r.appendChild(card);

    const head = el('div', 'pw-head');
    head.append(el('span', 'pw-badge', 'PRO'), el('h2', 'pw-title', 'Firing Order Pro'));
    const close = el('button', 'pw-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(el('p', 'pw-reason', this.reason));
    const list = el('ul', 'pw-list');
    for (const [b, rest] of FEATURES) {
      const li = el('li');
      li.append(el('b', '', b), document.createTextNode(` ${rest}`));
      list.appendChild(li);
    }
    card.appendChild(list);

    // a listen first
    const listen = el('div', 'pw-listen');
    listen.appendChild(el('span', 'pw-listen-label', `Hear ${PREVIEW_SECONDS} seconds of`));
    const row = el('div', 'pw-samples');
    for (const id of PAYWALL_SAMPLES) {
      const e = app.engineById(id);
      if (!e) continue;
      const b = el('button', 'chip pw-sample', e.name);
      b.addEventListener('click', () => {
        this.hide();
        app.previewEngine(id);
      });
      row.appendChild(b);
    }
    listen.appendChild(row);
    card.appendChild(listen);

    // buy
    const buy = el('button', 'btn btn-accent pw-buy');
    buy.disabled = this.busy;
    buy.textContent = this.busy ? 'Waiting for the store…' : this.buyLabel();
    buy.addEventListener('click', () => this.buy());
    card.appendChild(buy);

    const links = el('div', 'pw-links');
    if (pro.mode === 'revenuecat') {
      const restore = el('button', 'link-btn', 'Restore purchase');
      restore.addEventListener('click', () => this.restore());
      links.appendChild(restore);
    }
    if (pro.mode === 'unconfigured') {
      const test = el('button', 'link-btn', 'Unlock for testing');
      test.title = 'No store is connected to this build yet';
      test.addEventListener('click', () => {
        unlockForTesting();
        this.done('Pro unlocked for testing');
      });
      links.appendChild(test);
    }
    if (links.childElementCount) card.appendChild(links);

    const small = el('p', 'pw-small', this.smallPrint());
    card.appendChild(small);
    if (this.note) card.appendChild(el('p', 'pw-note', this.note));
  }

  buyLabel() {
    if (pro.mode === 'web') return 'Turn Pro back on';
    if (pro.mode === 'unconfigured') return 'Unlock Pro';
    return pro.price ? `Unlock Pro · ${pro.price}` : 'Unlock Pro';
  }

  smallPrint() {
    switch (pro.mode) {
      case 'web':
        return 'The web version includes everything. You are looking at the free version of the app.';
      case 'unconfigured':
        return 'This build has no store connected yet, so nothing can be bought. Unlock for testing turns Pro on for this phone.';
      case 'mock':
        return 'Test store: nothing is charged.';
      default:
        return 'One payment, no subscription. Restore it on any phone signed in to the same account.';
    }
  }

  async buy() {
    if (this.busy) return;
    this.busy = true;
    this.note = '';
    this.render();
    const res = await buyPro();
    this.busy = false;
    if (res.ok) return this.done(pro.mode === 'web' ? 'Pro is back on' : 'Pro unlocked. Thank you!');
    if (res.pending) this.note = 'Waiting for approval. Pro turns on as soon as the payment goes through.';
    else if (res.error) this.note = res.error;
    this.render();
  }

  async restore() {
    if (this.busy) return;
    this.busy = true;
    this.note = '';
    this.render();
    const res = await restorePro();
    this.busy = false;
    if (res.ok) return this.done('Pro restored');
    this.note = res.none ? 'No Pro purchase was found for this account.' : res.error;
    this.render();
  }

  done(msg) {
    this.hide();
    this.app.toast(msg);
  }
}

function el(tag, cls = '', text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
