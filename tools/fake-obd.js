// A pretend OBD-II adapter for tests: an ELM327 (echo, spaces, the protocol
// search, two PIDs per request, CAN multi-frame replies, a second control
// unit answering, 20-byte BLE chunks, some latency) on a car that drives the
// demo trace. fakeLink() gives the link Elm327 talks to; fakeBluetooth()
// stands in for navigator.bluetooth so the page itself can be tested.

import { demoAt } from '../js/car/demo.js';

const SUPPORTED = [0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x20, 0x40, 0x49];

function mask(base) {
  let m = 0;
  for (const p of SUPPORTED) if (p > base && p <= base + 32) m |= 1 << (32 - (p - base));
  return [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255];
}

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

export function fakeElm(opts = {}) {
  const o = { multi: true, oneShot: true, latency: 35, twoEcus: true, pedalRel: false, ...opts };
  const t0 = Date.now();
  let echo = true, spaces = true, searched = false, out = () => {}, inbuf = '';
  const car = () => demoAt((Date.now() - t0) / 1000 + (o.offset ?? 0));
  const data = (pid) => {
    const c = car();
    switch (pid) {
      case 0x00:
      case 0x20:
      case 0x40:
        return mask(pid);
      case 0x0c: {
        const v = Math.round(c.rpm * 4);
        return [v >> 8, v & 255];
      }
      case 0x0d:
        return [Math.round(c.kmh)];
      case 0x0b:
        return [Math.min(255, Math.round(c.map))];
      case 0x04:
        return [Math.round((c.load * 255) / 100)];
      case 0x49:
        return [Math.round(((14.9 + c.pedal * 65) * 255) / 100)];
      case 0x5a:
        return [Math.round(c.pedal * 255)];
      case 0x11:
        return [230];
      case 0x05:
      case 0x0f:
        return [125];
      default:
        return null;
    }
  };
  const fmt = (bytes) => bytes.map(hex).join(spaces ? ' ' : '');
  const reply = (cmd) => {
    if (cmd === 'ATZ') {
      echo = true;
      spaces = true;
      return '\r\rELM327 v1.5';
    }
    if (cmd === 'ATI') return 'ELM327 v1.5';
    if (cmd === 'ATDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
    if (cmd === 'ATE0') echo = false;
    if (cmd === 'ATS0') spaces = false;
    if (cmd.startsWith('AT')) return 'OK';
    const m = /^01((?:[0-9A-F]{2})+)([1-9]?)$/.exec(cmd);
    if (!m) return '?';
    let pids = m[1].match(/../g).map((x) => parseInt(x, 16));
    if (m[2] && !o.oneShot) return '?';
    if (!o.multi) pids = pids.slice(0, 1);
    const bytes = [0x41];
    for (const p of pids) {
      if (!SUPPORTED.includes(p) && p !== 0x00 && !(p === 0x5a && o.pedalRel)) continue;
      const d = data(p);
      if (d) bytes.push(p, ...d);
    }
    let txt = '';
    if (!searched) {
      searched = true;
      txt += 'SEARCHING...\r';
    }
    if (bytes.length === 1) return txt + 'NO DATA';
    if (bytes.length <= 7) txt += fmt(bytes);
    else {
      // ISO-TP: byte count, then numbered frames of 6 and 7 bytes
      txt += hex(bytes.length).padStart(3, '0') + '\r';
      txt += '0:' + (spaces ? ' ' : '') + fmt(bytes.slice(0, 6));
      for (let i = 6, n = 1; i < bytes.length; i += 7, n++) {
        const fr = bytes.slice(i, i + 7);
        while (fr.length < 7) fr.push(0);
        txt += `\r${n}:` + (spaces ? ' ' : '') + fmt(fr);
      }
    }
    // the gearbox answers some requests too, unless told to stop at one
    if (o.twoEcus && !m[2] && pids.includes(0x0d)) txt += '\r' + fmt([0x41, 0x0d, ...data(0x0d)]);
    return txt;
  };
  const send = (s) => {
    // BLE: the reply arrives in 20-byte notifications
    const chunks = s.match(/[\s\S]{1,20}/g) ?? [];
    let t = o.latency;
    for (const c of chunks) {
      setTimeout(() => out(c), t);
      t += 2;
    }
  };
  return {
    write(s) {
      inbuf += s;
      let i;
      while ((i = inbuf.indexOf('\r')) >= 0) {
        const cmd = inbuf.slice(0, i).trim().toUpperCase().replace(/\s+/g, '');
        inbuf = inbuf.slice(i + 1);
        if (!cmd) continue;
        send((echo ? cmd + '\r' : '') + reply(cmd) + '\r\r>');
      }
    },
    onData(fn) {
      out = fn;
    },
    onClose() {},
    close() {},
    name: 'Fake OBDLink CX',
  };
}

// navigator.bluetooth with one adapter in range.
export function fakeBluetooth(opts) {
  const elm = fakeElm(opts);
  const listeners = [];
  const rx = {
    uuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    properties: { notify: true },
    addEventListener: (type, fn) => listeners.push(fn),
    startNotifications: async () => rx,
  };
  const enc = new TextEncoder(), dec = new TextDecoder();
  elm.onData((s) => {
    const bytes = enc.encode(s);
    for (const fn of listeners) fn({ target: { value: new DataView(bytes.buffer) } });
  });
  const tx = {
    uuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    properties: { write: true, writeWithoutResponse: true },
    writeValueWithoutResponse: async (b) => elm.write(dec.decode(b)),
    writeValue: async (b) => elm.write(dec.decode(b)),
  };
  const service = { getCharacteristics: async () => [rx, tx] };
  const server = {
    getPrimaryService: async (uuid) => {
      if (uuid === '0000fff0-0000-1000-8000-00805f9b34fb') return service;
      const e = new Error('No such service');
      e.name = 'NotFoundError';
      throw e;
    },
  };
  const device = { name: 'OBDLink CX', gatt: { connect: async () => server, disconnect() {} }, addEventListener() {} };
  return { requestDevice: async () => device };
}
