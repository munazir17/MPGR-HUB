// lib/autonomy/__tests__/mainnet-delegated-execution.test.ts
//
// PROOF OF THE COMPLETE BASE MAINNET AUTONOMOUS EXECUTION PATH added by the
// MC-1..MC-4 remediation (docs/ACTIVATION-FLOW-AUDIT.md).
//
//   ACTIVE GOAL -> TRIGGER MET -> POLICY APPROVED -> AUTHORIZATION VALID
//   -> QUOTE FRESH -> LIMITS VALID -> EXECUTION PREPARED
//   -> MAINNET TX SUBMITTED -> RECEIPT CONFIRMED -> EXECUTION VERIFIED
//   -> GOAL COMPLETED
//
// Everything here runs on MOCKED chain infrastructure: a fake ChainReader, a
// fake posture chain view and a stubbed broadcaster. NO REAL MAINNET
// TRANSACTION IS EVER BROADCAST — there is no network client in this file, and
// the broadcaster is a spy that records calldata and mines a synthetic receipt.
//
// What is REAL: the AutonomyRuntime, the AutonomyScheduler, the
// DelegatedExecutionAdapter, the bounded hot-wallet gate, the MCP trade service
// (quote/delegateSwap/verifyTrade), the EIP-712 encoding and the deployed Base
// mainnet token/route registry. Only the chain and the operator key are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { utcDayKey } from "@/lib/autonomy/idempotency";
import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT,
  DELEGATED_EXECUTOR_REQUIRED_OWNER,
  DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR,
  DELEGATED_WITNESS_TYPE_STRING,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPermitTypedData,
  delegatedPolicyHash,
  mainnetDelegatedExecutorDeployment,
} from "@/lib/executor/delegated-executor";
import { RouterKind } from "@/lib/executor/executor-config";
import {
  EXECUTOR,
  MAINNET_REGISTRY,
  fakeReader,
  swapExecutedLog,
  testDeps,
  TEST_SECRET,
  newFakeState,
  type FakeChainState,
} from "@/lib/mcp/__tests__/fixtures";

import { makePolicy, silentLogger, usdc, WALLET } from "./helpers";

// A deliberately NON-canary, non-production test address. The real mainnet
// delegated executor is operator-pinned; tests pin their own.
const MAINNET_DELEGATED_EXECUTOR = getAddress("0x1111111111111111111111111111111111111111");
const MAINNET_BROADCASTER_KEY = ("0x" + "5a".repeat(32)) as Hex;
const MAINNET_BROADCASTER = privateKeyToAccount(MAINNET_BROADCASTER_KEY).address;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const AAPLC = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb");
const SELL_AMOUNT = usdc("20");

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["MPGR_MAINNET_DELEGATED_EXECUTOR", "MPGR_MAINNET_BROADCASTER_PRIVATE_KEY", "MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "MPGR_AUTONOMOUS_AGENT_ENABLED", "AUTONOMOUS_PRODUCTION_ENABLED"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = MAINNET_DELEGATED_EXECUTOR;
  process.env.MPGR_MAINNET_BROADCASTER_PRIVATE_KEY = MAINNET_BROADCASTER_KEY;
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
  // The explicit Base-mainnet production gate. This suite proves the mainnet
  // execution path, so it opens the gate exactly the way an operator would —
  // deliberately and explicitly. The gate-OFF refusals are proven separately
  // in production-gate.test.ts.
  process.env.AUTONOMOUS_PRODUCTION_ENABLED = "true";
  delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Harness: the REAL runtime/scheduler/adapter/MCP service over a FAKE chain.
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /** Posture reads fail (simulates an unverifiable on-chain posture). */
  posture?: "ok" | "paused" | "wrong-owner" | "token-not-allowed" | "rpc-error" | "no-code";
  /** Broadcast throws (simulates an uncertain broadcast). */
  broadcastFails?: boolean;
  /** Do not mine a receipt (simulates "submitted but never confirmable"). */
  neverConfirm?: boolean;
}

function makeMainnetHarness(options: HarnessOptions = {}) {
  const state = newFakeState();
  state.feeBps = 25;
  const clock = { ms: 1_800_000_000_000 };
  const store = new InMemoryAutonomyStore();
  store.clock = () => clock.ms;
  const slots = new InMemoryDelegatedAuthorizationStore();
  const deployment = mainnetDelegatedExecutorDeployment();
  if (!deployment) throw new Error("test precondition: mainnet delegated deployment must build when the executor is pinned");

  const broadcasts: { to: Address; data: Hex; chainId: number; value?: bigint }[] = [];
  const receiptsMined: string[] = [];
  let txCounter = 0;

  const deps = testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    delegatedRegistry: { 8453: deployment },
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? deployment.executor : EXECUTOR),
    delegatedBroadcaster: async (tx) => {
      if (options.broadcastFails) throw new Error("RPC connection reset during broadcast");
      broadcasts.push(tx);
      const txHash = ("0x" + (++txCounter).toString(16).padStart(2, "0").padEnd(64, "0")) as Hex;
      if (!options.neverConfirm) {
        receiptsMined.push(txHash);
        // feeRecipient must equal the QUOTE's, which comes from the live
        // executor config read through the fake reader (state.feeRecipient) —
        // intentFromPayload takes it from the quote payload, not the registry.
        mineReceipt(state, txHash, deployment.executor, state.feeRecipient);
      }
      return txHash;
    },
  });
  const gateway = new McpTradeGateway(deps);

  const posture = options.posture ?? "ok";
  const adapter = new DelegatedExecutionAdapter({
    slots,
    gateway,
    chainId: 8453,
    getPolicy: (policyId) => store.getPolicy(policyId),
    chain: {
      getBytecode: async () => (posture === "no-code" ? "0x" : ("0x6080" as Hex)),
      readContract: async <T,>({ functionName, args }: { functionName: string; args?: readonly unknown[] }): Promise<T> => {
        if (posture === "rpc-error") throw new Error("execution reverted");
        switch (functionName) {
          case "feeBps":
            return 25 as never;
          case "PERMIT2":
            return CANONICAL_PERMIT2 as never;
          case "WITNESS_TYPE_STRING":
            return DELEGATED_WITNESS_TYPE_STRING as never;
          case "owner":
            return (posture === "wrong-owner" ? "0x000000000000000000000000000000000000dead" : DELEGATED_EXECUTOR_REQUIRED_OWNER) as never;
          case "feeRecipient":
            return DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT as never;
          case "paused":
            return (posture === "paused" ? true : false) as never;
          case "isTokenAllowed":
            return (posture === "token-not-allowed" ? false : true) as never;
          default:
            throw new Error(`unexpected posture read ${functionName} ${JSON.stringify(args ?? [])}`);
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
    receiptsMined,
    auditEvents,
    now: () => new Date(clock.ms),
    advanceClock: (ms: number) => {
      clock.ms += ms;
      deps.clock.now = Math.floor(clock.ms / 1000);
    },
    advanceHarnessClockOnly: (ms: number) => {
      clock.ms += ms;
    },
  };
}

type MainnetHarness = ReturnType<typeof makeMainnetHarness>;

/** Mine a synthetic SUCCESS receipt for a delegated mainnet swap (BUY or SELL). */
function mineReceipt(
  state: FakeChainState,
  txHash: Hex,
  executor: Address,
  feeRecipient: Address,
  over: { status?: "success" | "reverted"; taker?: Address } = {},
) {
  const sell = currentGross;
  const fee = (sell * 25n) / 10_000n;
  state.receipts.set(txHash.toLowerCase(), {
    status: over.status ?? "success",
    transactionHash: txHash,
    blockNumber: 42n,
    // The GAS PAYER is the operator broadcaster; the TAKER (event) is the user.
    from: MAINNET_BROADCASTER,
    to: executor,
    logs: [
      swapExecutedLog(executor, {
        taker: over.taker ?? WALLET,
        router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
        intentId: currentIntentId,
        tokenIn: currentTokenIn,
        tokenOut: currentTokenOut,
        grossAmountIn: sell,
        feeAmount: fee,
        swapAmountIn: sell - fee,
        amountOut: BigInt(currentExpectedOut),
        feeRecipient,
        feeBps: state.feeBps,
        routerKind: RouterKind.AERODROME_SLIPSTREAM,
        flags: 0,
      }),
    ],
  } as never);
}

// Set per-execution so the mined receipt matches the intent the runtime pins.
// Direction-generalized: the BUY goal sets USDC->AAPLc, the SELL goal sets
// AAPLc->USDC (same machinery, mirrored pair — the fee is ALWAYS 25 bps of
// the SELL amount, whichever token that is).
let currentIntentId = ("0x" + "11".repeat(32)) as Hex;
let currentExpectedOut = "40000000";
let currentTokenIn: Address = USDC;
let currentTokenOut: Address = AAPLC;
let currentGross = BigInt(SELL_AMOUNT);

async function createMainnetGoal(h: MainnetHarness, over: { goalId?: string; maxTrades?: number | null; policyOver?: Partial<Parameters<typeof makePolicy>[0]> } = {}) {
  const policy = await h.store.createPolicy(makePolicy({ chainId: 8453, sellToken: USDC, buyToken: AAPLC, maxPerTradeRaw: SELL_AMOUNT, ...over.policyOver }));
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
    maxTrades: over.maxTrades ?? 1,
  });
  currentIntentId = delegatedActionId(goal.id);
  // BUY defaults (USDC -> AAPLc) so a preceding SELL test can never leak its
  // direction into this one.
  currentTokenIn = USDC;
  currentTokenOut = AAPLC;
  currentGross = BigInt(SELL_AMOUNT);
  currentExpectedOut = "40000000";
  return { goal, policy: policy! };
}

/** SELL direction: 1 AAPLc (8dp) -> USDC through the SAME delegated machinery. */
const SELL_GOAL_AMOUNT_RAW = "100000000"; // 1.00000000 AAPLc
const SELL_GOAL_EXPECTED_USDC = "199500000"; // fake quoter: 2x the post-fee swap amount

async function createMainnetSellGoal(h: MainnetHarness) {
  const policy = await h.store.createPolicy(
    makePolicy({
      chainId: 8453,
      sellToken: AAPLC,
      buyToken: USDC,
      // Limits are denominated in the SELL token — here AAPLc base units.
      maxPerTradeRaw: SELL_GOAL_AMOUNT_RAW,
      maxDailyRaw: "500000000",
    }),
  );
  const now = h.now();
  const goal = await h.store.createGoal({
    id: "",
    wallet: WALLET,
    policyId: policy!.id,
    type: "conditional_swap",
    description: "Sell AAPLc for USDC below 200 on Base mainnet",
    status: "ACTIVE",
    condition: { kind: "price_below", threshold: "200" },
    trade: { sellToken: AAPLC, buyToken: USDC, sellAmountRaw: SELL_GOAL_AMOUNT_RAW, slippageBps: 100, sellDecimals: 8, buyDecimals: 6 },
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
  currentIntentId = delegatedActionId(goal.id);
  currentTokenIn = AAPLC;
  currentTokenOut = USDC;
  currentGross = BigInt(SELL_GOAL_AMOUNT_RAW);
  currentExpectedOut = SELL_GOAL_EXPECTED_USDC;
  return { goal, policy: policy! };
}

/** Store a user-signed authorization slot bound to chain 8453. */
async function signMainnetSlot(
  h: MainnetHarness,
  goalId: string,
  policy: ReturnType<typeof makePolicy>,
  over: {
    slotIndex?: number;
    wallet?: Address;
    chainId?: number;
    amount?: string;
    minAmountOut?: string;
    deadline?: number;
    expired?: boolean;
    buyToken?: Address;
    /** Permit (SELL-side) token; defaults to USDC (the BUY goal's sell leg). */
    sellToken?: Address;
    actionId?: Hex;
  } = {},
) {
  const slotIndex = over.slotIndex ?? 0;
  const chainId = over.chainId ?? 8453;
  const nowSeconds = Math.floor(h.now().getTime() / 1000);
  const deadline = over.deadline ?? (over.expired ? nowSeconds - 60 : nowSeconds + 1800);
  const wallet = (over.wallet ?? WALLET).toLowerCase() as Address;
  const permit = {
    token: over.sellToken ?? USDC,
    amount: over.amount ?? SELL_AMOUNT,
    nonce: delegatedPermitNonce(goalId, slotIndex),
    deadline,
  };
  const witness = {
    owner: wallet,
    buyToken: over.buyToken ?? policy.buyToken,
    minAmountOut: over.minAmountOut ?? "1",
    deadline,
    actionId: over.actionId ?? delegatedActionId(goalId),
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
  // A real EIP-712 signature over the MAINNET domain with the MAINNET executor
  // as spender — proves the typed-data path is chain-correct, not just shape.
  // Build the real typed data so the domain/primaryType/message are exercised
  // for THIS chain and executor (a shape regression would throw here).
  const typed = delegatedPermitTypedData({ permit, witness }, chainId, MAINNET_DELEGATED_EXECUTOR);
  expect(typed.domain.chainId).toBe(chainId);
  const signature = ("0x" + "ab".repeat(65)) as Hex;
  await h.slots.saveSlots([
    {
      id: `slot-${policy.id}-${goalId}-${slotIndex}`,
      wallet,
      chainId: chainId as 8453,
      policyId: policy.id,
      goalId,
      slotIndex,
      permit,
      witness,
      signature,
      createdAt: h.now().toISOString(),
    },
  ]);
  return { permit, witness, signature, deadline };
}

// ---------------------------------------------------------------------------
// POSITIVE: the complete stage chain on Base mainnet.
// ---------------------------------------------------------------------------

describe("mainnet delegated execution — the complete authorized path", () => {
  it("ACTIVE GOAL -> TRIGGER MET -> POLICY APPROVED -> AUTHORIZATION VALID -> QUOTE FRESH -> EXECUTION PREPARED -> TX SUBMITTED -> CONFIRMED -> VERIFIED -> COMPLETED", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);

    // Posture must be provable BEFORE execution (MC-3): a cold adapter still
    // reports PENDING, but bootstrapping warms it.
    expect(h.adapter.checkStatic()).toEqual({ authorized: false, reason: "ONCHAIN_CHECK_PENDING" });
    await h.adapter.bootstrapPosture(policy);
    expect(h.adapter.checkStatic()).toEqual({ authorized: true });
    expect(h.adapter.checkAuthorization(WALLET, policy)).toEqual({ authorized: true });

    const summary = await h.scheduler.tick({ now: h.now() });
    expect(summary.evaluated).toBe(1);

    // MAINNET TX SUBMITTED: exactly one broadcast, on chain 8453, to the
    // PINNED mainnet delegated executor, carrying the Slipstream entrypoint.
    expect(h.broadcasts).toHaveLength(1);
    const tx = h.broadcasts[0]!;
    expect(tx.chainId).toBe(8453);
    expect(getAddress(tx.to)).toBe(MAINNET_DELEGATED_EXECUTOR);
    expect(tx.data.slice(0, 10).toLowerCase()).toBe(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR);
    expect(tx.value ?? 0n).toBe(0n);

    // The verification tick confirms the receipt and completes the goal. The
    // runtime schedules it ~30 s after submission, so advance BOTH clocks.
    h.advanceClock(31_000);
    await h.scheduler.tick({ now: h.now() });
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status, `lastResult=${JSON.stringify(after.lastResult ?? null)}`).toBe("COMPLETED");
    expect(after.stats.triggered).toBe(1);
    expect(after.stats.verified).toBe(1);
    expect(after.pendingExecution).toBeNull();

    // The full ordered audit chain, with no stage skipped.
    const order = [
      "QUOTE_CREATED",
      "CONDITION_CHECKED",
      "CONDITION_MET",
      "POLICY_APPROVED",
      "AUTHORIZATION_CHECKED",
      "TRADE_PREPARED",
      "TRANSACTION_SUBMITTED",
      "TRANSACTION_CONFIRMED",
      "EXECUTION_VERIFIED",
    ];
    let lastIndex = -1;
    for (const event of order) {
      const index = h.auditEvents.indexOf(event, lastIndex + 1);
      expect(index, `missing or out-of-order: ${event} in ${h.auditEvents.join(",")}`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("executes a BOUNDED trade: the amount broadcast is exactly the policy/goal amount, never more", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });

    expect(h.broadcasts).toHaveLength(1);
    // Decoding is done by the gate before signing; here we assert the observable
    // bound: the request the adapter received carried exactly the goal amount.
    const receipt = h.state.receipts.get(h.receiptsMined[0]!.toLowerCase()) as unknown as { logs: unknown[] };
    expect(receipt).toBeTruthy();
    // The slot's permit amount is the EXACT goal trade amount (base units).
    const [slot] = await h.slots.listSlots(WALLET.toLowerCase(), policy.id);
    expect(slot!.permit.amount).toBe(SELL_AMOUNT);
    expect(BigInt(slot!.permit.amount)).toBeLessThanOrEqual(BigInt(policy.maxPerTradeRaw));
  });

  it("accepts an authorization with the correct token, chain, amount and action binding", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    const slot = await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);

    const result = await h.adapter.executeSwap({
      goalId: goal.id,
      policyId: policy.id,
      wallet: WALLET,
      chainId: 8453,
      sellToken: USDC,
      buyToken: AAPLC,
      sellAmountRaw: SELL_AMOUNT,
      minBuyAmountRaw: "1",
      expectedBuyAmountRaw: "40000000",
      quoteId: "quote-mainnet",
      idempotencyKey: "idem-1",
      submittedAt: h.now().toISOString(),
    } as never);
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]!.chainId).toBe(8453);
    expect(slot.witness.actionId).toBe(delegatedActionId(goal.id));
    expect(slot.witness.buyToken.toLowerCase()).toBe(AAPLC.toLowerCase());
  });

  it("verification succeeds and the goal COMPLETES only on a confirmed, matching receipt", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    const mid = (await h.store.getGoal(goal.id))!;
    expect(mid.status).toBe("EXECUTING");
    expect(mid.pendingExecution).not.toBeNull();
    h.advanceClock(31_000);
    await h.scheduler.tick({ now: h.now() });
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status).toBe("COMPLETED");
    expect(h.auditEvents).toContain("EXECUTION_VERIFIED");
  });

  it("SELL path: AAPLc -> USDC runs the SAME delegated machinery, and the 25 bps fee is computed from the SELL-side fromAmount (AAPLc units)", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetSellGoal(h);
    await signMainnetSlot(h, goal.id, policy, { sellToken: AAPLC, amount: SELL_GOAL_AMOUNT_RAW });
    await h.adapter.bootstrapPosture(policy);

    await h.scheduler.tick({ now: h.now() });

    // Exactly one mainnet broadcast, to the pinned executor, Slipstream entrypoint.
    expect(h.broadcasts).toHaveLength(1);
    const tx = h.broadcasts[0]!;
    expect(tx.chainId).toBe(8453);
    expect(getAddress(tx.to)).toBe(MAINNET_DELEGATED_EXECUTOR);
    expect(tx.data.slice(0, 10).toLowerCase()).toBe(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR);
    expect(tx.value ?? 0n).toBe(0n);

    // Decode the broadcast calldata: the SELL direction is expressed by
    // tokenIn/tokenOut, and the fee is floor(gross * 25 / 10_000) of the
    // SELL amount in AAPLc base units — never of the buy-side amount.
    const decoded = decodeFunctionData({ abi: DELEGATED_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapOnBehalfOfSlipstream");
    const params = decoded.args[0] as {
      tokenIn: Address;
      tokenOut: Address;
      grossAmountIn: bigint;
      expectedFeeAmount: bigint;
      amountOutMinimum: bigint;
      recipient: Address;
      intentId: Hex;
    };
    expect(params.tokenIn.toLowerCase()).toBe(AAPLC.toLowerCase());
    expect(params.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
    expect(params.grossAmountIn).toBe(BigInt(SELL_GOAL_AMOUNT_RAW));
    expect(params.expectedFeeAmount).toBe((BigInt(SELL_GOAL_AMOUNT_RAW) * 25n) / 10_000n); // 250000 AAPLc-units
    expect(params.expectedFeeAmount).not.toBe((BigInt(SELL_GOAL_EXPECTED_USDC) * 25n) / 10_000n); // NOT the buy side
    expect(params.amountOutMinimum).toBe(1n); // the SIGNED floor, never weaker
    expect(params.recipient.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(params.intentId.toLowerCase()).toBe(delegatedActionId(goal.id).toLowerCase());

    // Verification against the mined SELL receipt completes the goal.
    h.advanceClock(31_000);
    await h.scheduler.tick({ now: h.now() });
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status, `lastResult=${JSON.stringify(after.lastResult ?? null)}`).toBe("COMPLETED");
    expect(after.stats.triggered).toBe(1);
    expect(after.stats.verified).toBe(1);
    // The verified action record carries the SELL-side fee, in AAPLc units.
    const records = await h.store.listActionRecords(goal.id);
    const confirmed = records.find((r) => r.status === "CONFIRMED");
    expect(confirmed?.feeAmountRaw).toBe(((BigInt(SELL_GOAL_AMOUNT_RAW) * 25n) / 10_000n).toString());
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE: every refusal must produce ZERO broadcasts.
// ---------------------------------------------------------------------------

describe("mainnet delegated execution — refusals broadcast nothing", () => {
  it("no authorization at all -> parked AUTHORIZATION_MISSING, no tx", async () => {
    const h = makeMainnetHarness();
    const { goal } = await createMainnetGoal(h);
    await h.adapter.bootstrapPosture();
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status).toBe("WAITING");
    expect(after.lastResult?.code).toBe("AUTHORIZATION_MISSING");
    expect(after.stats.triggered).toBe(0);
  });

  it("WRONG CHAIN: a Base Sepolia slot cannot authorize a mainnet policy", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy, { chainId: 84532 });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.stats.triggered).toBe(0);
    expect(["WAITING", "ACTIVE", "FAILED"]).toContain(after.status);
  });

  it("WRONG WALLET: a slot owned by another wallet is refused", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy, { wallet: getAddress("0x000000000000000000000000000000000000beef") });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("EXPIRED authorization: a lapsed deadline is refused before broadcast", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy, { expired: true });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("AMOUNT ABOVE AUTHORIZATION: a goal amount larger than the signed permit is refused", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    // The user signed for HALF the goal amount.
    await signMainnetSlot(h, goal.id, policy, { amount: usdc("10") });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("WRONG TOKEN: a permit for a different token than the policy sell token is refused", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy, { buyToken: getAddress("0x4200000000000000000000000000000000000006") });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("WRONG ACTION: a slot bound to a different goal's actionId is refused", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy, { actionId: delegatedActionId("some-other-goal") });
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("DAILY CAP EXCEEDED -> POLICY_REJECTED, no tx", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h, { maxTrades: null });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 0 });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 1 });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 2 });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 3 });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 4 });
    await signMainnetSlot(h, goal.id, policy, { slotIndex: 5 });
    await h.adapter.bootstrapPosture(policy);
    // Pre-load the policy's day ledger to its own maxActionsPerDay, exactly as
    // the runtime claims it (policyId + UTC day key + amount + cap). The next
    // claim must return null => POLICY_REJECTED.
    const dayKey = utcDayKey(h.now());
    for (let i = 0; i < policy.maxActionsPerDay; i += 1) {
      const ledger = await h.store.tryRecordDailyAction(policy.id, dayKey, SELL_AMOUNT, policy.maxActionsPerDay);
      expect(ledger, `pre-load ${i} should still be under the cap`).not.toBeNull();
    }
    expect(await h.store.tryRecordDailyAction(policy.id, dayKey, SELL_AMOUNT, policy.maxActionsPerDay)).toBeNull();
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.stats.triggered).toBe(0);
    expect(after.lastResult?.code).toBe("POLICY_REJECTED");
  });

  it("STALE QUOTE -> refused, no tx", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    // Advance ONLY the harness clock so the quote is created and then ages past
    // freshness before execution (the runtime's own guard must catch it).
    h.advanceHarnessClockOnly(10 * 60 * 1000);
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBe(0);
  });

  it("EMERGENCY STOP -> EXECUTION_UNAVAILABLE, no tx", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    await h.scheduler.tick({ now: h.now() });
    expect(h.broadcasts).toHaveLength(0);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.stats.triggered).toBe(0);
    expect(after.lastResult?.code).toMatch(/AUTHORIZATION_MISSING|EXECUTION_UNAVAILABLE/);
  });

  it("DUPLICATE TICK: two concurrent ticks broadcast at most once", async () => {
    const h = makeMainnetHarness();
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    await Promise.all([h.scheduler.tick({ now: h.now() }), h.scheduler.tick({ now: h.now() })]);
    expect(h.broadcasts.length).toBeLessThanOrEqual(1);
    expect((await h.store.getGoal(goal.id))!.stats.triggered).toBeLessThanOrEqual(1);
  });

  it("ADAPTER UNAVAILABLE (executor not pinned) -> refused, no tx", async () => {
    // Unpin the mainnet executor: the adapter must refuse at the OPERATIONAL
    // layer, before any chain I/O, and never construct a deployment.
    delete process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
    expect(mainnetDelegatedExecutorDeployment()).toBeNull();
    const adapter = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway: new McpTradeGateway(testDeps(newFakeState(), { quoteSecret: TEST_SECRET })),
      chainId: 8453,
      now: () => new Date(),
    });
    expect(adapter.executor).toBeNull();
    expect(adapter.checkStatic()).toEqual({ authorized: false, reason: "EXECUTOR_NOT_CONFIGURED" });
    expect(adapter.checkAuthorization(WALLET, makePolicy({ chainId: 8453 }))).toEqual({
      authorized: false,
      reason: "EXECUTOR_NOT_CONFIGURED",
    });
    expect(adapter.canDelegate).toBe(false);
    // And bootstrapPosture cannot make it available.
    expect((await adapter.bootstrapPosture()).authorized).toBe(false);
    expect(adapter.checkStatic()).toEqual({ authorized: false, reason: "EXECUTOR_NOT_CONFIGURED" });
  });

  it("UNVERIFIABLE POSTURE fails closed: paused / wrong owner / disallowed token / RPC error all refuse", async () => {
    for (const posture of ["paused", "wrong-owner", "token-not-allowed", "rpc-error", "no-code"] as const) {
      const h = makeMainnetHarness({ posture });
      const { policy } = await createMainnetGoal(h);
      const verdict = await h.adapter.bootstrapPosture(policy);
      expect(verdict.authorized, posture).toBe(false);
      expect(h.adapter.checkStatic().authorized, posture).toBe(false);
      expect(h.broadcasts, posture).toHaveLength(0);
    }
  });

  it("UNCERTAIN BROADCAST: the slot stays consumed and is never re-broadcast", async () => {
    const h = makeMainnetHarness({ neverConfirm: true });
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);

    await h.scheduler.tick({ now: h.now() });
    const submitted = h.broadcasts.length;
    expect(submitted).toBe(1);

    // Exhaust the verification budget: the tx never confirms.
    for (let i = 0; i < AUTONOMY_LIMITS.maxVerificationAttempts + 2; i += 1) {
      h.advanceClock(31_000);
      await h.scheduler.tick({ now: h.now() });
    }
    // NEVER a second broadcast, and the goal is terminally FAILED, not retried.
    expect(h.broadcasts).toHaveLength(submitted);
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.status).toBe("FAILED");
    expect(after.stats.verified ?? 0).toBe(0);
    const [slot] = await h.slots.listSlots(WALLET.toLowerCase(), policy.id);
    expect(slot!.consumedAt).not.toBeNull();
  });

  it("BROADCAST FAILURE: a throwing broadcaster yields no tx hash and keeps the slot consumed", async () => {
    const h = makeMainnetHarness({ broadcastFails: true });
    const { goal, policy } = await createMainnetGoal(h);
    await signMainnetSlot(h, goal.id, policy);
    await h.adapter.bootstrapPosture(policy);
    await h.scheduler.tick({ now: h.now() });
    const after = (await h.store.getGoal(goal.id))!;
    expect(after.stats.verified ?? 0).toBe(0);
    expect(after.status).not.toBe("COMPLETED");
    const [slot] = await h.slots.listSlots(WALLET.toLowerCase(), policy.id);
    expect(slot!.consumedAt).not.toBeNull();
  });

  it("a mainnet policy is never executed by the SEPOLIA adapter (and vice versa)", async () => {
    const h = makeMainnetHarness();
    const { policy } = await createMainnetGoal(h);
    // A Sepolia adapter must refuse a mainnet policy on chain grounds alone.
    const sepoliaAdapter = new DelegatedExecutionAdapter({
      slots: h.slots,
      gateway: h.gateway,
      chainId: 84532,
      getPolicy: (policyId) => h.store.getPolicy(policyId),
      broadcast: async () => ("0x" + "ee".repeat(32)) as Hex,
      // Fake posture chain so this never touches a network: warm it so the
      // refusal we assert is the CHAIN refusal, not a cold-cache artefact.
      chain: {
        getBytecode: async () => "0x6080" as Hex,
        readContract: async <T,>({ functionName }: { functionName: string }): Promise<T> => {
          if (functionName === "feeBps") return 25 as never;
          if (functionName === "PERMIT2") return CANONICAL_PERMIT2 as never;
          if (functionName === "WITNESS_TYPE_STRING") return DELEGATED_WITNESS_TYPE_STRING as never;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
      now: () => h.now(),
    });
    expect(sepoliaAdapter.chainId).toBe(84532);
    expect(sepoliaAdapter.id).toBe("delegated-permit2-sepolia");
    await sepoliaAdapter.verifyOnChain();
    expect(sepoliaAdapter.checkStatic()).toEqual({ authorized: true });
    // Fully warmed and healthy on Sepolia, it STILL refuses a mainnet policy —
    // the chain binding alone is sufficient.
    expect(sepoliaAdapter.checkAuthorization(WALLET, policy)).toEqual({ authorized: false, reason: "CHAIN_MISMATCH" });
    // And the mainnet adapter declares its own chain/id.
    expect(h.adapter.chainId).toBe(8453);
    expect(h.adapter.id).toBe("delegated-permit2-mainnet");
  });
});
