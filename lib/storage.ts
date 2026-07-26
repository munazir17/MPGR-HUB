// Generic localStorage-backed JSON storage helper, shared by every Phase 2B
// mock service (rewards, staking, lock, burn, etc.) so each module doesn't
// reimplement its own try/catch persistence layer.
//
// Phase 2B swap point: once a real backend/contract exists for a given
// module, that module's own get/save functions swap their bodies for
// fetch()/contract calls — this helper itself doesn't need to change.
//
// SSR-safe: no-ops when `window` isn't available (matches the guard already
// used in lib/xp-engine.ts).

export function readJSON<T extends object>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function writeJSON<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota, etc.) — fail silently,
    // consistent with the rest of the app's mock persistence layer.
  }
}
