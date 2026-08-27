// lib/architecture/tools/yield-types.ts
//
// P2 — Intelligence + Yield. Shared normalized types for every P2
// read-only tool (yield-data-service.ts, yield-math.ts, yield-risk.ts,
// p2-tool-definitions.ts).
//
// Why a new file rather than extending agent-tool-result.ts: that file's
// AgentToolResultMetadata is the envelope AgentToolRuntime attaches to
// EVERY tool result (P0.1-P0.2 and P2 alike) and is deliberately generic
// (source/timestamp/chainId/blockNumber). What's defined here is
// domain-specific to yield analysis — a single tool call can report
// freshness/confidence per-fact (e.g. "APR is current" but "TVL in USD
// is unknown" in the same response), which a single top-level
// metadata.source/timestamp cannot express. These types are the payload
// (AgentToolResult.data), never a replacement for the envelope.
//
// Every numeric on-chain amount here is carried as a decimal string
// (never `number`) — the same convention tool-definitions.ts already
// uses for raw/formatted balances — so nothing here re-introduces
// floating-point error for a token amount. See yield-math.ts for the
// bigint arithmetic that produces these strings.

// --- Freshness -----------------------------------------------------------

export const DATA_FRESHNESS_LEVELS = [
  "current",
  "stale",
  "unavailable",
  "unknown",
] as const;

export type DataFreshness = (typeof DATA_FRESHNESS_LEVELS)[number];

// --- Confidence ------------------------------------------------------------

export const CONFIDENCE_LEVELS = [
  "high",
  "medium",
  "low",
  "unknown",
] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

// --- Risk --------------------------------------------------------------

export const YIELD_RISK_LEVELS = [
  "low",
  "medium",
  "high",
  "unknown",
] as const;

export type YieldRiskLevel = (typeof YIELD_RISK_LEVELS)[number];

export const YIELD_RISK_DIMENSIONS = [
  "liquidityRisk",
  "volatilityExposure",
  "protocolRisk",
  "smartContractRisk",
  "withdrawalRisk",
  "rewardSustainability",
  "dataQuality",
] as const;

export type YieldRiskDimension = (typeof YIELD_RISK_DIMENSIONS)[number];

export interface YieldRiskFactor {
  dimension: YieldRiskDimension;
  level: YieldRiskLevel;
  reason: string;
}

export interface YieldRiskAssessment {
  overall: YieldRiskLevel;
  factors: YieldRiskFactor[];
}

// --- A single normalized fact -------------------------------------------

export interface NormalizedFact<T> {
  value: T | null;
  source: string;
  observedAt: string;
  blockNumber?: number;
  freshness: DataFreshness;
  confidence: ConfidenceLevel;
}

// --- Yield opportunity -----------------------------------------------------

export interface YieldOpportunity {
  id: string;
  asset: string;
  protocol: string;
  chainId: number;
  contractAddress: string;

  aprBps: NormalizedFact<string>;
  aprPercent: NormalizedFact<string>;

  totalStakedRaw: NormalizedFact<string>;
  totalStakedFormatted: NormalizedFact<string>;

  tvlNote: string;

  rewardPoolBalanceRaw: NormalizedFact<string>;
  rewardPoolBalanceFormatted: NormalizedFact<string>;
  rewardPeriodFinish: NormalizedFact<string>;
  rewardRateRaw: NormalizedFact<string>;

  isPaused: NormalizedFact<boolean>;
  minimumStakeRaw: NormalizedFact<string>;
  minimumStakeFormatted: NormalizedFact<string>;

  fees: {
    known: false;
    note: string;
  };

  lockConditions: {
    hasLock: boolean;
    hasCooldown: boolean;
    note: string;
  };

  risk: YieldRiskAssessment;

  overallFreshness: DataFreshness;
  overallConfidence: ConfidenceLevel;
}

// --- Deterministic calculation output ------------------------------------

export interface YieldProjection {
  opportunityId: string;
  principalRaw: string;
  principalFormatted: string;
  durationDays: number;
  aprBpsUsed: string;
  aprPercentUsed: string;
  estimatedGrossRewardRaw: string;
  estimatedGrossRewardFormatted: string;
  estimatedNetRewardRaw: string;
  estimatedNetRewardFormatted: string;
  feesApplied: boolean;
  method: "linear_apr_bps";
  assumptions: string[];
  disclaimer: string;
}

export interface YieldComparisonEntry {
  opportunityId: string;
  asset: string;
  protocol: string;
  aprPercent: string | null;
  risk: YieldRiskLevel;
  freshness: DataFreshness;
  confidence: ConfidenceLevel;
}

export interface YieldComparisonResult {
  entries: YieldComparisonEntry[];
  rankedBy: "aprPercent";
  note: string;
  disclaimer: string;
}

export const YIELD_ESTIMATE_DISCLAIMER =
  "This is an estimate based on the current on-chain APR and does not account for future rate changes, reward pool depletion, or protocol pauses. It is not a guaranteed return.";

export const YIELD_COMPARISON_DISCLAIMER =
  "Ranking reflects the current on-chain APR snapshot only. It is not investment advice and is not a guarantee of future performance.";
