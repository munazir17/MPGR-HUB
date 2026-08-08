// lib/rewards/providers/index.ts

import { stakingRewardsProvider } from "./staking-rewards-provider";
import {
  dailyEngagementRewardsProvider,
  referralRewardsProvider,
  seasonRewardsProvider,
} from "./legacy-engagement-provider";
import type { RewardCategoryKey, RewardProvider } from "../reward-types";

// Phase 3F Part 1 — Reward Provider Registry.
//
// The single plug-in point for the whole Reward Hub. reward-service.ts
// only ever reads this array — it never imports an individual provider
// file directly. Adding a future reward system (Weekly, Quest, Game,
// Referral is already here, AI, Premium, Airdrop) means: implement
// RewardProvider in a new file under lib/rewards/providers/, import it
// here, and add it to REWARD_PROVIDERS. Nothing else in lib/rewards/,
// hooks/useRewardHub.ts, or any component needs to change.

export const REWARD_PROVIDERS: RewardProvider[] = [
  stakingRewardsProvider,
  dailyEngagementRewardsProvider,
  referralRewardsProvider,
  seasonRewardsProvider,
];

export function getProviderForCategory(category: RewardCategoryKey): RewardProvider | undefined {
  return REWARD_PROVIDERS.find((provider) => provider.category === category);
}

export { stakingRewardsProvider, dailyEngagementRewardsProvider, referralRewardsProvider, seasonRewardsProvider };
