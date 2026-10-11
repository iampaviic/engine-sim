// The car's own data from an OBD-II adapter over Bluetooth Low Energy (Web
// Bluetooth: Chrome on Android and computers; on iPhone, the Bluefy browser,
// since Safari has none). Revs on every request, the pedal (or engine load)
// on most, road speed and boost now and then.

import { Elm327, PID } from './elm.js';

// Serial-over-BLE services that adapters use. A web page may only open the
// services it names up front, so the common ones are all listed.
const SERVICES = [
  '0000fff0-0000-1000-8000-00805f9b34fb', // OBDLink CX and most ELM327 clones: notify FFF1, write FFF2
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 style modules: FFE1 both ways
  '000018f0-0000-1000-8000-00805f9b34fb', // some clones: 2AF0 / 2AF1
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // another BLE serial service in use on adapters
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
];

export const hasWebBluetooth = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

// Pick an adapter, open its serial service. Returns a link for Elm327.
export async function connectBle() {
  if (!hasWebBluetooth()) {
    const e = new Error('This browser has no Bluetooth. On iPhone, open this page in the Bluefy browser.');
    e.code = 'nobt';
    throw e;
  }
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
  const server = await device.gatt.connect();
  let rx = null, tx = null;
  for (const uuid of SERVICES) {
    let svc;
    try {
      svc = await server.getPrimaryService(uuid);
    } catch {
      continue;
    }
    const chars = await svc.getCharacteristics();
    rx = chars.find((c) => c.properties.notify || c.properties.indicate) ?? null;
    tx = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write) ?? null;
    if (rx && tx) break;
    rx = tx = null;
  }
  if (!rx) {
    device.gatt.disconnect();
    const e = new Error(`${device.name ?? 'That device'} has no serial service this page knows. Is it an OBD adapter?`);
    e.code = 'noserial';
    throw e;
  }
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let onData = () => {};
  rx.addEventListener('characteristicvaluechanged', (e) => onData(dec.decode(e.target.value, { stream: true })));
  await rx.startNotifications();
  const noResp = tx.properties.writeWithoutResponse && typeof tx.writeValueWithoutResponse === 'function';
  let chain = Promise.resolve();
  return {
    name: device.name || 'OBD adapter',
    write(s) {
      const bytes = enc.encode(s);
      chain = chain
        .then(async () => {
          for (let i = 0; i < bytes.length; i += 20) {
            const part = bytes.slice(i, i + 20);
            if (noResp) await tx.writeValueWithoutResponse(part);
            else await tx.writeValue(part);
          }
        })
        .catch(() => {});
    },
    onData(fn) {
      onData = fn;
    },
    onClose(fn) {
      device.addEventListener('gattserverdisconnected', fn);
    },
    close() {
      try {
        device.gatt.disconnect();
      } catch {}
    },
  };
}

export class ObdSource {
  constructor(onSample, onStatus) {
    this.onSample = onSample;
    this.onStatus = onStatus;
    this.running = false;
    this.v = { rpm: 0, pedal: 0, speed: 0, map: null, load: null };
    this.pedMin = Infinity;
    this.pedMax = -Infinity;
  }

  async start() {
    this.onStatus('Choose your adapter');
    this.link = await connectBle();
    this.link.onClose(() => {
      if (this.running) {
        this.running = false;
        this.onStatus('The adapter disconnected', true);
      }
    });
    this.elm = new Elm327(this.link);
    const info = await this.elm.init((s) => this.onStatus(s));
    const e = this.elm;
    // a diesel's throttle reading is its intake flap: the pedal (or the
    // engine's load) says what the driver is asking for
    this.pedalPid = e.supports(PID.pedalRel) ? PID.pedalRel : e.supports(PID.pedalD) ? PID.pedalD : null;
    this.loadPid = e.supports(PID.load) ? PID.load : null;
    this.running = true;
    this.loop();
    const what = this.pedalPid ? 'revs, pedal, speed' : this.loadPid ? 'revs, load, speed' : 'revs, speed';
    return { label: `${this.link.name}${info.proto ? ' · ' + info.proto.replace(/^AUTO,\s*/i, '') : ''}`, detail: `Reading ${what}${this.elm.multi ? ', two at a time' : ''}` };
  }

  async loop() {
    const e = this.elm;
    let i = 0, fails = 0;
    while (this.running) {
      let second = this.pedalPid ?? this.loadPid ?? PID.speed;
      if (i % 6 === 5) second = e.supports(PID.map) ? PID.map : PID.speed;
      else if (i % 3 === 2) second = PID.speed;
      i++;
      try {
        const { values } = await e.read([PID.rpm, second]);
        fails = 0;
        const v = this.v;
        // no answer for revs: the engine is off
        v.rpm = values[PID.rpm] ?? 0;
        if (values[PID.speed] != null) v.speed = values[PID.speed] / 3.6;
        if (values[PID.map] != null) v.map = values[PID.map];
        if (values[PID.load] != null) v.load = values[PID.load];
        const p = values[this.pedalPid];
        if (p != null) v.pedal = this.pedal(p);
        else if (!this.pedalPid && values[PID.load] != null) v.pedal = Math.max(0, (values[PID.load] - 20) / 80);
        this.onSample({ t: performance.now(), rpm: v.rpm, pedal: v.pedal, speed: v.speed, map: v.map, load: v.load });
      } catch (err) {
        if (++fails > 6 && this.running) {
          this.running = false;
          this.onStatus('The adapter stopped answering', true);
        }
      }
    }
  }

  // Pedal position D reads about 15% at rest and 80% or so floored; learn
  // the span. The relative reading is already 0..100.
  pedal(raw) {
    if (this.pedalPid === PID.pedalRel) return Math.min(1, Math.max(0, raw / 100));
    this.pedMin = Math.min(this.pedMin, raw);
    this.pedMax = Math.max(this.pedMax, raw, this.pedMin + 55);
    return Math.min(1, Math.max(0, (raw - this.pedMin) / (this.pedMax - this.pedMin)));
  }

  stop() {
    this.running = false;
    this.link?.close();
  }
}
