import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Real config endpoint handler (autonomyStatus() from lib/autonomy) — proves
// the reply layer consumes the runtime's actual reported state.
import { GET } from "@/app/api/agent/autonomy/config/route";
import { generateIntelligentReply } from "@/lib/agent-intelligence";
import { INTENT_HANDLERS, notAvailable } from "@/lib/agent-intelligence/reply-generators";
import type { AgentContext } from "@/lib/agent-context";
import type { AgentAutonomyContext } from "@/lib/agent-context";

const baseCtx: AgentContext = {
  isConnected: true,
  xp: null,
  portfolio: null,
  premium: null,
  holderTier: null,
  staking: null,
  tokenLock: null,
  season: null,
  rewards: null,
};

/** Same mapping hooks/useAgentChat.ts performs from the AutonomyConfig payload. */
function toAutonomyContext(
  config: Record<string, unknown>,
  goals: { total: number; active: number } | null = null,
): AgentAutonomyContext {
  return {
    enabled: config.enabled as boolean,
    emergencyDisabled: config.emergencyDisabled as boolean,
    executionAvailable: config.executionAvailable as boolean,
    limits: config.limits as AgentAutonomyContext["limits"],
    goals,
  };
}

async function fetchRealConfig(): Promise<Record<string, unknown>> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const ENV_KEYS = [
  "MPGR_AUTONOMOUS_AGENT_ENABLED",
  "MPGR_AUTONOMOUS_EMERGENCY_DISABLE",
  "MPGR_AUTONOMOUS_EXECUTION_ADAPTER",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("autonomous_status reply uses the real autonomy config", () => {
  it("enabled runtime: reply mirrors the live endpoint flags and limits, and does NOT claim execution when executionAvailable is false", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    const config = await fetchRealConfig();
    expect(config.enabled).toBe(true);
    // The shipped runtime has no delegation adapter — the endpoint must say so.
    expect(config.executionAvailable).toBe(false);

    const ctx: AgentContext = {
      ...baseCtx,
      autonomy: toAutonomyContext(config, { total: 2, active: 1 }),
    };
    const reply = INTENT_HANDLERS.autonomous_status(ctx);

    // Exact flags from the live response — not hardcoded copy.
    expect(reply).toContain("Autonomous mode: enabled");
    expect(reply).toContain("Emergency stop: not engaged");
    // The critical accuracy guarantee: availability reported as it is.
    expect(reply).toContain("Autonomous execution available: no");
    expect(reply).not.toMatch(/execution available: yes/i);
    // Real limits figures from the endpoint (publicAutonomyLimits) appear verbatim.
    const limits = config.limits as Record<string, unknown>;
    expect(reply).toContain(`up to ${limits.maxGoalsPerWallet} goals per wallet`);
    expect(reply).toContain(`per-trade cap ${limits.maxPerTradeHuman}`);
    expect(reply).toContain(`daily cap ${limits.maxDailyHuman}`);
    expect(reply).toContain(`slippage bounded to ${limits.maxSlippageBps} bps`);
    expect(reply).toContain(`expire within ${limits.maxPolicyTtlDays} days`);
    // Goal counts passed through.
    expect(reply).toContain("1 active of 2");
  });

  it("end-to-end: 'What's my autonomous status?' routes and answers from the real config", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    const config = await fetchRealConfig();
    const result = generateIntelligentReply(
      "What's my autonomous status?",
      { ...baseCtx, autonomy: toAutonomyContext(config, { total: 0, active: 0 }) },
      null,
    );
    expect(result.intent).toBe("autonomous_status");
    expect(result.reply).toContain("Autonomous execution available: no");
    expect(result.reply).toContain("no autonomous goals");
  });

  it("disabled runtime: reply reports the runtime is off (real endpoint state)", async () => {
    // MPGR_AUTONOMOUS_AGENT_ENABLED stays unset → enabled=false.
    const config = await fetchRealConfig();
    expect(config.enabled).toBe(false);
    const reply = INTENT_HANDLERS.autonomous_status({ ...baseCtx, autonomy: toAutonomyContext(config) });
    expect(reply).toContain("Autonomous mode is disabled");
    expect(reply).toContain("assisted");
    expect(reply).not.toContain("Autonomous mode: enabled");
  });

  it("emergency stop: reply reports ENGAGED and still never claims execution availability", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    const config = await fetchRealConfig();
    expect(config.enabled).toBe(true);
    expect(config.emergencyDisabled).toBe(true);
    const reply = INTENT_HANDLERS.autonomous_status({ ...baseCtx, autonomy: toAutonomyContext(config) });
    expect(reply).toContain("Emergency stop: ENGAGED");
    expect(reply).toContain("Autonomous execution available: no");
  });

  it("missing autonomy snapshot: falls back to the shared not-available reply", () => {
    const reply = INTENT_HANDLERS.autonomous_status(baseCtx);
    expect(reply).toBe(notAvailable("autonomous status"));
  });

  it("terminal goals are excluded from the active count in the reply", () => {
    const reply = INTENT_HANDLERS.autonomous_status({
      ...baseCtx,
      autonomy: {
        enabled: true,
        emergencyDisabled: false,
        executionAvailable: false,
        limits: null,
        goals: { total: 3, active: 1 },
      },
    });
    expect(reply).toContain("1 active of 3");
    expect(reply).toContain("2 completed, failed, expired, or cancelled");
  });
});
