// lib/architecture/tools/p2-tool-definitions.ts
//
// P2 — Intelligence + Yield.
// Read-only yield/research/analysis tools.
// No wallet signing, transaction preparation, or transaction execution.

import { formatUnits } from "viem";

import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";
import {
  getKnownYieldOpportunityIds,
  getYieldOpportunities,
  getYieldOpportunityById,
} from "./yield-opportunity-service";
import {
  estimateLinearAprReward,
  parseTokenAmount,
  rankByAprDescending,
  YieldMathInputError,
} from "./yield-math";
import type {
  YieldComparisonEntry,
  YieldComparisonResult,
  YieldProjection,
} from "./yield-types";
import {
  YIELD_COMPARISON_DISCLAIMER,
  YIELD_ESTIMATE_DISCLAIMER,
} from "./yield-types";

// =============================================================================
// 1. yield_opportunities
// =============================================================================

const yieldOpportunitiesSchema: AgentToolSchema = {
  type: "object",
  properties: {
    opportunityId: {
      type: "string",
      description:
        'Optional. Filter to a known opportunity id, currently "mpgr-staking".',
    },
  },
};

export const yieldOpportunitiesTool: AgentTool = {
  id: "yield_opportunities",
  name: "Yield Opportunities",
  description:
    "Lists real on-chain yield opportunities in the MPGR ecosystem with APR, TVL in MPGR, reward-pool health, pause status, lock and fee conditions, structured risk, freshness, and confidence. Unknown data is never fabricated.",
  category: "defi",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: yieldOpportunitiesSchema,

  async execute(input) {
    const { opportunityId } = (input ?? {}) as {
      opportunityId?: unknown;
    };

    if (
      opportunityId !== undefined &&
      typeof opportunityId !== "string"
    ) {
      return toolError("yield_opportunities", {
        code: "INVALID_INPUT",
        message: "opportunityId must be a string if provided.",
      });
    }

    if (typeof opportunityId === "string") {
      const knownIds = getKnownYieldOpportunityIds();

      if (!knownIds.includes(opportunityId)) {
        return toolError("yield_opportunities", {
          code: "DATA_UNAVAILABLE",
          message: `Unknown opportunity id. Known ids: ${knownIds.join(", ")}.`,
        });
      }

      const opportunity =
        await getYieldOpportunityById(opportunityId);

      return toolSuccess(
        "yield_opportunities",
        {
          opportunities: opportunity ? [opportunity] : [],
        },
        {
          source:
            "lib/staking/staking-service (via yield-opportunity-service)",
        }
      );
    }

    const opportunities = await getYieldOpportunities();

    return toolSuccess(
      "yield_opportunities",
      { opportunities },
      {
        source:
          "lib/staking/staking-service (via yield-opportunity-service)",
      }
    );
  },
};

// =============================================================================
// 2. yield_estimator
// =============================================================================

const yieldEstimatorSchema: AgentToolSchema = {
  type: "object",
  properties: {
    opportunityId: {
      type: "string",
      description:
        'Known opportunity id. Currently "mpgr-staking".',
      enum: getKnownYieldOpportunityIds(),
    },
    amount: {
      type: "string",
      description:
        'Decimal MPGR amount, for example "1000" or "2500.5".',
    },
    durationDays: {
      type: "number",
      description:
        "Projection duration in days. Must be non-negative.",
    },
  },
  required: ["opportunityId", "amount", "durationDays"],
};

export const yieldEstimatorTool: AgentTool = {
  id: "yield_estimator",
  name: "Yield Estimator",
  description:
    "Deterministically estimates staking rewards for an MPGR amount and duration using the current on-chain APR. Uses precision-safe bigint arithmetic and always includes assumptions and a non-guarantee disclaimer.",
  category: "defi",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: yieldEstimatorSchema,

  async execute(input) {
    const { opportunityId, amount, durationDays } =
      (input ?? {}) as {
        opportunityId?: unknown;
        amount?: unknown;
        durationDays?: unknown;
      };

    const knownIds = getKnownYieldOpportunityIds();

    if (
      typeof opportunityId !== "string" ||
      !knownIds.includes(opportunityId)
    ) {
      return toolError("yield_estimator", {
        code: "INVALID_INPUT",
        message: `opportunityId must be one of: ${knownIds.join(", ")}.`,
      });
    }

    if (typeof amount !== "string") {
      return toolError("yield_estimator", {
        code: "INVALID_INPUT",
        message: "amount must be a decimal string.",
      });
    }

    if (
      typeof durationDays !== "number" ||
      !Number.isFinite(durationDays) ||
      durationDays < 0
    ) {
      return toolError("yield_estimator", {
        code: "INVALID_INPUT",
        message:
          "durationDays must be a non-negative finite number.",
      });
    }

    let principalRaw: bigint;

    try {
      principalRaw = parseTokenAmount(
        amount,
        MPGR_TOKEN_CONFIG.decimals
      );
    } catch (error) {
      return toolError("yield_estimator", {
        code: "INVALID_INPUT",
        message:
          error instanceof YieldMathInputError
            ? error.message
            : "amount could not be parsed.",
      });
    }

    const opportunity =
      await getYieldOpportunityById(opportunityId);

    if (
      !opportunity ||
      opportunity.aprBps.value === null ||
      opportunity.aprPercent.value === null
    ) {
      return toolError(
        "yield_estimator",
        {
          code: "DATA_UNAVAILABLE",
          message:
            "The current on-chain APR is unavailable, so no reward projection can be computed right now.",
          retryable: true,
        },
        {
          source:
            "lib/staking/staking-service (via yield-opportunity-service)",
        }
      );
    }

    const aprBps = BigInt(opportunity.aprBps.value);

    const { estimatedRewardRaw } =
      estimateLinearAprReward(
        principalRaw,
        aprBps,
        durationDays
      );

    const projection: YieldProjection = {
      opportunityId,
      principalRaw: principalRaw.toString(),
      principalFormatted: formatUnits(
        principalRaw,
        MPGR_TOKEN_CONFIG.decimals
      ),
      durationDays,
      aprBpsUsed: opportunity.aprBps.value,
      aprPercentUsed: opportunity.aprPercent.value,

      estimatedGrossRewardRaw:
        estimatedRewardRaw.toString(),

      estimatedGrossRewardFormatted: formatUnits(
        estimatedRewardRaw,
        MPGR_TOKEN_CONFIG.decimals
      ),

      estimatedNetRewardRaw:
        estimatedRewardRaw.toString(),

      estimatedNetRewardFormatted: formatUnits(
        estimatedRewardRaw,
        MPGR_TOKEN_CONFIG.decimals
      ),

      feesApplied: false,
      method: "linear_apr_bps",

      assumptions: [
        "Assumes the current on-chain APR remains constant for the full duration.",
        "Uses a linear, non-compounding projection.",
        "Assumes the reward pool remains sufficiently funded.",
        "Assumes the staking contract remains operational and unpaused.",
        opportunity.overallFreshness === "current"
          ? "The APR was read from current cached on-chain data."
          : `The APR data was classified as ${opportunity.overallFreshness}.`,
      ],

      disclaimer: YIELD_ESTIMATE_DISCLAIMER,
    };

    return toolSuccess(
      "yield_estimator",
      projection,
      {
        source:
          "yield-math.ts (deterministic) + lib/staking/staking-service",
      }
    );
  },
};

// =============================================================================
// 3. yield_comparison
// =============================================================================

const yieldComparisonSchema: AgentToolSchema = {
  type: "object",
  properties: {
    opportunityIds: {
      type: "array",
      description:
        "Optional list of known opportunity ids. Omit to compare all known opportunities.",
      items: {
        type: "string",
      },
    },
  },
};

export const yieldComparisonTool: AgentTool = {
  id: "yield_comparison",
  name: "Yield Comparison",
  description:
    "Ranks known yield opportunities by current on-chain APR and shows each opportunity's risk, freshness, and confidence. Does not fabricate protocols when only one real opportunity exists.",
  category: "defi",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: yieldComparisonSchema,

  async execute(input) {
    const { opportunityIds } = (input ?? {}) as {
      opportunityIds?: unknown;
    };

    if (opportunityIds !== undefined) {
      if (
        !Array.isArray(opportunityIds) ||
        !opportunityIds.every(
          (id) => typeof id === "string"
        )
      ) {
        return toolError("yield_comparison", {
          code: "INVALID_INPUT",
          message:
            "opportunityIds must be an array of strings if provided.",
        });
      }

      const knownIds =
        getKnownYieldOpportunityIds();

      const unknownIds = (
        opportunityIds as string[]
      ).filter((id) => !knownIds.includes(id));

      if (unknownIds.length > 0) {
        return toolError("yield_comparison", {
          code: "DATA_UNAVAILABLE",
          message:
            `Unknown opportunity id(s): ${unknownIds.join(", ")}. ` +
            `Known ids: ${knownIds.join(", ")}.`,
        });
      }
    }

    const all = await getYieldOpportunities();

    const filtered =
      Array.isArray(opportunityIds) &&
      opportunityIds.length > 0
        ? all.filter((opportunity) =>
            (opportunityIds as string[]).includes(
              opportunity.id
            )
          )
        : all;

    const rankable = filtered.map((opportunity) => ({
      opportunityId: opportunity.id,
      asset: opportunity.asset,
      protocol: opportunity.protocol,
      aprBps:
        opportunity.aprBps.value !== null
          ? BigInt(opportunity.aprBps.value)
          : null,
      aprPercent:
        opportunity.aprPercent.value,
      risk:
        opportunity.risk.overall,
      freshness:
        opportunity.overallFreshness,
      confidence:
        opportunity.overallConfidence,
    }));

    const ranked =
      rankByAprDescending(rankable);

    const entries: YieldComparisonEntry[] =
      ranked.map((entry) => ({
        opportunityId:
          entry.opportunityId,
        asset: entry.asset,
        protocol: entry.protocol,
        aprPercent:
          entry.aprPercent,
        risk: entry.risk,
        freshness:
          entry.freshness,
        confidence:
          entry.confidence,
      }));

    const result: YieldComparisonResult = {
      entries,
      rankedBy: "aprPercent",

      note:
        entries.length <= 1
          ? "Only one real yield opportunity is currently known in this app — no second protocol exists to compare against."
          : `Ranked ${entries.length} known opportunities by current APR, descending.`,

      disclaimer:
        YIELD_COMPARISON_DISCLAIMER,
    };

    return toolSuccess(
      "yield_comparison",
      result,
      {
        source:
          "lib/staking/staking-service (via yield-opportunity-service)",
      }
    );
  },
};

// =============================================================================
// Registration
// =============================================================================

const registry = getAgentToolRegistry();

for (const tool of [
  yieldOpportunitiesTool,
  yieldEstimatorTool,
  yieldComparisonTool,
]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
