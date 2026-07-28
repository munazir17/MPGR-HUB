// lib/holder-tier-config.ts

// Holder Tier — independent module.
//
// Holder Tier is completely separate from Premium Membership:
//   - Premium (lib/premium-engine.ts) is derived ONLY from active Token Lock
//     positions, and owns XP/Rewards multipliers.
//   - Holder Tier (this module) is derived from Total Holder Score — live
//     wallet balance + active staked + active locked, combined — and owns
//     a disjoint set of perks (badge, frame, governance weight, reputation,
//     leaderboard, and flagged future perks). It never touches XP or
//     Rewards multipliers; that stays Premium's job.
//
// Single source of truth for tier thresholds so tuning the Holder economy
// never requires touching engine logic.

export type HolderTierId = "none" | "bronze" | "silver" | "gold" | "platinum" | "diamond";

export interface HolderTierDef {
  id: Exclude<HolderTierId, "none">;
  label: string;
  // Minimum Total Holder Score (wallet + staked + locked, live) required to
  // hold this tier. Not a one-time purchase — falls away automatically if
  // the score drops below the threshold on any subsequent read.
  minScore: number;
  // Governance voting weight = holderScore * votingWeightMultiplier.
  // Kept as a per-tier multiplier (not a flat bonus) so voting power still
  // scales with actual holdings within a tier, not just tier membership.
  votingWeightMultiplier: number;
  // Flat community reputation points granted for holding this tier,
  // added on top of the score-derived base in getCommunityReputationScore.
  reputationBonus: number;
}

export const HOLDER_TIERS: HolderTierDef[] = [
  { id: "bronze", label: "Bronze", minScore: 1_000, votingWeightMultiplier: 1, reputationBonus: 25 },
  { id: "silver", label: "Silver", minScore: 10_000, votingWeightMultiplier: 1.25, reputationBonus: 75 },
  { id: "gold", label: "Gold", minScore: 50_000, votingWeightMultiplier: 1.5, reputationBonus: 150 },
  { id: "platinum", label: "Platinum", minScore: 150_000, votingWeightMultiplier: 2, reputationBonus: 300 },
  { id: "diamond", label: "Diamond", minScore: 500_000, votingWeightMultiplier: 3, reputationBonus: 600 },
];

export function getHolderTierDef(id: Exclude<HolderTierId, "none">): HolderTierDef {
  return HOLDER_TIERS.find((t) => t.id === id) ?? HOLDER_TIERS[0];
}

// --- Cosmetics ---------------------------------------------------------

export interface HolderCosmetics {
  badgeLabel: string;
  badgeClass: string; // apply to a small badge/pill
  frameClass: string; // apply to an avatar wrapper
  dashboardAccentClass: string; // apply to dashboard cards/headers for this tier
}

export function getHolderCosmetics(tier: HolderTierId): HolderCosmetics | null {
  switch (tier) {
    case "diamond":
      return {
        badgeLabel: "Diamond Holder",
        badgeClass: "bg-gradient-blue text-white",
        frameClass: "ring-2 ring-primary-glow shadow-glow-lg",
        dashboardAccentClass: "bg-gradient-blue",
      };
    case "platinum":
      return {
        badgeLabel: "Platinum Holder",
        badgeClass: "bg-gradient-to-br from-slate-300 to-slate-500 text-white",
        frameClass: "ring-2 ring-slate-300 shadow-glow-lg",
        dashboardAccentClass: "bg-gradient-to-br from-slate-300 to-slate-500",
      };
    case "gold":
      return {
        badgeLabel: "Gold Holder",
        badgeClass: "bg-gradient-gold text-white",
        frameClass: "ring-2 ring-gold shadow-glow-gold-lg",
        dashboardAccentClass: "bg-gradient-gold",
      };
    case "silver":
      return {
        badgeLabel: "Silver Holder",
        badgeClass: "bg-gradient-to-br from-gray-200 to-gray-400 text-black",
        frameClass: "ring-2 ring-white/40 shadow-soft",
        dashboardAccentClass: "bg-gradient-to-br from-gray-200 to-gray-400",
      };
    case "bronze":
      return {
        badgeLabel: "Bronze Holder",
        badgeClass: "bg-gradient-to-br from-amber-700 to-amber-900 text-white",
        frameClass: "ring-2 ring-amber-700/60 shadow-soft",
        dashboardAccentClass: "bg-gradient-to-br from-amber-700 to-amber-900",
      };
    default:
      return null;
  }
}

// --- Feature flags -------------------------------------------------------
// Every perk this module can grant is gated behind a flag here, not
// scattered through the engine/hook/UI. Perks already backed by real logic
// in this module default to on; perks explicitly called out as future work
// (launchpad allocation, airdrop priority, early-access eligibility) default
// to off so the UI can surface them as "coming soon" without extra plumbing,
// and they can be flipped on later without touching engine internals.
export const HOLDER_FEATURE_FLAGS = {
  holderBadge: true,
  holderFrame: true,
  dashboardCosmetics: true,
  governanceVotingWeight: true,
  communityReputationScore: true,
  exclusiveHolderEvents: true,
  holderAchievements: true,
  holderLeaderboard: true,
  // Future perks — computed where cheap to do so, but hidden until their
  // real program logic lands. Flip to `true` when ready; no other file in
  // this module needs to change.
  launchpadAllocation: false,
  airdropPriority: false,
  earlyAccessEligibility: false,
} as const;

export type HolderFeatureFlag = keyof typeof HOLDER_FEATURE_FLAGS;

export function isHolderFeatureEnabled(flag: HolderFeatureFlag): boolean {
  return HOLDER_FEATURE_FLAGS[flag];
}
