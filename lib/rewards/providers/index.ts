// lib/rewards/providers/index.ts

import { stakingRewardsProvider } from "./staking-rewards-provider";
import { gameRewardsProvider } from "./game-rewards-provider";
import type { RewardCategoryKey, RewardProvider } from "../reward-types";

// Phase 3F Part 1 — Reward Provider Registry.
//
// The single plug-in point for the whole Reward Hub. reward-service.ts
// only ever reads this array — it never imports an individual provider
// file directly.
//
// Reward Vault cleanup — the old local/mock engagement providers
// ("daily", "referral", "season", backed by lib/rewards-engine.ts's
// check-in/streak/level/referral/season mock claim data) have been
// removed now that real MPGR reward claiming happens on-chain via the
// deployed MPGRRewardVault contract (see lib/reward-vault/ and
// hooks/useRewardClaim.ts / components/ui/OnChainRewardsSection.tsx,
// which are a fully separate, self-contained data path and don't read
// this registry at all). "daily"/"referral"/"season" now simply have no
// registered provider, same as "weekly"/"quest"/"ai"/"premium"/
// "airdrop" still do — reward-service.ts's existing fallback renders
// them as isActive: false ("Coming soon") rather than a fabricated
// number. "staking" and "game" (both real, both read-only) are
// registered — "game" reads exclusively from already-allocated
// RewardType.GAME rewards on the deployed MPGRRewardVault; see
// game-rewards-provider.ts's header comment for why the allocation
// side (what actually creates those on-chain rewards) is a separate,
// not-yet-built server-side concern.
//
// Adding a future reward system means: implement RewardProvider in a new
// file under lib/rewards/providers/, import it here, and add it to
// REWARD_PROVIDERS. Nothing else in lib/rewards/, hooks/useRewardHub.ts,
// or any component needs to change.

export const REWARD_PROVIDERS: RewardProvider[] = [stakingRewardsProvider, gameRewardsProvider];

export function getProviderForCategory(category: RewardCategoryKey): RewardProvider | undefined {
  return REWARD_PROVIDERS.find((provider) => provider.category === category);
}

export { stakingRewardsProvider, gameRewardsProvider };
