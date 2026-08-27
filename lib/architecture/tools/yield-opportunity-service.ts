// lib/architecture/tools/yield-opportunity-service.ts
//
// P2 — Intelligence + Yield.
// Normalizes real MPGR Staking on-chain data into YieldOpportunity.
//
// READ-ONLY ONLY:
// - No wallet
// - No signing
// - No transaction execution
// - Reuses the existing stakingService.getGlobalState()
// - Never fabricates unavailable yield data

import { formatUnits } from "viem";
import { base } from "wagmi/chains";

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

const STAKING_SOURCE =
  "lib/staking/staking-service (getGlobalState)";

function fact<T>(
  value: T | null,
  observedAt: string,
  freshness: DataFreshness
): NormalizedFact<T> {
  return {
    value,
    source: STAKING_SOURCE,
    observedAt,
    freshness,
    confidence:
      value === null
        ? "unknown"
        : freshness === "current"
          ? "high"
          : freshness === "stale"
            ? "medium"
            : "unknown",
  };
}

/**
 * The existing stakingService exposes getGlobalState(), but it does not
 * expose cache age/TTL metadata. Therefore P2 does not invent a cache
 * freshness value.
 *
 * A successful getGlobalState() read is treated as "current" for the
 * purpose of this tool call because the service itself performed the
 * underlying read/cache resolution immediately before normalization.
 *
 * If the read fails, every dependent fact becomes "unavailable".
 */
export async function getYieldOpportunities(): Promise<
  YieldOpportunity[]
> {
  const observedAt = new Date().toISOString();

  let freshness: DataFreshness = "current";

  let totalStaked: bigint | null = null;
  let rewardPoolBalance: bigint | null = null;
  let currentAPRBps: bigint | null = null;
  let rewardRate: bigint | null = null;
  let periodFinish: bigint | null = null;
  let isPaused: boolean | null = null;
  let minimumStake: bigint | null = null;

  try {
    const state = await stakingService.getGlobalState();

    totalStaked = state.totalStaked;
    rewardPoolBalance = state.rewardPoolBalance;
    currentAPRBps = state.currentAPRBps;
    rewardRate = state.rewardRate;
    periodFinish = state.periodFinish;
    isPaused = state.isPaused;
    minimumStake = state.minimumStake;
  } catch (error) {
    freshness = "unavailable";

    // Provider/RPC details are intentionally not exposed to the user.
    console.error(
      "yield-opportunity-service: failed to read staking global state",
      error
    );
  }

  const effectiveFreshness =
    freshness === "unavailable"
      ? "unavailable"
      : "current";

  const nowSeconds = BigInt(
    Math.floor(Date.now() / 1000)
  );

  const liquidityRisk = classifyLiquidityRisk(
    false,
    false
  );

  const volatilityRisk =
    classifyVolatilityExposure();

  const protocolRisk =
    classifyProtocolRisk(isPaused);

  const smartContractRisk =
    classifySmartContractRisk();

  const withdrawalRisk =
    classifyWithdrawalRisk(false);

  const rewardSustainabilityRisk =
    classifyRewardSustainability(
      rewardPoolBalance,
      rewardRate,
      periodFinish,
      nowSeconds
    );

  const dataQualityRisk =
    classifyDataQuality(effectiveFreshness);

  const factors = [
    liquidityRisk,
    volatilityRisk,
    protocolRisk,
    smartContractRisk,
    withdrawalRisk,
    rewardSustainabilityRisk,
    dataQualityRisk,
  ];

  const opportunity: YieldOpportunity = {
    id: MPGR_STAKING_OPPORTUNITY_ID,

    asset: MPGR_TOKEN_CONFIG.symbol,

    protocol: "MPGR Staking",

    chainId: base.id,

    contractAddress: MPGR_STAKING_CONFIG.address,

    aprBps: fact(
      currentAPRBps?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    aprPercent: fact(
      currentAPRBps !== null
        ? bpsToPercentString(currentAPRBps)
        : null,
      observedAt,
      effectiveFreshness
    ),

    totalStakedRaw: fact(
      totalStaked?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    totalStakedFormatted: fact(
      totalStaked !== null
        ? formatUnits(
            totalStaked,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      observedAt,
      effectiveFreshness
    ),

    tvlNote:
      "TVL is denominated in MPGR only. No USD price provider is wired into this yield-analysis layer.",

    rewardPoolBalanceRaw: fact(
      rewardPoolBalance?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    rewardPoolBalanceFormatted: fact(
      rewardPoolBalance !== null
        ? formatUnits(
            rewardPoolBalance,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      observedAt,
      effectiveFreshness
    ),

    rewardPeriodFinish: fact(
      periodFinish?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    rewardRateRaw: fact(
      rewardRate?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    isPaused: fact(
      isPaused,
      observedAt,
      effectiveFreshness
    ),

    minimumStakeRaw: fact(
      minimumStake?.toString() ?? null,
      observedAt,
      effectiveFreshness
    ),

    minimumStakeFormatted: fact(
      minimumStake !== null
        ? formatUnits(
            minimumStake,
            MPGR_TOKEN_CONFIG.decimals
          )
        : null,
      observedAt,
      effectiveFreshness
    ),

    fees: {
      known: false,
      note:
        "The deployed MPGRStaking contract exposes no fee getter, so no staking fee is represented as a known value.",
    },

    lockConditions: {
      hasLock: false,
      hasCooldown: false,
      note:
        "MPGRStaking unstake() has no lock term or cooldown; staked MPGR can be withdrawn without a protocol-imposed waiting period.",
    },

    risk: {
      overall: overallYieldRisk(factors),
      factors,
    },

    overallFreshness: effectiveFreshness,

    overallConfidence:
      currentAPRBps === null
        ? "unknown"
        : effectiveFreshness === "current"
          ? "high"
          : "unknown",
  };

  return [opportunity];
}

export async function getYieldOpportunityById(
  id: string
): Promise<YieldOpportunity | null> {
  const opportunities =
    await getYieldOpportunities();

  return (
    opportunities.find(
      (opportunity) =>
        opportunity.id === id
    ) ?? null
  );
}

export function getKnownYieldOpportunityIds(): string[] {
  return [MPGR_STAKING_OPPORTUNITY_ID];
}
