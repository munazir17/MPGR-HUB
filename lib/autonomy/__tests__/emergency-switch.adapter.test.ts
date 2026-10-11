import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import {
  resetEmergencySwitchForTests,
  setEmergencySwitchKvForTests,
  setEmergencySwitchReaderForTests,
} from "@/lib/autonomy/emergency-switch";
import { delegateSwap } from "@/lib/mcp/mcp-trade-service";
import type { McpGateway } from "@/lib/autonomy/mcp-gateway";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;

describe("DelegatedExecutionAdapter executeSwap KV switch", () => {
  beforeEach(() => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    resetEmergencySwitchForTests();
  });
  afterEach(() => {
    resetEmergencySwitchForTests();
  });

  it("refuses at the execution boundary when KV is disabled — no gateway call", async () => {
    setEmergencySwitchReaderForTests(async () => ({
      allowed: false,
      reason: "EMERGENCY_SWITCH_DISABLED",
      correlationId: "a",
    }));
    let delegated = 0;
    const adapter = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway: {
        async quote() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async prepare() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async verify() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async delegateSwap() {
          delegated += 1;
          return { ok: false, failure: { code: "RPC_ERROR", message: "should not run" } };
        },
      } as unknown as McpGateway,
    });
    const result = await adapter.executeSwap({
      goalId: "g",
      policyId: "p",
      wallet,
      chainId: 84532,
      quoteId: "q",
      sellToken: wallet,
      buyToken: wallet,
      sellAmountRaw: "1",
      expectedBuyAmountRaw: "1",
      minBuyAmountRaw: "1",
      slippageBps: 100,
      idempotencyKey: "k",
      steps: [],
      transactionRequest: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXECUTION_UNAVAILABLE");
    expect(delegated).toBe(0);
  });

  it("env emergency disable cannot be bypassed by an enabled KV reader on the adapter env gate", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "true");
    setEmergencySwitchReaderForTests(null);
    setEmergencySwitchReaderForTests(async () => ({
      allowed: true,
      reason: "ENABLED",
      correlationId: "bypass",
    }));
    const adapter = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway: {
        async quote() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async prepare() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async verify() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "unused" } };
        },
        async delegateSwap() {
          return { ok: false, failure: { code: "RPC_ERROR", message: "no" } };
        },
      } as unknown as McpGateway,
    });
    // Reader override wins in tests; operational env gate still refuses after KV allow.
    const result = await adapter.executeSwap({
      goalId: "g",
      policyId: "p",
      wallet,
      chainId: 84532,
      quoteId: "q",
      sellToken: wallet,
      buyToken: wallet,
      sellAmountRaw: "1",
      expectedBuyAmountRaw: "1",
      minBuyAmountRaw: "1",
      slippageBps: 100,
      idempotencyKey: "k",
      steps: [],
      transactionRequest: null,
    });
    expect(result.ok).toBe(false);
    vi.unstubAllEnvs();
  });

  it("MCP delegateSwap refuses missing/malformed KV and never broadcasts", async () => {
    let broadcasts = 0;
    const deps = {
      delegatedBroadcaster: async () => {
        broadcasts += 1;
        return "0x" + "ab".repeat(32);
      },
    };

    setEmergencySwitchKvForTests({ get: async () => null });
    const missing = await delegateSwap(deps as never, { chainId: 84532 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("EXECUTION_UNAVAILABLE");

    setEmergencySwitchKvForTests({ get: async () => "not-json" });
    const malformed = await delegateSwap(deps as never, { chainId: 84532 });
    expect(malformed.ok).toBe(false);

    setEmergencySwitchReaderForTests(async () => ({
      allowed: false,
      reason: "EMERGENCY_SWITCH_DISABLED",
      correlationId: "flip",
    }));
    const disabled = await delegateSwap(deps as never, { chainId: 84532 });
    expect(disabled.ok).toBe(false);
    expect(broadcasts).toBe(0);
  });
});
