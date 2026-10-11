// lib/autonomy/__tests__/mainnet-canary.execution.test.ts
//
// MAINNET CANARY — the ONE-transaction readiness BUY (1.00 USDC -> AAPLc)
// through the REAL Mainnet runtime path (Goal -> Scheduler -> Policy -> fresh
// quote -> v1 prepare -> broadcast -> receipt verification -> audit -> goal
// state) against Base Mainnet 8453.
//
// FAIL-CLOSED GATING — this file is SKIPPED unless ALL of the following hold:
//   MPGR_MAINNET_CANARY === "true"          (explicit arm — never a default)
//   MPGR_MAINNET_CANARY_PRIVATE_KEY         (DEDICATED canary key; never the
//                                            user's wallet, deployer, or the
//                                            Sepolia broadcaster)
//   BASE_MAINNET_RPC_URL                    (dedicated Mainnet RPC; a localhost
//                                            endpoint is refused outright)
// No Vercel/app environment ever sets these; autonomous execution stays OFF in
// the product. The canary key must be PRE-FUNDED (>= 1 USDC + gas) and
// PRE-APPROVED (allowance to the executor >= 1 USDC) — the preflight
// (scripts/mainnet-canary-preflight.mjs) enforces both, so this canary is
// EXACTLY ONE broadcast transaction.

import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";

import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { allowAutonomousEmergencySwitchForTests } from "@/lib/autonomy/emergency-switch";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { isAutonomousExecutionEmergencyDisabled } from "@/lib/autonomy/config";
import { readTransactionReceiptWithFallback, waitForTransactionReceiptWithFallback, type ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_USDC,
  CANONICAL_PERMIT2,
  MPGR_EXECUTOR_DEPLOYMENTS,
} from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { DELEGATED_EXECUTOR_ADDRESS } from "@/lib/executor/delegated-executor";
import { delegatedBroadcasterAddress } from "@/lib/delegated/delegated-broadcaster";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import type { AutonomousExecutionAdapter, DelegatedSwapRequest, DelegatedSwapResult } from "@/lib/autonomy/types";
import type { McpDeps } from "@/lib/mcp/mcp-trade-service";

const ARMED = process.env.MPGR_MAINNET_CANARY === "true" && !!process.env.MPGR_MAINNET_CANARY_PRIVATE_KEY?.trim();
const RPC = process.env.BASE_MAINNET_RPC_URL?.trim() ?? "";
const KEY = (process.env.MPGR_MAINNET_CANARY_PRIVATE_KEY?.trim() ?? "") as `0x${string}` | "";

const AAPLc = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol === "AAPLc")!.address as Address;
const GROSS = 1_000_000n; // 1.00 USDC — the entire canary exposure
const EXPECTED_FEE = (GROSS * 25n) / 10_000n; // 2_500 raw (25 bps)
const silentLogger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!ARMED)("MAINNET CANARY — one real 1-USDC BUY through the Mainnet runtime path (operator-armed)", () => {
  it("executes exactly ONE buy, verifies every receipt fact, completes the goal", async () => {
    if (isAutonomousExecutionEmergencyDisabled()) throw new Error("MPGR_AUTONOMOUS_EMERGENCY_DISABLE is set — canary refuses to run.");
    if (!RPC || /^https?:\/\/(127\.|localhost)/i.test(RPC)) throw new Error("BASE_MAINNET_RPC_URL must be a real dedicated Mainnet endpoint.");
    const account: PrivateKeyAccount = privateKeyToAccount(KEY as `0x${string}`);
    // FAIL-CLOSED CANARY PIN (audit remediation): the configured key MUST
    // derive to the ONE authorized canary wallet. This runs BEFORE any
    // network activity, signing, or broadcast — a wrong key can never trade.
    const AUTHORIZED_CANARY_ADDRESS = getAddress("0xBF6c574b9543967f0D528ae49603b0A7574a280b");
    if (getAddress(account.address) !== AUTHORIZED_CANARY_ADDRESS) {
      throw new Error("FATAL: canary key does not derive to the authorized canary address — nothing was signed, read, or broadcast.");
    }
    const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
    const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });

    // ---- read-only pre-assertions (fail closed BEFORE anything is signed) ----
    expect(await publicClient.getChainId()).toBe(8453);
    const pinned = BASE_MAINNET_EXECUTOR_DEPLOYMENT;
    const [owner, feeRecipient, feeBps, paused] = await Promise.all([
      publicClient.readContract({ address: pinned.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "owner" }),
      publicClient.readContract({ address: pinned.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "feeRecipient" }),
      publicClient.readContract({ address: pinned.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "feeBps" }),
      publicClient.readContract({ address: pinned.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "paused" }),
    ]);
    expect(String(owner).toLowerCase()).toBe(pinned.owner.toLowerCase());
    expect(String(feeRecipient).toLowerCase()).toBe(pinned.feeRecipient.toLowerCase());
    expect(Number(feeBps)).toBe(25);
    expect(paused).toBe(false);
    // separation: the canary key is nobody else in the system
    expect(account.address.toLowerCase()).not.toBe(pinned.owner.toLowerCase());
    expect(account.address.toLowerCase()).not.toBe(pinned.feeRecipient.toLowerCase());
    expect(account.address.toLowerCase()).not.toBe(DELEGATED_EXECUTOR_ADDRESS.toLowerCase());
    // SEPOLIA-BROADCASTER REUSE GUARD (deterministic, fail-closed, both ways):
    // (1) if this runner carries the Sepolia broadcaster env, the canary key
    //     must NOT be that account; (2) the operator may pin the Sepolia
    //     broadcaster's ADDRESS (non-secret) via SEPOLIA_BROADCASTER_ADDRESS —
    //     equality with the canary address is fatal. The canary is MAINNET-only
    //     and the Sepolia broadcaster is 84532-only; they can never be the same
    //     account.
    const sepoliaBroadcaster = delegatedBroadcasterAddress();
    if (sepoliaBroadcaster && sepoliaBroadcaster.toLowerCase() === account.address.toLowerCase()) {
      throw new Error("FATAL: the canary key IS the Sepolia broadcaster — provision a DEDICATED Mainnet canary key. Nothing was broadcast.");
    }
    const pinnedSepoliaBroadcaster = process.env.SEPOLIA_BROADCASTER_ADDRESS?.trim().toLowerCase();
    if (pinnedSepoliaBroadcaster && pinnedSepoliaBroadcaster === account.address.toLowerCase()) {
      throw new Error("FATAL: canary address equals SEPOLIA_BROADCASTER_ADDRESS — a dedicated Mainnet canary key is required. Nothing was broadcast.");
    }
    // funded + pre-approved -> the canary is ONE transaction
    const usdcBalance = (await publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
    const allowance = (await publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, pinned.executor] })) as bigint;
    if (usdcBalance < GROSS) throw new Error(`canary USDC ${usdcBalance} < ${GROSS} — fund the dedicated canary wallet first.`);
    if (allowance < GROSS) throw new Error(`canary allowance ${allowance} < ${GROSS} — run the preflight approval FIRST (canary must be ONE transaction).`);
    expect(String(await publicClient.readContract({ address: pinned.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "PERMIT2" })).toLowerCase()).toBe(CANONICAL_PERMIT2.toLowerCase());

    // ---- the real runtime chain ----
    const reader: ChainReader = {
      chainId: 8453,
      readContract: (a) => publicClient.readContract(a as never),
      simulateContract: (a) => publicClient.simulateContract(a as never),
      getBalance: (a) => publicClient.getBalance(a),
      getTransactionReceipt: async ({ hash }) =>
        readTransactionReceiptWithFallback(8453, hash, async () => {
          const r = await publicClient.getTransactionReceipt({ hash: hash as Hex });
          return { status: r.status, transactionHash: r.transactionHash, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: r.logs };
        }) as never,
    };
    const deps = {
      registry: MPGR_EXECUTOR_DEPLOYMENTS,
      delegatedRegistry: { 84532: (await import("@/lib/executor/delegated-executor")).BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
      reader: () => reader,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      quoteSecret: `mainnet-canary-operator-armed-${Date.now()}`,
      mainnetEnabled: true,
      mainnetFeeRecipient: pinned.feeRecipient as Address,
    } as unknown as McpDeps;

    const store = new InMemoryAutonomyStore();
    store.clock = () => Date.now();
    const bus = new InMemoryEventBus();
    const audit: Array<{ event?: { type?: string } }> = [];
    bus.on("autonomy_audit", (payload: unknown) => audit.push(payload as { event?: { type?: string } }));
    const perf: PerformanceMonitor = new InMemoryPerformanceMonitor();
    const broadcasts: Array<Record<string, unknown>> = [];
    const adapter: AutonomousExecutionAdapter & { requests: Array<Record<string, unknown>> } = {
      requests: broadcasts,
      id: "mainnet-canary",
      canDelegate: true,
      checkAuthorization: () => ({ authorized: true }),
      async executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
        broadcasts.push(request as unknown as Record<string, unknown>);
        const prepared = request.transactionRequest as { to: `0x${string}`; data: `0x${string}` } | null;
        if (!prepared?.to || !prepared?.data) return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "no prepared transaction" };
        const hash = await wallet.sendTransaction({ chain: undefined, account, to: prepared.to, data: prepared.data, gas: 600_000n });
        return { ok: true, txHash: hash };
      },
    } as never;
    allowAutonomousEmergencySwitchForTests();
    const runtime = new AutonomyRuntime({
      store,
      gateway: new McpTradeGateway(deps),
      adapter,
      audit: new BusAuditSink(store, bus, perf),
      logger: silentLogger,
      performanceMonitor: perf,
      now: () => new Date(),
    });
    const scheduler = new AutonomyScheduler(store, runtime, silentLogger, perf);

    // TINY canary limits: 1 USDC per trade, 2 USDC daily, ONE action, 100 bps slippage.
    const policy = await store.createPolicy({
      id: "", wallet: account.address, chainId: 8453, actions: ["swap"],
      sellToken: BASE_MAINNET_USDC, buyToken: AAPLc,
      maxPerTradeRaw: GROSS.toString(), maxDailyRaw: (2n * GROSS).toString(),
      maxSlippageBps: 300, maxActionsPerDay: 1,
      enabled: true, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      authorizedAt: new Date().toISOString(), authorizationRef: "mainnet-canary-operator-armed",
    });
    await store.createGoal({
      id: "", wallet: account.address, policyId: policy!.id, type: "conditional_swap",
      description: "MAINNET CANARY — one 1-USDC BUY (operator-armed)", status: "ACTIVE",
      condition: { kind: "price_below", threshold: "1000000" }, // deterministic: canary is not price-timed
      trade: { sellToken: BASE_MAINNET_USDC, buyToken: AAPLc, sellAmountRaw: GROSS.toString(), slippageBps: 100, sellDecimals: 6, buyDecimals: 8 },
      cooldownSeconds: 3600, maxTrades: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), nextEvaluationAt: new Date().toISOString(),
      lastAction: null, lastResult: null, pendingExecution: null,
      stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    } as never);

    // ---- THE one broadcast ----
    const submit = await scheduler.tick({ now: new Date() });
    expect(submit.results[0]?.kind, JSON.stringify(submit.results)).toBe("EXECUTION_SUBMITTED");
    expect(broadcasts).toHaveLength(1);
    const goalId = (await store.listGoals(account.address))[0]!.id;
    const txHash = (await store.getGoal(goalId))!.pendingExecution!.txHash as Hex;

    // Receipt wait is endpoint-resilient: the primary RPC may serve JSON-RPC
    // archive-policy rejections for ordinary receipt reads (observed live on
    // the successful canary). Verification FACTS are unchanged — status,
    // from, to, logs and the SwapExecuted event are still proven below.
    const receipt = await waitForTransactionReceiptWithFallback(8453, txHash, reader, { timeoutMs: 240_000, intervalMs: 2_000 });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(receipt.to?.toLowerCase()).toBe(pinned.executor.toLowerCase());

    // ---- every receipt fact must match the intent ----
    const swapTopic = MPGR_EXECUTOR_ABI.find((x) => x.type === "event" && x.name === "SwapExecuted");
    let ev: Record<string, unknown> | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== pinned.executor.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [swapTopic!] as never, data: log.data, topics: log.topics as never }) as unknown as { args: Record<string, unknown> };
        if (String(decoded.args.taker).toLowerCase() === account.address.toLowerCase()) { ev = decoded.args; break; }
      } catch { /* not the executor event */ }
    }
    expect(ev, "exactly one SwapExecuted from the executor for this canary").toBeTruthy();
    expect(ev!["tokenIn"]).toBe(BASE_MAINNET_USDC);
    expect((ev!["tokenOut"] as string).toLowerCase()).toBe(AAPLc.toLowerCase());
    expect(ev!["grossAmountIn"]).toBe(GROSS);
    expect(ev!["feeAmount"]).toBe(EXPECTED_FEE); // EXACT 25 bps
    expect(Number(ev!["feeBps"])).toBe(25);
    expect(String(ev!["feeRecipient"]).toLowerCase()).toBe(pinned.feeRecipient.toLowerCase());
    expect(ev!["flags"]).toBe(0); // ERC20 -> ERC20
    const amountOut = ev!["amountOut"] as bigint;
    expect(amountOut > 0n).toBe(true);

    // ---- runtime verification pass -> goal COMPLETED; never a second tx ----
    await new Promise((r) => setTimeout(r, AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 5_000));
    await scheduler.tick({ now: new Date() });
    const goal = (await store.getGoal(goalId))!;
    expect(goal.status, JSON.stringify(goal.lastResult)).toBe("COMPLETED");
    expect(broadcasts, "the canary is EXACTLY ONE transaction").toHaveLength(1);

    // ordered audit chain
    const types = audit.map((p) => p.event?.type ?? "");
    const order = ["QUOTE_CREATED", "CONDITION_CHECKED", "CONDITION_MET", "POLICY_APPROVED", "AUTHORIZATION_CHECKED", "TRADE_PREPARED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"];
    let last = -1;
    for (const expected of order) {
      const idx = types.indexOf(expected);
      expect(idx, `missing/out-of-order ${expected}: ${types.join(",")}`).toBeGreaterThan(last);
      last = idx;
    }
    const dumped = JSON.stringify(audit);
    expect(dumped).not.toMatch(/privateKey|PRIVATE_KEY|mnemonic/i);
    expect(dumped).not.toMatch(/0x[a-fA-F0-9]{130}/);

    writeFileSync("mainnet-canary-tx.txt", `${txHash} ${receipt.blockNumber} ${amountOut}`);
    console.error(`::error::MAINNET_CANARY ok tx=${txHash} block=${receipt.blockNumber} grossRaw=${GROSS} feeRaw=${EXPECTED_FEE} amountOutRaw=${amountOut} goal=COMPLETED broadcasts=1`);
  }, 600_000);
});
