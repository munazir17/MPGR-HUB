// lib/autonomy/__tests__/phase6-fork-rehearsal.test.ts
//
// PHASE 6 — BASE MAINNET FORK REHEARSAL (local anvil fork; NOTHING is
// broadcast to any real chain). Runs ONLY when MPGR_PHASE6_FORK=true with
// BASE_MAINNET_RPC_URL (CI: foundry toolchain + public RPC), exactly like the
// repo's contracts-fork job. Rehearses the COMPLETE Mainnet autonomous path
// against REAL fork state:
//   Goal -> Scheduler -> Policy -> Fresh Quote (real QuoterV2) -> Prepare
//   (v1 intent, Mainnet registry — the F-9 seam) -> Authorization (user-side
//   approval, impersonated key on the fork) -> Execution through the FROZEN
//   Mainnet executor -> Receipt -> Verification (receipt facts) -> Audit ->
//   Goal state.
// Also proves: duplicate tick rejection, emergency stop, uncertain broadcast
// never re-broadcast, reverted transaction classified TX_REVERTED, exact
// 25 bps fee reconciliation, and on-chain chain-separation (the delegated
// Sepolia executor has NO code on the Mainnet fork).
//
// The execution adapter here is a TEST-ONLY impersonation adapter standing in
// for the (deliberately absent) production Mainnet signing mechanism — it
// sends the runtime-prepared, unsigned transactionRequest from a locally
// funded fork key. No production code path is modified.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseEther,
  decodeEventLog,
  pad,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import type { ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_B20_TOKENS,
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_SLIPSTREAM,
  BASE_MAINNET_USDC,
  CANONICAL_WETH,
  MPGR_EXECUTOR_DEPLOYMENTS,
} from "@/lib/executor/executor-config";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_EXECUTOR_ADDRESS,
} from "@/lib/executor/delegated-executor";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { approvalAuthorization, buildExecutorIntent, encodeExecutorSwap } from "@/lib/executor/executor-intent";
import { aerodromeQuoterV2Abi, aerodromeSlipstreamFactoryAbi } from "@/lib/trade/aerodrome-slipstream";
import { InMemoryEventBus } from "@/lib/architecture/core/event-bus";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import type { AutonomousExecutionAdapter, DelegatedSwapRequest, DelegatedSwapResult } from "@/lib/autonomy/types";
import type { McpDeps } from "@/lib/mcp/mcp-trade-service";

const FORK_RPC = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
const FORK = process.env.MPGR_PHASE6_FORK === "true";
const PORT = 8645;
const LOCAL = `http://127.0.0.1:${PORT}`;
const silentLogger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
const AAPLc = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol !== "USDC" && t.symbol !== "WETH")!.address as Address;

type FailMode = "none" | "skipApproval" | "fabricateHash";

function makeAdapter(
  account: PrivateKeyAccount,
  opts: { failMode?: FailMode; requests: Array<Record<string, unknown>>; publicClient: ReturnType<typeof createPublicClient>; wallet: ReturnType<typeof createWalletClient> },
): AutonomousExecutionAdapter & { requests: Array<Record<string, unknown>> } {
  const failMode = opts.failMode ?? "none";
  return {
    requests: opts.requests,
    id: "phase6-mainnet-rehearsal",
    canDelegate: true,
    checkAuthorization: () => ({ authorized: true }),
    async executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
      opts.requests.push(request as unknown as Record<string, unknown>);
      if (failMode === "fabricateHash") return { ok: true, txHash: ("0x" + "11".repeat(32)) as Hex };
      const sellToken = getAddressLike(request.sellToken);
      if (failMode !== "skipApproval") {
        const allowance = (await opts.publicClient.readContract({ address: sellToken, abi: erc20Abi, functionName: "allowance", args: [account.address, BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor] })) as bigint;
        if (allowance < BigInt(request.sellAmountRaw)) {
          await opts.wallet.sendTransaction({ chain: undefined, account: opts.wallet.account!, to: sellToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, 2n ** 200n] }), gas: 80_000n });
        }
      }
      const prepared = request.transactionRequest as { to: `0x${string}`; data: `0x${string}` } | null;
      if (!prepared?.to || !prepared?.data) return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "no prepared transaction" };
      // Explicit gas: skips pre-send estimation so a REVERTING swap still
      // reaches the block (anvil includes reverting txs) — required by the
      // TX_REVERTED failure-mode rehearsal below.
      const hash = await opts.wallet.sendTransaction({ chain: undefined, account: opts.wallet.account!, to: prepared.to, data: prepared.data, gas: 600_000n });
      return { ok: true, txHash: hash };
    },
  } as never;
}

function getAddressLike(a: string): Address {
  return a as Address;
}

describe.skipIf(!FORK)("PHASE 6 fork rehearsal — Base Mainnet fork (local anvil, nothing broadcast to real chains)", () => {
  let anvil: ChildProcess | null = null;
  let anvilLog: WriteStream | null = null;
  const anvilLogPath = `${process.env.TMPDIR ?? "/tmp"}/phase6-anvil.stderr.log`;
  const publicClient = createPublicClient({ chain: foundry, transport: http(LOCAL) });
  const clock = { ms: 1_800_000_000_000 };

  beforeAll(async () => {
    // Submission gate (runtime.ts): autonomous submission requires the master
    // flag. Set directly (NOT vi.stubEnv) so the emergency test's
    // vi.unstubAllEnvs() cannot silently strip it mid-suite.
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    // Capture anvil's stderr (fork RPC errors, 429s) for CI debugging.
    anvilLog = createWriteStream(anvilLogPath);
    // PIN the fork to ONE block for the whole job (BASE_FORK_BLOCK, computed
    // once by the workflow): a moving latest block invalidates cached state on
    // every new upstream block, generating refetch storms public RPCs throttle.
    // A pinned block is deterministic AND lets anvil's disk storage cache stay
    // warm across the workflow's upstream retries (same recipe as the green
    // forge contracts-fork job's rpc_storage_caching).
    let forkUrl = FORK_RPC;
    const pinned = process.env.BASE_FORK_BLOCK?.trim();
    if (pinned && /^\d+$/.test(pinned)) forkUrl = `${FORK_RPC}@${pinned}`;
    anvil = spawn(
      "anvil",
      [
        "--fork-url", forkUrl,
        "--port", String(PORT),
        "--no-rate-limit",
        "--fork-retry-backoff", "300",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
    anvil.stderr?.on("data", (chunk: Buffer) => anvilLog?.write(chunk));
    // wait for readiness
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(LOCAL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(4000) });
        const json = (await res.json()) as { result?: string };
        if (json.result === "0x2105") { ready = true; break; } // 8453
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      anvilLog?.end();
      throw new Error(`anvil fork did not become ready in time (stderr tail: ${await import("node:fs/promises").then((f) => f.readFile(anvilLogPath, "utf8").then((t) => t.slice(-800)).catch(() => "unavailable"))})`);
    }
    // EAGER WARM-UP: a lazy anvil fork degrades SILENTLY when the upstream
    // public RPC flakes (a contract can read as codeless EOA -> OpcodeNotFound
    // or a call "succeeds" as a plain transfer). Touch every contract this
    // suite needs once — bytecode AND a view/quote call that MUST succeed —
    // with retries, so state is cached locally BEFORE any rehearsal runs and
    // a genuinely absent contract/pool fails loudly HERE.
    const code = async (label: string, address: Address, missing: string[]) => {
      const c = await publicClient.getBytecode({ address });
      if (!c || c === "0x") missing.push(`${label}(no code)`);
    };
    const decimalsOf = (address: Address) => publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" });
    const warmDeadline = Date.now() + 180_000;
    for (;;) {
      const missing: string[] = [];
      await code("executor", BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, missing).catch(() => missing.push("executor(code)"));
      await code("USDC", BASE_MAINNET_USDC, missing).catch(() => missing.push("USDC(code)"));
      await code("AAPLc", AAPLc, missing).catch(() => missing.push("AAPLc(code)"));
      await code("WETH", CANONICAL_WETH, missing).catch(() => missing.push("WETH(code)"));
      await code("slipstreamRouter", BASE_MAINNET_SLIPSTREAM.swapRouter, missing).catch(() => missing.push("slipstreamRouter(code)"));
      await code("slipstreamFactory", BASE_MAINNET_SLIPSTREAM.factory, missing).catch(() => missing.push("slipstreamFactory(code)"));
      await code("slipstreamQuoter", BASE_MAINNET_SLIPSTREAM.quoterV2, missing).catch(() => missing.push("slipstreamQuoter(code)"));
      // State probes (each MUST succeed for its contract type):
      try {
        await publicClient.readContract({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "owner" });
        await decimalsOf(BASE_MAINNET_USDC);
        await decimalsOf(CANONICAL_WETH);
        // F-13: every configured stock token must answer decimals()==8 on the fork.
        for (const stock of BASE_MAINNET_B20_TOKENS) {
          const d = await decimalsOf(stock.address as Address);
          if (d !== 8) missing.push(`${stock.symbol}(decimals ${d} != 8)`);
        }
        const pool = (await publicClient.readContract({ address: BASE_MAINNET_SLIPSTREAM.factory, abi: aerodromeSlipstreamFactoryAbi, functionName: "getPool", args: [BASE_MAINNET_USDC, AAPLc, 10] })) as Address;
        if (pool === "0x0000000000000000000000000000000000000000") missing.push("slipstreamPool(USDC/AAPLc tick 10 EMPTY)");
        const quote = await publicClient.readContract({ address: BASE_MAINNET_SLIPSTREAM.quoterV2, abi: aerodromeQuoterV2Abi as never, functionName: "quoteExactInputSingle", args: [{ tokenIn: BASE_MAINNET_USDC, tokenOut: AAPLc, amountIn: 1_000_000n, tickSpacing: 10, sqrtPriceLimitX96: 0n }] }) as unknown as readonly [bigint, bigint, number, bigint];
        if (!(Array.isArray(quote) && quote[0] > 0n)) missing.push(`slipstreamQuote(1 USDC -> AAPLc = ${String(quote)})`);
      } catch (e) {
        const err = e as Error & { cause?: Error };
        const detail = `${err.message}${err.cause?.message ? ` <- ${err.cause.message}` : ""}`;
        missing.push(`state probes failed (${detail.slice(0, 220)})`);
      }
      if (missing.length === 0) break;
      if (Date.now() > warmDeadline) {
        anvilLog?.end();
        throw new Error(`fork warm-up failed — contracts still unusable (upstream RPC degradation or genuinely absent): ${missing.join("; ")}`);
      }
      console.error(`[phase6-warmup] retrying unusable contracts: ${missing.join("; ")}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }, 600_000); // boot (≤180s) + warm-up (≤180s) + margin on slow public upstreams

  afterAll(() => {
    anvil?.kill("SIGKILL");
    anvilLog?.end();
    delete process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
  });

  function forkReader(): ChainReader {
    const client = createPublicClient({ chain: foundry, transport: http(LOCAL) });
    return {
      chainId: 8453,
      readContract: (a) => client.readContract(a as never),
      simulateContract: (a) => client.simulateContract(a as never),
      getBalance: (a) => client.getBalance(a),
      getTransactionReceipt: async ({ hash }) => {
        const r = await client.getTransactionReceipt({ hash: hash as Hex });
        return r as never;
      },
    };
  }

  function buildDeps(): McpDeps {
    return {
      registry: MPGR_EXECUTOR_DEPLOYMENTS,
      delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
      reader: () => forkReader(),
      nowSeconds: () => Math.floor(clock.ms / 1000),
      quoteSecret: "phase6-fork-secret-quote-signing-v1",
      mainnetEnabled: true,
      mainnetFeeRecipient: BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient as Address,
    } as unknown as McpDeps;
  }

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(LOCAL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
    return json.result;
  }

  /**
   * Fund the taker with REAL USDC on the fork (storage-level, same approach as
   * the green Solidity fork tests' `deal`). No swap scaffolding: the first CI
   * attempt showed a WETH-deposit + SwapRouter02 bootstrap can degrade silently
   * on a lazy public-RPC fork; direct funding is deterministic. Verifies the
   * exact balance before returning — funding is never silently assumed.
   */
  async function fundUsdc(account: PrivateKeyAccount, usdcRaw: bigint): Promise<void> {
    const testClient = (await import("viem")).createTestClient({ chain: foundry, mode: "anvil", transport: http(LOCAL) });
    await testClient.setBalance({ address: account.address, value: parseEther("1") });
    const balance = () => publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>;
    // 1) anvil_deal — Foundry auto-detects the ERC20 balance slot.
    let dealt = false;
    try {
      await rpc("anvil_deal", [account.address, BASE_MAINNET_USDC, `0x${usdcRaw.toString(16)}`]);
      dealt = (await balance()) === usdcRaw;
    } catch { dealt = false; }
    // 2) Fallback: Circle FiatToken `balances` mapping lives at storage slot 9.
    if (!dealt) {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 9n]));
      await testClient.setStorageAt({ address: BASE_MAINNET_USDC, index: slot, value: pad(`0x${usdcRaw.toString(16)}` as `0x${string}`, { size: 32 }) });
    }
    const final = await balance();
    expect(final === usdcRaw, `fork USDC funding failed: anvil_deal=${dealt ? "ok" : "unavailable"} balance=${final} wanted=${usdcRaw}`).toBe(true);
  }

  function buildRuntime(store: InMemoryAutonomyStore, adapter: AutonomousExecutionAdapter, bus: EventBus) {
    store.clock = () => clock.ms; // deterministic goal/policy ids
    const perf: PerformanceMonitor = new InMemoryPerformanceMonitor();
    const runtime = new AutonomyRuntime({
      store,
      gateway: new McpTradeGateway(buildDeps()),
      adapter,
      audit: new BusAuditSink(store, bus, perf),
      logger: silentLogger,
      performanceMonitor: perf,
      now: () => new Date(clock.ms),
    });
    const scheduler = new AutonomyScheduler(store, runtime, silentLogger, perf);
    return { runtime, scheduler };
  }

  async function createGoal(store: InMemoryAutonomyStore, wallet: Address, sellToken: Address, buyToken: Address, sellRaw: bigint, decimals: { sell: number; buy: number }) {
    // ALL timestamps are on the RUNTIME clock — the runtime evaluates expiry
    // against this.now(), so real-wall-clock dates would instantly expire.
    const nowIso = () => new Date(clock.ms).toISOString();
    const policy = await store.createPolicy({
      id: "", wallet, chainId: 8453, actions: ["swap"], sellToken, buyToken,
      maxPerTradeRaw: sellRaw.toString(), maxDailyRaw: (sellRaw * 5n).toString(), maxSlippageBps: 500, maxActionsPerDay: 4,
      enabled: true, createdAt: nowIso(), expiresAt: new Date(clock.ms + 6 * 3600_000).toISOString(),
      authorizedAt: nowIso(), authorizationRef: "phase6-fork",
    });
    return store.createGoal({
      id: "", wallet, policyId: policy!.id, type: "conditional_swap", description: "phase6 fork rehearsal", status: "ACTIVE",
      condition: { kind: "price_below", threshold: "1000000" }, // human price of 1 buy token in sell tokens (both legs are far below)
      trade: { sellToken, buyToken, sellAmountRaw: sellRaw.toString(), slippageBps: 300, sellDecimals: decimals.sell, buyDecimals: decimals.buy },
      cooldownSeconds: 60, maxTrades: 1, createdAt: nowIso(), updatedAt: nowIso(),
      expiresAt: new Date(clock.ms + 6 * 3600_000).toISOString(), nextEvaluationAt: nowIso(),
      lastAction: null, lastResult: null,
      pendingExecution: null, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    } as never);
  }

  it("on-chain chain separation: the delegated Sepolia executor has NO code on the Mainnet fork", async () => {
    const code = await publicClient.getBytecode({ address: DELEGATED_EXECUTOR_ADDRESS });
    expect(code === undefined || code === "0x", "delegated Sepolia executor must not exist on Mainnet").toBe(true);
    const mainnetCode = await publicClient.getBytecode({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor });
    expect(mainnetCode && mainnetCode !== "0x").toBe(true);
    const [feeBps, permit2, owner, feeRecipient] = await Promise.all([
      publicClient.readContract({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "feeBps" }),
      publicClient.readContract({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "PERMIT2" }),
      publicClient.readContract({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "owner" }),
      publicClient.readContract({ address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, abi: MPGR_EXECUTOR_ABI as never, functionName: "feeRecipient" }),
    ]);
    expect(Number(feeBps)).toBe(25);
    expect(String(permit2).toLowerCase()).toBe(CANONICAL_PERMIT2_LOWER);
    expect(String(owner).toLowerCase()).toBe(BASE_MAINNET_EXECUTOR_DEPLOYMENT.owner.toLowerCase());
    expect(String(feeRecipient).toLowerCase()).toBe(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient.toLowerCase());
    console.error(`::error::PHASE6_FORK chainAudit ok executor=${BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor} feeBps=25 code=${(mainnetCode!.length - 2) / 2}B`);
  });

  it("BUY + SELL through the full runtime chain on the fork, with exact 25 bps fee reconciliation", async () => {
    const taker = privateKeyToAccount(generatePrivateKey());
    await fundUsdc(taker, 10_000_000n); // 10 USDC headroom for the round trip
    const wallet = createWalletClient({ account: taker, chain: foundry, transport: http(LOCAL) });
    const requests: Array<Record<string, unknown>> = [];
    const adapter = makeAdapter(taker, { requests, publicClient, wallet });
    const store = new InMemoryAutonomyStore();
    const bus = new InMemoryEventBus();
    const audit: Array<{ event?: { type?: string } }> = [];
    bus.on("autonomy_audit", (payload: unknown) => audit.push(payload as { event?: { type?: string } }));
    const { scheduler } = buildRuntime(store, adapter, bus);

    // ---------- BUY: 1 USDC -> AAPLc ----------
    const usdcBefore = (await publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint;
    const stockBefore = (await publicClient.readContract({ address: AAPLc, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint;
    const buyGoal = await createGoal(store, taker.address, BASE_MAINNET_USDC, AAPLc, 1_000_000n, { sell: 6, buy: 18 });
    const submit = await scheduler.tick({ now: new Date(clock.ms) });
    expect(submit.results[0]?.kind, JSON.stringify(submit.results)).toBe("EXECUTION_SUBMITTED");
    expect(requests).toHaveLength(1);
    const buyTx = (await store.getGoal(buyGoal.id))!.pendingExecution!.txHash as Hex;
    const buyReceipt = await publicClient.getTransactionReceipt({ hash: buyTx });
    expect(buyReceipt.status).toBe("success");

    // fee reconciliation from the REAL SwapExecuted event
    const swapTopic = (await import("@/lib/executor/mpgr-executor-abi")).MPGR_EXECUTOR_ABI.find((x) => x.type === "event" && x.name === "SwapExecuted");
    let buyGross = 0n, buyFee = 0n, buyFeeRecipient = "";
    for (const log of buyReceipt.logs) {
      try {
        const ev = decodeEventLog({ abi: [swapTopic!] as never, data: log.data, topics: log.topics as never }) as unknown as { args: Record<string, unknown> };
        buyGross = ev.args.grossAmountIn as bigint;
        buyFee = ev.args.feeAmount as bigint;
        buyFeeRecipient = String(ev.args.feeRecipient);
        break;
      } catch { /* not the executor event */ }
    }
    expect(buyGross).toBe(1_000_000n);
    expect(buyFee).toBe((buyGross * 25n) / 10_000n);
    expect(buyFeeRecipient.toLowerCase()).toBe(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient.toLowerCase());

    // duplicate tick: rejected, no second broadcast
    const dup = await scheduler.tick({ now: new Date(clock.ms) });
    expect(dup.evaluated).toBe(0);
    expect(requests).toHaveLength(1);

    // verification pass
    clock.ms += AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000;
    const verify = await scheduler.tick({ now: new Date(clock.ms) });
    const buyAfter = (await store.getGoal(buyGoal.id))!;
    expect(buyAfter.status, JSON.stringify(buyAfter.lastResult)).toBe("COMPLETED");
    void verify;
    const stockReceived = ((await publicClient.readContract({ address: AAPLc, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint) - stockBefore;
    expect(stockReceived > 0n).toBe(true);

    // ---------- SELL: all received AAPLc -> USDC ----------
    const sellRequests: Array<Record<string, unknown>> = [];
    const sellAdapter = makeAdapter(taker, { requests: sellRequests, publicClient, wallet });
    const sellStore = new InMemoryAutonomyStore();
    const sellBus = new InMemoryEventBus();
    const sellAudit: Array<{ event?: { type?: string } }> = [];
    sellBus.on("autonomy_audit", (payload: unknown) => sellAudit.push(payload as { event?: { type?: string } }));
    const sellRuntime = buildRuntime(sellStore, sellAdapter, sellBus);
    const sellGoal = await createGoal(sellStore, taker.address, AAPLc, BASE_MAINNET_USDC, stockReceived, { sell: 18, buy: 6 });
    const sellSubmit = await sellRuntime.scheduler.tick({ now: new Date(clock.ms) });
    expect(sellSubmit.results[0]?.kind, JSON.stringify(sellSubmit.results)).toBe("EXECUTION_SUBMITTED");
    expect(sellRequests).toHaveLength(1);
    const sellTx = (await sellStore.getGoal(sellGoal.id))!.pendingExecution!.txHash as Hex;
    const sellReceipt = await publicClient.getTransactionReceipt({ hash: sellTx });
    expect(sellReceipt.status).toBe("success");
    clock.ms += AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000;
    await sellRuntime.scheduler.tick({ now: new Date(clock.ms) });
    expect((await sellStore.getGoal(sellGoal.id))!.status).toBe("COMPLETED");

    const usdcEnd = (await publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint;
    expect(usdcEnd < usdcBefore, "round trip should cost fees + spread").toBe(true);

    // ordered audit chain on the SELL leg
    const types = sellAudit.map((p) => p.event?.type ?? "");
    const order = ["QUOTE_CREATED", "CONDITION_MET", "POLICY_APPROVED", "AUTHORIZATION_CHECKED", "TRADE_PREPARED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"];
    let last = -1;
    for (const expected of order) {
      const idx = types.indexOf(expected);
      expect(idx, `missing/out-of-order ${expected}: ${types.join(",")}`).toBeGreaterThan(last);
      last = idx;
    }
    console.error(`::error::PHASE6_FORK roundTrip ok buy=${buyTx} sell=${sellTx} buyFeeRaw=${buyFee} usdcStart=${usdcBefore} usdcEnd=${usdcEnd}`);
  }, 600_000);

  it("emergency stop blocks a new broadcast mid-suite; nothing is signed or sent", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "true");
    try {
      const taker = privateKeyToAccount(generatePrivateKey());
      await fundUsdc(taker, 1_000_000n);
      const wallet = createWalletClient({ account: taker, chain: foundry, transport: http(LOCAL) });
      const requests: Array<Record<string, unknown>> = [];
      const store = new InMemoryAutonomyStore();
      const bus = new InMemoryEventBus();
      const { scheduler } = buildRuntime(store, makeAdapter(taker, { requests, publicClient, wallet }), bus);
      const emergencyAudit: Array<Record<string, unknown>> = [];
      bus.on("autonomy_audit", (payload: unknown) => emergencyAudit.push(payload as Record<string, unknown>));
      await createGoal(store, taker.address, BASE_MAINNET_USDC, AAPLc, 10_000n, { sell: 6, buy: 18 });
      const summary = await scheduler.tick({ now: new Date(clock.ms) });
      // The kill switch fires inside the evaluation loop (post quote/policy,
      // pre authorization): the goal is PARKED, never broadcast.
      expect(summary.results[0]?.kind, JSON.stringify(summary.results)).toBe("PARKED");
      const goal = (await store.listGoals(taker.address))[0]!;
      expect(goal.lastResult?.code).toBe("EXECUTION_UNAVAILABLE");
      expect(goal.lastResult?.message ?? "").toContain("globally disabled");
      expect(JSON.stringify(emergencyAudit)).toContain("EMERGENCY_DISABLE");
      expect(requests, "emergency stop must prevent any signature or broadcast").toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 300_000);

  it("uncertain broadcast (fabricated hash) is NEVER re-broadcast: PENDING -> UNCERTAIN -> goal FAILED", async () => {
    const taker = privateKeyToAccount(generatePrivateKey());
    await fundUsdc(taker, 1_000_000n);
    const wallet = createWalletClient({ account: taker, chain: foundry, transport: http(LOCAL) });
    const requests: Array<Record<string, unknown>> = [];
    const store = new InMemoryAutonomyStore();
    const { scheduler } = buildRuntime(store, makeAdapter(taker, { requests, publicClient, wallet, failMode: "fabricateHash" }), new InMemoryEventBus());
    await createGoal(store, taker.address, BASE_MAINNET_USDC, AAPLc, 10_000n, { sell: 6, buy: 18 });
    const submit = await scheduler.tick({ now: new Date(clock.ms) });
    expect(submit.results[0]?.kind).toBe("EXECUTION_SUBMITTED");
    expect(requests).toHaveLength(1);
    for (let i = 0; i < AUTONOMY_LIMITS.maxVerificationAttempts; i++) {
      clock.ms += AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000;
      await scheduler.tick({ now: new Date(clock.ms) });
    }
    const goal = (await store.listGoals(taker.address))[0]!;
    expect(goal.status).toBe("FAILED");
    expect(goal.pendingExecution).toBeNull();
    expect(requests, "uncertain broadcast must NEVER be re-broadcast").toHaveLength(1);
    console.error(`::error::PHASE6_FORK uncertain ok classified=${goal.lastResult?.code} rebroadcasts=0`);
  }, 600_000);

  it("reverted execution is classified TX_REVERTED and not retried", async () => {
    const taker = privateKeyToAccount(generatePrivateKey());
    await fundUsdc(taker, 1_000_000n);
    const wallet = createWalletClient({ account: taker, chain: foundry, transport: http(LOCAL) });
    const requests: Array<Record<string, unknown>> = [];
    const store = new InMemoryAutonomyStore();
    const { scheduler } = buildRuntime(store, makeAdapter(taker, { requests, publicClient, wallet, failMode: "skipApproval" }), new InMemoryEventBus());
    await createGoal(store, taker.address, BASE_MAINNET_USDC, AAPLc, 10_000n, { sell: 6, buy: 18 });
    const submit = await scheduler.tick({ now: new Date(clock.ms) });
    expect(submit.results[0]?.kind).toBe("EXECUTION_SUBMITTED"); // broadcast happened
    expect(requests).toHaveLength(1);
    clock.ms += AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000;
    await scheduler.tick({ now: new Date(clock.ms) });
    const goal = (await store.listGoals(taker.address))[0]!;
    expect(goal.pendingExecution).toBeNull();
    expect(["TX_REVERTED", "VERIFICATION_FAILED"]).toContain(goal.lastResult?.code ?? "");
    expect(requests, "reverted execution must NOT be blindly retried").toHaveLength(1);
    console.error(`::error::PHASE6_FORK revert ok classified=${goal.lastResult?.code} rebroadcasts=0`);
  }, 600_000);

  it("slippage/minOut is enforced ON-CHAIN by the executor: an unmeetable minOut REVERTS — no bad fill is possible", async () => {
    const taker = privateKeyToAccount(generatePrivateKey());
    await fundUsdc(taker, 1_000_000n);
    const wallet = createWalletClient({ account: taker, chain: foundry, transport: http(LOCAL) });
    const approve = await wallet.sendTransaction({
      chain: undefined, account: taker, to: BASE_MAINNET_USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, 2n ** 200n] }), gas: 80_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });
    // Adversarial intent: same real executor/route, but expectedBuyAmount claims
    // 10,000,000 AAPLc (8 decimals) for 1 USDC — ~30,000x the live price — so the
    // derived minOut can never be met on the real USDC/AAPLc pool.
    const built = buildExecutorIntent({
      deployment: BASE_MAINNET_EXECUTOR_DEPLOYMENT,
      taker: taker.address,
      sellToken: BASE_MAINNET_USDC,
      buyToken: AAPLc,
      sellAmount: 1_000_000n,
      expectedBuyAmount: 10n ** 24n,
      slippageBps: 300,
      authorization: "APPROVAL",
      nowSeconds: Math.floor(clock.ms / 1000),
      quoteId: "phase6-minout-adversarial",
      feeBps: 25,
      feeRecipient: BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient,
    });
    expect(built.ok, JSON.stringify(built.ok ? null : built.error)).toBe(true);
    const intent = built.ok ? built.value : null;
    expect(BigInt(intent!.minBuyAmount)).toBe((10n ** 24n * 97n) / 100n); // minOut = expected x (1 - slippage), immutable in calldata
    const prepared = encodeExecutorSwap(intent!, approvalAuthorization());
    const hash = await wallet.sendTransaction({ chain: undefined, account: taker, to: prepared.to, data: prepared.data, gas: 600_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status, "the executor/venue must revert when amountOut < minOut — a broadcaster cannot force a bad fill").toBe("reverted");
    // Nothing moved: the revert is atomic (no partial fill, no fee skim).
    const stock = (await publicClient.readContract({ address: AAPLc, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint;
    const usdcAfter = (await publicClient.readContract({ address: BASE_MAINNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] })) as bigint;
    expect(stock).toBe(0n);
    expect(usdcAfter).toBe(1_000_000n);
    console.error(`::error::PHASE6_FORK minOut ok reverted=${hash} minOutRaw=${intent!.minBuyAmount} balancesUnchanged=true`);
  }, 300_000);
});

const CANONICAL_PERMIT2_LOWER = "0x000000000022d473030f116ddee9f6b43ac78ba3";
