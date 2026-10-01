// Key-value storage for settings, builds and best times. On phones it uses
// Capacitor Preferences (UserDefaults / SharedPreferences), which the OS
// keeps like any other app data; web view storage can be cleared when the
// phone runs low on space. In the browser it is localStorage.
//
// Values are cached in memory so reads stay synchronous; await `ready`
// before the first read.

import { isNative, Preferences } from './native.js';

const cache = new Map();
const MIGRATED = '__migratedFromWebStorage';

function webStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

async function loadNative() {
  // One-time copy of anything an earlier build kept in web view storage.
  const { value: done } = await Preferences.get({ key: MIGRATED });
  const ls = webStore();
  if (!done && ls) {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key?.startsWith('firing-order.')) await Preferences.set({ key, value: ls.getItem(key) ?? '' });
    }
    await Preferences.set({ key: MIGRATED, value: '1' });
  }
  const { keys } = await Preferences.keys();
  for (const key of keys) {
    if (key === MIGRATED) continue;
    const { value } = await Preferences.get({ key });
    if (value != null) cache.set(key, value);
  }
}

// Falls back to web storage if the native store can't be read.
let nativeOk = false;
export const ready = isNative
  ? loadNative().then(
      () => {
        nativeOk = true;
      },
      (err) => console.warn('Native storage unavailable, using web storage:', err?.message ?? err)
    )
  : Promise.resolve();

export function getItem(key) {
  if (nativeOk) return cache.has(key) ? cache.get(key) : null;
  try {
    return webStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

// Returns false when nothing could be stored (e.g. blocked browser storage).
export function setItem(key, value) {
  if (nativeOk) {
    cache.set(key, value);
    Preferences.set({ key, value }).catch((err) => console.warn('Could not save', key, err?.message ?? err));
    return true;
  }
  try {
    const ls = webStore();
    if (!ls) return false;
    ls.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key) {
  if (nativeOk) {
    cache.delete(key);
    Preferences.remove({ key }).catch(() => {});
    return;
  }
  try {
    webStore()?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
