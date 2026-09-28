// Shared fixtures for the autonomy runtime tests. Reuses the MCP test
// fixtures (fake ChainReader + real deployed mainnet registry) so the
// runtime exercises the REAL MCP quote/prepare/status/verify functions —
// only the chain reader and the (hypothetical) delegation adapter are fake.
import { decodeFunctionData, type Hex } from "viem";

import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import type { AutonomousExecutionAdapter, AutonomyFailureCode, AutonomyPolicy, DelegatedSwapRequest, DelegatedSwapResult } from "@/lib/autonomy/types";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import type { EventBus, Logger } from "@/lib/architecture/core/types";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";

import {
  EXECUTOR,
  MAINNET_EXECUTOR,
  MAINNET_REGISTRY,
  fakeReader,
  MAINNET_SLIP_ROUTER,
  MAINNET_USDC,
  TEST_SECRET,
  newFakeState,
  setAllowance,
  setBalance,
  swapExecutedLog,
  testDeps,
  type FakeChainState,
} from "@/lib/mcp/__tests__/fixtures";
import { RouterKind } from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";

export const WALLET = "0x0000000000000000000000000000000000d0e541" as `0x${string}`;
export const USDC = MAINNET_USDC;
export const silentLogger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };

export interface DelegatingOptions {
  authorized?: boolean;
  reason?: string;
  /** Build a receipt for the prepared intent (simulates a landed tx). */
  mineReceipt?: boolean;
  /** Force the "executed but never confirmable" case. */
  neverConfirm?: boolean;
  /** Return a failure instead of broadcasting. */
  failWith?: { code: AutonomyFailureCode; message: string };
  requests: DelegatedSwapRequest[];
}

/** Test-ONLY adapter simulating a future user-controlled session-key wallet. */
export function makeDelegatingAdapter(state: FakeChainState, options: DelegatingOptions = { requests: [] }): AutonomousExecutionAdapter & { options: DelegatingOptions } {
  return {
    id: "test-session-key",
    canDelegate: options.authorized ?? true,
    options,
    checkAuthorization() {
      return { authorized: options.authorized ?? true, reason: options.reason };
    },
    async executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
      options.requests.push(request);
      if (options.failWith) return { ok: false, ...options.failWith };
      if (!options.mineReceipt && !options.neverConfirm) return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "test adapter does not broadcast" };
      const txHash = `0x${"7e".repeat(32)}` as Hex;
      if (!options.neverConfirm) {
        const swap = request.transactionRequest as { to: string; data: Hex } | null;
        const decoded = swap ? decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: swap.data }) : null;
        const params = decoded?.args?.[0] as { intentId: Hex } | undefined;
        const sell = BigInt(request.sellAmountRaw);
        const fee = (sell * 25n) / 10_000n;
        state.receipts.set(txHash.toLowerCase(), {
          status: "success",
          transactionHash: txHash,
          blockNumber: 42n,
          from: request.wallet,
          to: MAINNET_EXECUTOR,
          logs: [
            swapExecutedLog(MAINNET_EXECUTOR, {
              taker: request.wallet,
              router: MAINNET_SLIP_ROUTER,
              intentId: params?.intentId ?? `0x${"11".repeat(32)}`,
              tokenIn: request.sellToken,
              tokenOut: request.buyToken,
              grossAmountIn: sell,
              feeAmount: fee,
              swapAmountIn: sell - fee,
              amountOut: BigInt(request.expectedBuyAmountRaw),
              feeRecipient: state.feeRecipient,
              feeBps: state.feeBps,
              routerKind: RouterKind.AERODROME_SLIPSTREAM,
              flags: 0,
            }),
          ],
        } as never);
      }
      return { ok: true, txHash };
    },
  };
}

export interface TestHarness {
  store: InMemoryAutonomyStore;
  bus: EventBus;
  auditEvents: string[];
  adapter: ReturnType<typeof makeDelegatingAdapter>;
  runtime: AutonomyRuntime;
  scheduler: AutonomyScheduler;
  state: FakeChainState;
  now: () => Date;
  setClock: (ms: number) => void;
  /** Advances BOTH the harness clock and the MCP deps clock together. */
  advanceClock: (ms: number) => void;
  /** Advances ONLY the harness clock — used to prove quote-freshness guards. */
  advanceHarnessClockOnly: (ms: number) => void;
}

export function makeHarness(adapterOverrides: DelegatingOptions = { requests: [] }): TestHarness {
  const state = newFakeState();
  state.feeBps = 25;
  const clock = { ms: 1_800_000_000_000 };
  const store = new InMemoryAutonomyStore();
  store.clock = () => clock.ms;
  const bus = new InMemoryEventBus();
  const auditEvents: string[] = [];
  bus.on("autonomy_audit", (payload) => auditEvents.push(payload.event.type));
  const perf = new InMemoryPerformanceMonitor();
  const audit = new BusAuditSink(store, bus, perf);
  const adapter = makeDelegatingAdapter(state, adapterOverrides);
  const deps = testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? MAINNET_EXECUTOR : EXECUTOR),
  });
  const gateway = new McpTradeGateway(deps);
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
    store,
    bus,
    auditEvents,
    adapter,
    runtime,
    scheduler,
    state,
    now: () => new Date(clock.ms),
    setClock: (ms: number) => {
      clock.ms = ms;
      deps.clock.now = Math.floor(ms / 1000);
    },
    advanceClock: (ms: number) => {
      clock.ms += ms;
      deps.clock.now = Math.floor(clock.ms / 1000);
    },
    advanceHarnessClockOnly: (ms: number) => {
      clock.ms += ms;
    },
  };
}

export function usdc(amountHuman: string): string {
  const [int, frac = ""] = amountHuman.split(".");
  return BigInt(int + frac.padEnd(6, "0").slice(0, 6)).toString();
}

export function makePolicy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  const now = new Date();
  return {
    id: "pol_test_1",
    wallet: WALLET,
    chainId: 8453,
    actions: ["swap"],
    sellToken: USDC,
    buyToken: "0xb200000000000000000000C2e324d24d7eEcd1fb", // AAPLc from the deployed registry fixture
    maxPerTradeRaw: usdc("20"),
    maxDailyRaw: usdc("50"),
    maxSlippageBps: 100,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: now.toISOString(),
    // Far-future by default; tests override explicitly when testing expiry.
    expiresAt: new Date(now.getTime() + 3650 * 86_400_000).toISOString(),
    authorizedAt: now.toISOString(),
    authorizationRef: "sess:test:digest",
    ...over,
  };
}

export function fundWallet(state: FakeChainState, amountRaw: string): void {
  setBalance(state, USDC, WALLET, BigInt(amountRaw));
  setAllowance(state, USDC, WALLET, MAINNET_REGISTRY[8453]!.executor, BigInt(amountRaw) * 10n);
}

export async function createActiveGoal(
  harness: TestHarness,
  over: Partial<Parameters<InMemoryAutonomyStore["createGoal"]>[0]> = {},
  policyOver: Partial<AutonomyPolicy> = {},
) {
  const policy = over.policyId ? await harness.store.getPolicy(over.policyId) : await harness.store.createPolicy(makePolicy(policyOver));
  const now = harness.now();
  const goal = await harness.store.createGoal({
    id: "",
    wallet: WALLET,
    policyId: policy!.id,
    type: "conditional_swap",
    description: "Buy AAPLc below 200",
    status: "ACTIVE",
    condition: { kind: "price_below", threshold: "200" },
    trade: {
      sellToken: policy!.sellToken,
      buyToken: policy!.buyToken,
      sellAmountRaw: usdc("20"),
      slippageBps: 100,
      sellDecimals: 6,
      buyDecimals: 8,
    },
    cooldownSeconds: 60,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    nextEvaluationAt: now.toISOString(),
    lastAction: null,
    lastResult: null,
    pendingExecution: null,
    stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    ...over,
  });
  return { goal, policy: policy! };
}
