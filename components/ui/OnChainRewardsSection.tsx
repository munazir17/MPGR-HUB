"use client";

import { ExternalLink, Loader2, AlertCircle, Gift } from "lucide-react";
import { formatUnits } from "viem";
import { GlassCard } from "./GlassCard";
import { SectionHeader } from "./SectionHeader";
import { EmptyState } from "./EmptyState";
import { SkeletonCard } from "./SkeletonCard";
import { RewardClaimCard } from "./RewardClaimCard";
import { useRewardClaim } from "@/hooks/useRewardClaim";
import { VaultRewardStatus, VaultRewardType, type VaultReward } from "@/lib/reward-vault/reward-vault-types";
import type { RewardClaim, RewardSource } from "@/lib/rewards-engine";

// Reward Vault Integration — On-Chain Rewards section.
//
// Self-contained, additive section powered entirely by the real deployed
// MPGRRewardVault contract on Base Mainnet via hooks/useRewardClaim.ts.
// Does not read from or write into hooks/useRewards.ts, lib/rewards-
// engine.ts, or hooks/useRewardHub.ts — the existing local check-in/
// streak/level claim grid and its "Claim All" button are completely
// unaffected by anything in this file.
//
// Reuses the existing RewardClaimCard UI (no redesign) by adapting each
// on-chain VaultReward into the same RewardClaim shape the local system
// already renders. On-chain rewards have no partial-progress concept —
// a reward is either ALLOCATED or CLAIMED — so progress/target are
// always 1/1 rather than being fabricated.

const REWARD_TYPE_TO_SOURCE: Record<VaultRewardType, RewardSource> = {
  [VaultRewardType.GAME]: "GAME",
  [VaultRewardType.QUEST]: "QUEST",
  [VaultRewardType.WEEKLY]: "WEEKLY",
  [VaultRewardType.SEASON]: "SEASON",
  [VaultRewardType.REFERRAL]: "REFERRAL",
  [VaultRewardType.BONUS]: "BONUS",
};

const REWARD_TYPE_TO_TITLE: Record<VaultRewardType, string> = {
  [VaultRewardType.GAME]: "Game Reward",
  [VaultRewardType.QUEST]: "Quest Reward",
  [VaultRewardType.WEEKLY]: "Weekly Reward",
  [VaultRewardType.SEASON]: "Season Reward",
  [VaultRewardType.REFERRAL]: "Referral Reward",
  [VaultRewardType.BONUS]: "Bonus Reward",
};

function toRewardClaim(reward: VaultReward, decimals: number): RewardClaim {
  const amount = parseFloat(formatUnits(reward.amount, decimals));
  const claimed = reward.status === VaultRewardStatus.CLAIMED;
  const unlocked = reward.status === VaultRewardStatus.ALLOCATED && reward.isClaimable;

  return {
    id: `vault-${reward.rewardId.toString()}`,
    source: REWARD_TYPE_TO_SOURCE[reward.rewardType],
    title: REWARD_TYPE_TO_TITLE[reward.rewardType],
    description: `Season ${reward.seasonId.toString()} · Reward #${reward.rewardId.toString()}`,
    amount,
    unlocked: unlocked || claimed,
    claimed,
    progress: unlocked || claimed ? 1 : 0,
    target: 1,
  };
}

export function OnChainRewardsSection() {
  const {
    isConnected,
    isWrongNetwork,
    isSwitchingChain,
    switchToBase,
    rewards,
    claimableRewards,
    claimedRewards,
    claimableAmount,
    decimals,
    isLoading,
    isClaiming,
    readError,
    error,
    txHash,
    claim,
    claimMultiple,
    getActionState,
  } = useRewardClaim();

  if (!isConnected) return null;

  const explorerUrl = txHash ? `https://basescan.org/tx/${txHash}` : null;

  return (
    <div>
      <SectionHeader
        title="On-Chain Rewards"
        subtitle="Real MPGR rewards allocated to your wallet in the Reward Vault on Base"
      />

      {isWrongNetwork ? (
        <GlassCard className="flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="text-sm font-medium text-white">Switch to Base to view your rewards</p>
            <p className="mt-1 text-xs text-muted">The Reward Vault only exists on Base Mainnet.</p>
          </div>
          <button
            onClick={() => switchToBase()}
            disabled={isSwitchingChain}
            className="flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-gold px-5 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSwitchingChain ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Switch to Base
          </button>
        </GlassCard>
      ) : (
        <div className="space-y-4">
          {readError && (
            <div className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 text-xs text-red-400 backdrop-blur-xl">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {readError}
            </div>
          )}

          {isLoading ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
            </div>
          ) : rewards.length === 0 ? (
            <EmptyState
              icon={Gift}
              title="No on-chain rewards yet"
              description="Rewards allocated to your wallet by MPGR HUB will appear here."
            />
          ) : (
            <>
              <GlassCard className="flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
                <div>
                  <p className="text-sm font-medium text-white">
                    {claimableRewards.length > 0
                      ? `${claimableRewards.length} on-chain reward${claimableRewards.length > 1 ? "s" : ""} ready · ${claimableAmount} MPGR`
                      : "No on-chain rewards ready yet"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Claims are real Base Mainnet transactions — MPGR is sent directly to your wallet.
                  </p>
                </div>
                {claimableRewards.length > 1 && (
                  <button
                    onClick={() => claimMultiple(claimableRewards.map((r) => r.rewardId))}
                    disabled={isClaiming}
                    className="flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-gold px-5 py-2.5 text-sm font-semibold text-background transition-colors disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted sm:w-auto"
                  >
                    {isClaiming ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Claiming All
                      </>
                    ) : (
                      "Claim All On-Chain"
                    )}
                  </button>
                )}
              </GlassCard>

              {error && (
                <div className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 text-xs text-red-400 backdrop-blur-xl">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {error}
                </div>
              )}

              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-gold hover:underline"
                >
                  View last transaction on BaseScan <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[...claimableRewards, ...claimedRewards].map((reward) => {
                  const actionState = getActionState(reward.rewardId.toString());
                  return (
                    <RewardClaimCard
                      key={reward.rewardId.toString()}
                      reward={toRewardClaim(reward, decimals)}
                      onClaim={() => claim(reward.rewardId)}
                      claiming={
                        actionState.phase === "simulating" ||
                        actionState.phase === "pending" ||
                        actionState.phase === "confirming"
                      }
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
