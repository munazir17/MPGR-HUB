// lib/autonomy/__tests__/production-gate.test.ts
//
// AUTONOMOUS_PRODUCTION_ENABLED — the explicit Base-mainnet production gate.
//
// Properties pinned here (each one a go-live requirement):
//   * default OFF: missing / empty / "false" / any non-"true" value fails
//     closed — isAutonomousProductionEnabled() is false;
//   * with EVERY other mainnet prerequisite fully configured (feature flag,
//     pinned executor, operator broadcaster key, provable on-chain posture,
//     a live policy and a user-signed Permit2 witness slot), a gate-OFF
//     mainnet adapter still refuses at every seam — checkStatic,
//     checkAuthorization and executeSwap — and ZERO broadcasts happen;
//   * the runtime parks the goal honestly (the refusal reason names the
//     gate) and consumes nothing: the signed slot stays unconsumed;
//   * flipping the gate OFF after the posture was already proven (the
//     operator "pulls" the gate) stops execution on the very next tick;
//   * the MCP delegateSwap broadcast chokepoint refuses chain 8453 with
//     PRODUCTION_GATE_DISABLED before any calldata is built or key touched,
//     and Base Sepolia (84532) is NOT gated by this flag;
//   * autonomyStatus() reports the gate as a public, non-secret boolean.
//
// Everything runs on mocked chain infrastructure (fake ChainReader, fake
// posture view, spy broadcaster). NO REAL MAINNET TRANSACTION IS EVER
// BROADCAST — there is no network client in this file.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { AUTONOMOUS_PRODUCTION_GATE_ENV, isAutonomousProductionEnabled } from "@/lib/autonomy/config";
import { autonomyStatus } from "@/lib/autonomy";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT,
  DELEGATED_EXECUTOR_REQUIRED_OWNER,
  DELEGATED_WITNESS_TYPE_STRING,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPolicyHash,
  mainnetDelegatedExecutorDeployment,
} from "@/lib/executor/delegated-executor";
import { delegateSwap } from "@/lib/mcp/mcp-trade-service";
import {
  EXECUTOR,
  MAINNET_REGISTRY,
  TEST_SECRET,
  fakeReader,
  newFakeState,
  testDeps,
} from "@/lib/mcp/__tests__/fixtures";

import { makePolicy, silentLogger, usdc, WALLET } from "./helpers";

// A deliberately NON-canary, non-production test address (same convention as
// mainnet-delegated-execution.test.ts — the real one is operator-pinned).
const MAINNET_DELEGATED_EXECUTOR = getAddress("0x1111111111111111111111111111111111111111");
const MAINNET_BROADCASTER_KEY = ("0x" + "5a".repeat(32)) as Hex;
const MAINNET_BROADCASTER = privateKeyToAccount(MAINNET_BROADCASTER_KEY).address;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const AAPLC = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb");
const SELL_AMOUNT = usdc("20");

const MANAGED_ENV = [
  AUTONOMOUS_PRODUCTION_GATE_ENV,
  "MPGR_MAINNET_DELEGATED_EXECUTOR",
  "MPGR_MAINNET_BROADCASTER_PRIVATE_KEY",
  "MPGR_AUTONOMOUS_EMERGENCY_DISABLE",
  "MPGR_AUTONOMOUS_AGENT_ENABLED",
  "MPGR_AUTONOMOUS_EXECUTION_ADAPTER",
  "MPGR_BROADCASTER_PRIVATE_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Every mainnet prerequisite EXCEPT the production gate, fully configured. */
function configureEverythingButTheGate() {
  process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = MAINNET_DELEGATED_EXECUTOR;
  process.env.MPGR_MAINNET_BROADCASTER_PRIVATE_KEY = MAINNET_BROADCASTER_KEY;
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
  delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
}

beforeEach(() => {
  for (const k of MANAGED_ENV) savedEnv[k] = process.env[k];
  configureEverythingButTheGate();
  delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
});

afterEach(() => {
  for (const k of MANAGED_ENV) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Harness: the REAL runtime/scheduler/adapter/MCP service over a FAKE chain.
// ---------------------------------------------------------------------------

function makeGateHarness() {
  const state = newFakeState();
  state.feeBps = 25;
  const clock = { ms: 1_800_000_000_000 };
  const store = new InMemoryAutonomyStore();
  store.clock = () => clock.ms;
  const slots = new InMemoryDelegatedAuthorizationStore();
  const deployment = mainnetDelegatedExecutorDeployment();
  if (!deployment) throw new Error("test precondition: mainnet delegated deployment must build when the executor is pinned");

  const broadcasts: { to: Address; data: Hex; chainId: number; value?: bigint }[] = [];
  let txCounter = 0;
  const deps = testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    delegatedRegistry: { 8453: deployment },
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? deployment.executor : EXECUTOR),
    delegatedBroadcaster: async (tx) => {
      broadcasts.push(tx);
      return ("0x" + (++txCounter).toString(16).padStart(2, "0").padEnd(64, "0")) as Hex;
    },
  });
  const gateway = new McpTradeGateway(deps);

  const adapter = new DelegatedExecutionAdapter({
    slots,
    gateway,
    chainId: 8453,
    getPolicy: (policyId) => store.getPolicy(policyId),
    chain: {
      getBytecode: async () => "0x6080" as Hex,
      readContract: async <T,>({ functionName }: { functionName: string }): Promise<T> => {
        switch (functionName) {
          case "feeBps":
            return 25 as never;
          case "PERMIT2":
            return CANONICAL_PERMIT2 as never;
          case "WITNESS_TYPE_STRING":
            return DELEGATED_WITNESS_TYPE_STRING as never;
          case "owner":
            return DELEGATED_EXECUTOR_REQUIRED_OWNER as never;
          case "feeRecipient":
            return DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT as never;
          case "paused":
            return false as never;
          case "isTokenAllowed":
            return true as never;
          default:
            throw new Error(`unexpected posture read ${functionName}`);
        }
      },
    },
    now: () => new Date(clock.ms),
  });

  const bus = new InMemoryEventBus();
  const auditEvents: string[] = [];
  bus.on("autonomy_audit", (payload) => auditEvents.push(payload.event.type));
  const perf = new InMemoryPerformanceMonitor();
  const audit = new BusAuditSink(store, bus, perf);
  const runtime = new AutonomyRuntime({
    store,
    gateway,
    adapter,
    audit,
    logger: silentLogger,
    performanceMonitor: perf,
    now: () => new Date(clock.ms),
  });
  const scheduler = new AutonomyScheduler(store, runtime, silentLogger, perf);

  return {
    state,
    store,
    slots,
    gateway,
    adapter,
    runtime,
    scheduler,
    deployment,
    broadcasts,
    auditEvents,
    deps,
    now: () => new Date(clock.ms),
    advanceClock: (ms: number) => {
      clock.ms += ms;
      deps.clock.now = Math.floor(clock.ms / 1000);
    },
  };
}

type GateHarness = ReturnType<typeof makeGateHarness>;

async function createGateGoal(h: GateHarness) {
  const policy = await h.store.createPolicy(
    makePolicy({ chainId: 8453, sellToken: USDC, buyToken: AAPLC, maxPerTradeRaw: SELL_AMOUNT }),
  );
  const now = h.now();
  const goal = await h.store.createGoal({
    id: "",
    wallet: WALLET,
    policyId: policy!.id,
    type: "conditional_swap",
    description: "Buy AAPLc below 200 on Base mainnet",
    status: "ACTIVE",
    condition: { kind: "price_below", threshold: "200" },
    trade: { sellToken: USDC, buyToken: AAPLC, sellAmountRaw: SELL_AMOUNT, slippageBps: 100, sellDecimals: 6, buyDecimals: 8 },
    cooldownSeconds: 60,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    nextEvaluationAt: now.toISOString(),
    lastAction: null,
    lastResult: null,
    pendingExecution: null,
    stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    maxTrades: 1,
  });
  return { goal, policy: policy! };
}

/** Store a user-signed authorization slot bound to chain 8453 (same shape as the mainnet suite). */
async function signGateSlot(h: GateHarness, goalId: string, policy: ReturnType<typeof makePolicy>, slotIndex = 0) {
  const nowSeconds = Math.floor(h.now().getTime() / 1000);
  const deadline = nowSeconds + 1800;
  const wallet = WALLET.toLowerCase() as Address;
  const permit = { token: USDC, amount: SELL_AMOUNT, nonce: delegatedPermitNonce(goalId, slotIndex), deadline };
  const witness = {
    owner: wallet,
    buyToken: policy.buyToken,
    minAmountOut: "1",
    deadline,
    actionId: delegatedActionId(goalId),
    policyHash: delegatedPolicyHash({
      id: policy.id,
      wallet: policy.wallet.toLowerCase() as Address,
      chainId: policy.chainId,
      sellToken: policy.sellToken,
      buyToken: policy.buyToken,
      maxPerTradeRaw: policy.maxPerTradeRaw,
      maxSlippageBps: policy.maxSlippageBps,
      expiresAt: policy.expiresAt,
    }),
  };
  const signature = ("0x" + "ab".repeat(65)) as Hex;
  await h.slots.saveSlots([
    {
      id: `slot-${policy.id}-${goalId}-${slotIndex}`,
      wallet,
      chainId: 8453,
      policyId: policy.id,
      goalId,
      slotIndex,
      permit,
      witness,
      signature,
      createdAt: h.now().toISOString(),
    },
  ]);
  return { permit, witness, signature };
}

// ---------------------------------------------------------------------------
// 1. Flag semantics — explicit "true" only; everything else fails closed.
// ---------------------------------------------------------------------------

describe("AUTONOMOUS_PRODUCTION_ENABLED flag semantics", () => {
  it("is false when missing, empty, false-ish, or any non-'true' value", () => {
    for (const value of [undefined, "", "false", "FALSE", "0", "1", "yes", "on", "enabled", "true false"]) {
      if (value === undefined) delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
      else process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = value;
      expect(isAutonomousProductionEnabled(), `value=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("is true only for the exact string 'true' (trimmed, case-insensitive)", () => {
    for (const value of ["true", "TRUE", "True", "  true  "]) {
      process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = value;
      expect(isAutonomousProductionEnabled(), `value=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("the gate env name is pinned so it cannot be renamed silently", () => {
    expect(AUTONOMOUS_PRODUCTION_GATE_ENV).toBe("AUTONOMOUS_PRODUCTION_ENABLED");
  });
});

// ---------------------------------------------------------------------------
// 2. Adapter seams — every refusal, zero broadcasts, everything else configured.
// ---------------------------------------------------------------------------

describe("mainnet adapter with the gate OFF (every other prerequisite configured)", () => {
  it("checkStatic / checkAuthorization / canDelegate refuse with PRODUCTION_GATE_DISABLED", async () => {
    const h = makeGateHarness();
    const { policy } = await createGateGoal(h);
    expect(h.adapter.executor?.toLowerCase()).toBe(MAINNET_DELEGATED_EXECUTOR.toLowerCase());
    expect(h.adapter.checkStatic()).toEqual({ authorized: false, reason: "PRODUCTION_GATE_DISABLED" });
    expect(h.adapter.checkAuthorization(WALLET, policy)).toEqual({ authorized: false, reason: "PRODUCTION_GATE_DISABLED" });
    expect(h.adapter.canDelegate).toBe(false);
    expect(h.adapter.canDelegateNow()).toBe(false);
    // Even an explicit posture bootstrap cannot open the gate: the posture
    // proof is read-only chain verification, while checkStatic() layers the
    // operational gate ON TOP — a proven posture still refuses execution.
    await h.adapter.bootstrapPosture(policy);
    expect(h.adapter.checkStatic()).toEqual({ authorized: false, reason: "PRODUCTION_GATE_DISABLED" });
    expect(h.adapter.canDelegate).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("executeSwap refuses EXECUTION_UNAVAILABLE and never broadcasts — the signed slot stays unconsumed", async () => {
    const h = makeGateHarness();
    const { goal, policy } = await createGateGoal(h);
    await signGateSlot(h, goal.id, policy);

    const result = await h.adapter.executeSwap({
      goalId: goal.id,
      policyId: policy.id,
      wallet: WALLET,
      chainId: 8453,
      quoteId: "q",
      sellToken: USDC,
      buyToken: AAPLC,
      sellAmountRaw: SELL_AMOUNT,
      expectedBuyAmountRaw: "40000000",
      minBuyAmountRaw: "1",
      slippageBps: 100,
      idempotencyKey: "k",
      steps: [],
      transactionRequest: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXECUTION_UNAVAILABLE");
      expect(result.message).toMatch(/PRODUCTION_GATE_DISABLED/);
    }
    expect(h.broadcasts).toHaveLength(0);
    const slots = await h.slots.listSlots(WALLET.toLowerCase(), policy.id);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.consumedAt ?? null).toBeNull();
  });

  it("the runtime parks the goal honestly: zero broadcasts, zero triggers, the refusal names the gate", async () => {
    const h = makeGateHarness();
    const { goal, policy } = await createGateGoal(h);
    await signGateSlot(h, goal.id, policy);

    const summary = await h.scheduler.tick({ now: h.now() });
    expect(summary.evaluated).toBe(1);
    expect(h.broadcasts).toHaveLength(0);

    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status).toBe("WAITING");
    expect(after.pendingExecution).toBeNull();
    expect(after.stats.triggered).toBe(0);
    expect(after.lastResult?.code).toBe("AUTHORIZATION_MISSING");
    expect(after.lastResult?.message).toMatch(/PRODUCTION_GATE_DISABLED/);
    // The pipeline really ran up to the authorization boundary and stopped.
    expect(h.auditEvents).toContain("POLICY_APPROVED");
    expect(h.auditEvents).toContain("AUTHORIZATION_CHECKED");
    expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
    // Nothing was consumed: the user's signed slot is still fully usable.
    const slots = await h.slots.listSlots(WALLET.toLowerCase(), policy.id);
    expect(slots[0]!.consumedAt ?? null).toBeNull();
  });

  it("pulling the gate AFTER the posture was proven stops execution on the very next tick", async () => {
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    const h = makeGateHarness();
    const { goal, policy } = await createGateGoal(h);
    await signGateSlot(h, goal.id, policy);

    // Gate ON: the posture proves and the adapter authorizes.
    await h.adapter.bootstrapPosture(policy);
    expect(h.adapter.checkStatic()).toEqual({ authorized: true });
    expect(h.adapter.checkAuthorization(WALLET, policy)).toEqual({ authorized: true });

    // Operator pulls the production gate. No redeploy, no other change.
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    expect(h.adapter.checkStatic()).toEqual({ authorized: false, reason: "PRODUCTION_GATE_DISABLED" });

    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.stats.triggered).toBe(0);
    expect(after.pendingExecution).toBeNull();
    expect(after.lastResult?.message).toMatch(/PRODUCTION_GATE_DISABLED/);
  });

  it("gate ON: the adapter passes the operational layer and evaluates the NEXT gate (slots), proving the gate is the only blocker", async () => {
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    const h = makeGateHarness();
    const { policy } = await createGateGoal(h);
    await h.adapter.bootstrapPosture(policy);
    expect(h.adapter.checkStatic()).toEqual({ authorized: true });

    // No slot signed -> the refusal is now AUTHORIZATION_MISSING (the next
    // gate in the chain), never PRODUCTION_GATE_DISABLED.
    const result = await h.adapter.executeSwap({
      goalId: "goal-no-slot",
      policyId: policy.id,
      wallet: WALLET,
      chainId: 8453,
      quoteId: "q",
      sellToken: USDC,
      buyToken: AAPLC,
      sellAmountRaw: SELL_AMOUNT,
      expectedBuyAmountRaw: "40000000",
      minBuyAmountRaw: "1",
      slippageBps: 100,
      idempotencyKey: "k",
      steps: [],
      transactionRequest: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTHORIZATION_MISSING");
    expect(h.broadcasts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Chain scoping — Base Sepolia is NOT gated by the production flag.
// ---------------------------------------------------------------------------

describe("chain scoping of the production gate", () => {
  it("a Base Sepolia adapter is unaffected by the gate (testnet stays testable)", async () => {
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    process.env.MPGR_BROADCASTER_PRIVATE_KEY = "0x" + "ab".repeat(32);
    const h = makeGateHarness();
    const sepolia = new DelegatedExecutionAdapter({
      slots: h.slots,
      gateway: h.gateway,
      chainId: 84532,
      chain: {
        getBytecode: async () => "0x6080" as Hex,
        readContract: async <T,>({ functionName }: { functionName: string }): Promise<T> => {
          if (functionName === "feeBps") return 25 as never;
          if (functionName === "PERMIT2") return CANONICAL_PERMIT2 as never;
          if (functionName === "WITNESS_TYPE_STRING") return DELEGATED_WITNESS_TYPE_STRING as never;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
      now: () => new Date(),
    });
    // The refusal (cold posture cache) is NOT the production gate.
    const cold = sepolia.checkStatic();
    expect(cold.authorized).toBe(false);
    expect(cold.reason).not.toBe("PRODUCTION_GATE_DISABLED");
    await sepolia.bootstrapPosture();
    expect(sepolia.checkStatic()).toEqual({ authorized: true });
    delete process.env.MPGR_BROADCASTER_PRIVATE_KEY;
  });
});

// ---------------------------------------------------------------------------
// 4. The MCP delegateSwap broadcast chokepoint (defence in depth).
// ---------------------------------------------------------------------------

describe("delegateSwap chokepoint", () => {
  const minimalRequest = (chainId: number) => ({ chainId, intentId: "0x" + "11".repeat(32) });

  it("refuses chain 8453 with PRODUCTION_GATE_DISABLED before anything else, gate OFF", async () => {
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    const h = makeGateHarness();
    const out = await delegateSwap(h.deps, minimalRequest(8453));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("PRODUCTION_GATE_DISABLED");
      expect(out.error.message).toMatch(/AUTONOMOUS_PRODUCTION_ENABLED/);
    }
    expect(h.broadcasts).toHaveLength(0);
  });

  it("gate ON: the same call gets PAST the gate (fails later, on the malformed authorization — a different seam)", async () => {
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    const h = makeGateHarness();
    const out = await delegateSwap(h.deps, minimalRequest(8453));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).not.toBe("PRODUCTION_GATE_DISABLED");
    expect(h.broadcasts).toHaveLength(0);
  });

  it("Base Sepolia (84532) is never refused by the production gate", async () => {
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    const h = makeGateHarness();
    const out = await delegateSwap(h.deps, minimalRequest(84532));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).not.toBe("PRODUCTION_GATE_DISABLED");
    expect(h.broadcasts).toHaveLength(0);
  });

  it("an unsupported chain is still refused with UNSUPPORTED_CHAIN regardless of the gate", async () => {
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    const h = makeGateHarness();
    const out = await delegateSwap(h.deps, minimalRequest(1));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED_CHAIN");
  });
});

// ---------------------------------------------------------------------------
// 5. Public status surface — honest, non-secret reporting.
// ---------------------------------------------------------------------------

describe("autonomyStatus() reports the gate", () => {
  it("productionGate is false by default and true only when explicitly enabled", () => {
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    expect(autonomyStatus().productionGate).toBe(false);
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    expect(autonomyStatus().productionGate).toBe(true);
  });

  it("the status payload never leaks the gate's neighbours (no key material, no secret env names' VALUES)", () => {
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    const serialized = JSON.stringify(autonomyStatus());
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/); // no 32-byte hex (keys/hashes)
    expect(serialized).not.toContain(MAINNET_BROADCASTER_KEY);
    expect(serialized.toLowerCase()).not.toContain("private");
  });
});

// ---------------------------------------------------------------------------
// 6. The broadcaster itself is untouched by the gate — key separation holds.
// ---------------------------------------------------------------------------

describe("no unsafe fallback around the gate", () => {
  it("the mainnet broadcaster address is the operator key's, never the canary, and the gate does not change it", async () => {
    const { mainnetBroadcasterAddress } = await import("@/lib/delegated/delegated-broadcaster");
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    expect(mainnetBroadcasterAddress()?.toLowerCase()).toBe(MAINNET_BROADCASTER.toLowerCase());
    process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = "true";
    expect(mainnetBroadcasterAddress()?.toLowerCase()).toBe(MAINNET_BROADCASTER.toLowerCase());
  });
});
