import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SWAP_V2_SEALED_MANIFEST, __setSwapV2ExecutorForTests } from "@/lib/swap/v2/deployment";
import { V2QuoteError } from "@/lib/swap/v2/discovery";
import { directQuote } from "@/lib/swap/v2/__tests__/helpers";

const discover = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
const allowanceRead = vi.hoisted(() => vi.fn(async (): Promise<bigint> => { throw new Error("no allowance"); }));
const BLOCK = `0x${"11".repeat(32)}` as const;

vi.mock("@/lib/swap/v2/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swap/v2/discovery")>();
  return { ...actual, discoverV2Quote: discover };
});
vi.mock("@/lib/swap/v2/execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swap/v2/execution")>();
  return { ...actual, prepareV2Execution: prepare };
});
vi.mock("@/lib/trade/trade-public-client", () => ({
  getTradePublicClient: () => ({
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 10n, hash: BLOCK, timestamp: 1_700_000_000n }),
    getCode: async () => "0x1234",
    readContract: allowanceRead,
    call: async () => ({ data: "0x01" }),
  }),
}));

import { createPaigerSwapV2Port, quoteOnPaigerSwapV2 } from "@/lib/mcp/paigerswap-v2-runtime";
import { createMcpDeps } from "@/lib/mcp/mcp-deps";

const TAKER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const MPGR = "0xB2000000000000000000008d204203177a78AF01" as const;

beforeEach(() => {
  __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
  discover.mockReset();
  prepare.mockReset();
  allowanceRead.mockReset();
  allowanceRead.mockRejectedValue(new Error("no allowance"));
  discover.mockImplementation(async (_source: unknown, _sell: string, _buy: string, gross: bigint) => directQuote({ gross }));
  prepare.mockImplementation(async (_reader: unknown, deployment: { executor: string }, request: { quote: { fee: bigint; gross: bigint }; deadline: bigint; nativeIn: boolean }, block: { number: bigint; hash: string }) => ({
    executor: deployment.executor,
    transaction: { to: deployment.executor, data: "0xabcdef", value: request.nativeIn ? request.quote.gross : 0n },
    minimum: 1n,
    intentId: `0x${"ab".repeat(32)}`,
    intent: { deadline: request.deadline, hops: 1 },
    blockNumber: block.number,
    blockHash: block.hash,
    executionSimulation: "eth-call-succeeded-no-settlement-proof",
    entry: "swapExactInput",
    fee: request.quote.fee,
  }));
});
afterEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));

describe("PaigerSwap V2 runtime used by MPGR Agent", () => {
  it("calls canonical discovery and prepareV2Execution and returns that transaction", async () => {
    const gross = 1_000_000_000_000_000_000n;
    const result = await quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross, taker: TAKER, slippageBps: 100,
      nativeIn: true, nativeOut: false, deadline: 1_800_000_180n,
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0][3]).toBe(gross);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][2].quote.fee).toBe((gross * 25n) / 10_000n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fee).toBe((gross * 25n) / 10_000n);
    expect(result.binding.transaction).toMatchObject({ to: SWAP_V2_SEALED_MANIFEST.executor, data: "0xabcdef", value: gross.toString() });
    expect(result.binding.executionSimulation).toBe("eth-call-succeeded-no-settlement-proof");
  });

  it("does not ask prepare to re-simulate a route that only cleared with an allowance override", async () => {
    allowanceRead.mockResolvedValue(0n);
    const result = await quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross: 1_000_000n, taker: TAKER, slippageBps: 100,
      nativeIn: false, nativeOut: false, deadline: 10n,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.executionSimulation).toBe("quoted-before-approval");
  });

  it("does not turn a simulation or RPC failure into a fall-through", async () => {
    prepare.mockRejectedValue(new Error("simulation reverted"));
    const missed = await quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross: 10_000n, taker: TAKER, slippageBps: 100,
      nativeIn: true, nativeOut: false, deadline: 10n,
    });
    expect(missed).toMatchObject({ ok: false, code: "EXECUTION_UNAVAILABLE", fallThrough: false });

    discover.mockRejectedValue(new V2QuoteError("DISCOVERY_UNAVAILABLE", "rpc"));
    const rpc = await quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross: 10_000n, taker: TAKER, slippageBps: 100,
      nativeIn: true, nativeOut: false, deadline: 10n,
    });
    expect(rpc).toMatchObject({ ok: false, code: "DISCOVERY_UNAVAILABLE", fallThrough: false });
  });

  it("allows an explicit 0x fall-through only when discovery finished with no pool", async () => {
    discover.mockRejectedValue(new V2QuoteError("LIQUIDITY_UNAVAILABLE", "none"));
    const result = await quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross: 10_000n, taker: TAKER, slippageBps: 100,
      nativeIn: true, nativeOut: false, deadline: 10n,
    });
    expect(result).toMatchObject({ ok: false, code: "LIQUIDITY_UNAVAILABLE", fallThrough: true });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("is the port createMcpDeps installs while the source gate is on", async () => {
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    const port = createPaigerSwapV2Port();
    expect(port.activated).toBe(true);
    expect(port.executor).toBe(SWAP_V2_SEALED_MANIFEST.executor);
    expect(port.quote).toBe(quoteOnPaigerSwapV2);
    expect(createMcpDeps().paigerSwapV2?.quote).toBe(quoteOnPaigerSwapV2);
    __setSwapV2ExecutorForTests(null);
    expect(createPaigerSwapV2Port().activated).toBe(false);
    await expect(quoteOnPaigerSwapV2({
      sellToken: WETH, buyToken: MPGR, gross: 10_000n, taker: TAKER, slippageBps: 100,
      nativeIn: true, nativeOut: false, deadline: 10n,
    })).resolves.toMatchObject({ ok: false, code: "V2_NOT_ACTIVATED", fallThrough: true });
  });
});
