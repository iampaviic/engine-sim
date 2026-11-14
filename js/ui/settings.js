// App settings: units, how the sound shares the phone with other apps,
// screen keep-awake, and the about box.

import { isNative, platform } from '../platform/native.js';

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

    let g = group('Units');
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
