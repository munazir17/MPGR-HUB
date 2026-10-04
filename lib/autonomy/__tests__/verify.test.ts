// Verification engine tests (spec §24 — Verification). Uses the REAL MCP
// status/verify functions against fixture receipts, so "verified" means the
// executor receipt genuinely matched the quote (event, fee, min output).
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";

import { verifyExecution } from "@/lib/autonomy/verify";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { RouterKind } from "@/lib/executor/executor-config";
import {
  EXECUTOR,
  MAINNET_EXECUTOR,
  MAINNET_REGISTRY,
  fakeReader,
  MAINNET_SLIP_ROUTER,
  MAINNET_USDC,
  TEST_SECRET,
  newFakeState,
  setBalance,
  swapExecutedLog,
  testDeps,
  type FakeChainState,
} from "@/lib/mcp/__tests__/fixtures";

const AAPLc = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const QUOTE_ID = "q1.fake.fake"; // MAC-checked in real use; here the fake deps' secret verifies only real ids
const TX = `0x${"cd".repeat(32)}` as Hex;

function depsWith(state: FakeChainState) {
  return testDeps(state, {
    registry: MAINNET_REGISTRY,
    mainnetEnabled: true,
    quoteSecret: TEST_SECRET,
    reader: (chainId) => fakeReader(state, chainId, chainId === 8453 ? MAINNET_EXECUTOR : EXECUTOR),
  });
}

function gateway(state: FakeChainState) {
  return new McpTradeGateway(depsWith(state));
}

function baseInput(over: Partial<Parameters<typeof verifyExecution>[1]> = {}): Parameters<typeof verifyExecution>[1] {
  return {
    chainId: 8453,
    quoteId: QUOTE_ID,
    txHash: TX,
    expectedBuyAmountRaw: "40000000",
    minBuyAmountRaw: "39600000",
    attemptsSoFar: 0,
    ...over,
  };
}

describe("verifyExecution verdicts", () => {
  it("unknown tx -> PENDING (never success), until the attempt budget is exhausted", async () => {
    const state = newFakeState();
    const pending = await verifyExecution(gateway(state), baseInput());
    expect(pending.outcome).toBe("PENDING_VERIFICATION");
    expect(pending.verified).toBe(false);

    const exhausted = await verifyExecution(gateway(state), baseInput({ attemptsSoFar: 10 }));
    expect(exhausted.outcome).toBe("UNCERTAIN");
    expect(exhausted.code).toBe("TIMEOUT");
  });

  it("reverted receipt -> FAILED with TX_REVERTED (never reported as success)", async () => {
    const state = newFakeState();
    state.receipts.set(TX.toLowerCase(), {
      status: "reverted",
      transactionHash: TX,
      blockNumber: 9n,
      from: MAINNET_EXECUTOR,
      to: MAINNET_EXECUTOR,
      logs: [],
    } as never);
    const verdict = await verifyExecution(gateway(state), baseInput());
    expect(verdict.outcome).toBe("FAILED");
    expect(verdict.code).toBe("TX_REVERTED");
    expect(verdict.verified).toBe(false);
  });

  it("invalid quoteId (MAC mismatch) never yields success", async () => {
    const state = newFakeState();
    state.receipts.set(TX.toLowerCase(), {
      status: "success",
      transactionHash: TX,
      blockNumber: 9n,
      from: MAINNET_EXECUTOR,
      to: MAINNET_EXECUTOR,
      logs: [],
    } as never);
    const verdict = await verifyExecution(gateway(state), baseInput());
    // Either PENDING (retryable verification error) or FAILED — but NEVER verified.
    expect(verdict.verified).toBe(false);
    expect(["PENDING_VERIFICATION", "FAILED", "UNCERTAIN"]).toContain(verdict.outcome);
  });

  it("full honest flow: a properly minted quote + matching receipt verifies", async () => {
    const state = newFakeState();
    // Mint a REAL quoteId through the real MCP quote path so the MAC verifies.
    const deps = depsWith(state);
    const { getQuote } = await import("@/lib/mcp/mcp-trade-service");
    const wallet = "0x0000000000000000000000000000000000d0e541" as const;
    setBalance(state, MAINNET_USDC, wallet, 1_000_000_000n); // fund: prepare checks balance
    state.quoteNum = 2n;
    state.quoteDen = 1n;
    const quote = await getQuote(deps, {
      chainId: 8453,
      taker: wallet,
      sellToken: MAINNET_USDC,
      buyToken: AAPLc,
      sellAmount: "20000000",
      slippageBps: 100,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    // mpgr_get_quote returns the intent view flat at the top level.
    const intent = quote.data as unknown as { quoteId: string; expectedBuyAmount: string; minBuyAmount: string; sellAmount: string };

    // A receipt that matches the quote exactly (executor event, exact fee).
    const sell = BigInt(intent.sellAmount);
    const fee = (sell * 25n) / 10_000n;
    state.receipts.set(TX.toLowerCase(), {
      status: "success",
      transactionHash: TX,
      blockNumber: 42n,
      from: wallet,
      to: MAINNET_EXECUTOR,
      logs: [
        swapExecutedLog(MAINNET_EXECUTOR, {
          taker: wallet,
          router: MAINNET_SLIP_ROUTER,
          intentId: `0x${"11".repeat(32)}`, // replaced below with the real intent id via prepare
          tokenIn: MAINNET_USDC,
          tokenOut: AAPLc,
          grossAmountIn: sell,
          feeAmount: fee,
          swapAmountIn: sell - fee,
          amountOut: BigInt(intent.expectedBuyAmount),
          feeRecipient: state.feeRecipient,
          feeBps: 25,
          routerKind: RouterKind.AERODROME_SLIPSTREAM,
          flags: 0,
        }),
      ],
    } as never);

    // The intentId is part of the MAC'd quote — derive it from prepare.
    const { prepareTrade } = await import("@/lib/mcp/mcp-trade-service");
    const { decodeFunctionData } = await import("viem");
    const { MPGR_EXECUTOR_ABI } = await import("@/lib/executor/mpgr-executor-abi");
    const prepared = await prepareTrade(deps, { quoteId: intent.quoteId, authorization: "APPROVAL" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const txRequest = (prepared.data as { transactionRequest: { to: string; data: Hex } }).transactionRequest;
    const params = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: txRequest.data }).args?.[0] as { intentId: Hex };
    const receipt = state.receipts.get(TX.toLowerCase()) as unknown as { logs: unknown[] };
    const rebuilt = swapExecutedLog(MAINNET_EXECUTOR, {
      taker: wallet,
      router: MAINNET_SLIP_ROUTER,
      intentId: params.intentId,
      tokenIn: MAINNET_USDC,
      tokenOut: AAPLc,
      grossAmountIn: sell,
      feeAmount: fee,
      swapAmountIn: sell - fee,
      amountOut: BigInt(intent.expectedBuyAmount),
      feeRecipient: state.feeRecipient,
      feeBps: 25,
      routerKind: RouterKind.AERODROME_SLIPSTREAM,
      flags: 0,
    });
    receipt.logs = [rebuilt];

    const verdict = await verifyExecution(gateway(state), baseInput({ quoteId: intent.quoteId, expectedBuyAmountRaw: intent.expectedBuyAmount, minBuyAmountRaw: intent.minBuyAmount }));
    expect(verdict.outcome).toBe("VERIFIED");
    expect(verdict.verified).toBe(true);
    expect(verdict.code).toBe("VERIFIED");
  });
});
