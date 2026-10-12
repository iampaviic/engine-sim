// Firing Order Pro: one non-consumable purchase, handled by RevenueCat on
// iOS and Android. The app only asks `pro.active`; everything about stores,
// receipts and restoring lives here.
//
// Modes:
//   revenuecat    the apps, with store keys in config.js
//   unconfigured  the apps before the store exists: an "unlock for testing"
//   web           the browser: unlocked (config WEB_UNLOCKED), with an
//                 option to preview the free version
//   mock          the browser with ?store=mock: a pretend store for testing
//                 the purchase screens

import { isNative, platform } from './native.js';
import { getItem, setItem } from './storage.js';
import { STORE, WEB_UNLOCKED } from '../config.js';

const CACHE = 'firing-order.pro';
const FREE_PREVIEW = 'firing-order.freePreview';

const Purchases = isNative ? window.Capacitor.registerPlugin('Purchases') : null;
const mockStore = !isNative && typeof location !== 'undefined' && new URLSearchParams(location.search).get('store') === 'mock';

export const pro = {
  active: false,
  mode: 'web',
  price: null, // the store's localized price, e.g. "$6.99" or "6,99 €"
  error: null, // last store problem, in words
};

let pkg = null;
const listeners = new Set();

// fn(active) runs whenever Pro turns on or off, and when the price loads
export function onProChange(fn) {
  listeners.add(fn);
}

function emit() {
  for (const fn of listeners) fn(pro.active);
}

function setActive(on, { remember = true } = {}) {
  if (remember && pro.mode !== 'web') setItem(CACHE, on ? '1' : '0');
  if (pro.active === on) return;
  pro.active = on;
  emit();
}

export async function initPurchases() {
  if (!isNative) {
    if (mockStore) {
      pro.mode = 'mock';
      pro.price = '$6.99';
      setActive(getItem(CACHE) === '1');
    } else {
      pro.mode = 'web';
      setActive(WEB_UNLOCKED && getItem(FREE_PREVIEW) !== '1');
    }
    return;
  }
  // last known state first, so Pro works offline from the first frame
  setActive(getItem(CACHE) === '1', { remember: false });
  const apiKey = STORE.revenueCatKeys[platform];
  if (!apiKey) {
    pro.mode = 'unconfigured';
    emit();
    return;
  }
  pro.mode = 'revenuecat';
  try {
    await Purchases.configure({ apiKey });
    // options first, then the callback: RevenueCat calls it on every change
    Purchases.addCustomerInfoUpdateListener({}, (info) => info && applyInfo(info));
    const { customerInfo } = await Purchases.getCustomerInfo();
    applyInfo(customerInfo);
  } catch (err) {
    pro.error = describe(err);
  }
  await loadOffer();
}

function applyInfo(info) {
  setActive(!!info?.entitlements?.active?.[STORE.entitlement]);
}

async function loadOffer() {
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings?.current;
    const all = current?.availablePackages ?? [];
    pkg = current?.lifetime ?? all.find((p) => p.product?.identifier === STORE.productId) ?? all[0] ?? null;
    pro.price = pkg?.product?.priceString ?? null;
    pro.error = pkg ? null : 'Pro is not in the store yet.';
  } catch (err) {
    pro.error = describe(err);
  }
  emit();
}

// Returns { ok } on success, { cancelled }, { pending } or { error }.
export async function buyPro() {
  if (pro.mode === 'web') {
    setItem(FREE_PREVIEW, '0');
    setActive(WEB_UNLOCKED);
    return { ok: pro.active };
  }
  if (pro.mode === 'mock') {
    await new Promise((r) => setTimeout(r, 600));
    setActive(true);
    return { ok: true };
  }
  if (pro.mode === 'unconfigured') return { error: 'The store is not connected in this build yet.' };
  if (!pkg) await loadOffer();
  if (!pkg) return { error: pro.error ?? 'Pro is not in the store yet.' };
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    applyInfo(customerInfo);
    return pro.active ? { ok: true } : { pending: true };
  } catch (err) {
    const code = errCode(err);
    if (code === '1' || err?.data?.userCancelled || err?.userCancelled) return { cancelled: true };
    if (code === '6') return restorePro(); // already owned on this account
    if (code === '20') return { pending: true };
    return { error: describe(err) };
  }
}

// Returns { ok } when Pro is restored, { none } when the account owns nothing.
export async function restorePro() {
  if (pro.mode === 'web' || pro.mode === 'mock') return pro.active ? { ok: true } : { none: true };
  if (pro.mode === 'unconfigured') return { error: 'The store is not connected in this build yet.' };
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    applyInfo(customerInfo);
    return pro.active ? { ok: true } : { none: true };
  } catch (err) {
    return { error: describe(err) };
  }
}

// Test builds only: there is no store to buy from yet.
export function unlockForTesting(on = true) {
  if (pro.mode !== 'unconfigured') return;
  setActive(on);
}

// Web only: show the app's free version while the web version is unlocked.
export function setFreePreview(on) {
  if (pro.mode !== 'web') return;
  setItem(FREE_PREVIEW, on ? '1' : '0');
  setActive(WEB_UNLOCKED && !on);
}

export function freePreview() {
  return pro.mode === 'web' && getItem(FREE_PREVIEW) === '1';
}

function errCode(err) {
  const c = err?.code ?? err?.data?.code;
  return c == null ? '' : String(c);
}

function describe(err) {
  switch (errCode(err)) {
    case '10':
    case '35':
      return 'Could not reach the store. Check the connection and try again.';
    case '3':
      return 'Purchases are turned off on this device (Screen Time or parental controls).';
    case '2':
      return 'The store had a problem. Try again in a moment.';
    case '23':
      return 'The store is not set up correctly for this app yet.';
    default:
      return err?.message || 'Something went wrong with the store.';
  }
}
