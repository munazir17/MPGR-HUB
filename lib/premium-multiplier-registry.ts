// Dependency-free registry — this file imports NOTHING from the rest of the
// app. It exists purely so lib/xp-engine.ts and lib/rewards-engine.ts can
// one day read Premium multipliers WITHOUT importing lib/premium-engine.ts
// directly, which would create a cycle:
//
//   xp-engine -> premium-engine -> token-lock-engine -> rewards-engine -> xp-engine
//
// Instead, premium-engine.ts registers its real implementation here via
// setPremiumMultiplierProvider() (a one-directional call, safe because this
// file has zero imports of its own). xp-engine/rewards-engine would only
// ever import getPremiumMultipliers / applyPremiumMultiplier from THIS file
// — never from premium-engine.ts.
//
// Until a provider is registered (e.g. Premium hasn't loaded for this
// session yet), every lookup safely returns neutral 1x multipliers, so nothing
// in xp-engine/rewards-engine can ever break because Premium isn't present.
//
// V1 status: the registry and provider are fully wired (see the bottom of
// premium-engine.ts). xp-engine.ts and rewards-engine.ts are NOT modified in
// V1 — see "Future multiplier activation" below for the exact one-line
// change each engine needs to start applying these multipliers.

export interface PremiumMultipliers {
  xpMultiplier: number;
  rewardsMultiplier: number;
}

const NEUTRAL: PremiumMultipliers = { xpMultiplier: 1, rewardsMultiplier: 1 };

type PremiumMultiplierProvider = (address: string) => PremiumMultipliers;

let provider: PremiumMultiplierProvider | null = null;

/** Called once by premium-engine.ts to register the real implementation. */
export function setPremiumMultiplierProvider(fn: PremiumMultiplierProvider): void {
  provider = fn;
}

/**
 * Safe to call from anywhere, including xp-engine/rewards-engine once they
 * opt in. Returns neutral 1x multipliers if Premium hasn't registered a
 * provider yet (or throws), so callers never need a null check.
 */
export function getPremiumMultipliers(address: string): PremiumMultipliers {
  if (!provider) return NEUTRAL;
  try {
    return provider(address);
  } catch {
    return NEUTRAL;
  }
}

/**
 * Pure helper the award pipeline calls once multipliers go live. Example
 * future usage inside xp-engine.ts:
 *
 *   const base = XP_ACTIONS[action].xp;
 *   const xp = applyPremiumMultiplier(base, getPremiumMultipliers(address).xpMultiplier);
 *
 * Rounds to 2 decimals so XP/reward totals never accumulate floating-point
 * drift across many awards.
 */
export function applyPremiumMultiplier(baseAmount: number, multiplier: number): number {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(multiplier) || multiplier <= 0) {
    return baseAmount;
  }
  return Math.round(baseAmount * multiplier * 100) / 100;
}
