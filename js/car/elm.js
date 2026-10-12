// ELM327: the command interpreter inside nearly every OBD-II adapter. Text
// commands go in ("010C" asks the engine for its rpm), text replies come back
// and end with a ">" prompt. This speaks it over any link that can write a
// string and hand back what arrives.

export const PID = {
  load: 0x04, // calculated engine load, %
  map: 0x0b, // intake manifold absolute pressure, kPa
  rpm: 0x0c, // engine speed, rpm
  speed: 0x0d, // road speed, km/h
  throttle: 0x11, // throttle plate, % (on a diesel: the intake flap, nearly always open)
  pedalD: 0x49, // accelerator pedal position D, %
  pedalRel: 0x5a, // relative accelerator pedal position, %
};

// data bytes after each PID in a mode 01 reply
const BYTES = { 0x00: 4, 0x20: 4, 0x40: 4, 0x60: 4, 0x04: 1, 0x05: 1, 0x0b: 1, 0x0c: 2, 0x0d: 1, 0x0f: 1, 0x10: 2, 0x11: 1, 0x49: 1, 0x4a: 1, 0x5a: 1 };

export function decode(pid, b) {
  switch (pid) {
    case 0x0c:
      return (b[0] * 256 + b[1]) / 4;
    case 0x0d:
    case 0x0b:
      return b[0];
    case 0x05:
    case 0x0f:
      return b[0] - 40;
    case 0x10:
      return (b[0] * 256 + b[1]) / 100;
    case 0x00:
    case 0x20:
    case 0x40:
    case 0x60:
      return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    default:
      return (b[0] * 100) / 255;
  }
}

// A mode 01 reply (headers off) as { pid: value }. Copes with spaces, with
// several control units answering (first answer wins), and with CAN replies
// split over frames: a byte count line ("00A") then "0:…", "1:…".
export function parseReply(text) {
  const out = {};
  const msgs = [];
  let multi = null;
  for (const raw of text.split(/[\r\n]+/)) {
    const l = raw.replace(/\s+/g, '');
    if (!l) continue;
    if (/^[0-9A-F]{3}$/i.test(l)) {
      if (multi?.hex) msgs.push(multi.hex);
      multi = { need: parseInt(l, 16), hex: '' };
      continue;
    }
    const m = /^([0-9A-F]):([0-9A-F]+)$/i.exec(l);
    if (m && multi) {
      multi.hex += m[2];
      if (multi.hex.length >= multi.need * 2) {
        msgs.push(multi.hex.slice(0, multi.need * 2));
        multi = null;
      }
      continue;
    }
    if (/^[0-9A-F]+$/i.test(l) && l.length % 2 === 0) msgs.push(l);
  }
  if (multi?.hex) msgs.push(multi.hex);
  for (const h of msgs) {
    const b = h.match(/../g).map((x) => parseInt(x, 16));
    let i = b.indexOf(0x41);
    if (i < 0) continue;
    i++;
    while (i < b.length) {
      const pid = b[i];
      const n = BYTES[pid];
      if (!n || i + 1 + n > b.length) break;
      if (out[pid] == null) out[pid] = decode(pid, b.slice(i + 1, i + 1 + n));
      i += 1 + n;
    }
  }
  return out;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Elm327 {
  // link: { write(str), onData(fn(str)) }
  constructor(link) {
    this.link = link;
    this.buf = '';
    this.waiter = null;
    this.sup = new Set();
    this.multi = false;
    this.oneShot = false;
    link.onData((s) => this.feed(s));
  }

  feed(s) {
    this.buf += s;
    const i = this.buf.indexOf('>');
    if (i < 0 || !this.waiter) return;
    const txt = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    const w = this.waiter;
    this.waiter = null;
    w(txt);
  }

  send(cmd, timeout = 2500) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`No answer to ${cmd}`));
      }, timeout);
      this.waiter = (t) => {
        clearTimeout(timer);
        resolve(t);
      };
      this.link.write(cmd + '\r');
    });
  }

  supports(pid) {
    return this.sup.has(pid);
  }

  // Reset, quiet replies, find the car's protocol, learn what it reports and
  // how fast we may ask. Returns a short description for the status line.
  async init(log = () => {}) {
    log('Waking the adapter');
    try {
      await this.send('ATZ', 4000);
    } catch {
      // some clones never finish their reset banner with a prompt
      await sleep(500);
    }
    let id = '';
    try {
      id = (await this.send('ATI')).replace(/[\r\n>]+/g, ' ').trim();
    } catch {}
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) await this.send(c);
    try {
      // adaptive timing: stop waiting for more answers sooner
      await this.send('ATAT2');
    } catch {}
    log('Looking for the car (ignition on)');
    const r0 = await this.send('0100', 15000);
    const p0 = parseReply(r0)[0x00];
    if (p0 == null) throw new Error(/UNABLE|ERROR|NO ?DATA/i.test(r0) ? 'The car does not answer: is the ignition on?' : `Unexpected reply: ${r0.trim().slice(0, 40)}`);
    this.addMask(0x00, p0);
    for (const base of [0x20, 0x40]) {
      if (!this.supports(base)) break;
      const v = parseReply(await this.send('01' + hex2(base)))[base];
      if (v == null) break;
      this.addMask(base, v);
    }
    // Two PIDs in one request, and "1" on the end (stop at the first answer)
    // save a round trip each; not every adapter understands them.
    try {
      const t = await this.send('010C0D1');
      const v = parseReply(t);
      this.multi = v[0x0c] != null && v[0x0d] != null;
      this.oneShot = this.multi || v[0x0c] != null;
    } catch {}
    if (!this.multi) {
      try {
        const v = parseReply(await this.send('010C0D'));
        this.multi = v[0x0c] != null && v[0x0d] != null;
      } catch {}
    }
    if (!this.oneShot) {
      try {
        this.oneShot = parseReply(await this.send('010C1'))[0x0c] != null;
      } catch {}
    }
    let proto = '';
    try {
      proto = (await this.send('ATDP')).replace(/[\r\n>]+/g, ' ').trim();
    } catch {}
    return { id, proto };
  }

  addMask(base, mask) {
    for (let i = 0; i < 32; i++) if ((mask >>> (31 - i)) & 1) this.sup.add(base + 1 + i);
  }

  // Ask for up to two PIDs (so the reply fits one CAN frame).
  async read(pids) {
    if (this.multi && pids.length > 1) {
      const t = await this.send('01' + pids.map(hex2).join('') + (this.oneShot ? '1' : ''), 1500);
      return { values: parseReply(t), raw: t };
    }
    const values = {};
    let raw = '';
    for (const p of pids) {
      const t = await this.send('01' + hex2(p) + (this.oneShot ? '1' : ''), 1500);
      raw += t;
      Object.assign(values, parseReply(t));
    }
    return { values, raw };
  }
}
