// lib/rewards/providers/game-rewards-provider.ts

import type { Address } from "viem";
import { rewardVaultService } from "@/lib/reward-vault/reward-vault-service";
import { VaultRewardStatus, VaultRewardType } from "@/lib/reward-vault/reward-vault-types";
import { REWARD_CATEGORY_METADATA } from "../reward-config";
import type { RewardCategorySummary, RewardClaimHistoryEntry, RewardProvider } from "../reward-types";

// "game" category — Reward Provider.
//
// Read-only. The ONLY source of truth here is the deployed
// MPGRRewardVault: rewardVaultService.getWalletRewards() (the exact same
// call hooks/useRewardClaim.ts already makes, through the same
// short-TTL cache) filtered to RewardType.GAME. This provider never
// computes, estimates, or fabricates a game-reward amount — if the
// backend/admin allocation pipeline hasn't allocated a GAME reward for
// this wallet on-chain, claimableRaw is exactly 0.
//
// IMPORTANT — this file intentionally does NOT decide *when* a Game
// reward is allocated. That is a separate, not-yet-built concern: a
// server-side, rewardManager-authorized allocation flow that validates a
// completed run and calls allocateReward(seasonId, user, amount,
// RewardType.GAME) on the vault. See the repo audit notes / chat history
// for why that boundary is deliberately unimplemented until (a) an
// approved Game -> MPGR reward formula exists (see docs/REWARDS.md,
// which only states a Mini Games treasury budget, not a per-run rule)
// and (b) a persistent, server-side idempotency store exists (this repo
// currently has no database/KV — only client localStorage and two
// stateless AI-agent API routes). Allocating without both would either
// invent unapproved token economics or risk duplicate/forged payouts.
//
// Claiming a Game reward still only ever happens through the existing,
// isolated hooks/useRewardClaim.ts / <OnChainRewardsSection /> claim
// path — this provider is read-only and submits no transactions, exactly
// like staking-rewards-provider.ts.

const CATEGORY = "game" as const;

export const gameRewardsProvider: RewardProvider = {
  category: CATEGORY,
  label: REWARD_CATEGORY_METADATA[CATEGORY].label,

  async getSummary(address: Address): Promise<RewardCategorySummary> {
    const allRewards = await rewardVaultService.getWalletRewards(address);
    const gameRewards = allRewards.filter((r) => r.rewardType === VaultRewardType.GAME);

    const claimedRaw = gameRewards
      .filter((r) => r.status === VaultRewardStatus.CLAIMED)
      .reduce((sum, r) => sum + r.amount, 0n);

    // Claimable = ALLOCATED and the contract's own isRewardClaimable()
    // check agrees (mirrors hooks/useRewardClaim.ts's claimableRewards
    // filter exactly, so this summary can never disagree with what the
    // Claim button on this same page shows as claimable).
    const claimableRaw = gameRewards
      .filter((r) => r.status === VaultRewardStatus.ALLOCATED && r.isClaimable)
      .reduce((sum, r) => sum + r.amount, 0n);

    return {
      category: CATEGORY,
      label: REWARD_CATEGORY_METADATA[CATEGORY].label,
      isActive: true,
      totalEarnedRaw: claimedRaw + claimableRaw,
      claimedRaw,
      claimableRaw,
    };
  },

  // Per-claim history (with a timestamp) requires scanning RewardClaimed
  // event logs the same way lib/staking/staking-history-reader.ts /
  // staking-history-service.ts do for staking — there is no timestamp on
  // the vault's getReward() struct itself. That reader does not exist
  // yet for the Reward Vault and is deliberately not fabricated here
  // (no invented timestamps). Returning [] means Game claims simply
  // don't appear in the merged history feed yet; they still show up
  // correctly in getSummary() above and in <OnChainRewardsSection />,
  // which reads claimed status directly rather than a timestamped log.
  async getHistory(_address: Address, _limit?: number): Promise<RewardClaimHistoryEntry[]> {
    return [];
  },
};

