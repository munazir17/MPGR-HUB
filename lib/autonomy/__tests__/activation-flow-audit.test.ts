// lib/autonomy/__tests__/activation-flow-audit.test.ts
//
// ACTIVATION-FLOW AUDIT (runtime level) — the decisive half.
//
// An ACTIVE goal with 0 triggered / 0 verified / no tx hash is only "safe"
// if the trigger path is provably incapable of broadcasting. This suite runs
// the REAL AutonomyRuntime against the REAL MCP trade service (fake chain
// reader) with a condition that IS met, and proves what happens next for each
// possible execution capability configuration:
//
//   B1. Production default (MPGR_AUTONOMOUS_EXECUTION_ADAPTER unset):
//       the adapter registry resolves to noDelegationAdapter, and
//       autonomyStatus().executionAvailable is false — exactly the UI's
//       "Delegated execution · Base Sepolia · not configured".
//   B2. Trigger fires -> quote -> condition MET -> policy APPROVED ->
//       AUTHORIZATION_MISSING -> goal PARKED (WAITING). triggered stays 0,
//       pendingExecution stays null, TRANSACTION_SUBMITTED is never audited,
//       and no adapter executeSwap is ever reached.
//   B3. With the delegated adapter explicitly CONFIGURED + INSTALLED (the
//       real production wiring from lib/autonomy/index.ts) and its on-chain
//       posture warmed so canDelegate is genuinely true, a Base MAINNET
//       (8453) policy is still refused at the adapter (CHAIN_MISMATCH) and
//       the goal still never broadcasts.
//   B4. Chain separation holds in BOTH directions at the policy engine.
//   B5. The emergency stop fires before authorization: nothing signed/sent.
//   B6. Source boundary: the activation seam (hook + policy/goals routes)
//       contains no signing, approval, or broadcast machinery at all.
//   B7. An unknown adapter id fails closed (throws) — no permissive default.
//
// No network, no keys, no transaction is sent by this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { evaluatePolicyAgainstAction } from "@/lib/autonomy/policy-engine";
import {
  clearInstalledAutonomousExecutionAdapter,
  getAutonomousExecutionAdapter,
  installAutonomousExecutionAdapter,
  NO_DELEGATION_ADAPTER_ID,
  noDelegationAdapter,
} from "@/lib/autonomy/execution-adapter";
import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { autonomyStatus } from "@/lib/autonomy";
import {
  DELEGATED_ADAPTER_IDS,
  DELEGATED_ADAPTER_ID,
  DELEGATED_EXECUTION_CHAIN_ID,
  MAINNET_DELEGATED_ADAPTER_ID,
  isDelegatedAdapterId,
  type AutonomousExecutionAdapter,
  type AutonomyPolicy,
} from "@/lib/autonomy/types";
import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_WITNESS_TYPE_STRING,
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
} from "@/lib/executor/delegated-executor";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import type { Logger } from "@/lib/architecture/core/types";
import {
  EXECUTOR,
  MAINNET_EXECUTOR,
  MAINNET_REGISTRY,
  MAINNET_SLIP_ROUTER,
  MAINNET_USDC,
  TEST_SECRET,
  fakeReader,
  newFakeState,
  setAllowance,
  setBalance,
  testDeps,
  type FakeChainState,
} from "@/lib/mcp/__tests__/fixtures";
import { makePolicy, usdc, WALLET } from "./helpers";

const silentLogger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address; // deployed registry fixture

interface AuditHarness {
  store: InMemoryAutonomyStore;
  state: FakeChainState;
  auditEvents: string[];
  runtime: AutonomyRuntime;
  now: () => Date;
  advanceClock: (ms: number) => void;
}

/**
 * Mirrors __tests__/helpers.makeHarness, but the execution adapter is
 * INJECTED so the audit can run the real runtime against each production
 * adapter configuration instead of a permissive test double.
 */
function makeAuditHarness(adapter: AutonomousExecutionAdapter, opts: { delegatedRegistry?: boolean } = {}): AuditHarness {
  const state = newFakeState();
  state.feeBps = 25;
  const clock = { ms: 1_800_000_000_000 };
  const store = new InMemoryAutonomyStore();
  store.clock = () => clock.ms;
  const bus = new InMemoryEventBus();
  const auditEvents: string[] = [];
  bus.on("autonomy_audit", (payload) => auditEvents.push(payload.event.type));
  const perf = new InMemoryPerformanceMonitor();
  const deps = testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? MAINNET_EXECUTOR : EXECUTOR),
    ...(opts.delegatedRegistry ? { delegatedRegistry: { [DELEGATED_EXECUTION_CHAIN_ID]: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT } } : {}),
  });
  const gateway = new McpTradeGateway(deps);
  const runtime = new AutonomyRuntime({
    store,
    gateway,
    adapter,
    audit: new BusAuditSink(store, bus, perf),
    logger: silentLogger,
    performanceMonitor: perf,
    now: () => new Date(clock.ms),
  });
  return {
    store,
    state,
    auditEvents,
    runtime,
    now: () => new Date(clock.ms),
    advanceClock: (ms: number) => {
      clock.ms += ms;
      deps.clock.now = Math.floor(clock.ms / 1000);
    },
  };
}

/** The exact goal shape the production goals route mints on activation. */
async function seedActivatedGoal(h: AuditHarness, policyOver: Partial<AutonomyPolicy> = {}) {
  const now = h.now();
  const policy = await h.store.createPolicy(makePolicy(policyOver));
  setBalance(h.state, MAINNET_USDC, WALLET, BigInt(usdc("100")));
  setAllowance(h.state, MAINNET_USDC, WALLET, MAINNET_REGISTRY[8453]!.executor, BigInt(usdc("1000")));
  const goal = await h.store.createGoal({
    id: "",
    wallet: WALLET,
    policyId: policy.id,
    type: "conditional_swap",
    description: "Buy AAPLc below 200",
    status: "ACTIVE", // <- exactly what "Authorize & activate goal" produces
    condition: { kind: "price_below", threshold: "200" },
    trade: {
      sellToken: policy.sellToken,
      buyToken: policy.buyToken,
      sellAmountRaw: usdc("20"),
      slippageBps: 100,
      sellDecimals: 6,
      buyDecimals: 8,
    },
    cooldownSeconds: 60,
    maxTrades: 10,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    nextEvaluationAt: now.toISOString(),
    lastAction: null,
    lastResult: null,
    pendingExecution: null,
    stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
  });
  return { goal, policy };
}

/** A delegated adapter whose on-chain posture is warmed => genuinely capable. */
function capableDelegatedAdapter(gateway: McpTradeGateway, store: InMemoryAutonomyStore, slots: InMemoryDelegatedAuthorizationStore, broadcastSpy: (tx: unknown) => Promise<Hex>) {
  return new DelegatedExecutionAdapter({
    slots,
    gateway,
    getPolicy: (policyId) => store.getPolicy(policyId),
    broadcast: broadcastSpy,
    chain: {
      getBytecode: async () => "0x60806040" as Hex,
      readContract: async <T,>(args: { functionName: string }): Promise<T> => {
        if (args.functionName === "feeBps") return 25 as T;
        if (args.functionName === "PERMIT2") return CANONICAL_PERMIT2 as T;
        if (args.functionName === "WITNESS_TYPE_STRING") return DELEGATED_WITNESS_TYPE_STRING as T;
        throw new Error(`unexpected read ${args.functionName}`);
      },
    },
  });
}

beforeEach(() => {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "false");
  vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", "");
  clearInstalledAutonomousExecutionAdapter();
});

describe("B1 — production default posture (matches the UI's 'not configured')", () => {
  it("the adapter registry resolves to the refusing adapter with env unset", () => {
    const adapter = getAutonomousExecutionAdapter();
    expect(adapter.id).toBe(NO_DELEGATION_ADAPTER_ID);
    expect(adapter.canDelegate).toBe(false);
    expect(adapter.checkAuthorization(WALLET, makePolicy())).toEqual({ authorized: false, reason: "NO_DELEGATION_MECHANISM" });
  });

  it("autonomyStatus().executionAvailable is false — the UI's 'Delegated execution · Base Sepolia · not configured'", async () => {
    const status = autonomyStatus();
    expect(status.executionAvailable).toBe(false);
    expect(status.enabled).toBe(true);
    expect(status.emergencyDisabled).toBe(false);
  });

  it("noDelegationAdapter.executeSwap refuses even if it were called directly", async () => {
    const result = await noDelegationAdapter.executeSwap({
      goalId: "g", policyId: "p", wallet: WALLET, chainId: 8453, quoteId: "q",
      sellToken: MAINNET_USDC, buyToken: AAPLC, sellAmountRaw: "1",
      expectedBuyAmountRaw: "1", minBuyAmountRaw: "1", slippageBps: 100,
      idempotencyKey: "k", steps: [], transactionRequest: null,
    });
    expect(result).toMatchObject({ ok: false, code: "AUTHORIZATION_MISSING" });
  });
});

describe("B2 — an ACTIVE goal whose trigger condition IS met cannot execute (default posture)", () => {
  it("trigger -> quote -> CONDITION_MET -> POLICY_APPROVED -> AUTHORIZATION_MISSING -> PARKED, no tx", async () => {
    const h = makeAuditHarness(getAutonomousExecutionAdapter());
    const { goal } = await seedActivatedGoal(h);

    // Sanity: the fixture quote is 2:1, so 20 USDC -> 0.4 AAPLc => price 50,
    // which DOES satisfy `price_below 200`. The trigger is genuinely firing.
    const result = await h.runtime.evaluateGoal(goal.id);

    expect(result.kind).toBe("PARKED");
    if (result.kind === "PARKED") expect(result.failureCode).toBe("AUTHORIZATION_MISSING");

    // The pipeline really did run up to the authorization boundary.
    expect(h.auditEvents).toContain("QUOTE_CREATED");
    expect(h.auditEvents).toContain("CONDITION_CHECKED");
    expect(h.auditEvents).toContain("CONDITION_MET");
    expect(h.auditEvents).toContain("POLICY_APPROVED");
    expect(h.auditEvents).toContain("AUTHORIZATION_CHECKED");
    // ...and stopped there. Nothing downstream ever happened.
    expect(h.auditEvents).not.toContain("TRADE_PREPARED");
    expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
    expect(h.auditEvents).not.toContain("EXECUTION_VERIFIED");

    // The UI's reported state is therefore CORRECT, not a missing update.
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status).toBe("WAITING");
    expect(after.pendingExecution).toBeNull();
    expect(after.stats.triggered).toBe(0);
    expect(after.stats.verified).toBe(0);
    expect(after.lastResult?.outcome).toBe("AUTHORIZATION_MISSING");
    expect(after.lastResult?.code).toBe("AUTHORIZATION_MISSING");
    // Honest, user-visible reason — not a silent no-op.
    expect(after.lastResult?.message).toMatch(/No valid autonomous authorization/i);
    // No action record with a tx hash exists.
    expect((await h.store.listActionRecords(goal.id)).every((r) => !r.txHash)).toBe(true);
  });

  it("keeps refusing across repeated ticks (never eventually leaks an execution)", async () => {
    const h = makeAuditHarness(getAutonomousExecutionAdapter());
    const { goal } = await seedActivatedGoal(h);
    for (let i = 0; i < 6; i++) {
      h.advanceClock(120_000);
      const current = (await h.store.getGoal(goal.id))!;
      if (current.status === "WAITING") {
        await h.store.transitionGoal(goal.id, WALLET, ["WAITING"], current.updatedAt, { status: "ACTIVE", updatedAt: `tick-${i}` });
      }
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(["PARKED", "SKIPPED"]).toContain(result.kind);
      expect(result.kind).not.toBe("EXECUTION_SUBMITTED");
    }
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.pendingExecution).toBeNull();
    expect(after.stats.triggered).toBe(0);
    expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
  });
});

/**
 * Builds state/store/gateway FIRST, then a genuinely capable delegated
 * adapter over them, then the real runtime — the same order
 * lib/autonomy/index.ts#build() uses in production.
 */
function makeDelegatedHarness() {
  const state = newFakeState();
  state.feeBps = 25;
  const clock = { ms: 1_800_000_000_000 };
  const store = new InMemoryAutonomyStore();
  store.clock = () => clock.ms;
  const bus = new InMemoryEventBus();
  const auditEvents: string[] = [];
  bus.on("autonomy_audit", (payload) => auditEvents.push(payload.event.type));
  const perf = new InMemoryPerformanceMonitor();
  const deps = testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? MAINNET_EXECUTOR : EXECUTOR),
    delegatedRegistry: { [DELEGATED_EXECUTION_CHAIN_ID]: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
  });
  const gateway = new McpTradeGateway(deps);
  const slots = new InMemoryDelegatedAuthorizationStore();
  const broadcasts: unknown[] = [];
  const adapter = capableDelegatedAdapter(gateway, store, slots, async (tx) => {
    broadcasts.push(tx);
    throw new Error("audit: must never broadcast");
  });
  const runtime = new AutonomyRuntime({
    store,
    gateway,
    adapter,
    audit: new BusAuditSink(store, bus, perf),
    logger: silentLogger,
    performanceMonitor: perf,
    now: () => new Date(clock.ms),
  });
  return {
    store,
    state,
    auditEvents,
    broadcasts,
    slots,
    adapter,
    runtime,
    now: () => new Date(clock.ms),
    advanceClock: (ms: number) => {
      clock.ms += ms;
      deps.clock.now = Math.floor(clock.ms / 1000);
    },
  };
}

describe("B3 — even a FULLY CAPABLE delegated adapter refuses a UI-activated mainnet goal", () => {
  it("warmed posture => canDelegate true, yet an 8453 policy is refused CHAIN_MISMATCH", async () => {
    const h = makeDelegatedHarness();
    // Warm the on-chain posture so the adapter is genuinely, provably capable.
    expect((await h.adapter.verifyOnChain()).authorized).toBe(true);
    expect(h.adapter.canDelegate).toBe(true);
    expect(h.adapter.id).toBe(DELEGATED_ADAPTER_ID);

    // The policy the UI activation flow actually creates is Base MAINNET.
    expect(h.adapter.checkAuthorization(WALLET, makePolicy({ chainId: 8453 }))).toEqual({ authorized: false, reason: "CHAIN_MISMATCH" });

    // A Sepolia policy WOULD be accepted — proving the refusal is chain
    // separation, not a blanket failure of the harness.
    expect(h.adapter.checkAuthorization(WALLET, makePolicy({ chainId: DELEGATED_EXECUTION_CHAIN_ID })).authorized).toBe(true);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("configured + installed via the production seam, the mainnet goal still never broadcasts", async () => {
    const h = makeDelegatedHarness();
    await h.adapter.verifyOnChain(); // warm => canDelegate true

    // Exactly the production wiring: install, then resolve through the registry.
    installAutonomousExecutionAdapter(h.adapter);
    vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", DELEGATED_ADAPTER_ID);
    const resolved = getAutonomousExecutionAdapter();
    expect(resolved.id).toBe(DELEGATED_ADAPTER_ID);
    expect(resolved.canDelegate).toBe(true); // delegated execution IS available

    // ...but the goal activated through the UI is a Base MAINNET goal.
    const { goal } = await seedActivatedGoal(h);
    expect((await h.store.getPolicy(goal.policyId))!.chainId).toBe(8453);

    const result = await h.runtime.evaluateGoal(goal.id);

    // Fail-closed before any broadcast — never EXECUTION_SUBMITTED/VERIFIED.
    expect(["PARKED", "EXECUTION_FAILED", "SKIPPED"]).toContain(result.kind);
    expect(result.kind).not.toBe("EXECUTION_SUBMITTED");
    expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
    expect(h.broadcasts).toHaveLength(0);
    expect(await h.slots.listSlots(WALLET.toLowerCase())).toHaveLength(0);

    const after = (await h.store.getGoal(goal.id))!;
    expect(after.pendingExecution).toBeNull();
    expect(after.stats.triggered).toBe(0);
    expect(after.stats.verified).toBe(0);
    expect(after.status).not.toBe("EXECUTING");
    // LAYERED chain separation: the FIRST gate to fire is OBSERVE — the
    // delegated (84532) executor allowlist does not contain Base mainnet USDC,
    // so the quote is refused TOKEN_NOT_ALLOWED and the pipeline never reaches
    // the condition, policy, or authorization stages at all.
    expect(after.lastResult?.code).toBe("TOKEN_NOT_ALLOWED");
    expect(after.lastResult?.outcome).toBe("FAILED");
    expect(h.auditEvents).not.toContain("QUOTE_CREATED");
    expect(h.auditEvents).not.toContain("CONDITION_MET");
    expect(h.auditEvents).not.toContain("POLICY_APPROVED");
    // Behind that first gate sit two more, independently proven above: the
    // policy engine's CHAIN_MISMATCH (B4) and the adapter's own CHAIN_MISMATCH
    // (B3) — a mainnet policy is refused by all three.
    expect(after.lastResult?.outcome).not.toBe("VERIFIED");
  });
});

describe("B3b — the delegated adapter's cold on-chain posture (the exact missing capability)", () => {
  it("a COLD posture cache refuses authorization, and nothing in the server warms it", async () => {
    const h = makeDelegatedHarness();
    // No verifyOnChain() here — this IS the server's real cold-start posture:
    // lib/autonomy/index.ts#build() constructs the adapter and never warms it,
    // and no API route calls verifyOnChain() either.
    expect(h.adapter.canDelegate).toBe(false);
    expect(h.adapter.checkStatic()).toEqual({ authorized: false, reason: "ONCHAIN_CHECK_PENDING" });
    // Even a correctly-chained Base Sepolia policy is refused while cold.
    expect(h.adapter.checkAuthorization(WALLET, makePolicy({ chainId: DELEGATED_EXECUTION_CHAIN_ID }))).toEqual({
      authorized: false,
      reason: "ONCHAIN_CHECK_PENDING",
    });
    // Warming is the only thing that changes the answer...
    expect((await h.adapter.verifyOnChain()).authorized).toBe(true);
    expect(h.adapter.checkAuthorization(WALLET, makePolicy({ chainId: DELEGATED_EXECUTION_CHAIN_ID })).authorized).toBe(true);
    // ...and the ONLY production caller of verifyOnChain() is executeSwap(),
    // which the runtime reaches only AFTER checkAuthorization() said yes.
    const adapterSrc = readFileSync(join(process.cwd(), "lib/autonomy/delegated-execution-adapter.ts"), "utf8");
    expect(adapterSrc.match(/this\.verifyOnChain\(\)/g)).toHaveLength(1); // inside executeSwap only
    const bootstrapSrc = readFileSync(join(process.cwd(), "lib/autonomy/index.ts"), "utf8");
    expect(bootstrapSrc).not.toContain("verifyOnChain");
  });

  it("so executionAvailable stays FALSE (the UI's 'not configured') even with the adapter env set and installed", async () => {
    // A production-shaped adapter: NO injected broadcast/chain, so it reads
    // the real operator env (MPGR_BROADCASTER_PRIVATE_KEY) and the real
    // Base Sepolia chain view — exactly like lib/autonomy/index.ts#build().
    const productionShaped = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway: new McpTradeGateway(
        testDeps(newFakeState(), { registry: MAINNET_REGISTRY, mainnetEnabled: true, quoteSecret: TEST_SECRET }),
      ),
      getPolicy: async () => null,
    });
    installAutonomousExecutionAdapter(productionShaped);
    vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", DELEGATED_ADAPTER_ID);
    expect(getAutonomousExecutionAdapter().id).toBe(DELEGATED_ADAPTER_ID);

    // 1) No operator broadcaster key at all -> the operational gate refuses.
    vi.stubEnv("MPGR_BROADCASTER_PRIVATE_KEY", "");
    expect(productionShaped.checkStatic().reason).toBe("BROADCASTER_NOT_CONFIGURED");
    expect(autonomyStatus().executionAvailable).toBe(false);

    // 2) Key present -> the operational gate passes, but the COLD on-chain
    //    posture cache still refuses. Nothing in the server warms it.
    vi.stubEnv("MPGR_BROADCASTER_PRIVATE_KEY", "0x" + "ab".repeat(32));
    expect(productionShaped.checkStatic()).toEqual({ authorized: false, reason: "ONCHAIN_CHECK_PENDING" });
    // This is exactly what /api/agent/autonomy/config reports to the panel:
    // "Delegated execution · Base Sepolia · not configured".
    expect(autonomyStatus().executionAvailable).toBe(false);
  });
});

describe("B4 — policy-engine chain separation, both directions", () => {
  const spend = { dailySpendRaw: "0", actionsToday: 0 };
  const goal = { expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const action = (chainId: number, policy: AutonomyPolicy) => ({
    action: "swap" as const,
    chainId,
    sellToken: policy.sellToken,
    buyToken: policy.buyToken,
    sellAmountRaw: usdc("1"),
    slippageBps: 100,
  });

  it("a delegated-chain (84532) proposal against a mainnet (8453) policy is CHAIN_MISMATCH", () => {
    const policy = makePolicy({ chainId: 8453 });
    const decision = evaluatePolicyAgainstAction(policy, goal, action(DELEGATED_EXECUTION_CHAIN_ID, policy), spend, new Date());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rejection.rule).toBe("CHAIN_MISMATCH");
  });

  it("a mainnet (8453) proposal against a delegated (84532) policy is CHAIN_MISMATCH", () => {
    const policy = makePolicy({ chainId: DELEGATED_EXECUTION_CHAIN_ID });
    const decision = evaluatePolicyAgainstAction(policy, goal, action(8453, policy), spend, new Date());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rejection.rule).toBe("CHAIN_MISMATCH");
  });
});

describe("B5 — the emergency stop fires before authorization", () => {
  it("parks the goal EXECUTION_UNAVAILABLE with nothing signed or sent", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "true");
    const h = makeAuditHarness(getAutonomousExecutionAdapter());
    const { goal } = await seedActivatedGoal(h);
    const result = await h.runtime.evaluateGoal(goal.id);
    expect(result.kind).toBe("PARKED");
    if (result.kind === "PARKED") expect(result.failureCode).toBe("EXECUTION_UNAVAILABLE");
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.pendingExecution).toBeNull();
    expect(after.stats.triggered).toBe(0);
    expect(after.lastResult?.message).toMatch(/globally disabled by the operator/i);
    expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
  });
});

describe("B6 — source boundary: the activation seam has no signing/approval/broadcast machinery", () => {
  const forbidden = [
    /signTypedData/,
    /signTransaction/,
    /sendTransaction/,
    /writeContract/,
    /createWalletClient/,
    /privateKey|PRIVATE_KEY/,
    /\bapprove\(|\bapproval\b|permit2|Permit2/i,
    /delegated-broadcaster|delegateSwap/,
    /mpgr-executor-abi|encodeFunctionData/,
  ];

  it("the policy route and goals route (the two activation calls) are pure store writes", () => {
    for (const rel of ["app/api/agent/autonomy/policy/route.ts", "app/api/agent/autonomy/goals/route.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      for (const pattern of forbidden) {
        expect({ file: rel, pattern: String(pattern), match: pattern.test(src) }).toEqual({ file: rel, pattern: String(pattern), match: false });
      }
    }
  });

  it("the client authorizeGoal seam performs two fetches and no wallet interaction", () => {
    const src = readFileSync(join(process.cwd(), "hooks/useAgentAutonomy.ts"), "utf8");
    const start = src.indexOf("const authorizeGoal = useCallback(");
    const end = src.indexOf("const revokeSlot = useCallback(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    // Exactly the two off-chain control-plane calls, nothing else.
    expect(slice).toContain('"/api/agent/autonomy/policy"');
    expect(slice).toContain('"/api/agent/autonomy/goals"');
    for (const pattern of forbidden) {
      expect({ pattern: String(pattern), match: pattern.test(slice) }).toEqual({ pattern: String(pattern), match: false });
    }
    // The ONLY signature in the whole hook lives in the separate, explicit
    // delegated-slot signing seam — never in activation.
    const signIndex = src.indexOf("signTypedDataAsync({");
    expect(signIndex).toBeGreaterThan(end);
    expect(src.indexOf("const signDelegatedSlots = useCallback(")).toBeGreaterThan(end);
  });

  it("lib/autonomy never imports the broadcaster or executor ABI outside the delegated adapter", () => {
    // The delegated adapter is the single audited chokepoint; the runtime,
    // policy engine, store and activation routes must not reach for it.
    for (const rel of ["lib/autonomy/runtime.ts", "lib/autonomy/policy-engine.ts", "lib/autonomy/store.ts", "lib/autonomy/execution-adapter.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect({ file: rel, importsAbi: /mpgr-executor-abi/.test(src) }).toEqual({ file: rel, importsAbi: false });
      expect({ file: rel, encodes: /encodeFunctionData/.test(src) }).toEqual({ file: rel, encodes: false });
    }
  });
});

describe("B7 — the registry cannot resolve permissively by accident", () => {
  it("an unknown adapter id throws instead of falling back to something capable", () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", "session-key-nightmode");
    expect(() => getAutonomousExecutionAdapter()).toThrow(/fail-closed|Unknown autonomous execution adapter/i);
  });

  it("the delegated id configured but NOT installed throws (server wiring missing)", () => {
    clearInstalledAutonomousExecutionAdapter();
    vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", DELEGATED_ADAPTER_ID);
    expect(() => getAutonomousExecutionAdapter()).toThrow(/not installed|fail-closed/i);
  });

  it("only a delegated adapter id can ever be installed", () => {
    // UPDATED BY THE MC-2 REMEDIATION: the registry now accepts BOTH delegated
    // ids (Base Sepolia + Base mainnet) because they are one class with one
    // safety machinery, differing only by chain. The property that matters is
    // unchanged — an arbitrary id still throws instead of resolving
    // permissively, and the accepted set is closed and explicit.
    clearInstalledAutonomousExecutionAdapter();
    expect(() =>
      installAutonomousExecutionAdapter({
        id: "rogue-adapter",
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
      } as unknown as AutonomousExecutionAdapter),
    ).toThrow(/Only a delegated adapter \(delegated-permit2-sepolia \| delegated-permit2-mainnet\) can be installed/);

    // The accepted set is exactly the two delegated ids — nothing else.
    expect([...DELEGATED_ADAPTER_IDS].sort()).toEqual(["delegated-permit2-mainnet", "delegated-permit2-sepolia"]);
    for (const id of DELEGATED_ADAPTER_IDS) {
      expect(isDelegatedAdapterId(id)).toBe(true);
      clearInstalledAutonomousExecutionAdapter();
      installAutonomousExecutionAdapter({
        id,
        chainId: id === MAINNET_DELEGATED_ADAPTER_ID ? 8453 : 84532,
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
      } as unknown as AutonomousExecutionAdapter);
    }
    clearInstalledAutonomousExecutionAdapter();
  });

  it("a configured adapter id that does not match the INSTALLED adapter throws", () => {
    // New guard added by the MC-2 remediation: selecting the mainnet adapter
    // while the Sepolia one is wired (or vice versa) must not silently execute
    // on the wrong chain.
    clearInstalledAutonomousExecutionAdapter();
    installAutonomousExecutionAdapter({
      id: DELEGATED_ADAPTER_ID,
      chainId: 84532,
      canDelegate: true,
      checkAuthorization: () => ({ authorized: true }),
      executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
    } as unknown as AutonomousExecutionAdapter);
    vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", MAINNET_DELEGATED_ADAPTER_ID);
    expect(() => getAutonomousExecutionAdapter()).toThrow(/is configured but .* is installed|fail-closed/i);

    // And overwriting an installed adapter with a DIFFERENT one is refused.
    expect(() =>
      installAutonomousExecutionAdapter({
        id: MAINNET_DELEGATED_ADAPTER_ID,
        chainId: 8453,
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
      } as unknown as AutonomousExecutionAdapter),
    ).toThrow(/already installed|refusing to overwrite/i);
    clearInstalledAutonomousExecutionAdapter();
  });

  it("the delegated executor is pinned to Base Sepolia; the mainnet registry has no delegated entry", () => {
    expect(DELEGATED_EXECUTION_CHAIN_ID).toBe(84532);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.chainId).toBe(84532);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.executor.toLowerCase()).toBe(DELEGATED_EXECUTOR_ADDRESS.toLowerCase());
    // The mainnet registry is a different contract with a different allowlist:
    // the delegated executor is not deployed/registered on 8453, and the
    // mainnet Slipstream route the UI pair trades is unrelated to it.
    expect(MAINNET_REGISTRY[8453]!.executor.toLowerCase()).not.toBe(DELEGATED_EXECUTOR_ADDRESS.toLowerCase());
    expect(MAINNET_SLIP_ROUTER.toLowerCase()).not.toBe(DELEGATED_EXECUTOR_ADDRESS.toLowerCase());
    expect(
      BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.tokens.some((t) => t.address.toLowerCase() === MAINNET_USDC.toLowerCase()),
    ).toBe(false);
  });
});
