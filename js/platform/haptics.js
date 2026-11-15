// Haptics: what a hand on the car would feel, as taps from the phone. In the
// native shells through the Haptics plugin, using only its impact styles,
// which go through the system's own feedback generators (on iOS they follow
// the System Haptics switch by themselves; on Android the app also asks the
// system whether touch feedback is on). In a browser through the Vibration
// API (Chrome on Android; Safari has none, so the web version on an iPhone
// stays still).
//
// Effects carry a priority: a stronger event cuts in over a weaker one, and
// a weaker one waits until the stronger has finished. Taps never come closer
// than an actuator can render them apart (Android's impacts last 43 to 60
// ms; a phone's vibration motor needs about 30 ms to spin up and down).

import { call, EngineAudio, Haptics, isNative } from './native.js';

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
export const hapticsSupported = isNative || canVibrate;
const GAP = isNative ? 50 : 30;

let level = 1; // the setting: 0 off, 0.5 low, 1 full
let systemOn = true; // the system's own haptics switch, where it can be read
let reduced = false; // prefers-reduced-motion
let busyUntil = 0, busyPri = -1, lastAt = -1e9;
const timers = [];

if (typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  mq.addEventListener?.('change', (e) => (reduced = e.matches));
}

export function setHapticLevel(l) {
  level = l;
}
export const reducedMotion = () => reduced;
export const hapticsOn = () => level > 0 && systemOn && hapticsSupported;

// Ask the system whether it wants haptics at all (Android's touch feedback
// setting; iOS answers yes and lets its feedback generators decide). Asked
// again whenever the app comes back to the front.
export function readSystemHaptics() {
  if (!isNative) return;
  call(EngineAudio, 'hapticFeedback').then((r) => {
    if (r && typeof r.enabled === 'boolean') systemOn = r.enabled;
  });
}

function cancel() {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}

// May an effect of priority p, lasting ms, play now?
function claim(p, ms) {
  if (!hapticsOn()) return false;
  const now = performance.now();
  if (now < busyUntil && p <= busyPri) return false;
  if (now - lastAt < GAP && p <= busyPri) return false;
  cancel();
  busyUntil = now + Math.max(ms, GAP);
  busyPri = p;
  lastAt = now;
  return true;
}

// One tap at strength s (0..1, already scaled by the setting): the native
// impact styles step through light, medium and heavy; a vibration motor has
// only its on-time to play with, 8 to 30 ms.
const style = (s) => (s < 0.4 ? 'LIGHT' : s < 0.75 ? 'MEDIUM' : 'HEAVY');
const onMs = (s) => Math.round(8 + 22 * s);
function out(s) {
  if (isNative) call(Haptics, 'impact', { style: style(s) });
  else navigator.vibrate(onMs(s));
}

// One tap: the event's strength s (0..1) and its priority p.
export function tap(s, p = 1) {
  const k = Math.min(1, s) * level;
  if (k < 0.03 || !claim(p, GAP)) return;
  out(k);
}

// A run of taps, gap ms apart: one vibration pattern on the web, timed
// impacts natively. (duty: the longest a motor may run in each gap, as a
// share of it, so that pulses stay apart.)
export function taps(strengths, gap, p = 1, duty = 1) {
  const g = Math.max(gap, GAP);
  if (!claim(p, strengths.length * g)) return;
  if (isNative) {
    strengths.forEach((s, i) => {
      const k = Math.min(1, s) * level;
      if (k < 0.03) return;
      if (i === 0) out(k);
      else timers.push(setTimeout(() => out(k), i * g));
    });
  } else {
    const pat = [];
    for (const s of strengths) {
      const on = Math.min(onMs(Math.min(1, s) * level), Math.round(g * duty));
      pat.push(on, Math.max(0, Math.round(g - on)));
    }
    pat.pop();
    navigator.vibrate(pat);
  }
}

// A steady shake: taps at hz (stepped down to what the actuator can render
// apart), strength s, for about 300 ms; the caller renews it while it lasts.
// The lowest priority, and never with reduced motion.
let shakeUntil = 0;
export function shake(s, hz) {
  if (reduced || !(hz > 0)) return;
  const now = performance.now();
  if (busyPri === 0 && now < busyUntil) {
    // a shake already playing: renew it just before it runs out
    if (now < shakeUntil - 60) return;
    busyUntil = 0;
  }
  const every = Math.ceil((hz * GAP) / 1000);
  const n = Math.max(1, Math.round((0.3 * hz) / every));
  const strengths = new Array(n).fill(s);
  const before = busyUntil;
  taps(strengths, (1000 * every) / hz, 0, 0.5);
  if (busyUntil !== before) shakeUntil = busyUntil;
}

// Stop whatever is playing (the engine switched off, the app hidden).
export function hush() {
  cancel();
  busyUntil = 0;
  busyPri = -1;
  if (!isNative && canVibrate && hapticsOn()) navigator.vibrate(0);
}
