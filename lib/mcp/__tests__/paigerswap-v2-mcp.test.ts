import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, type Log } from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import { MPGR_TOKEN_ADDRESS } from "@/lib/chain/base";
import { BASE_MAINNET_CHAIN_ID } from "@/lib/executor/executor-config";
import { getCapabilities, getQuote, finalizeTrade, prepareTrade, verifyTrade, type McpDeps, type ToolOutcome } from "@/lib/mcp/mcp-trade-service";
import type { PaigerSwapV2Port, PaigerSwapV2QuoteRequest, PaigerSwapV2QuoteResult } from "@/lib/mcp/paigerswap-v2";
import { SWAP_V2_ABI } from "@/lib/swap/v2/abi";
import { V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/sealed-manifest";
import { encodeSingle, hop, INTENT_ID, params, POOL_AB, TAKER, UNI_V3_ROUTER, WETH } from "@/lib/swap/v2/__tests__/helpers";

import { fakeReader, FEE_RECIPIENT, EXECUTOR as SEPOLIA_EXECUTOR, MAINNET_EXECUTOR, MAINNET_REGISTRY, MAINNET_USDC, MAINNET_WETH, newFakeState, setBalance, testDeps, type FakeChainState } from "./fixtures";

const MPGR = getAddress(MPGR_TOKEN_ADDRESS);
const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const GROSS = 1_000_000_000_000_000_000n;
const OUT = 2_000_000_000_000_000_000n;

function ok(result: ToolOutcome): Record<string, unknown> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function err(result: ToolOutcome): string {
  if (result.ok) throw new Error("expected failure");
  return result.error.code;
}

function quoted(input: PaigerSwapV2QuoteRequest): Extract<PaigerSwapV2QuoteResult, { ok: true }> {
  const fee = (input.gross * 25n) / 10_000n;
  const min = (OUT * BigInt(10_000 - input.slippageBps)) / 10_000n;
  const data = encodeSingle(params(input.gross, {
    tokenIn: input.sellToken,
    tokenOut: input.buyToken,
    expectedFeeAmount: fee,
    amountOutMinimum: min,
    recipient: input.taker,
    deadline: input.deadline,
    unwrapNativeOut: input.nativeOut,
    intentId: INTENT_ID,
  }), [hop({ tokenOut: input.buyToken })]);
  return {
    ok: true,
    fee,
    amountOut: OUT,
    priceImpactBps: 12,
    binding: {
      executor: EXECUTOR,
      transaction: { to: EXECUTOR, data, value: input.nativeIn ? input.gross.toString() : "0" },
      minBuyAmount: min.toString(),
      intentId: INTENT_ID,
      deadline: input.deadline.toString(),
      blockNumber: "52820895",
      blockHash: `0x${"ab".repeat(32)}`,
      executionSimulation: "eth-call-succeeded-no-settlement-proof",
      entry: "swapExactInput",
      hops: 1,
      pools: [POOL_AB],
    },
  };
}

let state: FakeChainState;
let seen: PaigerSwapV2QuoteRequest[];
let zeroExCalls: number;
let confirmations: number;
let port: PaigerSwapV2Port;

function deps(over: Partial<McpDeps> = {}) {
  return testDeps(state, {
    registry: MAINNET_REGISTRY,
    reader: (chainId) => fakeReader(state, chainId, chainId === BASE_MAINNET_CHAIN_ID ? MAINNET_EXECUTOR : SEPOLIA_EXECUTOR),
    mainnetEnabled: true,
    mainnetFeeRecipient: FEE_RECIPIENT,
    paigerSwapV2: port,
    zeroExFetch: (async () => {
      zeroExCalls += 1;
      return new Response("no", { status: 503 });
    }) as typeof fetch,
    ...over,
  });
}

beforeEach(() => {
  state = newFakeState();
  seen = [];
  zeroExCalls = 0;
  confirmations = 0;
  port = {
    activated: true,
    executor: EXECUTOR,
    quote: async (input) => {
      seen.push(input);
      return quoted(input);
    },
    confirm: async () => {
      confirmations += 1;
      return { ok: true };
    },
  };
  setBalance(state, MPGR, TAKER, GROSS);
  state.ethBalance = GROSS;
});

describe("MPGR Agent PaigerSwap V2", () => {
  it("quotes and prepares an MPGR sell through the sealed V2 executor, not the legacy one", async () => {
    const d = deps();
    const quote = ok(await getQuote(d, {
      chainId: 8453, taker: TAKER, sellToken: "MPGR", buyToken: "ETH", sellAmount: GROSS.toString(), slippageBps: 100,
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sellToken: MPGR, buyToken: WETH, gross: GROSS, nativeIn: false, nativeOut: true, taker: getAddress(TAKER) });
    expect(zeroExCalls).toBe(0);
    const fee = (GROSS * 25n) / 10_000n;
    expect(quote).toMatchObject({
      provider: "paigerswap-v2",
      chainId: 8453,
      executor: EXECUTOR,
      spender: EXECUTOR,
      feeBps: 25,
      feeAmount: fee.toString(),
      feeRecipient: V2_FEE_RECIPIENT,
      sellAmount: GROSS.toString(),
      expectedBuyAmount: OUT.toString(),
      recipient: getAddress(TAKER),
      authorization: "APPROVAL",
    });
    expect(quote.executor).not.toBe(MAINNET_EXECUTOR);
    const tx = quote.transactionRequest as { to: string; data: string; value: string };
    expect(tx.to).toBe(EXECUTOR);
    expect(tx.value).toBe("0");
    expect(tx.data.startsWith("0x")).toBe(true);

    const prepared = ok(await prepareTrade(d, { quoteId: quote.quoteId, authorization: "APPROVAL" }));
    expect(confirmations).toBe(1);
    expect(prepared.transactionRequest).toMatchObject({ to: EXECUTOR, data: tx.data, value: "0" });
    const steps = prepared.steps as { step: string; transactionRequest: { to: string } }[];
    expect(steps.map((step) => step.step)).toEqual(["sendApprovalTransaction", "sendSwapTransaction"]);
    expect(steps[0].transactionRequest.to).toBe(MPGR);
    expect(steps[1].transactionRequest.to).toBe(EXECUTOR);
    expect(prepared.typedData).toBeNull();
    expect(String(prepared.safety)).toMatch(/never signs or broadcasts/i);
    expect(err(await prepareTrade(d, { quoteId: quote.quoteId, authorization: "PERMIT2" }))).toBe("INVALID_AUTHORIZATION");
    expect(err(await finalizeTrade(d, { quoteId: quote.quoteId, authorization: "EIP2612", signature: `0x${"11".repeat(65)}`, permitNonce: "0" }))).toBe("NOT_APPLICABLE");
  });

  it("prepares a native ETH buy of MPGR with value equal to the gross and no approval", async () => {
    const d = deps();
    const quote = ok(await getQuote(d, {
      chainId: 8453, taker: TAKER, sellToken: "ETH", buyToken: "MPGR", sellAmount: GROSS.toString(), slippageBps: 50,
    }));
    expect(seen[0]).toMatchObject({ nativeIn: true, nativeOut: false, sellToken: WETH, buyToken: MPGR });
    expect((quote.transactionRequest as { value: string }).value).toBe(GROSS.toString());
    expect(quote.feeAmount).toBe(((GROSS * 25n) / 10_000n).toString());
    const prepared = ok(await prepareTrade(d, { quoteId: quote.quoteId }));
    const steps = prepared.steps as { step: string }[];
    expect(steps.map((step) => step.step)).toEqual(["sendSwapTransaction"]);
    expect(prepared.transactionRequest).toMatchObject({ to: EXECUTOR, value: GROSS.toString() });
  });

  it("keeps an allowlisted USDC to WETH quote on the legacy executor", async () => {
    setBalance(state, MAINNET_USDC, TAKER, 10_000_000n);
    const quote = ok(await getQuote(deps(), {
      chainId: 8453, taker: TAKER, sellToken: "USDC", buyToken: "WETH", sellAmount: "10000000", slippageBps: 100,
    }));
    expect(seen).toHaveLength(0);
    expect(quote).toMatchObject({ provider: "mpgr-executor", executor: MAINNET_EXECUTOR, feeAmount: "25000" });
  });

  it("does not quote V2 while mainnet MCP trading is disabled", async () => {
    expect(err(await getQuote(deps({ mainnetEnabled: false }), {
      chainId: 8453, taker: TAKER, sellToken: "MPGR", buyToken: "ETH", sellAmount: GROSS.toString(),
    }))).toBe("BASE_MAINNET_DISABLED");
    expect(seen).toHaveLength(0);
  });

  it("returns a simulation failure instead of an 0x quote", async () => {
    port.quote = async () => ({ ok: false, code: "EXECUTION_UNAVAILABLE", message: "simulation missed the minimum", fallThrough: false });
    expect(err(await getQuote(deps(), {
      chainId: 8453, taker: TAKER, sellToken: "MPGR", buyToken: "ETH", sellAmount: GROSS.toString(),
    }))).toBe("EXECUTION_UNAVAILABLE");
    expect(zeroExCalls).toBe(0);
  });

  it("falls through to 0x only when V2 proves the pair has no pool", async () => {
    port.quote = async () => ({ ok: false, code: "LIQUIDITY_UNAVAILABLE", message: "no pool", fallThrough: true });
    const alien = getAddress("0x1111111111111111111111111111111111111111");
    const other = getAddress("0x2222222222222222222222222222222222222222");
    const base = deps();
    const reader = base.reader;
    base.reader = (chainId) => {
      const inner = reader(chainId);
      return {
        ...inner,
        readContract: async (args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
          if (args.functionName === "decimals") return 18;
          if (args.functionName === "symbol") return "ALIEN";
          return inner.readContract(args);
        },
      };
    };
    // getZeroExNativeFeeQuote refuses before fetch when the key is unset.
    // A dummy key proves the fallthrough actually invokes 0x; it is not a live credential.
    const previousKey = process.env.ZERO_EX_API_KEY;
    process.env.ZERO_EX_API_KEY = "unit-test-not-a-credential";
    try {
      const result = await getQuote(base, {
        chainId: 8453, taker: TAKER, sellToken: alien, buyToken: other, sellAmount: GROSS.toString(), slippageBps: 100,
      });
      expect(zeroExCalls).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
    } finally {
      if (previousKey === undefined) delete process.env.ZERO_EX_API_KEY;
      else process.env.ZERO_EX_API_KEY = previousKey;
    }
  });

  it("refuses to return the quoted transaction when confirmation fails", async () => {
    port.confirm = async () => ({ ok: false, code: "QUOTE_STALE", message: "route moved" });
    const quote = ok(await getQuote(deps(), {
      chainId: 8453, taker: TAKER, sellToken: "MPGR", buyToken: "ETH", sellAmount: GROSS.toString(),
    }));
    const prepared = await prepareTrade(deps(), { quoteId: quote.quoteId, authorization: "APPROVAL" });
    expect(err(prepared)).toBe("QUOTE_STALE");
  });

  it("verifies a V2 receipt against the committed fee and rejects a revert or the wrong contract", async () => {
    const d = deps();
    const quote = ok(await getQuote(d, {
      chainId: 8453, taker: TAKER, sellToken: "MPGR", buyToken: "ETH", sellAmount: GROSS.toString(), slippageBps: 100,
    }));
    const fee = (GROSS * 25n) / 10_000n;
    const swapExecuted = SWAP_V2_ABI.find((item) => item.type === "event" && item.name === "SwapExecuted");
    if (!swapExecuted || swapExecuted.type !== "event") throw new Error("SwapExecuted missing");
    const topics = encodeEventTopics({
      abi: [swapExecuted],
      eventName: "SwapExecuted",
      args: { taker: getAddress(TAKER), router: UNI_V3_ROUTER, intentId: INTENT_ID },
    }) as Hex[];
    const nonIndexed = swapExecuted.inputs.filter((input) => !input.indexed);
    const eventArgs: Record<string, unknown> = {
      tokenIn: MPGR,
      tokenOut: WETH,
      grossAmountIn: GROSS,
      feeAmount: fee,
      swapAmountIn: GROSS - fee,
      amountOut: OUT,
      feeRecipient: V2_FEE_RECIPIENT,
      feeBps: 25,
      routerKind: 2,
      flags: 2,
    };
    const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input) => eventArgs[input.name]) as never);
    const hash = `0x${"cd".repeat(32)}` as Hex;
    state.receipts.set(hash, {
      status: "success",
      transactionHash: hash,
      blockNumber: 1n,
      from: getAddress(TAKER),
      to: EXECUTOR,
      logs: [{ address: EXECUTOR, topics: topics as [Hex, ...Hex[]], data } as Log],
    });
    const verified = ok(await verifyTrade(d, { quoteId: quote.quoteId, txHash: hash }));
    expect(verified).toMatchObject({ verified: true, provider: "paigerswap-v2", feeAmount: fee.toString(), feeBps: 25, executor: EXECUTOR });

    const reverted = `0x${"ee".repeat(32)}` as Hex;
    state.receipts.set(reverted, { ...state.receipts.get(hash)!, status: "reverted", transactionHash: reverted });
    expect(ok(await verifyTrade(d, { quoteId: quote.quoteId, txHash: reverted })).verified).toBe(false);

    const wrong = `0x${"ff".repeat(32)}` as Hex;
    state.receipts.set(wrong, { ...state.receipts.get(hash)!, to: MAINNET_EXECUTOR, transactionHash: wrong });
    expect(ok(await verifyTrade(d, { quoteId: quote.quoteId, txHash: wrong })).verified).toBe(false);
  });

  it("advertises paigerswap-v2 only when the gate and the mainnet flag are both on", () => {
    const on = (ok(getCapabilities(deps())).chains as { chainId: number; tradingProviders: string[] }[])
      .find((chain) => chain.chainId === 8453);
    expect(on?.tradingProviders).toEqual(["mpgr-executor", "paigerswap-v2", "0x-native-fee"]);
    const off = (ok(getCapabilities(deps({ mainnetEnabled: false }))).chains as { chainId: number; tradingProviders: string[] }[])
      .find((chain) => chain.chainId === 8453);
    expect(off?.tradingProviders).toEqual([]);
  });
});
