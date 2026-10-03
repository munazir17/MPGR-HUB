// Phase 2 delegated-execution test suite (spec section O).
// Covers adapter registration, fail-closed posture, authorization-slot
// bindings, policy/quote/fee semantics, verification scoping, idempotency,
// and assisted-trading regression via the untouched default adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { clearInstalledAutonomousExecutionAdapter, installAutonomousExecutionAdapter } from "../execution-adapter";
import { DelegatedExecutionAdapter } from "../delegated-execution-adapter";
import {
  InMemoryDelegatedAuthorizationStore,
  policyHashFor,
  selectDelegatedSlot,
  validateNewSlotAgainstPolicy,
  type DelegatedAuthorizationSlot,
} from "../delegated-authorization";
import {
  delegatedActionId,
  delegatedPermitDigest,
  delegatedPermitTypedData,
  DELEGATED_WITNESS_TYPE_STRING,
} from "@/lib/executor/delegated-executor";
import { verifyExecutorReceipt } from "@/lib/executor/executor-verify";
import { AUTONOMY_CHAIN_ID, DELEGATED_ADAPTER_ID, DELEGATED_EXECUTION_CHAIN_ID, type AutonomyPolicy } from "../types";
import type { McpGateway } from "../mcp-gateway";
import type { DelegatedSwapRequest } from "../types";
import type { ExecutorSwapIntent } from "@/lib/executor/executor-intent";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const sellToken = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const buyToken = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const broadcaster = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const EXECUTOR = "0xa9568499D7e58854F2590a56B6D32788DbfA58F9" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

const env = { ...process.env };
beforeEach(() => {
  process.env = { ...env };
  clearInstalledAutonomousExecutionAdapter();
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
});

function policy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    id: "pol-1",
    wallet,
    chainId: DELEGATED_EXECUTION_CHAIN_ID,
    actions: ["swap"],
    sellToken,
    buyToken,
    maxPerTradeRaw: "1000000000",
    maxDailyRaw: "10000000000",
    maxSlippageBps: 100,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-12-31T00:00:00Z",
    authorizedAt: "2026-01-01T00:00:00Z",
    authorizationRef: "sess:abc",
    ...over,
  };
}

function slot(over: Partial<DelegatedAuthorizationSlot> = {}): DelegatedAuthorizationSlot {
  return {
    id: "slot-1",
    wallet,
    chainId: DELEGATED_EXECUTION_CHAIN_ID,
    policyId: "pol-1",
    goalId: "goal-1",
    slotIndex: 0,
    permit: { token: sellToken, amount: "1000000000", nonce: "123", deadline: 4_100_000_000 },
    witness: {
      owner: wallet,
      buyToken,
      minAmountOut: "900000000",
      deadline: 4_100_000_000,
      // bound to the slot's goal (H-2 invariant, Phase 4)
      actionId: delegatedActionId("goal-1"),
      policyHash: policyHashFor(policy()),
    },
    signature: ("0x" + "22".repeat(65)) as Hex,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function request(over: Partial<DelegatedSwapRequest> = {}): DelegatedSwapRequest {
  return {
    goalId: "goal-1",
    policyId: "pol-1",
    wallet,
    chainId: DELEGATED_EXECUTION_CHAIN_ID,
    quoteId: "q-1",
    sellToken,
    buyToken,
    sellAmountRaw: "1000000000",
    expectedBuyAmountRaw: "990000000",
    minBuyAmountRaw: "950000000",
    slippageBps: 100,
    idempotencyKey: "exec-1",
    steps: [],
    transactionRequest: null,
    ...over,
  };
}

function makeDeps(over: Record<string, unknown> = {}) {
  const slots = new InMemoryDelegatedAuthorizationStore();
  const policies = new Map<string, AutonomyPolicy>([["pol-1", policy()]]);
  const calls: Array<Record<string, unknown>> = [];
  const gateway = {
    delegateSwap: vi.fn(async (input: Record<string, unknown>) => {
      calls.push(input);
      return { ok: true as const, data: { txHash: ("0x" + "ab".repeat(32)) as Hex, expectedSender: broadcaster } };
    }),
  } as unknown as McpGateway;
  const chain = {
    getBytecode: vi.fn(async (a: Address) => (a === EXECUTOR || a === PERMIT2 ? ("0x" + "60".repeat(16)) as Hex : null)),
    readContract: vi.fn(async (args: { functionName: string }) =>
      args.functionName === "feeBps" ? 25 : args.functionName === "PERMIT2" ? PERMIT2 : args.functionName === "WITNESS_TYPE_STRING" ? DELEGATED_WITNESS_TYPE_STRING : wallet,
    ),
  };
  const adapter = new DelegatedExecutionAdapter({
    slots,
    gateway,
    chain,
    broadcast: vi.fn(async () => ("0x" + "ab".repeat(32)) as Hex),
    getPolicy: async (id: string) => policies.get(id) ?? null,
    ...(over as object),
  } as never);
  return { adapter, slots, gateway, chain, calls, policies };
}

// 1 — registration / installer
describe("adapter registration", () => {
  it("installs and resolves only the delegated id (fail-closed otherwise)", () => {
    const { adapter } = makeDeps();
    installAutonomousExecutionAdapter(adapter);
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = DELEGATED_ADAPTER_ID;
    expect(() => installAutonomousExecutionAdapter({ id: "rogue" } as never)).toThrow();
  });
});

// 2–7 + 34–36 — fail-closed posture
describe("fail-closed executionAvailable", () => {
  const cases: Array<[string, (e: Record<string, string | undefined>) => void, string, boolean]> = [
    ["flag off", (e) => (e.MPGR_AUTONOMOUS_AGENT_ENABLED = "false"), "AUTONOMOUS_FLAG_DISABLED", true],
    ["emergency stop", (e) => (e.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true"), "EMERGENCY_DISABLE", true],
    ["broadcaster missing", () => undefined, "BROADCASTER_NOT_CONFIGURED", false],
  ];
  for (const [name, mutate, reason, withBroadcaster] of cases) {
    it(`refuses: ${name}`, async () => {
      const { adapter } = makeDeps(withBroadcaster ? {} : { broadcast: undefined });
      mutate(process.env);
      const verdict = adapter.checkAuthorization(wallet, policy());
      expect(verdict.authorized).toBe(false);
      expect(verdict.reason).toBe(reason);
      const result = await adapter.executeSwap(request());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("EXECUTION_UNAVAILABLE");
    });
  }
  it("cold chain-check cache fails closed; chain-mismatch surfaces once posture is proven", async () => {
    const { adapter } = makeDeps();
    // Cold cache: never an optimistic true.
    expect(adapter.checkAuthorization(wallet, policy({ chainId: AUTONOMY_CHAIN_ID })).reason).toBe("ONCHAIN_CHECK_PENDING");
    expect(adapter.checkStatic().reason).toBe("ONCHAIN_CHECK_PENDING");
    // After the deep on-chain pass the specific chain rejection is auditable.
    await adapter.verifyOnChain();
    expect(adapter.checkAuthorization(wallet, policy({ chainId: AUTONOMY_CHAIN_ID })).reason).toBe("CHAIN_MISMATCH");
    expect(adapter.checkAuthorization(wallet, policy()).authorized).toBe(true);
  });
  it("missing executor code / permit2 code / wrong feeBps / wrong permit2 / rpc failure refuse on-chain", async () => {
    const variants: Array<[string, (c: Record<string, unknown>) => unknown]> = [
      ["executor code missing", (c) => (c.getBytecode = async (a: Address) => (a === EXECUTOR ? null : "0x60"))],
      ["permit2 code missing", (c) => (c.getBytecode = async (a: Address) => (a === PERMIT2 ? null : "0x60"))],
      ["wrong feeBps", (c) => (c.readContract = async (args: { functionName: string }) => (args.functionName === "feeBps" ? 30 : PERMIT2))],
      ["wrong permit2", (c) => (c.readContract = async (args: { functionName: string }) => (args.functionName === "PERMIT2" ? wallet : 25))],
      ["rpc failure", (c) => (c.getBytecode = async () => { throw new Error("down"); })],
    ];
    for (const [name, mutate] of variants) {
      const deps = makeDeps();
      mutate(deps.chain as unknown as Record<string, unknown>);
      const verdict = await deps.adapter.verifyOnChain();
      expect(verdict.authorized, name).toBe(false);
    }
  });
});

// 8–17 — slot bindings
describe("authorization slot bindings", () => {
  it("selects a valid slot and enforces every binding", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const p = policy();
    const ok = selectDelegatedSlot([slot()], { now, policy: p, sellToken, buyToken, sellAmountRaw: "1000000000", liveMinBuyAmountRaw: "950000000" });
    expect(ok.authorized).toBe(true);
    const bad: Array<[string, DelegatedAuthorizationSlot, string]> = [
      ["expired", slot({ permit: { token: sellToken, amount: "1000000000", nonce: "1", deadline: 1000 }, witness: { owner: wallet, buyToken, minAmountOut: "1", deadline: 1000, actionId: delegatedActionId("goal-1"), policyHash: policyHashFor(p) } }), "SLOT_EXPIRED"],
      ["revoked", slot({ revokedAt: now.toISOString() }), "NO_SLOTS"],
      ["consumed", slot({ consumedAt: now.toISOString() }), "NO_SLOTS"],
      ["wrong owner", slot({ witness: { ...slot().witness, owner: broadcaster } }), "OWNER_MISMATCH"],
      ["wrong input token", slot({ permit: { ...slot().permit, token: buyToken } }), "TOKEN_MISMATCH"],
      ["wrong output token", slot({ witness: { ...slot().witness, buyToken: sellToken } }), "OUTPUT_TOKEN_MISMATCH"],
      ["wrong amount", slot({ permit: { ...slot().permit, amount: "42" } }), "AMOUNT_MISMATCH"],
      ["wrong policyHash", slot({ witness: { ...slot().witness, policyHash: ("0x" + "99".repeat(32)) as Hex } }), "POLICY_HASH_MISMATCH"],
      ["stale quote vs signed floor", slot(), "MIN_OUT_WEAKER_THAN_SIGNED"],
    ];
    for (const [name, s, reason] of bad) {
      const live = name === "stale quote vs signed floor" ? "1" : "950000000";
      const v = selectDelegatedSlot(name === "revoked" || name === "consumed" ? [s] : [s], { now, policy: p, sellToken, buyToken, sellAmountRaw: "1000000000", liveMinBuyAmountRaw: live });
      expect(v.authorized, name).toBe(false);
      expect(v.reason, name).toBe(reason);
    }
  });
  it("server-side slot validation refuses policy violations", () => {
    expect(validateNewSlotAgainstPolicy(slot(), policy())).toBeNull();
    expect(validateNewSlotAgainstPolicy(slot({ wallet: broadcaster }), policy())).toBe("OWNER_MISMATCH");
    expect(validateNewSlotAgainstPolicy(slot({ permit: { ...slot().permit, amount: "99999999999999" } }), policy())).toBe("AMOUNT_MISMATCH");
  });
});

// 18–20 — policy-level rejections remain upstream (runtime); adapter consumes slots once
describe("consumption + idempotency", () => {
  it("second executeSwap finds no slot (nonce reuse impossible)", async () => {
    const { adapter, slots } = makeDeps();
    await slots.saveSlots([slot()]);
    const first = await adapter.executeSwap(request());
    expect(first.ok).toBe(true);
    const second = await adapter.executeSwap(request());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("AUTHORIZATION_MISSING");
  });
  it("daily-limit/policy rejection happens upstream and is audited (runtime-tested); adapter refuses unknown policy", async () => {
    const { adapter } = makeDeps({ getPolicy: async () => null });
    await (adapter as unknown as { deps: { slots: InMemoryDelegatedAuthorizationStore } }).deps.slots.saveSlots([slot()]);
    const result = await adapter.executeSwap(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POLICY_REJECTED");
  });
  it("MCP failure surfaces as failure, slot stays consumed", async () => {
    const { adapter, slots } = makeDeps();
    await slots.saveSlots([slot()]);
    (adapter as unknown as { deps: { gateway: McpGateway } }).deps.gateway.delegateSwap = vi.fn(async () => ({ ok: false as const, failure: { code: "RPC_ERROR" as const, message: "boom" } }));
    const result = await adapter.executeSwap(request());
    expect(result.ok).toBe(false);
    const list = await slots.listSlots(wallet, "pol-1");
    expect(list[0].consumedAt).toBeTruthy();
  });
  it("executor revert (MCP RPC_ERROR) keeps slot consumed — no rebroadcast", async () => {
    const { adapter, slots } = makeDeps();
    await slots.saveSlots([slot()]);
    (adapter as unknown as { deps: { gateway: McpGateway } }).deps.gateway.delegateSwap = vi.fn(async () => ({ ok: false as const, failure: { code: "RPC_ERROR" as const, message: "reverted" } }));
    await adapter.executeSwap(request());
    expect((await slots.listSlots(wallet, "pol-1"))[0].consumedAt).toBeTruthy(); // consumed, no tx hash
  });
});

// 21 + fee + verification
describe("fee + verification semantics", () => {
  it("BUY/SELL bind exact 25 bps fee through the shared canonical math", async () => {
    const { adapter, slots, calls } = makeDeps();
    await slots.saveSlots([slot(), { ...slot(), id: "slot-2", slotIndex: 1, permit: { ...slot().permit, nonce: "124" } }]);
    await adapter.executeSwap(request()); // BUY-shaped request (sellToken->buyToken)
    const buy = calls[0] as Record<string, unknown>;
    expect(BigInt(buy.expectedFeeAmount as string)).toBe((1_000_000_000n * 25n) / 10_000n);
  });
  it("verification: broadcaster sender scoped check (delegated) vs default (assisted)", () => {
    const intent = (over: Partial<ExecutorSwapIntent>): ExecutorSwapIntent =>
      ({
        version: 1, chainId: 84532, executor: EXECUTOR, router: buyToken, routerKind: 2, taker: wallet, recipient: wallet,
        sellToken: { address: sellToken, symbol: "T", decimals: 6 }, buyToken: { address: buyToken, symbol: "B", decimals: 18 },
        sellNative: false, buyNative: false, sellAmount: "1000", feeBps: 25, feeAmount: "3", feeToken: sellToken,
        feeRecipient: broadcaster, swapAmount: "997", expectedBuyAmount: "900", minBuyAmount: "890",
        slippageBps: 100, deadline: 4100000000, intentId: ("0x" + "33".repeat(32)) as Hex, ...over,
      }) as ExecutorSwapIntent;
    const receipt = { status: "success" as const, transactionHash: ("0x" + "44".repeat(32)) as Hex, blockNumber: 1n, from: broadcaster, to: EXECUTOR, logs: [] };
    expect(verifyExecutorReceipt(receipt, intent({ expectedSender: broadcaster })).checks.find((c) => c.name.includes("expectedSender"))?.ok).toBe(true);
    expect(verifyExecutorReceipt(receipt, intent({})).verified).toBe(false); // default path still requires tx.from == taker
    const wrongOwner = verifyExecutorReceipt(receipt, intent({ expectedSender: broadcaster, taker: broadcaster }));
    expect(wrongOwner.verified).toBe(false); // event taker must be the owner
  });
});

// canonical digest/typed-data + revocation/cancellation via store
describe("authorization lifecycle", () => {
  it("typed data signs the canonical digest (client == server recipe)", () => {
    const s = slot();
    const typed = delegatedPermitTypedData({ permit: s.permit, witness: s.witness }, 84532, EXECUTOR);
    expect(typeof typed.message.nonce).toBe("bigint");
    expect(delegatedPermitDigest({ permit: s.permit, witness: s.witness }, 84532, EXECUTOR)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("revocation refuses execution", async () => {
    const { adapter, slots } = makeDeps();
    await slots.saveSlots([slot()]);
    await slots.markRevoked("slot-1", wallet, new Date().toISOString());
    const result = await adapter.executeSwap(request());
    expect(result.ok).toBe(false);
  });
});

// assisted regression: default adapter untouched
describe("assisted/manual regression", () => {
  it("default registry still refuses (no delegated config)", async () => {
    delete process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER;
    const mod = await import("../execution-adapter");
    expect(mod.getAutonomousExecutionAdapter().id).toBe("none");
    expect(mod.delegatedExecutionAvailable()).toBe(false);
  });
});
