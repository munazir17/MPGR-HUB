// lib/architecture/tools/__tests__/p2-tool-definitions.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type {
  EventBus,
  Logger,
  PerformanceMonitor,
} from "@/lib/architecture/core/types";

const { mockGetGlobalStateWithMeta } = vi.hoisted(() => ({
  mockGetGlobalStateWithMeta: vi.fn(),
}));

vi.mock("@/lib/staking/staking-service", () => ({
  stakingService: {
    getGlobalStateWithMeta: (...args: unknown[]) =>
      mockGetGlobalStateWithMeta(...args),
  },
}));

const {
  yieldOpportunitiesTool,
  yieldEstimatorTool,
  yieldComparisonTool,
} = await import("../p2-tool-definitions");

function makeDeps() {
  const eventBus: EventBus = {
    on: () => () => {},
    off: () => {},
    emit: () => {},
    use: () => () => {},
  };

  const logger: Logger = {
    debug: () => {},
    warn: () => {},
    error: () => {},
  };

  const performanceMonitor: PerformanceMonitor = {
    time: async (_label, fn) => fn(),
    timeSync: (_label, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };

  return {
    eventBus,
    logger,
    performanceMonitor,
  };
}

function makeRuntime() {
  const registry = new AgentToolRegistry();

  for (const tool of [
    yieldOpportunitiesTool,
    yieldEstimatorTool,
    yieldComparisonTool,
  ]) {
    registry.register(tool);
  }

  const {
    eventBus,
    logger,
    performanceMonitor,
  } = makeDeps();

  return new AgentToolRuntime(
    registry,
    eventBus,
    logger,
    performanceMonitor
  );
}

const ALL_P2_TOOLS = [
  yieldOpportunitiesTool,
  yieldEstimatorTool,
  yieldComparisonTool,
];

function fakeGlobalStateWithMeta(
  overrides: Partial<{
    totalStaked: bigint;
    rewardPoolBalance: bigint;
    currentAPRBps: bigint;
    rewardRate: bigint;
    periodFinish: bigint;
    isPaused: boolean;
    minimumStake: bigint;
  }> = {}
) {
  const now = Date.now();

  return {
    state: {
      totalStaked: 1_000_000n * 10n ** 18n,
      rewardPoolBalance: 30_000_000n * 10n ** 18n,
      currentAPRBps: 1250n,
      rewardRate: 100n * 10n ** 18n,
      periodFinish: BigInt(
        Math.floor(now / 1000) + 30 * 24 * 60 * 60
      ),
      isPaused: false,
      minimumStake: 100n * 10n ** 18n,
      ...overrides,
    },
    observedAt: new Date(now).toISOString(),
    ageMs: 0,
    ttlMs: 12_000,
  };
}

beforeEach(() => {
  mockGetGlobalStateWithMeta.mockReset();
});

describe("P2 tool registration", () => {
  it("all three are read-only, low-risk and require no confirmation", () => {
    for (const tool of ALL_P2_TOOLS) {
      expect(tool.mode).toBe("read");
      expect(tool.riskLevel).toBe("low");
      expect(tool.requiresConfirmation).toBe(false);
      expect(tool.requiresWallet).toBe(false);
    }
  });

  it("registers into a fresh registry without duplicate collisions", () => {
    const registry = new AgentToolRegistry();

    expect(() => {
      for (const tool of ALL_P2_TOOLS) {
        registry.register(tool);
      }
    }).not.toThrow();

    expect(registry.list()).toHaveLength(3);
  });

  it("contains no write-capable transaction primitive", () => {
    const source = readFileSync(
      join(__dirname, "../p2-tool-definitions.ts"),
      "utf8"
    );

    expect(source).not.toMatch(
      /writeContract|simulateContract|sendTransaction|signTransaction|sendRawTransaction|eth_sendTransaction/
    );
  });

  it("never declares prepare or execute mode", () => {
    const source = readFileSync(
      join(__dirname, "../p2-tool-definitions.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/mode:\s*"prepare"/);
    expect(source).not.toMatch(/mode:\s*"execute"/);
  });
});

describe("yield_opportunities", () => {
  it("returns a normalized opportunity on a healthy read", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta()
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      opportunities: Array<{
        id: string;
        aprPercent: { value: string | null };
        overallFreshness: string;
        overallConfidence: string;
        risk: { overall: string };
      }>;
    };

    expect(data.opportunities).toHaveLength(1);

    const opportunity = data.opportunities[0];

    expect(opportunity.id).toBe("mpgr-staking");
    expect(opportunity.aprPercent.value).toBe("12.50");
    expect(opportunity.overallFreshness).toBe("current");
    expect(opportunity.overallConfidence).toBe("high");

    // Unknown volatility/audit signals do not automatically
    // increase the overall risk. The worst known healthy factor is low.
    expect(opportunity.risk.overall).toBe("low");
  });

  it("filters to a known opportunity id", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta()
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      { opportunityId: "mpgr-staking" },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      opportunities: Array<{ id: string }>;
    };

    expect(data.opportunities).toHaveLength(1);
    expect(data.opportunities[0].id).toBe("mpgr-staking");
  });

  it("rejects an unknown opportunity id", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {
        opportunityId: "not-a-real-protocol",
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
    expect(mockGetGlobalStateWithMeta).not.toHaveBeenCalled();
  });

  it("rejects a non-string opportunityId", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      { opportunityId: 123 },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("degrades to unavailable facts when the provider fails", async () => {
    mockGetGlobalStateWithMeta.mockRejectedValue(
      new Error("RPC internal failure")
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      opportunities: Array<{
        aprBps: { value: string | null };
        aprPercent: { value: string | null };
        overallFreshness: string;
        overallConfidence: string;
        risk: { overall: string };
      }>;
    };

    const opportunity = data.opportunities[0];

    expect(opportunity.aprBps.value).toBeNull();
    expect(opportunity.aprPercent.value).toBeNull();
    expect(opportunity.overallFreshness).toBe("unavailable");
    expect(opportunity.overallConfidence).toBe("unknown");

    // Data quality is a real known signal here, so unavailable
    // provider data correctly produces high overall risk.
    expect(opportunity.risk.overall).toBe("high");
  });

  it("does not fabricate pause status after provider failure", async () => {
    mockGetGlobalStateWithMeta.mockRejectedValue(
      new Error("RPC failure")
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      opportunities: Array<{
        isPaused: { value: boolean | null };
      }>;
    };

    expect(data.opportunities[0].isPaused.value).toBeNull();
  });

  it("reflects a paused contract as high protocol risk", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta({
        isPaused: true,
      })
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      opportunities: Array<{
        risk: {
          overall: string;
          factors: Array<{
            dimension: string;
            level: string;
          }>;
        };
      }>;
    };

    expect(data.opportunities[0].risk.overall).toBe("high");

    const protocolFactor =
      data.opportunities[0].risk.factors.find(
        (factor) => factor.dimension === "protocolRisk"
      );

    expect(protocolFactor?.level).toBe("high");
  });
});

describe("yield_estimator", () => {
  it("computes a deterministic projection", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta({
        currentAPRBps: 1000n,
      })
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "mpgr-staking",
        amount: "1000",
        durationDays: 365,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      estimatedGrossRewardFormatted: string;
      feesApplied: boolean;
      disclaimer: string;
    };

    expect(data.estimatedGrossRewardFormatted).toBe("100");
    expect(data.feesApplied).toBe(false);
    expect(data.disclaimer).toMatch(/not a guaranteed return/i);
  });

  it("rejects an unknown opportunity id", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "nope",
        amount: "1000",
        durationDays: 30,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects malformed amount before provider access", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "mpgr-staking",
        amount: "not-a-number",
        durationDays: 30,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(mockGetGlobalStateWithMeta).not.toHaveBeenCalled();
  });

  it("rejects a negative duration", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "mpgr-staking",
        amount: "1000",
        durationDays: -1,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("returns DATA_UNAVAILABLE when APR is unavailable", async () => {
    mockGetGlobalStateWithMeta.mockRejectedValue(
      new Error("RPC failure")
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "mpgr-staking",
        amount: "1000",
        durationDays: 30,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
  });

  it("never leaks raw provider errors", async () => {
    mockGetGlobalStateWithMeta.mockRejectedValue(
      new Error("SUPER_SECRET_RPC_INTERNAL_URL")
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_estimator",
      {
        opportunityId: "mpgr-staking",
        amount: "1000",
        durationDays: 30,
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.error?.message).not.toContain(
      "SUPER_SECRET_RPC_INTERNAL_URL"
    );
  });
});

describe("yield_comparison", () => {
  it("returns the known opportunity", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta()
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_comparison",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      entries: Array<{
        opportunityId: string;
        aprPercent: string | null;
      }>;
      rankedBy: string;
      note: string;
      disclaimer: string;
    };

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].opportunityId).toBe("mpgr-staking");
    expect(data.rankedBy).toBe("aprPercent");
    expect(data.note).toMatch(/no second protocol/i);
    expect(data.disclaimer).toMatch(/not investment advice/i);
  });

  it("rejects an unknown opportunity filter", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_comparison",
      {
        opportunityIds: [
          "mpgr-staking",
          "fake-protocol",
        ],
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
    expect(mockGetGlobalStateWithMeta).not.toHaveBeenCalled();
  });

  it("rejects a non-array opportunityIds", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_comparison",
      {
        opportunityIds: "mpgr-staking",
      },
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("keeps unknown APR as null", async () => {
    mockGetGlobalStateWithMeta.mockRejectedValue(
      new Error("RPC failure")
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_comparison",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
      }
    );

    expect(result.success).toBe(true);

    const data = result.data as {
      entries: Array<{
        aprPercent: string | null;
      }>;
    };

    expect(data.entries[0].aprPercent).toBeNull();
  });
});

describe("P2 permission enforcement", () => {
  it("refuses read tools when canRead is disabled", async () => {
    mockGetGlobalStateWithMeta.mockResolvedValue(
      fakeGlobalStateWithMeta()
    );

    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "yield_opportunities",
      {},
      {
        requestId: "r1",
        confirmationMode: "always_confirm",
        permissions: {
          canRead: false,
          canPrepare: true,
          canExecute: true,
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");

    expect(
      mockGetGlobalStateWithMeta
    ).not.toHaveBeenCalled();
  });
});
