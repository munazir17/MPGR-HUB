import { getLevelProgress, type UserXPRecord } from "@/lib/xp-engine";
import type { PremiumStatus } from "@/lib/premium-engine";
import type { HolderTierStatus } from "@/lib/holder-tier-engine";
import type { SeasonPassStatus } from "@/lib/season-engine";

// Phase 3A.2 — MPGR Agent Intelligence Layer, context layer.
//
// This module has exactly one job: turn the app's existing hook state into
// a plain, serializable snapshot (`AgentContext`) that lib/agent-intelligence.ts
// can read from. It never calls a hook itself (it's not a hook, so it
// can't) — hooks/useAgentChat.ts is the only place that calls useXP,
// useRewards, useStaking, useTokenLock, usePremium, useHolderTier, and
// useSeasonPass, then hands their results in here. That keeps this file
// pure and trivially testable, and keeps React's hook rules intact.
//
// Every field here traces back to a real value already computed elsewhere
// in the app (xp-engine, premium-engine, holder-tier-engine, season-engine,
// staking-engine, token-lock-engine, rewards-engine) — nothing is
// invented or estimated here.

export interface AgentXPContext {
  xp: number;
  level: number;
  nextLevel: number;
  xpIntoLevel: number;
  xpNeededForLevel: number;
  progress: number;
  streak: number;
  referralCount: number;
}

export interface AgentPortfolioContext {
  walletBalance: number;
  stakedBalance: number;
  lockedBalance: number;
  totalHoldings: number;
  claimableRewards: number;
}

export interface AgentPremiumContext {
  isPremium: boolean;
  tierLabel: string;
  xpMultiplier: number;
  rewardsMultiplier: number;
  nextTierLabel: string | null;
  progressToNextTier: number;
  amountToNextTier: number;
}

export interface AgentHolderTierContext {
  tierLabel: string | null;
  totalScore: number;
  nextTierLabel: string | null;
  progressToNextTier: number;
  amountToNextTier: number;
  votingWeight: number;
  reputationScore: number;
}

export interface AgentStakingContext {
  totalStaked: number;
  claimableRewards: number;
  activePositionsCount: number;
}

export interface AgentLockContext {
  totalLocked: number;
  activeLocksCount: number;
  upcomingUnlockAt: string | null;
}

export interface AgentSeasonContext {
  seasonNumber: number;
  seasonPoints: number;
  level: number;
  progress: number;
}

export interface AgentRewardsContext {
  claimableTotal: number;
  totalClaimed: number;
}

export interface AgentContext {
  isConnected: boolean;
  xp: AgentXPContext | null;
  portfolio: AgentPortfolioContext | null;
  premium: AgentPremiumContext | null;
  holderTier: AgentHolderTierContext | null;
  staking: AgentStakingContext | null;
  tokenLock: AgentLockContext | null;
  season: AgentSeasonContext | null;
  rewards: AgentRewardsContext | null;
}

export interface BuildAgentContextInput {
  isConnected: boolean;
  xpRecord: UserXPRecord | null;
  premiumStatus: PremiumStatus | null;
  holderTierStatus: HolderTierStatus | null;
  seasonStatus: SeasonPassStatus | null;
  staking: {
    totalStaked: number;
    totalClaimableRewards: number;
    activePositionsCount: number;
  };
  tokenLock: {
    totalLocked: number;
    activeLocksCount: number;
    upcomingUnlockAt: string | null;
  };
  rewards: {
    claimableTotal: number;
    totalClaimed: number;
  };
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  const { isConnected, xpRecord, premiumStatus, holderTierStatus, seasonStatus, staking, tokenLock, rewards } =
    input;

  const xp: AgentXPContext | null = xpRecord
    ? (() => {
        const levelInfo = getLevelProgress(xpRecord.xp);
        return {
          xp: xpRecord.xp,
          level: levelInfo.level,
          nextLevel: levelInfo.nextLevel,
          xpIntoLevel: levelInfo.xpIntoLevel,
          xpNeededForLevel: levelInfo.xpNeededForLevel,
          progress: levelInfo.progress,
          streak: xpRecord.streak,
          referralCount: xpRecord.referralCount,
        };
      })()
    : null;

  // Wallet/staked/locked figures are read from Holder Tier's score
  // breakdown rather than re-derived here, since that's already the one
  // place in the app that aggregates wallet + staked + locked MPGR
  // (lib/holder-score-providers.ts) — avoids a second, possibly
  // inconsistent calculation.
  const portfolio: AgentPortfolioContext | null = holderTierStatus
    ? {
        walletBalance: holderTierStatus.score.walletBalance,
        stakedBalance: holderTierStatus.score.stakedBalance,
        lockedBalance: holderTierStatus.score.lockedBalance,
        totalHoldings: holderTierStatus.score.totalScore,
        claimableRewards: rewards.claimableTotal,
      }
    : null;

  const premium: AgentPremiumContext | null = premiumStatus
    ? {
        isPremium: premiumStatus.isPremium,
        tierLabel: premiumStatus.currentTierDef?.label ?? "Free",
        xpMultiplier: premiumStatus.xpMultiplier,
        rewardsMultiplier: premiumStatus.rewardsMultiplier,
        nextTierLabel: premiumStatus.nextTierDef?.label ?? null,
        progressToNextTier: premiumStatus.progressToNextTier,
        amountToNextTier: premiumStatus.amountToNextTier,
      }
    : null;

  const holderTier: AgentHolderTierContext | null = holderTierStatus
    ? {
        tierLabel: holderTierStatus.currentTierDef?.label ?? null,
        totalScore: holderTierStatus.score.totalScore,
        nextTierLabel: holderTierStatus.nextTierDef?.label ?? null,
        progressToNextTier: holderTierStatus.progressToNextTier,
        amountToNextTier: holderTierStatus.amountToNextTier,
        votingWeight: holderTierStatus.votingWeight,
        reputationScore: holderTierStatus.communityReputationScore,
      }
    : null;

  const stakingCtx: AgentStakingContext | null = isConnected
    ? {
        totalStaked: staking.totalStaked,
        claimableRewards: staking.totalClaimableRewards,
        activePositionsCount: staking.activePositionsCount,
      }
    : null;

  const tokenLockCtx: AgentLockContext | null = isConnected
    ? {
        totalLocked: tokenLock.totalLocked,
        activeLocksCount: tokenLock.activeLocksCount,
        upcomingUnlockAt: tokenLock.upcomingUnlockAt,
      }
    : null;

  const season: AgentSeasonContext | null = seasonStatus
    ? {
        seasonNumber: seasonStatus.seasonNumber,
        seasonPoints: seasonStatus.seasonPoints,
        level: seasonStatus.levelProgress.level,
        progress: seasonStatus.levelProgress.progress,
      }
    : null;

  const rewardsCtx: AgentRewardsContext | null = isConnected
    ? { claimableTotal: rewards.claimableTotal, totalClaimed: rewards.totalClaimed }
    : null;

  return {
    isConnected,
    xp,
    portfolio,
    premium,
    holderTier,
    staking: stakingCtx,
    tokenLock: tokenLockCtx,
    season,
    rewards: rewardsCtx,
  };
}
