// Engine picker: the factory engines plus the user's own builds.

import { PREVIEW_SECONDS } from '../config.js';

const FILTERS = [
  ['all', 'All'],
  ['V12', 'V12'],
  ['W16', 'W16'],
  ['V10', 'V10'],
  ['V8', 'V8'],
  ['six', 'Sixes'],
  ['four', 'Fives & fours'],
  ['two', 'Two-strokes'],
  ['odd', 'Oddballs'],
  ['mine', 'My garage'],
];

function matches(p, f) {
  if (f === 'all') return true;
  if (f === 'mine') return !!p.custom;
  if (p.custom) return false;
  if (f === 'six') return p.family === 'I6' || p.family === 'F6';
  if (f === 'four') return p.family === 'I4' || p.family === 'F4' || p.family === 'I5';
  if (f === 'two') return p.kind === 'twostroke';
  if (f === 'odd') return p.family === 'Rotary' || p.family === 'V2';
  return p.family === f;
}

export class Garage {
  constructor({ root, cards, filters, close, getEngines, isLocked = () => false, onPick, onBuild, onEdit, onDelete }) {
    this.root = root;
    this.cardsEl = cards;
    this.filtersEl = filters;
    this.getEngines = getEngines;
    this.isLocked = isLocked;
    this.onPick = onPick;
    this.onBuild = onBuild;
    this.onEdit = onEdit;
    this.onDelete = onDelete;
    this.filter = 'all';
    this.current = null;
    this.confirm = null;
    close.addEventListener('click', () => this.hide());
    root.addEventListener('click', (e) => {
      if (e.target === root) this.hide();
    });
    this.renderFilters();
  }

  renderFilters() {
    this.filtersEl.innerHTML = '';
    for (const [k, label] of FILTERS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(k === this.filter));
      b.addEventListener('click', () => {
        this.filter = k;
        this.renderFilters();
        this.render();
      });
      this.filtersEl.appendChild(b);
    }
  }

  render() {
    this.cardsEl.innerHTML = '';
    const engines = this.getEngines();
    if (this.filter === 'all' || this.filter === 'mine') {
      const b = document.createElement('button');
      b.className = 'card card-build';
      b.innerHTML = `<div class="card-top"><span class="badge">New</span><span class="origin">Engine builder</span></div>
        <h3>Build your own</h3>
        <p class="blurb">Pick a layout, a crankshaft and a firing order, size the bores, cams and pipes, add boost. You hear every change as you make it, and a virtual dyno measures the result.</p>
        <div class="fo-line"><b>1 to 16 cylinders</b> · inline, vee, flat or rotary</div>`;
      b.addEventListener('click', () => {
        this.hide();
        this.onBuild();
      });
      this.cardsEl.appendChild(b);
    }
    const mine = engines.filter((p) => p.custom);
    if (this.filter === 'mine' && !mine.length) {
      const p = document.createElement('p');
      p.className = 'garage-empty';
      p.textContent = 'Your saved builds appear here. Builds are kept in this browser.';
      this.cardsEl.appendChild(p);
    }
    for (const p of engines) {
      if (!matches(p, this.filter)) continue;
      const locked = this.isLocked(p.id);
      const card = document.createElement('div');
      card.className = 'card' + (p.custom ? ' card-mine' : '') + (locked ? ' card-locked' : '');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-current', String(p.id === this.current));
      const fo =
        p.kind === 'rotary'
          ? `${p.cylinders / 3} rotors · every ${Math.round(1080 / p.cylinders)}°`
          : p.kind === 'twostroke' && p.cylinders === 1
            ? 'every turn'
            : p.firingOrder.join('-');
      const ind =
        p.induction?.type === 'turbo'
          ? `${p.induction.count >= 4 ? (p.induction.sequential ? 'sequential quad-turbo' : 'quad-turbo') : p.induction.count > 1 ? 'twin-turbo' : 'turbo'} ${p.induction.boost} bar`
          : p.induction?.type === 'twinscrew' || p.induction?.type === 'roots'
            ? 'supercharged'
            : p.induction?.type === 'centrifugal'
              ? 'centrifugal blower'
              : p.kind === 'twostroke'
                ? 'expansion chamber'
                : 'NA';
      card.innerHTML = `
        <div class="card-top"><span class="badge">${p.family}</span>${locked ? '<span class="pro-tag">PRO</span>' : ''}<span class="origin">${p.origin}</span></div>
        <h3>${escapeHtml(p.name)}</h3>
        <div class="tagline">${p.tagline}</div>
        <p class="blurb">${p.blurb}</p>
        <div class="fo-line"><b>firing</b> ${fo}<br><b>redline</b> ${p.ecu.limit.toLocaleString('en-US')} rpm · ${ind}</div>${
          locked ? `<div class="card-preview">Tap for a ${PREVIEW_SECONDS}-second listen</div>` : ''
        }`;
      const pick = () => {
        this.hide();
        this.onPick(p.id);
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      if (p.custom) {
        const row = document.createElement('div');
        row.className = 'card-actions';
        const edit = document.createElement('button');
        edit.className = 'link-btn';
        edit.textContent = 'Edit';
        edit.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hide();
          this.onEdit(p.id);
        });
        const del = document.createElement('button');
        del.className = 'link-btn danger';
        del.textContent = this.confirm === p.id ? 'Delete for good?' : 'Delete';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.confirm === p.id) {
            this.confirm = null;
            this.onDelete(p.id);
          } else this.confirm = p.id;
          this.render();
        });
        row.append(edit, del);
        card.appendChild(row);
      }
      this.cardsEl.appendChild(card);
    }
  }

  show(current) {
    this.current = current;
    this.confirm = null;
    this.render();
    this.root.hidden = false;
    this.cardsEl.querySelector('[aria-current="true"]')?.focus();
  }

  hide() {
    this.root.hidden = true;
  }

  get open() {
    return !this.root.hidden;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
