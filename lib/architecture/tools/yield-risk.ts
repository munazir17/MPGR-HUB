// lib/architecture/tools/yield-risk.ts
//
// P2 — Structured Risk Evaluation (requirement 5).
//
// Pure classification logic: every function here takes already-fetched
// facts (a pause flag, a freshness level, ...) and returns a
// YieldRiskLevel + reason — no I/O, no guessing at a signal this
// codebase has no source for. Per the spec: "Do not call anything 'safe'
// merely because a tool returned data" — notice `overallRisk` below
// never returns "low" unless every contributing factor was actually
// evaluated as low; a merely-successful read is not evidence of safety.

import type {
  DataFreshness,
  YieldRiskDimension,
  YieldRiskFactor,
  YieldRiskLevel,
} from "./yield-types";

const RISK_RANK: Record<YieldRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  unknown: -1,
};

/** No lock/cooldown on unstake reads as low liquidity risk. */
export function classifyLiquidityRisk(
  hasLock: boolean,
  hasCooldown: boolean
): YieldRiskFactor {
  if (hasLock || hasCooldown) {
    return {
      dimension: "liquidityRisk",
      level: "medium",
      reason: "Withdrawing requires waiting out a lock or cooldown period.",
    };
  }

  return {
    dimension: "liquidityRisk",
    level: "low",
    reason: "No lock or cooldown period — funds can be withdrawn at any time.",
  };
}

/**
 * No market-data provider exists in this codebase for MPGR price history,
 * so volatility cannot be honestly assessed.
 */
export function classifyVolatilityExposure(): YieldRiskFactor {
  return {
    dimension: "volatilityExposure",
    level: "unknown",
    reason:
      "No market-data provider exists in this codebase to read MPGR's price volatility.",
  };
}

/** Directly reflects the staking contract's pause state. */
export function classifyProtocolRisk(
  isPaused: boolean | null
): YieldRiskFactor {
  if (isPaused === null) {
    return {
      dimension: "protocolRisk",
      level: "unknown",
      reason: "Pause status could not be read from the contract.",
    };
  }

  if (isPaused) {
    return {
      dimension: "protocolRisk",
      level: "high",
      reason:
        "The staking contract is currently paused — new stakes cannot be submitted.",
    };
  }

  return {
    dimension: "protocolRisk",
    level: "low",
    reason: "The staking contract is not paused.",
  };
}

/**
 * No audit/security-review source exists in this application, so this
 * dimension must remain unknown rather than being guessed.
 */
export function classifySmartContractRisk(): YieldRiskFactor {
  return {
    dimension: "smartContractRisk",
    level: "unknown",
    reason:
      "No audit or security-review data source exists in this codebase.",
  };
}

/** Withdrawal penalty risk. */
export function classifyWithdrawalRisk(
  hasEarlyExitPenalty: boolean
): YieldRiskFactor {
  if (hasEarlyExitPenalty) {
    return {
      dimension: "withdrawalRisk",
      level: "medium",
      reason: "Withdrawing early carries a penalty.",
    };
  }

  return {
    dimension: "withdrawalRisk",
    level: "low",
    reason: "No early-withdrawal penalty.",
  };
}

/**
 * Compares the available reward pool with the rewards required to
 * maintain the current emission rate until periodFinish.
 */
export function classifyRewardSustainability(
  rewardPoolBalanceRaw: bigint | null,
  rewardRateRaw: bigint | null,
  periodFinish: bigint | null,
  nowSeconds: bigint
): YieldRiskFactor {
  if (
    rewardPoolBalanceRaw === null ||
    rewardRateRaw === null ||
    periodFinish === null
  ) {
    return {
      dimension: "rewardSustainability",
      level: "unknown",
      reason:
        "Reward pool balance, reward rate, or period-finish could not be read.",
    };
  }

  if (rewardRateRaw === 0n || periodFinish <= nowSeconds) {
    return {
      dimension: "rewardSustainability",
      level: "medium",
      reason:
        "The current reward period has ended or is emitting no rewards — rates may change when a new period is funded.",
    };
  }

  const secondsRemaining = periodFinish - nowSeconds;
  const requiredForRemainingPeriod =
    rewardRateRaw * secondsRemaining;

  if (rewardPoolBalanceRaw < requiredForRemainingPeriod) {
    return {
      dimension: "rewardSustainability",
      level: "medium",
      reason:
        "The reward pool balance is lower than the amount required to sustain the current reward rate through period end.",
    };
  }

  return {
    dimension: "rewardSustainability",
    level: "low",
    reason:
      "The reward pool balance covers the current reward rate through period end.",
  };
}

/**
 * Data quality is itself a risk signal.
 */
export function classifyDataQuality(
  worstFreshness: DataFreshness
): YieldRiskFactor {
  if (
    worstFreshness === "unavailable" ||
    worstFreshness === "unknown"
  ) {
    return {
      dimension: "dataQuality",
      level: "high",
      reason: `One or more required data points are ${worstFreshness}.`,
    };
  }

  if (worstFreshness === "stale") {
    return {
      dimension: "dataQuality",
      level: "medium",
      reason:
        "Some data points are stale (older than their normal refresh window).",
    };
  }

  return {
    dimension: "dataQuality",
    level: "low",
    reason: "All required data points are current.",
  };
}

/**
 * Returns the worst known risk level.
 *
 * Unknown dimensions are intentionally not converted into a severity.
 * If every dimension is unknown, the overall result is unknown rather
 * than incorrectly defaulting to low.
 */
export function overallYieldRisk(
  factors: readonly YieldRiskFactor[]
): YieldRiskLevel {
  const known = factors.filter(
    (factor) => factor.level !== "unknown"
  );

  if (known.length === 0) {
    return "unknown";
  }

  return known.reduce<YieldRiskLevel>(
    (worst, factor) =>
      RISK_RANK[factor.level] > RISK_RANK[worst]
        ? factor.level
        : worst,
    "low"
  );
}

export function buildYieldRiskDimensionList(): readonly YieldRiskDimension[] {
  return [
    "liquidityRisk",
    "volatilityExposure",
    "protocolRisk",
    "smartContractRisk",
    "withdrawalRisk",
    "rewardSustainability",
    "dataQuality",
  ];
}
