// The app's shared state: `app` (what is loaded, what is running, and the
// methods the UI panels call), `store` (saved settings) and `$`.

import { AudioEngine, ENVIRONMENTS } from '../audio/audio.js';
import { defaultSpeedUnit, units } from '../ui/units.js';
import { isNative } from '../platform/native.js';
import { getItem, setItem, ready as storageReady } from '../platform/storage.js';

// app storage on phones is read asynchronously, once, before anything uses it
await storageReady;

export const $ = (id) => document.getElementById(id);
export const store = {
  get(k, d) {
    try {
      const v = getItem('firing-order.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    setItem('firing-order.' + k, JSON.stringify(v));
  },
};

export const app = {
  presetId: store.get('engine', 'v12-65'),
  factory: null,
  spec: null,
  compiled: null,
  tune: {},
  camLevel: 0,
  flyLevel: 1,
  camera: store.get('camera', 'rear'),
  env: store.get('env', 'open'),
  volume: store.get('volume', 0.8),
  mode: 'rev',
  environments: ENVIRONMENTS,
  audio: new AudioEngine(),
  started: false,
  starting: false,
  tel: null,
  lastGear: 0,
  dynoPts: [],
  dynoActive: false,
  lastRun: null,
  timer: { state: 'idle', t0: 0, result: null },
  warned: {},
  units,
  mixAudio: store.get('mixAudio', false),
  keepAwake: store.get('keepAwake', true),
  awake: false,
  // iOS (Safari and the app) can share the speaker with other apps; Android
  // apps share it through audio focus.
  canMixAudio: isNative || 'audioSession' in navigator,
  canKeepAwake: isNative || 'wakeLock' in navigator,
};
units.speed = store.get('units', defaultSpeedUnit());
