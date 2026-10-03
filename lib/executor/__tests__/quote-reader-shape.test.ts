// lib/executor/__tests__/quote-reader-shape.test.ts
//
// REGRESSION LOCK (offline, mocked — no network, no keys) for the harness
// reader bug that stopped the armed Mainnet canary BEFORE signing:
// viem 2.x `simulateContract()` returns { result, request }. A ChainReader
// must pass that object through SINGLE-wrapped (exactly like the production
// createViemChainReader). Double-wrapping made quoteSlipstream index [0] on
// the wrapper object and silently return `undefined` -> TypeError at
// mcp-trade-service `expectedBuyAmount: expected.toString()`.

import { describe, expect, it } from "vitest";
import { quoteSlipstream, quoteUniswapV3, type ChainReader } from "@/lib/executor/executor-chain";

// Exact output tuple of Aerodrome Slipstream QuoterV2.quoteExactInputSingle —
// delivered by viem inside { result, request }.
const QUOTER_RESULT = [997_500n, 123456789n, 1, 100_000n] as const;
const fakeViemClient = { simulateContract: async (_a: unknown) => ({ result: QUOTER_RESULT, request: {} }) };

/** Production shape (createViemChainReader, executor-chain.ts:69). */
const singleWrapReader = (client: typeof fakeViemClient): ChainReader =>
  ({ chainId: 8453, simulateContract: (a: unknown) => client.simulateContract(a) }) as unknown as ChainReader;

/** The historical harness bug: wrapping the { result, request } object AGAIN. */
const doubleWrapReader = (client: typeof fakeViemClient): ChainReader =>
  ({ chainId: 8453, simulateContract: async (a: unknown) => ({ result: await client.simulateContract(a) }) }) as unknown as ChainReader;

describe("ChainReader simulateContract shape -> quoter extraction (offline regression)", () => {
  it("production single-wrap: quoteSlipstream returns the amountOut bigint", async () => {
    const out = await quoteSlipstream(singleWrapReader(fakeViemClient), "0xq" as never, "0xi" as never, "0xo" as never, 1_000_000n, 10);
    expect(typeof out).toBe("bigint");
    expect(out).toBe(997_500n);
  });

  it("quoteUniswapV3 extraction consumes the same viem { result } shape", async () => {
    const out = await quoteUniswapV3(singleWrapReader(fakeViemClient), "0xq" as never, "0xi" as never, "0xo" as never, 1_000_000n, 500);
    expect(typeof out).toBe("bigint");
    expect(out).toBe(997_500n);
  });

  it("documents the bug: double-wrap makes the extractor return undefined (readers must never do this)", async () => {
    const out = await quoteSlipstream(doubleWrapReader(fakeViemClient), "0xq" as never, "0xi" as never, "0xo" as never, 1_000_000n, 10);
    expect(out).toBeUndefined();
  });
});
