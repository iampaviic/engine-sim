// The native shells (Capacitor on iOS and Android). In the browser there is
// no window.Capacitor and every export here is null or a no-op, so the web
// version runs unchanged.

const Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;

export const isNative = !!Cap?.isNativePlatform?.();
export const platform = isNative ? Cap.getPlatform() : 'web';

// Proxies to the native plugins. The npm packages aren't loaded (the app has
// no bundler), so the proxies are registered here by name.
const plugin = (name) => (isNative ? Cap.registerPlugin(name) : null);
export const Preferences = plugin('Preferences');
export const AppPlugin = plugin('App');
export const StatusBar = plugin('StatusBar');
export const EngineAudio = plugin('EngineAudio');

// Fire-and-forget native call: a plugin that's missing or fails must never
// take the app down with it.
export function call(p, method, args) {
  if (!p) return Promise.resolve(null);
  try {
    return Promise.resolve(p[method](args)).catch((err) => {
      console.warn(`${method} failed:`, err?.message ?? err);
      return null;
    });
  } catch (err) {
    console.warn(`${method} failed:`, err?.message ?? err);
    return Promise.resolve(null);
  }
}
