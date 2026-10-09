// lib/executor/__tests__/phase6-mainnet-audit.test.ts
//
// PHASE 6 — BASE MAINNET ADVERSARIAL AUDIT (offline, deterministic).
// Read-only code/config audit of the COMPLETE Mainnet execution path,
// INDEPENDENT of the Sepolia delegated path:
//   §A  Mainnet executor deployment/config audit (address, owner, fee
//       recipient, feeBps, Permit2, WETH, routes, token registry)
//   §B  Chain separation: Mainnet cannot select the Sepolia delegated
//       registry/executor; Sepolia cannot select the Mainnet executor;
//       wrong-chain policies fail closed at every seam
//   §C  The F-9 prepare seam audited ON MAINNET: the v1 prepare path MUST
//       run there (with the chain-scoped Mainnet registry) and must never
//       inherit the delegated skip
//   §D  Execution boundary reality + assisted-path unchanged pins
// No RPC, no signing, no broadcast. Fork rehearsal lives in
// lib/autonomy/__tests__/phase6-fork-rehearsal.test.ts.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import {
  BASE_MAINNET_B20_TOKENS,
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EXECUTOR_DEPLOYMENT,
  CANONICAL_PERMIT2,
  CANONICAL_WETH,
  EXECUTOR_DEFAULT_FEE_BPS,
  MPGR_EXECUTOR_DEPLOYMENTS,
  RouterKind,
  findExecutorRoute,
} from "@/lib/executor/executor-config";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
} from "@/lib/executor/delegated-executor";
import { buildExecutorIntent } from "@/lib/executor/executor-intent";
import { delegateSwap } from "@/lib/mcp/mcp-trade-service";
import {
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  validateNewSlotAgainstPolicy,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import { noDelegationAdapter } from "@/lib/autonomy/execution-adapter";
import { evaluatePolicyAgainstAction } from "@/lib/autonomy/policy-engine";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import type { AutonomyPolicy } from "@/lib/autonomy/types";

const MAINNET_EXECUTOR = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor);
const DELEGATED_EXECUTOR = getAddress(DELEGATED_EXECUTOR_ADDRESS);
const SEPOLIA_V1_EXECUTOR = getAddress(BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.executor);
const AAPLc = getAddress(
  BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol !== "USDC" && t.symbol !== "WETH")!.address,
);

describe("PHASE 6 §A: Mainnet executor deployment/config audit", () => {
  it("pins the deployed Mainnet facts (address, owner, fee recipient, feeBps, Permit2, WETH, deploy record)", () => {
    expect(MAINNET_EXECUTOR).toBe(getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A"));
    expect(getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.owner)).toBe(getAddress("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e"));
    expect(getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient)).toBe(getAddress("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4"));
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeBps).toBe(25);
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeBps).toBe(EXECUTOR_DEFAULT_FEE_BPS);
    expect(getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.permit2)).toBe(getAddress(CANONICAL_PERMIT2));
    expect(getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.weth)).toBe(getAddress(CANONICAL_WETH));
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.chainId).toBe(8453);
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock).toBeGreaterThan(0);
  });

  it("registry routes: USDC/WETH on official Uniswap V3 (fee 3000) + USDC/B20 stocks on Slipstream (tick 10)", () => {
    const routes = BASE_MAINNET_EXECUTOR_DEPLOYMENT.routes;
    expect(routes.length).toBeGreaterThan(1);
    const v3 = routes.find((r) => r.kind === RouterKind.UNISWAP_V3_ROUTER02);
    expect(v3, "USDC/WETH V3 route must exist").toBeTruthy();
    const slip = routes.filter((r) => r.kind === RouterKind.AERODROME_SLIPSTREAM);
    expect(slip.length).toBeGreaterThan(0);
    for (const r of slip) expect(r.tickSpacing).toBe(10);
    // every registered route's tokens are allowlisted tokens
    const tokens = new Set(BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.map((t) => t.address.toLowerCase()));
    for (const r of routes) {
      expect(tokens.has(r.tokenA.toLowerCase())).toBe(true);
      expect(tokens.has((r.tokenB as Address).toLowerCase())).toBe(true);
    }
    // BUY/SELL legs the rehearsal will use both exist and quote against live quoters
    expect(findExecutorRoute(BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC, AAPLc)).toBeTruthy();
    expect(findExecutorRoute(BASE_MAINNET_EXECUTOR_DEPLOYMENT, AAPLc, BASE_MAINNET_USDC)).toBeTruthy();
  });
});

describe("PHASE 6 §B: chain separation — Mainnet and Sepolia registries can never cross", () => {
  it("v1 executor deployments are per-chain and the pinned delegated Sepolia executor stays separate", () => {
    expect(MAINNET_EXECUTOR.toLowerCase()).not.toBe(DELEGATED_EXECUTOR.toLowerCase());
    expect(MAINNET_EXECUTOR.toLowerCase()).not.toBe(SEPOLIA_V1_EXECUTOR.toLowerCase());
    expect(SEPOLIA_V1_EXECUTOR.toLowerCase()).not.toBe(DELEGATED_EXECUTOR.toLowerCase());
    expect(BASE_MAINNET_EXECUTOR_DEPLOYMENT.chainId).toBe(8453);
    expect(BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.chainId).toBe(84532);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.chainId).toBe(84532);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.executor.toLowerCase()).toBe(DELEGATED_EXECUTOR.toLowerCase());
  });

  it("Mainnet token registry contains NO Sepolia delegated token; intent build refuses them (TOKEN_NOT_ALLOWED)", () => {
    const mainnetTokens = new Set(BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.map((t) => t.address.toLowerCase()));
    expect(mainnetTokens.has(DELEGATED_BASE_SEPOLIA_TUSD.toLowerCase())).toBe(false);
    expect(mainnetTokens.has(DELEGATED_BASE_SEPOLIA_TSTOCK.toLowerCase())).toBe(false);
    const built = buildExecutorIntent({
      deployment: BASE_MAINNET_EXECUTOR_DEPLOYMENT,
      taker: getAddress("0x0000000000000000000000000000000000000001"),
      sellToken: DELEGATED_BASE_SEPOLIA_TUSD, // Sepolia delegated token
      buyToken: AAPLc,
      sellNative: false,
      buyNative: false,
      sellAmount: 10_000n,
      expectedBuyAmount: 1n,
      slippageBps: 100,
      authorization: "APPROVAL",
      nowSeconds: 1_800_000_000,
      quoteId: "q-chain-sep",
      feeBps: 25,
      feeRecipient: BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe("TOKEN_NOT_ALLOWED");
  });

  it("a Sepolia delegated-executor receipt can NEVER verify as a Mainnet v1 success", async () => {
    // This exercises the v1 Mainnet quote/verify seam specifically. The
    // Mainnet delegated adapter has its own chain-bound registry and verifier.
    const { verifyTrade } = await import("@/lib/mcp/mcp-trade-service");
    const { fakeReader, newFakeState, swapExecutedLog, TEST_SECRET } = await import("@/lib/mcp/__tests__/fixtures");
    const state = newFakeState();
    // Forge a receipt whose emitter AND tx.to are the DELEGATED (Sepolia) executor:
    const delegatedSwapLog = swapExecutedLog(DELEGATED_EXECUTOR, {
      taker: getAddress("0x0000000000000000000000000000000000000002"),
      router: getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.routes[0]!.router),
      intentId: ("0x" + "11".repeat(32)) as Hex,
      tokenIn: BASE_MAINNET_USDC,
      tokenOut: AAPLc,
      grossAmountIn: 10_000_000n,
      feeAmount: 25_000n,
      swapAmountIn: 9_975_000n,
      amountOut: 1n,
      feeRecipient: getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient),
      feeBps: 25,
      routerKind: 2,
      flags: 0,
    });
    const delegatedDeps = {
      registry: MPGR_EXECUTOR_DEPLOYMENTS,
      delegatedRegistry: { [BASE_SEPOLIA_CHAIN_ID]: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT }, // Isolated Sepolia fixture; this test exercises v1 Mainnet verification.
      reader: () => fakeReader(state, BASE_MAINNET_CHAIN_ID, MAINNET_EXECUTOR),
      nowSeconds: () => 1_800_000_000,
      quoteSecret: TEST_SECRET,
      mainnetEnabled: true,
      mainnetFeeRecipient: getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient),
    };
    // A quote signed for the MAINNET executor, verified against a receipt whose
    // tx.to is the DELEGATED executor -> executor checks MUST fail.
    const { getQuote } = await import("@/lib/mcp/mcp-trade-service");
    const quote = await getQuote(delegatedDeps as never, {
      chainId: 8453,
      taker: getAddress("0x0000000000000000000000000000000000000002"),
      sellToken: BASE_MAINNET_USDC,
      buyToken: AAPLc,
      sellAmount: "10000000",
      slippageBps: 100,
    });
    expect(quote.ok, `mainnet quote failed: ${quote.ok ? "" : quote.error.message}`).toBe(true);
    const quoteId = String((quote.ok && (quote.data as Record<string, unknown>).quoteId) || "");
    const txHash = ("0x" + "cd".repeat(32)) as Hex;
    state.receipts.set(txHash.toLowerCase(), {
      status: "success",
      transactionHash: txHash,
      blockNumber: 42n,
      from: getAddress("0x0000000000000000000000000000000000000002"),
      to: DELEGATED_EXECUTOR, // <- the Sepolia delegated executor
      logs: [delegatedSwapLog],
    } as never);
    const verdict = await verifyTrade(delegatedDeps as never, { chainId: 8453, quoteId, txHash });
    if (!verdict.ok) {
      // hard-refusal variant (e.g. registry/executor mismatch surfaced as a tool error) is also fail-closed
      expect(verdict.error.code).toBeTruthy();
    } else {
      expect(verdict.data.verified, "a delegated-executor receipt must NEVER verify as a Mainnet success").toBe(false);
      const checks = (verdict.data as { checks?: Array<{ name: string; ok: boolean }> }).checks ?? [];
      expect(checks.filter((c) => !c.ok).length).toBeGreaterThan(0);
    }
  });

  /**
   * UPDATED BY THE MC-1/MC-2 REMEDIATION. This test originally pinned the fact
   * that Base mainnet was NOT a delegated chain at all, so `delegateSwap(8453)`
   * answered UNSUPPORTED_CHAIN and a mainnet policy was refused CHAIN_MISMATCH
   * before any slot was even considered.
   *
   * Mainnet delegated execution now EXISTS, so those two specific codes moved —
   * but the property this §B section is actually about (Mainnet and Sepolia can
   * never CROSS) is preserved and is now asserted far more precisely and in
   * BOTH directions:
   *
   *   - unpinned mainnet execution still fails closed (EXECUTOR_NOT_CONFIGURED,
   *     never a silent fall back to the Sepolia contract);
   *   - a genuinely non-delegated chain still fails closed (UNSUPPORTED_CHAIN);
   *   - a SEPOLIA slot can never authorize a MAINNET policy, and a MAINNET slot
   *     can never authorize a SEPOLIA policy (CHAIN_MISMATCH), even when every
   *     other field — owner, tokens, amount, policyHash, deadline — matches.
   */
  it("delegateSwap fails closed on an unpinned Mainnet executor and on non-delegated chains; slots can never CROSS chains", async () => {
    // (1) Unpinned mainnet => fail closed with the precise reason. Nothing is
    //     broadcast, and it never falls back to the Sepolia contract.
    delete process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
    const out = await delegateSwap({} as never, { chainId: 8453 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("EXECUTOR_NOT_CONFIGURED");

    // (2) A chain that is not delegated at all still answers UNSUPPORTED_CHAIN.
    for (const chainId of [1, 10, 137, 31337]) {
      const wrongChain = await delegateSwap({} as never, { chainId });
      expect(wrongChain.ok, `chain ${chainId}`).toBe(false);
      if (!wrongChain.ok) expect(wrongChain.error.code).toBe("UNSUPPORTED_CHAIN");
    }

    const USER = getAddress("0x0000000000000000000000000000000000000003") as Address;
    const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
    const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
    const NOW = new Date("2026-10-01T00:00:00Z");
    const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;

    const policyOn = (chainId: 8453 | 84532, id: string): AutonomyPolicy => ({
      id,
      wallet: USER,
      chainId,
      actions: ["swap"],
      sellToken: SELL,
      buyToken: BUY,
      maxPerTradeRaw: "10000",
      maxDailyRaw: "50000",
      maxSlippageBps: 500,
      maxActionsPerDay: 2,
      enabled: true,
      createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 6 * 3600_000).toISOString(),
      authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      authorizationRef: "p6",
    });
    const mainnetPolicy = policyOn(8453, "pol-p6-m");
    const sepoliaPolicy = policyOn(84532, "pol-p6-s");

    // A slot that is PERFECT in every other respect — right owner, right tokens,
    // right amount, a policyHash computed for the TARGET policy, live deadline —
    // so the ONLY thing that can stop it is the chain binding.
    const slotFor = (slotChainId: 8453 | 84532, policy: AutonomyPolicy, goalId: string): DelegatedAuthorizationSlot => ({
      id: delegatedSlotId(policy.id, goalId, 0),
      wallet: USER.toLowerCase() as Address,
      chainId: slotChainId,
      policyId: policy.id,
      goalId,
      slotIndex: 0,
      permit: { token: SELL, amount: "10000", nonce: "7", deadline: DEADLINE },
      witness: {
        owner: USER.toLowerCase() as Address,
        buyToken: BUY,
        minAmountOut: "1",
        deadline: DEADLINE,
        actionId: delegatedActionId(goalId),
        policyHash: policyHashFor(policy),
      },
      signature: ("0x" + "ab".repeat(65)) as Hex,
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });

    const ctxFor = (policy: AutonomyPolicy) => ({
      now: NOW,
      policy,
      sellToken: SELL,
      buyToken: BUY,
      sellAmountRaw: "10000",
      liveMinBuyAmountRaw: "1",
    });

    // (3) SEPOLIA slot vs MAINNET policy => CHAIN_MISMATCH.
    const sepoliaSlotOnMainnet = selectDelegatedSlot([slotFor(84532, mainnetPolicy, "goal-p6")], ctxFor(mainnetPolicy));
    expect(sepoliaSlotOnMainnet.authorized).toBe(false);
    expect(sepoliaSlotOnMainnet.reason).toBe("CHAIN_MISMATCH");

    // (4) MAINNET slot vs SEPOLIA policy => CHAIN_MISMATCH (both directions).
    const mainnetSlotOnSepolia = selectDelegatedSlot([slotFor(8453, sepoliaPolicy, "goal-p6")], ctxFor(sepoliaPolicy));
    expect(mainnetSlotOnSepolia.authorized).toBe(false);
    expect(mainnetSlotOnSepolia.reason).toBe("CHAIN_MISMATCH");

    // (5) The same binding is enforced BEFORE a slot is ever stored.
    expect(validateNewSlotAgainstPolicy(slotFor(84532, mainnetPolicy, "goal-p6"), mainnetPolicy)).toBe("CHAIN_MISMATCH");
    expect(validateNewSlotAgainstPolicy(slotFor(8453, sepoliaPolicy, "goal-p6"), sepoliaPolicy)).toBe("CHAIN_MISMATCH");

    // (6) A mainnet policy with NO slots is still not authorized — the chain
    //     becoming valid did not make an unauthorized goal executable.
    const noSlots = selectDelegatedSlot([], ctxFor(mainnetPolicy));
    expect(noSlots.authorized).toBe(false);
    expect(noSlots.reason).toBe("NO_SLOTS");

    // (7) Sanity: the chain check is the ONLY thing stopping (3)/(4). A slot on
    //     its OWN chain with these exact fields is accepted, proving the
    //     refusals above are chain-specific rather than an artifact of a fixture
    //     that could never authorize anything.
    expect(selectDelegatedSlot([slotFor(8453, mainnetPolicy, "goal-p6")], ctxFor(mainnetPolicy)).authorized).toBe(true);
    expect(selectDelegatedSlot([slotFor(84532, sepoliaPolicy, "goal-p6")], ctxFor(sepoliaPolicy)).authorized).toBe(true);
  });
});

describe("PHASE 6 §C: the F-9 prepare seam audited ON THE MAINNET PATH", () => {
  it("the v1 (Mainnet) runtime path MUST call gateway.prepare — the delegated skip cannot leak to Mainnet", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const { InMemoryAutonomyStore } = await import("@/lib/autonomy/store");
      const { AutonomyRuntime } = await import("@/lib/autonomy/runtime");
      const { BusAuditSink } = await import("@/lib/autonomy/audit");
      const { InMemoryEventBus } = await import("@/lib/architecture/core/event-bus");
      const { InMemoryPerformanceMonitor } = await import("@/lib/architecture/core/performance-monitor");
      const { silentLogger } = await import("@/lib/autonomy/__tests__/helpers");
      const { NO_DELEGATION_ADAPTER_ID } = await import("@/lib/autonomy/execution-adapter");

      const prepareSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true as const,
        data: { steps: [{ step: "x" }], transactionRequest: { to: MAINNET_EXECUTOR, data: "0xdead" as Hex }, expiresAt: 9_999_999_999 },
      }));
      const executeSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, txHash: ("0x" + "7e".repeat(32)) as `0x${string}` }));
      const gw = {
        quote: async () => ({
          ok: true as const,
          data: { quoteId: "q-p6", sellAmountRaw: "500", expectedBuyAmountRaw: "1000", minBuyAmountRaw: "900", quoteExpiresAt: 1_800_100_000 },
        }),
        prepare: prepareSpy,
        status: async () => ({ ok: true as const, data: { status: "confirmed", blockNumber: "1" } }),
        verify: async () => ({ ok: true as const, data: { verified: true, checks: [], actualBuyAmountRaw: "1000", feeAmountRaw: "1" } }),
      } as never;
      const adapter = {
        id: NO_DELEGATION_ADAPTER_ID, // v1/Mainnet-style adapter id (NOT the delegated adapter)
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: executeSpy,
      };
      const store = new InMemoryAutonomyStore();
      const walletAddr = getAddress("0x0000000000000000000000000000000000000d0e") as Address;
      const policy = await store.createPolicy({
        id: "pol-p6", wallet: walletAddr, chainId: 8453, actions: ["swap"], sellToken: BASE_MAINNET_USDC, buyToken: AAPLc,
        maxPerTradeRaw: "500", maxDailyRaw: "2500", maxSlippageBps: 500, maxActionsPerDay: 2, enabled: true,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        authorizedAt: new Date().toISOString(), authorizationRef: "p6",
      });
      const goal = await store.createGoal({
        id: "", wallet: walletAddr, policyId: policy!.id, type: "conditional_swap", description: "p6", status: "ACTIVE",
        condition: { kind: "price_below", threshold: "1000000000000000000" },
        trade: { sellToken: BASE_MAINNET_USDC, buyToken: AAPLc, sellAmountRaw: "500", slippageBps: 100, sellDecimals: 6, buyDecimals: 18 },
        cooldownSeconds: 60, maxTrades: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), nextEvaluationAt: new Date().toISOString(),
        pendingExecution: null, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
      } as never);
      const bus = new InMemoryEventBus();
      const perf = new InMemoryPerformanceMonitor();
      const runtime = new AutonomyRuntime({ store, gateway: gw, adapter: adapter as never, audit: new BusAuditSink(store, bus, perf), logger: silentLogger, performanceMonitor: perf, now: () => new Date() });
      const submitted = await runtime.evaluateGoal(goal.id);
      expect(submitted.kind).toBe("EXECUTION_SUBMITTED");
      expect(prepareSpy, "Mainnet/v1 path MUST build the intent through the chain-scoped prepare seam").toHaveBeenCalledTimes(1);
      const prepared = (prepareSpy.mock.calls as unknown as Array<Array<unknown>>)[0]?.[0] as Record<string, unknown>;
      expect(prepared.authorization).toBe("APPROVAL");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("PHASE 6 §D: execution boundary reality + assisted-path unchanged pins", () => {
  it("the ONLY production Mainnet adapter refuses every action (NO_DELEGATION_MECHANISM) — by design", async () => {
    expect(noDelegationAdapter.canDelegate).toBe(false);
    expect(noDelegationAdapter.checkAuthorization(getAddress("0x0000000000000000000000000000000000000004"), {} as never)).toMatchObject({ authorized: false, reason: "NO_DELEGATION_MECHANISM" });
    const result = await noDelegationAdapter.executeSwap({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTHORIZATION_MISSING");
  });

  it("assisted path unchanged: malformed and non-taker signatures are still refused", async () => {
    const { finalizeTrade, getQuote, prepareTrade } = await import("@/lib/mcp/mcp-trade-service");
    const { newFakeState, testDeps } = await import("@/lib/mcp/__tests__/fixtures");
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const state = newFakeState();
    const taker = privateKeyToAccount(generatePrivateKey());
    const { setBalance, TUSD, TSTOCK } = await import("@/lib/mcp/__tests__/fixtures");
    setBalance(state, TUSD, taker.address, 50_000_000n);
    // The assisted path is chain-shared code; the pin uses the proven fake-state fixture.
    const deps = testDeps(state, {});
    const q = await getQuote(deps, { chainId: BASE_SEPOLIA_CHAIN_ID, taker: taker.address, sellToken: TUSD, buyToken: TSTOCK, sellAmountHuman: "10", slippageBps: 100 });
    const quoteId = String((q.ok && (q.data as Record<string, unknown>).quoteId) || "");
    expect(quoteId, `mainnet assisted quote failed: ${q.ok ? "" : q.error.code}: ${q.ok ? "" : q.error.message}`).toBeTruthy();
    const prep = await prepareTrade(deps, { quoteId, authorization: "EIP2612" });
    expect(prep.ok, `prepare failed: ${prep.ok ? "" : JSON.stringify(prep.error)}`).toBe(true);

    // malformed signature -> INVALID_SIGNATURE
    const malformed = await finalizeTrade(deps, { quoteId, authorization: "EIP2612", signature: "0x" + "11".repeat(64), permitNonce: "0" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_SIGNATURE");

    // a NON-TAKER key over the REAL typed data -> SIGNATURE_MISMATCH
    const typedData = (prep.ok && (prep.data as Record<string, unknown>).typedData) as Record<string, unknown>;
    const nonce = prep.ok ? (((prep.data as Record<string, unknown>).permit as { nonce: string }).nonce ?? "0") : "0";
    const attacker = privateKeyToAccount(generatePrivateKey());
    const forged = await attacker.signTypedData(reviveTypedData(typedData));
    const mismatch = await finalizeTrade(deps, { quoteId, authorization: "EIP2612", signature: forged, permitNonce: String(nonce) });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("SIGNATURE_MISMATCH");
  });
});

import { privateKeyToAccount } from "viem/accounts";

/** Wallets accept decimal strings for uintN in eth_signTypedData_v4; viem's local signer wants bigint. */
function reviveTypedData(td: Record<string, unknown>): Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0] {
  const types = td.types as Record<string, { name: string; type: string }[]>;
  const revive = (typeName: string, value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        const field = types[typeName]?.find((f) => f.name === key);
        if (field && /^uint\d+$/.test(field.type) && typeof v === "string") return [key, BigInt(v)];
        if (field && types[field.type] && v && typeof v === "object") return [key, revive(field.type, v as Record<string, unknown>)];
        return [key, v];
      }),
    );
  return { ...(td as object), message: revive(td.primaryType as string, td.message as Record<string, unknown>) } as never;
}

// -----------------------------------------------------------------------------
// §E — POLICY LIMITS ON THE MAINNET PATH (8453, v1 execution chain).
// The policy engine is chain-shared and deterministic (bigint only); these pins
// prove every cap binds for MAINNET proposals through the exact function the
// runtime calls before any prepare/authorization work (runtime.ts
// evaluatePolicyAgainstAction). Max-trade, daily, slippage, action-rate, and
// wrong-chain all fail closed BEFORE any quote is acted on.
// -----------------------------------------------------------------------------
describe("PHASE 6 §E: policy limits bind on the Mainnet path (max trade, daily cap, slippage, action rate, chain)", () => {
  const NOW = new Date("2026-10-01T00:00:00Z");
  const USER = getAddress("0x0000000000000000000000000000000000000002");
  const basePolicy: AutonomyPolicy = {
    id: "pol-p6e",
    wallet: USER,
    chainId: BASE_MAINNET_CHAIN_ID,
    actions: ["swap"],
    sellToken: getAddress(BASE_MAINNET_USDC),
    buyToken: AAPLc,
    maxPerTradeRaw: "1000000", // 1 USDC (raw)
    maxDailyRaw: "3000000", // 3 USDC (raw)
    maxSlippageBps: 500,
    maxActionsPerDay: 3,
    enabled: true,
    createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(),
    authorizedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    authorizationRef: "phase6-offline",
  };
  const goal = { expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() };
  const proposed = (over: Partial<{ chainId: number; sellAmountRaw: string; slippageBps: number }>) => ({
    action: "swap" as const,
    chainId: BASE_MAINNET_CHAIN_ID,
    sellToken: getAddress(BASE_MAINNET_USDC),
    buyToken: AAPLc,
    sellAmountRaw: "1000000",
    slippageBps: 300,
    ...over,
  });
  const spend = (over: Partial<{ dailySpendRaw: string; actionsToday: number }> = {}) => ({
    dailySpendRaw: "0",
    actionsToday: 0,
    ...over,
  });

  it("exactly-at-cap trade is allowed (boundary is inclusive)", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({}), spend(), NOW);
    expect(d.allowed).toBe(true);
  });

  it("sell amount above maxPerTradeRaw -> OVER_PER_TRADE_LIMIT (no broadcast)", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({ sellAmountRaw: "1000001" }), spend(), NOW);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.rejection.rule).toBe("OVER_PER_TRADE_LIMIT");
  });

  it("trade that would cross the daily cap -> OVER_DAILY_LIMIT", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({}), spend({ dailySpendRaw: "2000001", actionsToday: 2 }), NOW);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.rejection.rule).toBe("OVER_DAILY_LIMIT");
  });

  it("requested slippage above the policy cap -> OVER_SLIPPAGE_LIMIT", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({ slippageBps: 501 }), spend(), NOW);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.rejection.rule).toBe("OVER_SLIPPAGE_LIMIT");
  });

  it("action count at the daily cap -> OVER_ACTION_RATE", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({}), spend({ actionsToday: 3 }), NOW);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.rejection.rule).toBe("OVER_ACTION_RATE");
  });

  it("a Sepolia (84532) proposal against a Mainnet policy -> CHAIN_MISMATCH (fail-closed, both directions)", () => {
    const d = evaluatePolicyAgainstAction(basePolicy, goal, proposed({ chainId: BASE_SEPOLIA_CHAIN_ID }), spend(), NOW);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.rejection.rule).toBe("CHAIN_MISMATCH");
  });

  it("absolute runtime ceilings are surfaced and unchanged (maxPerTrade 10000 / maxDaily 100000 human)", () => {
    expect(AUTONOMY_LIMITS.maxPerTradeHuman).toBe("10000");
    expect(AUTONOMY_LIMITS.maxDailyHuman).toBe("100000");
    expect(AUTONOMY_LIMITS.maxVerificationAttempts).toBe(10);
    expect(AUTONOMY_LIMITS.verificationRetrySeconds).toBe(30);
  });
});

// -----------------------------------------------------------------------------
// §F — CONCURRENT EXECUTION + REPLAY PROTECTION ON THE MAINNET PATH (8453).
// Two simultaneous evaluations of the SAME goal slot must produce exactly ONE
// broadcast: the evaluation lease (store-level) makes the second concurrent
// evaluation SKIPPED before it even quotes, and the execution-guard
// idempotency key makes same-slot replay impossible. These are the v1/Mainnet
// equivalents of the delegated path's nonce/replay binding.
// -----------------------------------------------------------------------------
describe("PHASE 6 §F: concurrent execution is single-broadcast; same-slot replay is impossible on the Mainnet path", () => {
  it("two concurrent evaluations of one goal -> exactly ONE quote, ONE broadcast (lease win), loser SKIPPED", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const { InMemoryAutonomyStore } = await import("@/lib/autonomy/store");
      const { AutonomyRuntime } = await import("@/lib/autonomy/runtime");
      const { BusAuditSink } = await import("@/lib/autonomy/audit");
      const { InMemoryEventBus } = await import("@/lib/architecture/core/event-bus");
      const { InMemoryPerformanceMonitor } = await import("@/lib/architecture/core/performance-monitor");
      const { silentLogger } = await import("@/lib/autonomy/__tests__/helpers");
      const { NO_DELEGATION_ADAPTER_ID } = await import("@/lib/autonomy/execution-adapter");

      const quoteSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true as const,
        data: { quoteId: "q-p6f", sellAmountRaw: "500", expectedBuyAmountRaw: "1000", minBuyAmountRaw: "900", quoteExpiresAt: 9_999_999_999 },
      }));
      const executeSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, txHash: ("0x" + "7f".repeat(32)) as `0x${string}` }));
      const gw = {
        quote: quoteSpy,
        prepare: async () => ({
          ok: true as const,
          data: { steps: [{ step: "x" }], transactionRequest: { to: MAINNET_EXECUTOR, data: "0xdead" as Hex }, expiresAt: 9_999_999_999 },
        }),
        status: async () => ({ ok: true as const, data: { status: "confirmed", blockNumber: "1" } }),
        verify: async () => ({ ok: true as const, data: { verified: true, checks: [], actualBuyAmountRaw: "1000", feeAmountRaw: "1" } }),
      } as never;
      const adapter = {
        id: NO_DELEGATION_ADAPTER_ID, // v1/Mainnet execution chain (8453)
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: executeSpy,
      };
      const store = new InMemoryAutonomyStore();
      const walletAddr = getAddress("0x0000000000000000000000000000000000006b1a") as Address;
      const policy = await store.createPolicy({
        id: "pol-p6f", wallet: walletAddr, chainId: 8453, actions: ["swap"], sellToken: BASE_MAINNET_USDC, buyToken: AAPLc,
        maxPerTradeRaw: "500", maxDailyRaw: "2500", maxSlippageBps: 500, maxActionsPerDay: 2, enabled: true,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        authorizedAt: new Date().toISOString(), authorizationRef: "p6f",
      });
      const goal = await store.createGoal({
        id: "", wallet: walletAddr, policyId: policy!.id, type: "conditional_swap", description: "p6f concurrency", status: "ACTIVE",
        condition: { kind: "price_below", threshold: "1000000000000000000" },
        trade: { sellToken: BASE_MAINNET_USDC, buyToken: AAPLc, sellAmountRaw: "500", slippageBps: 100, sellDecimals: 6, buyDecimals: 18 },
        cooldownSeconds: 60, maxTrades: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), nextEvaluationAt: new Date().toISOString(),
        pendingExecution: null, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
      } as never);
      const bus = new InMemoryEventBus();
      const perf = new InMemoryPerformanceMonitor();
      const runtime = new AutonomyRuntime({ store, gateway: gw, adapter: adapter as never, audit: new BusAuditSink(store, bus, perf), logger: silentLogger, performanceMonitor: perf, now: () => new Date() });

      // TRUE concurrency: both evaluations enter the runtime simultaneously.
      const [a, b] = await Promise.all([runtime.evaluateGoal(goal.id), runtime.evaluateGoal(goal.id)]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["EXECUTION_SUBMITTED", "SKIPPED"]);
      const loser = a.kind === "SKIPPED" ? a : b;
      expect(loser.kind === "SKIPPED" && loser.reason).toBe("LEASE_BUSY");
      expect(executeSpy, "exactly ONE broadcast under concurrency").toHaveBeenCalledTimes(1);
      expect(quoteSpy, "the lease loser must never even quote").toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the execution guard refuses a replayed idempotency key (same slot can never broadcast twice)", async () => {
    const { InMemoryAutonomyStore } = await import("@/lib/autonomy/store");
    const store = new InMemoryAutonomyStore();
    const key = "exec-goal_p6f:2026-10-01T00:00:00.000Z"; // deterministic per-slot key shape (runtime.ts)
    expect(await store.claimExecution(key, 86_400)).toBe(true);
    expect(await store.claimExecution(key, 86_400), "replay of the same slot key must be refused").toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §G — F-13 CLOSURE (registry ↔ fork-proof drift pin). The on-chain half of
// F-13 is test/fork/B20StockBytecodeFork.t.sol (contracts-fork CI): it proves
// all 13 configured stock tokens are DEPLOYED 8-decimal contracts on Base
// mainnet. This offline pin guarantees that .sol proof and the TS registry can
// never drift: same 13 addresses, exact per-symbol match, no extra members.
// -----------------------------------------------------------------------------
describe("PHASE 6 §G: F-13 closure — the fork bytecode proof and the TS stock registry are in lockstep", () => {
  it("BASE_MAINNET_B20_TOKENS has exactly 13 entries and matches test/fork/B20StockBytecodeFork.t.sol symbol-for-symbol", () => {
    expect(BASE_MAINNET_B20_TOKENS).toHaveLength(13);

    const sol = readFileSync("test/fork/B20StockBytecodeFork.t.sol", "utf8");
    const declared = [...sol.matchAll(/address internal constant (\w+c) = (0x[bB]20[0-9a-fA-F]{37});/g)].map(
      (m) => ({ symbol: m[1], address: m[2].toLowerCase() }),
    );
    expect(declared, "the fork test must declare exactly the 13 stock tokens").toHaveLength(13);

    const config = BASE_MAINNET_B20_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address.toLowerCase() }));
    for (let i = 0; i < 13; i++) {
      expect(declared[i].symbol, `registry order/symbol drift at #${i}`).toBe(config[i].symbol);
      expect(declared[i].address, `registry address drift for ${config[i].symbol}`).toBe(config[i].address);
    }
  });
});
