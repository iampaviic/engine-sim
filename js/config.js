// Store settings and what the free version includes.

export const STORE = {
  // RevenueCat public SDK keys (RevenueCat → Project settings → API keys).
  // Empty means no store yet: the app offers an "unlock for testing" button
  // instead, so test builds can try every feature.
  revenueCatKeys: { ios: '', android: '' },
  // RevenueCat entitlement that unlocks Pro, attached to the product below.
  entitlement: 'pro',
  // Product id in App Store Connect (non-consumable) and the Play Console
  // (one-time product).
  productId: 'firingorder_pro',
};

// The web version has no store. It stays fully unlocked until the apps are
// out; set this to false to turn it into a free demo.
export const WEB_UNLOCKED = true;

// What works without Pro.
export const FREE = {
  engines: new Set(['v12-65', 'v8-ls', 'i6-turbo', 'i4-vtec', 'vtwin']),
  scenes: new Set(['flyby']),
  tabs: new Set(['engine', 'wave']),
  builds: 1,
  // workshop settings, by their label
  workshop: new Set(['Microphone', 'Place', 'Volume', 'Physics rate', 'Silencer', 'Exhaust valve', 'Rev limit', 'Traction control']),
};

// Locked engines play this long before the paywall
export const PREVIEW_SECONDS = 30;

// Pro engines offered as a listen on the paywall
export const PAYWALL_SAMPLES = ['f1-v10', 'v8-blower', 'rotary'];
