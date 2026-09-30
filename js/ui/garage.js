// Engine picker.

const FILTERS = [
  ['all', 'All'],
  ['V12', 'V12'],
  ['V10', 'V10'],
  ['V8', 'V8'],
  ['six', 'Sixes'],
  ['four', 'Fours'],
  ['odd', 'Oddballs'],
];

function matches(p, f) {
  if (f === 'all') return true;
  if (f === 'six') return p.family === 'I6' || p.family === 'F6';
  if (f === 'four') return p.family === 'I4' || p.family === 'F4';
  if (f === 'odd') return p.family === 'Rotary' || p.family === 'V2';
  return p.family === f;
}

export class Garage {
  constructor({ root, cards, filters, close, presets, onPick }) {
    this.root = root;
    this.cardsEl = cards;
    this.filtersEl = filters;
    this.presets = presets;
    this.onPick = onPick;
    this.filter = 'all';
    this.current = null;
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
    for (const p of this.presets) {
      if (!matches(p, this.filter)) continue;
      const b = document.createElement('button');
      b.className = 'card';
      b.setAttribute('aria-current', String(p.id === this.current));
      const fo = p.kind === 'rotary' ? 'rotor 1 · rotor 2 · every 180°' : p.firingOrder.join('-');
      const ind =
        p.induction?.type === 'turbo'
          ? `${p.induction.count > 1 ? 'twin-turbo' : 'turbo'} ${p.induction.boost} bar`
          : p.induction?.type === 'twinscrew' || p.induction?.type === 'roots'
            ? 'supercharged'
            : 'NA';
      b.innerHTML = `
        <div class="card-top"><span class="badge">${p.family}</span><span class="origin">${p.origin}</span></div>
        <h3>${p.name}</h3>
        <div class="tagline">${p.tagline}</div>
        <p class="blurb">${p.blurb}</p>
        <div class="fo-line"><b>firing</b> ${fo}<br><b>redline</b> ${p.ecu.limit.toLocaleString('en-US')} rpm · ${ind}</div>`;
      b.addEventListener('click', () => {
        this.hide();
        this.onPick(p.id);
      });
      this.cardsEl.appendChild(b);
    }
  }

  show(current) {
    this.current = current;
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
