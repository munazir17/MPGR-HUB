// lib/architecture/tools/yield-opportunity-service.ts
//
// P2 — Intelligence + Yield.
// Normalizes real MPGR Staking on-chain data into YieldOpportunity.
// Read-only only: no wallet, no signing, no transaction execution.

import { base } from "wagmi/chains";
import { formatUnits } from "viem";

import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { stakingService } from "@/lib/staking/staking-service";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

import { bpsToPercentString } from "./yield-math";
import {
  classifyDataQuality,
  classifyLiquidityRisk,
  classifyProtocolRisk,
  classifyRewardSustainability,
  classifySmartContractRisk,
  classifyVolatilityExposure,
  classifyWithdrawalRisk,
  overallYieldRisk,
} from "./yield-risk";
import type {
  DataFreshness,
  NormalizedFact,
  YieldOpportunity,
} from "./yield-types";

export const MPGR_STAKING_OPPORTUNITY_ID = "mpgr-staking";

function classifyFreshness(
  ageMs: number,
  ttlMs: number
): DataFreshness {
  if (ageMs < 0) return "current";
  return ageMs <= ttlMs ? "current" : "stale";
}

function fact<T>(
  value: T | null,
  opts: {
    source: string;
    observedAt: string;
    freshness: DataFreshness;
  }
): NormalizedFact<T> {
  return {
    value,
    source: opts.source,
    observedAt: opts.observedAt,
    freshness: opts.freshness,
    confidence:
      value === null
        ? "unknown"
        : opts.freshness === "current"
          ? "high"
          : "medium",
  };
}

export async function getYieldOpportunities(): Promise<
  YieldOpportunity[]
> {
  const source =
    "lib/staking/staking-service (cached reads of the deployed MPGRStaking contract)";

  let observedAt = new Date().toISOString();
  let freshness: DataFreshness = "unavailable";

  let totalStaked: bigint | null = null;
  let rewardPoolBalance: bigint | null = null;
  let currentAPRBps: bigint | null = null;
  let rewardRate: bigint | null = null;
  let periodFinish: bigint | null = null;
  let isPaused: boolean | null = null;
  let minimumStake: bigint | null = null;

  try {
    const {
      state,
      observedAt: at,
      ageMs,
      ttlMs,
    } = await stakingService.getGlobalStateWithMeta();

    observedAt = at;
    freshness = classifyFreshness(ageMs, ttlMs);

    totalStaked = state.totalStaked;
    rewardPoolBalance = state.rewardPoolBalance;
    currentAPRBps = state.currentAPRBps;
    rewardRate = state.rewardRate;
    periodFinish = state.periodFinish;
    isPaused = state.isPaused;
    minimumStake = state.minimumStake;
  } catch (err) {
    // Provider details stay server-side and are never exposed to users.
    console.error(
      "yield-opportunity-service: failed to read staking global state",
      err
    );
  }

  const nowSeconds = BigInt(
    Math.floor(Date.now() / 1000)
  );

  const liquidity = classifyLiquidityRisk(false, false);

  const volatility = classifyVolatilityExposure();

  const protocol = classifyProtocolRisk(isPaused);

  const smartContract = classifySmartContractRisk();

  const withdrawal = classifyWithdrawalRisk(false);

  const rewardSustainability =
    classifyRewardSustainability(
      rewardPoolBalance,
      rewardRate,
      periodFinish,
      nowSeconds
    );

  const dataQuality = classifyDataQuality(freshness);

  const factors = [
    liquidity,
    volatility,
    protocol,
    smartContract,
    withdrawal,
    rewardSustainability,
    dataQuality,
  ];

  const opportunity: YieldOpportunity = {
    id: MPGR_STAKING_OPPORTUNITY_ID,
    asset: MPGR_TOKEN_CONFIG.symbol,
    protocol: "MPGR Staking",
    chainId: base.id,
    contractAddress: MPGR_STAKING_CONFIG.address,

    aprBps: fact(
      currentAPRBps?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    aprPercent: fact(
      currentAPRBps !== null
        ? bpsToPercentString(currentAPRBps)
        : null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    totalStakedRaw: fact(
      totalStaked?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    totalStakedFormatted: fact(
      totalStaked !== null
        ? formatUnits(
            totalStaked,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    tvlNote:
      "Denominated in MPGR only — no USD price provider is wired into this codebase.",

    rewardPoolBalanceRaw: fact(
      rewardPoolBalance?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    rewardPoolBalanceFormatted: fact(
      rewardPoolBalance !== null
        ? formatUnits(
            rewardPoolBalance,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    rewardPeriodFinish: fact(
      periodFinish?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    rewardRateRaw: fact(
      rewardRate?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    isPaused: fact(isPaused, {
      source,
      observedAt,
      freshness,
    }),

    minimumStakeRaw: fact(
      minimumStake?.toString() ?? null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    minimumStakeFormatted: fact(
      minimumStake !== null
        ? formatUnits(
            minimumStake,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      {
        source,
        observedAt,
        freshness,
      }
    ),

    fees: {
      known: false,
      note:
        "The deployed MPGRStaking contract exposes no fee getter — no stake/unstake/claim fee is known to exist.",
    },

    lockConditions: {
      hasLock: false,
      hasCooldown: false,
      note:
        "unstake() has no lock term or cooldown — staked MPGR can be withdrawn at any time.",
    },

    risk: {
      overall: overallYieldRisk(factors),
      factors,
    },

    overallFreshness: freshness,

    overallConfidence:
      currentAPRBps === null
        ? "unknown"
        : freshness === "current"
          ? "high"
          : "medium",
  };

  return [opportunity];
}

export async function getYieldOpportunityById(
  id: string
): Promise<YieldOpportunity | null> {
  const opportunities = await getYieldOpportunities();

  return (
    opportunities.find(
      (opportunity) => opportunity.id === id
    ) ?? null
  );
}

export function getKnownYieldOpportunityIds(): string[] {
  return [MPGR_STAKING_OPPORTUNITY_ID];
}
