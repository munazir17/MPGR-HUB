// Premium Membership — Phase 2C, Module 1.
// Single source of truth for tier thresholds and multipliers so tuning the
// Premium economy never requires touching engine logic. Premium has no
// separate lock mechanism of its own — it reads amounts already locked via
// lib/token-lock-engine.ts (see lib/premium-engine.ts).

export type PremiumTierId = "none" | "silver" | "gold" | "diamond";

export interface PremiumTierDef {
  id: Exclude<PremiumTierId, "none">;
  label: string;
  // MPGR required, currently ACTIVE (non-released) in Token Lock, to hold
  // this tier. Not a one-time purchase — falls away automatically if the
  // user releases enough locked MPGR to drop below the threshold.
  minLocked: number;
}

export const PREMIUM_TIERS: PremiumTierDef[] = [
  { id: "silver", label: "Silver", minLocked: 10_000 },
  { id: "gold", label: "Gold", minLocked: 50_000 },
  { id: "diamond", label: "Diamond", minLocked: 100_000 },
];

export function getTierDef(id: Exclude<PremiumTierId, "none">): PremiumTierDef {
  return PREMIUM_TIERS.find((t) => t.id === id) ?? PREMIUM_TIERS[0];
}

// Flat V1 multipliers, applied uniformly across every Premium tier. Named
// constants (not inline numbers) so tuning is a one-line change here.
export const PREMIUM_XP_MULTIPLIER = 1.5;
export const PREMIUM_REWARDS_MULTIPLIER = 1.25;

// Weekly Treasure Box payout range (mock — see getTreasureBoxLedger note in
// premium-engine.ts for how this becomes a real claim later).
export const TREASURE_BOX_CONFIG = {
  rewardMin: 50,
  rewardMax: 250,
};
