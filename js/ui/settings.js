// App settings: units, how the sound shares the phone with other apps,
// screen keep-awake, and the about box.

import { isNative, platform } from '../platform/native.js';
import { pro, restorePro, setFreePreview, freePreview, unlockForTesting } from '../platform/purchases.js';

// Fill these in once the support site exists; empty links are left out.
export const SITE = { privacy: '', support: '' };

export class Settings {
  constructor({ root, body, close, app }) {
    this.root = root;
    this.body = body;
    this.app = app;
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

  render() {
    const app = this.app;
    const b = this.body;
    b.innerHTML = '';
    const group = (title) => {
      const g = document.createElement('section');
      g.className = 'ws-group';
      const h = document.createElement('h3');
      h.textContent = title;
      g.appendChild(h);
      b.appendChild(g);
      return g;
    };
    const seg = (g, label, opts, value, onSet, hint) => {
      const f = document.createElement('div');
      f.className = 'field';
      const l = document.createElement('label');
      l.textContent = label;
      f.appendChild(l);
      const s = document.createElement('div');
      s.className = 'seg';
      for (const [v, text] of opts) {
        const bt = document.createElement('button');
        bt.textContent = text;
        bt.setAttribute('aria-pressed', String(v === value));
        bt.addEventListener('click', () => {
          onSet(v);
          this.render();
        });
        s.appendChild(bt);
      }
      f.appendChild(s);
      if (hint) {
        const h = document.createElement('div');
        h.className = 'hint';
        h.textContent = hint;
        f.appendChild(h);
      }
      g.appendChild(f);
    };
    const line = (g, text, cls = 'ws-note') => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      g.appendChild(p);
      return p;
    };

    let g = group('Pro');
    const status = {
      web: pro.active ? 'The web version has everything unlocked.' : 'Showing the free version of the app.',
      mock: pro.active ? 'Pro is unlocked (test store).' : 'Free version (test store).',
      unconfigured: pro.active ? 'Pro is unlocked for testing. No store is connected to this build yet.' : 'Free version. No store is connected to this build yet.',
      revenuecat: pro.active ? 'Pro is unlocked. Thank you!' : 'Free version.',
    }[pro.mode];
    line(g, status, 'about-version');
    const row = document.createElement('div');
    row.className = 'btn-row';
    const btn = (text, onClick, cls = 'btn') => {
      const b2 = document.createElement('button');
      b2.className = cls;
      b2.textContent = text;
      b2.addEventListener('click', onClick);
      row.appendChild(b2);
    };
    if (!pro.active && pro.mode !== 'web') btn('See what Pro adds', () => app.showPaywall(), 'btn btn-accent');
    if (pro.mode === 'revenuecat')
      btn('Restore purchase', async () => {
        const res = await restorePro();
        app.toast(res.ok ? 'Pro restored' : res.none ? 'No Pro purchase was found for this account' : res.error);
        this.render();
      });
    if (pro.mode === 'unconfigured')
      btn(pro.active ? 'Turn test unlock off' : 'Unlock for testing', () => {
        unlockForTesting(!pro.active);
        this.render();
      });
    if (row.childElementCount) g.appendChild(row);
    if (pro.mode === 'web') {
      seg(
        g,
        'Free version preview',
        [
          ['off', 'Off'],
          ['on', 'On'],
        ],
        freePreview() ? 'on' : 'off',
        (v) => setFreePreview(v === 'on'),
        'Shows what the free app looks like: five engines, the basic workshop, Pro features locked.'
      );
    }

    g = group('Units');
    seg(
      g,
      'Speed',
      [
        ['kmh', 'km/h'],
        ['mph', 'mph'],
      ],
      app.units.speed,
      (v) => app.setUnits(v),
      'Drag strip time slips always show mph and km/h.'
    );

    if (app.canMixAudio) {
      g = group('Sound');
      const hint =
        platform === 'android'
          ? 'Play alongside lets music from other apps keep going under the engine.'
          : 'Play alongside keeps your music going under the engine. On iPhone the silent switch then mutes the engine too.';
      seg(
        g,
        'Other apps',
        [
          ['pause', 'Pause them'],
          ['mix', 'Play alongside'],
        ],
        app.mixAudio ? 'mix' : 'pause',
        (v) => app.setMixAudio(v === 'mix'),
        hint
      );
    }

    if (app.canKeepAwake) {
      g = group('Screen');
      seg(
        g,
        'Keep the screen on',
        [
          ['on', 'While the engine runs'],
          ['off', 'Never'],
        ],
        app.keepAwake ? 'on' : 'off',
        (v) => app.setKeepAwake(v === 'on')
      );
    }

    g = group('About');
    const name = document.createElement('p');
    name.className = 'about-name';
    name.textContent = 'Firing Order';
    g.appendChild(name);
    line(g, app.versionText ?? (isNative ? '' : 'Web version'), 'about-version');
    line(g, 'Every sound is computed live from the physics of the engine and its pipes. Nothing is recorded.');
    line(g, 'Fonts: B612 Mono, Barlow Semi Condensed and Big Shoulders Display, under the SIL Open Font License 1.1.');
    const links = [
      ['Privacy policy', SITE.privacy],
      ['Support', SITE.support],
    ].filter(([, href]) => href);
    if (links.length) {
      const row = document.createElement('div');
      row.className = 'btn-row';
      for (const [text, href] of links) {
        const a = document.createElement('a');
        a.className = 'btn';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = text;
        row.appendChild(a);
      }
      g.appendChild(row);
    }
  }
}
