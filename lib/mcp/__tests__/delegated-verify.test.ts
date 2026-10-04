// lib/mcp/__tests__/delegated-verify.test.ts
//
// PHASE 3 SEAM REGRESSION (verify side): the delegated executor's trades must
// verify against the DELEGATED registry, selected by FACT from the receipt's
// executed contract, with the event intentId pinned to the SIGNED witness
// actionId (the executor reverts unless call intentId == actionId, so the
// event can never carry the quote-derived id). Caught live by the Phase-3
// run: verification used the v1 registry and refused the delegated tokens.

import { describe, expect, it, beforeEach } from "vitest";
import { getAddress, type Hex, type Log } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { verifyTrade } from "@/lib/mcp/mcp-trade-service";
import {
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
} from "@/lib/executor/delegated-executor";
import { BASE_SEPOLIA_UNISWAP_V3 } from "@/lib/executor/executor-config";
import {
  FEE_RECIPIENT,
  fakeReader,
  newFakeState,
  swapExecutedLog,
  testDeps,
  type FakeChainState,
} from "./fixtures";

const BROADCASTER = getAddress("0x0000000000000000000000000000000000000b22");
const TAKER = privateKeyToAccount(generatePrivateKey()).address;
const FEE_RECIPIENT_LOCAL = getAddress("0x0000000000000000000000000000000000000fee");
const TX = ("0x" + "77".repeat(32)) as Hex;
const ACTION_ID = delegatedActionId("verify-goal-1");
const GROSS = 100_000_000n; // 100 x 6dp
const FEE = (GROSS * 25n) / 10000n; // exact 25 bps

function delegatedReceipt(): Record<string, unknown> {
  const log: Log = swapExecutedLog(DELEGATED_EXECUTOR_ADDRESS, {
    taker: TAKER,
    router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
    intentId: ACTION_ID,
    tokenIn: DELEGATED_BASE_SEPOLIA_TUSD,
    tokenOut: DELEGATED_BASE_SEPOLIA_TSTOCK,
    grossAmountIn: GROSS,
    feeAmount: FEE,
    swapAmountIn: GROSS - FEE,
    amountOut: 700_000_000_000_000_000n,
    feeRecipient: FEE_RECIPIENT,
    feeBps: 25,
    routerKind: 2,
    flags: 0,
  });
  return {
    status: "success",
    transactionHash: TX,
    blockNumber: 99n,
    from: BROADCASTER,
    to: DELEGATED_EXECUTOR_ADDRESS,
    logs: [log],
  };
}

async function realDelegatedQuoteId(state: FakeChainState): Promise<string> {
  // A REAL delegated quote (executor hint) so the HMAC payload is authentic.
  const { getQuote } = await import("@/lib/mcp/mcp-trade-service");
  const deps = {
    ...testDeps(state, {}),
    reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
    delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_REGISTRY },
  };
  const out = await getQuote(deps, {
    chainId: 84532,
    taker: TAKER,
    executor: DELEGATED_EXECUTOR_ADDRESS,
    sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
    buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
    sellAmount: GROSS.toString(),
    slippageBps: 100,
  });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return String(out.data.quoteId);
}

import { BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT as BASE_SEPOLIA_DELEGATED_REGISTRY } from "@/lib/executor/delegated-executor";

describe("delegated trade verification (registry-by-receipt + actionId pinning)", () => {
  let state: FakeChainState;

  beforeEach(() => {
    state = newFakeState();
  });

  it("verifies a delegated-executor receipt against the delegated registry", async () => {
    const quoteId = await realDelegatedQuoteId(state);
    state.receipts.set(TX.toLowerCase(), delegatedReceipt() as never);
    const deps = {
      ...testDeps(state, {}),
      reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
      delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_REGISTRY },
    };
    const out = await verifyTrade(deps, {
      quoteId,
      txHash: TX,
      expectedSender: BROADCASTER,
      expectedIntentId: ACTION_ID,
    });
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
    const d = out.data as Record<string, unknown>;
    const failed = (d.checks as Array<{ name: string; ok: boolean; expected: string; actual: string }>).filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(d.verified).toBe(true);
    const event = d.event as Record<string, unknown>;
    expect(event.taker).toBe(getAddress(TAKER));
    expect(event.feeAmount).toBe(FEE.toString());
    expect(event.feeBps).toBe(25);
  });

  it("refuses the delegated receipt when the v1 registry would be used (no receipt-fact selection)", async () => {
    const quoteId = await realDelegatedQuoteId(state);
    state.receipts.set(TX.toLowerCase(), delegatedReceipt() as never);
    const depsWithoutDelegated = {
      ...testDeps(state, {}),
      reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
      delegatedRegistry: {},
    };
    const out = await verifyTrade(depsWithoutDelegated, {
      quoteId,
      txHash: TX,
      expectedSender: BROADCASTER,
      expectedIntentId: ACTION_ID,
    });
    // Fail-closed: TOKEN_NOT_ALLOWED (v1 allowlist) — exactly the live failure.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TOKEN_NOT_ALLOWED");
  });

  it("fails the intentId check when the actionId is not pinned", async () => {
    const quoteId = await realDelegatedQuoteId(state);
    state.receipts.set(TX.toLowerCase(), delegatedReceipt() as never);
    const deps = {
      ...testDeps(state, {}),
      reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
      delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_REGISTRY },
    };
    const out = await verifyTrade(deps, {
      quoteId,
      txHash: TX,
      expectedSender: BROADCASTER,
      // no expectedIntentId -> the quote-derived id can never match the event
    });
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
    expect((out.data as Record<string, unknown>).verified).toBe(false);
  });
});
