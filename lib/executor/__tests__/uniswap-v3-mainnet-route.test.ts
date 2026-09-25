// Regression tests for the Base Mainnet production route migration:
//
//   old: Aerodrome Slipstream (USDC<->WETH, tickSpacing 50)
//   new: official Base Uniswap V3 (SwapRouter02 + QuoterV2, WETH/USDC fee 3000)
//
// Everything here is offline and deterministic: no RPC, no key, no signing,
// no broadcast. The Uniswap V3 pool is proven by CREATE2 against the official
// factory instead of a copy-pasted address, and the quote/swap calldata is
// pinned byte-for-byte.
//
// Unchanged by this migration (asserted below): the MPGR Executor address, the
// exact 25 bps sell-token fee, the non-custodial approval/permit flow, and the
// fallback of every non-proven pair to the 0x path.

import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { quoteUniswapV3, type ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_UNISWAP_V3,
  BASE_MAINNET_USDC,
  BASE_MAINNET_USDC_WETH_POOL,
  BASE_MAINNET_USDC_WETH_POOL_FEE,
  CANONICAL_WETH,
  EXECUTOR_DEFAULT_FEE_BPS,
  RouterKind,
  findExecutorRoute,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";
import { computeExecutorFee } from "@/lib/executor/executor-fee";
import {
  approvalAuthorization,
  buildExecutorIntent,
  encodeExactApproval,
  encodeExecutorSwap,
} from "@/lib/executor/executor-intent";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { UNISWAP_V3_POOL_INIT_CODE_HASH, computeUniswapV3PoolAddress, uniswapV3TokenOrder } from "@/lib/executor/uniswap-v3-pool";
import { ZERO_EX_ALLOWANCE_HOLDER_BASE } from "@/lib/trade/zero-ex-native-fee";
import { getQuote, type McpDeps } from "@/lib/mcp/mcp-trade-service";
import { MAINNET_EXECUTOR, MAINNET_REGISTRY, MAINNET_USDC, MAINNET_WETH, fakeReader, newFakeState, testDeps } from "@/lib/mcp/__tests__/fixtures";

const D: ExecutorDeployment = BASE_MAINNET_EXECUTOR_DEPLOYMENT;
const USDC: Address = BASE_MAINNET_USDC;
const WETH: Address = CANONICAL_WETH;
const TAKER = getAddress("0x1234567890123456789012345678901234567890");
/** A Coinbase B20 tokenized stock the CONTRACT allowlists but the registry must never route. */
const B20_AAPL = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb");
/** An arbitrary ERC-20 with no executor route at all. */
const OTHER_ERC20 = getAddress("0x0000000000000000000000000000000000004321");

// ---------------------------------------------------------------------------
// Fixed calldata fixtures (regenerated from this repo's encoders; changing them
// means the route, the fee math or the executor ABI moved).
// ---------------------------------------------------------------------------

/** quoteExactInputSingle((USDC, WETH, 9_975_000, 3000, 0)) on the Uniswap V3 QuoterV2. */
const EXPECTED_QUOTE_CALLDATA =
  "0xc6a5026a" +
  "000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913" +
  "0000000000000000000000004200000000000000000000000000000000000006" +
  "00000000000000000000000000000000000000000000000000000000009834d8" +
  "0000000000000000000000000000000000000000000000000000000000000bb8" +
  "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * swapUniswapV3ExactInputSingle(params, 3000, APPROVAL) for 10 USDC -> WETH with the exact
 * 25 bps fee: gross 10_000_000, fee 25_000, minOut 2_970_000_000_000_000 (1% slippage),
 * deadline 1_800_000_600, recipient == taker, authorization APPROVAL.
 *
 * Pinned byte-for-byte: if this ever changes, the route, the fee math, the executor ABI or
 * the non-custodial flow moved, and the change needs a deliberate review.
 */
const EXPECTED_SWAP_CALLDATA =
  "0xaa7cebd9" + // swapUniswapV3ExactInputSingle selector
  "0000000000000000000000002626664c2603336e57b271c5c0b26f421741e481" + // router = Uniswap V3 SwapRouter02 (0x2626664c…e481)
  "000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913" + // tokenIn = USDC
  "0000000000000000000000004200000000000000000000000000000000000006" + // tokenOut = WETH
  "0000000000000000000000000000000000000000000000000000000000989680" + // grossAmountIn = 10_000_000 (10 USDC)
  "00000000000000000000000000000000000000000000000000000000000061a8" + // expectedFeeAmount = 25_000 (exact 25 bps, never rounded up)
  "000000000000000000000000000000000000000000000000000a8d3302fba000" + // amountOutMinimum = 2_970_000_000_000_000 (1% slippage)
  "0000000000000000000000001234567890123456789012345678901234567890" + // recipient == taker (output can never be redirected)
  "000000000000000000000000000000000000000000000000000000006b49d458" + // deadline = 1_800_000_600
  "93d7df2aff4ccce885fb3f40c40fbe9d8a4002f45cc21564a141aa383e47fc09" + // intentId = keccak256('mpgr-executor-intent:q1.aaaa')
  "0000000000000000000000000000000000000000000000000000000000000000" + // unwrapNativeOut = false
  "0000000000000000000000000000000000000000000000000000000000000bb8" + // poolFee = 3000 (Uniswap V3 0.30%)
  "0000000000000000000000000000000000000000000000000000000000000180" + // authorization tuple offset (0x180)
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.kind = APPROVAL (0)
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.deadline = 0
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.nonce = 0
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.v = 0
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.r = 0
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.s = 0
  "00000000000000000000000000000000000000000000000000000000000000e0" + // auth.signature offset (0xe0)
  "0000000000000000000000000000000000000000000000000000000000000000" + // auth.signature length = 0 (no permit signature)
  "";

/** approve(executor, 10_000_000) — exact amount, never unlimited. */
const EXPECTED_APPROVAL_CALLDATA =
  "0x095ea7b3" +
  "000000000000000000000000d982726e28275661f8ab64054e6b17a70a63505a" +
  "0000000000000000000000000000000000000000000000000000000000989680";

/** Minimal Uniswap V3 QuoterV2 ABI (mirrors lib/executor/executor-chain.ts). */
const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Loosely-typed encode for the fake reader (viem's overloads can't type a dynamic ABI). */
const encodeCall = encodeFunctionData as unknown as (params: {
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}) => string;

/** A reader that records what the executor layer asked the chain to simulate. */
function recordingReader(quoteOut: bigint) {
  const calls: { address: Address; functionName: string; args: unknown[] | readonly unknown[]; data: string }[] = [];
  const reader: ChainReader = {
    chainId: BASE_MAINNET_CHAIN_ID,
    async readContract({ address, functionName }) {
      if (functionName === "feeBps") return EXECUTOR_DEFAULT_FEE_BPS;
      if (functionName === "feeRecipient") return D.feeRecipient;
      if (functionName === "paused") return false;
      if (functionName === "MAX_FEE_BPS") return 100;
      if (functionName === "owner") return D.owner;
      throw new Error(`unexpected read ${functionName} on ${address}`);
    },
    async simulateContract({ address, abi, functionName, args }) {
      const data = encodeCall({ abi: abi as readonly unknown[], functionName, args: (args ?? []) as readonly unknown[] });
      calls.push({ address, functionName, args: (args ?? []) as unknown[], data });
      return { result: [quoteOut, 0n, 0, 0n] };
    },
    async getBalance() {
      return 0n;
    },
    async getTransactionReceipt() {
      throw new Error("not found");
    },
  };
  return { reader, calls };
}

function buildIntent(sellAmount: bigint, expectedBuyAmount: bigint, slippageBps = 100) {
  const built = buildExecutorIntent({
    deployment: D,
    taker: TAKER,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount,
    expectedBuyAmount,
    slippageBps,
    authorization: "APPROVAL",
    nowSeconds: 1_800_000_000,
    deadlineSeconds: 600,
    quoteId: "q1.aaaa",
    feeBps: EXECUTOR_DEFAULT_FEE_BPS,
    feeRecipient: D.feeRecipient,
  });
  if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
  return built.value;
}

describe("Base Mainnet route: official Uniswap V3 (fee 3000)", () => {
  it("selects the Uniswap V3 / 3000 route for USDC <-> WETH in both directions", () => {
    const forward = findExecutorRoute(D, USDC, WETH);
    const reverse = findExecutorRoute(D, WETH, USDC);
    expect(forward).not.toBeNull();
    expect(reverse).toBe(forward); // one route object, pair order independent
    expect(forward?.kind).toBe(RouterKind.UNISWAP_V3_ROUTER02);
    expect(forward?.kind).toBe(2);
    expect(forward?.router).toBe(BASE_MAINNET_UNISWAP_V3.swapRouter02);
    expect(forward?.quoter).toBe(BASE_MAINNET_UNISWAP_V3.quoterV2);
    expect(forward?.poolFee).toBe(3000);
    expect(forward?.poolFee).toBe(BASE_MAINNET_USDC_WETH_POOL_FEE);
    expect(forward?.tickSpacing).toBeUndefined();
  });

  it("registers exactly one route, and it is no longer the old Slipstream one", () => {
    expect(D.routes).toHaveLength(1);
    for (const r of D.routes) {
      expect(r.kind).toBe(RouterKind.UNISWAP_V3_ROUTER02);
      expect(r.kind).not.toBe(RouterKind.AERODROME_SLIPSTREAM);
    }
    // Only the two proven tokens are routable.
    expect(D.tokens.map((t) => t.symbol)).toEqual(["USDC", "WETH"]);
    // The executor, owner, fee policy and WETH/Permit2 are untouched by the migration.
    expect(D.executor).toBe("0xD982726e28275661F8aB64054E6b17a70a63505A");
    expect(D.feeBps).toBe(25);
    expect(D.weth).toBe(WETH);
  });

  it("never routes a B20 tokenized stock or an arbitrary ERC-20 through the executor", () => {
    expect(findExecutorRoute(D, USDC, B20_AAPL)).toBeNull();
    expect(findExecutorRoute(D, USDC, OTHER_ERC20)).toBeNull();
    expect(findExecutorRoute(D, WETH, B20_AAPL)).toBeNull();
    const refused = buildExecutorIntent({
      deployment: D,
      taker: TAKER,
      sellToken: USDC,
      buyToken: B20_AAPL,
      sellAmount: 10_000_000n,
      expectedBuyAmount: 1n,
      slippageBps: 100,
      authorization: "APPROVAL",
      nowSeconds: 1_800_000_000,
      quoteId: "q1.b20",
      feeBps: 25,
      feeRecipient: D.feeRecipient,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("TOKEN_NOT_ALLOWED");
  });
});

describe("CREATE2 pool verification (official Base Uniswap V3 factory)", () => {
  it("derives the registered WETH/USDC 0.30% pool from the factory", () => {
    expect(computeUniswapV3PoolAddress(BASE_MAINNET_UNISWAP_V3.factory, WETH, USDC, 3000)).toBe(BASE_MAINNET_USDC_WETH_POOL);
    expect(BASE_MAINNET_USDC_WETH_POOL).toBe("0x6c561B446416E1A00E8E93E221854d6eA4171372");
  });

  it("uses the canonical Uniswap V3 pool init-code hash (cross-checked on a known Base pool)", () => {
    expect(UNISWAP_V3_POOL_INIT_CODE_HASH).toBe("0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54");
    // Same formula, different fee tier: the well-known Base WETH/USDC 0.05% pool. If the init
    // code hash (or the factory) were wrong for Base, this would not reproduce.
    expect(computeUniswapV3PoolAddress(BASE_MAINNET_UNISWAP_V3.factory, WETH, USDC, 500)).toBe(
      "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    );
  });

  it("orders the pair by address (token0 = WETH) and is order-independent", () => {
    expect(uniswapV3TokenOrder(WETH, USDC)).toEqual([WETH, USDC]);
    expect(uniswapV3TokenOrder(USDC, WETH)).toEqual([WETH, USDC]);
    expect(computeUniswapV3PoolAddress(BASE_MAINNET_UNISWAP_V3.factory, USDC, WETH, 3000)).toBe(
      computeUniswapV3PoolAddress(BASE_MAINNET_UNISWAP_V3.factory, WETH, USDC, 3000),
    );
    // Different fee tier => different pool, so the route cannot silently drift.
    expect(computeUniswapV3PoolAddress(BASE_MAINNET_UNISWAP_V3.factory, WETH, USDC, 10000)).not.toBe(BASE_MAINNET_USDC_WETH_POOL);
  });
});

describe("exact quote calldata (Uniswap V3 QuoterV2)", () => {
  it("quotes through the registered QuoterV2 with (tokenIn, tokenOut, swapAmount, 3000, 0)", async () => {
    const { reader, calls } = recordingReader(3_000_000_000_000_000n);
    const route = findExecutorRoute(D, USDC, WETH)!;
    const out = await quoteUniswapV3(reader, route.quoter, USDC, WETH, 9_975_000n, route.poolFee!);
    expect(out).toBe(3_000_000_000_000_000n);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.address).toBe(BASE_MAINNET_UNISWAP_V3.quoterV2);
    expect(call.address).toBe("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
    expect(call.functionName).toBe("quoteExactInputSingle");
    expect(call.args).toEqual([
      { tokenIn: USDC, tokenOut: WETH, amountIn: 9_975_000n, fee: 3000, sqrtPriceLimitX96: 0n },
    ]);
    expect(call.data).toBe(EXPECTED_QUOTE_CALLDATA);
    expect(encodeCall({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [call.args[0]] })).toBe(
      EXPECTED_QUOTE_CALLDATA,
    );
  });

  it("quotes the NET amount (gross minus the 25 bps fee), never the gross", async () => {
    const { reader, calls } = recordingReader(1n);
    const route = findExecutorRoute(D, USDC, WETH)!;
    await quoteUniswapV3(reader, route.quoter, USDC, WETH, 10_000_000n - 25_000n, route.poolFee!);
    const params = calls[0].args[0] as unknown as { amountIn: bigint; fee: number };
    expect(params.amountIn).toBe(9_975_000n);
    expect(params.fee).toBe(3000);
  });
});

describe("exact 25 bps fee (unchanged by the migration)", () => {
  it("fee = floor(gross * 25 / 10_000) and swapAmount = gross - fee", () => {
    const fee = computeExecutorFee(10_000_000n, 25);
    expect(fee.ok).toBe(true);
    if (!fee.ok) return;
    expect(fee.value).toEqual({ grossAmountIn: 10_000_000n, feeBps: 25, feeAmount: 25_000n, swapAmountIn: 9_975_000n });
    // Never rounded up, never silently skipped: floor(799*25/10_000) = 1, floor(399*25/10_000) = 0
    // and a zero fee is REFUSED (the contract reverts FeeRoundsToZero).
    const small = computeExecutorFee(799n, 25);
    expect(small.ok === true && small.value.feeAmount).toBe(1n);
    const smallest = computeExecutorFee(400n, 25);
    expect(smallest.ok === true && smallest.value.feeAmount).toBe(1n);
    const refused = computeExecutorFee(399n, 25);
    expect(refused.ok === false && refused.error.code).toBe("FEE_ROUNDS_TO_ZERO");
    expect(EXECUTOR_DEFAULT_FEE_BPS).toBe(25);
  });

  it("the intent carries the same 25 bps of the SELL token and the V3 poolFee", () => {
    const intent = buildIntent(10_000_000n, 3_000_000_000_000_000n);
    expect(intent).toMatchObject({
      chainId: 8453,
      executor: D.executor,
      router: BASE_MAINNET_UNISWAP_V3.swapRouter02,
      routerKind: RouterKind.UNISWAP_V3_ROUTER02,
      poolFee: 3000,
      feeBps: 25,
      feeAmount: "25000",
      feeToken: USDC,
      feeRecipient: D.feeRecipient,
      sellAmount: "10000000",
      swapAmount: "9975000",
      minBuyAmount: "2970000000000000", // 1% slippage on a 0.003 WETH quote
      recipient: TAKER,
      authorization: "APPROVAL",
      spender: D.executor, // APPROVAL approves the executor, not the router
    });
    expect(intent.tickSpacing).toBeUndefined();
    expect(intent.feeAmount).not.toBe("0");
  });
});

describe("exact Uniswap V3 swap calldata", () => {
  it("encodes swapUniswapV3ExactInputSingle(params, 3000, APPROVAL) byte-for-byte", () => {
    const intent = buildIntent(10_000_000n, 3_000_000_000_000_000n);
    const tx = encodeExecutorSwap(intent, approvalAuthorization());
    expect(tx).toMatchObject({ chainId: 8453, to: D.executor, value: "0" });
    expect(tx.data).toBe(EXPECTED_SWAP_CALLDATA);
    expect(tx.data.slice(0, 10)).toBe("0xaa7cebd9"); // swapUniswapV3ExactInputSingle
  });

  it("binds the router, tokens, exact fee, recipient and deadline into the params", () => {
    const intent = buildIntent(10_000_000n, 3_000_000_000_000_000n);
    const tx = encodeExecutorSwap(intent, approvalAuthorization());
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapUniswapV3ExactInputSingle");
    const params = decoded.args?.[0] as {
      router: Address;
      tokenIn: Address;
      tokenOut: Address;
      grossAmountIn: bigint;
      expectedFeeAmount: bigint;
      amountOutMinimum: bigint;
      recipient: Address;
      deadline: bigint;
      intentId: Hex;
      unwrapNativeOut: boolean;
    };
    expect(params.router).toBe(BASE_MAINNET_UNISWAP_V3.swapRouter02);
    expect(params.tokenIn).toBe(USDC);
    expect(params.tokenOut).toBe(WETH);
    expect(params.grossAmountIn).toBe(10_000_000n);
    expect(params.expectedFeeAmount).toBe(25_000n);
    expect(params.amountOutMinimum).toBe(2_970_000_000_000_000n);
    expect(params.recipient).toBe(TAKER); // output can never be redirected
    expect(params.deadline).toBe(1_800_000_600n);
    expect(params.intentId).toBe(intent.intentId);
    expect(params.unwrapNativeOut).toBe(false);
    // The fee tier is the second positional argument, and the auth is APPROVAL (kind 0).
    expect(decoded.args?.[1]).toBe(3000);
    const auth = decoded.args?.[2] as { kind: number; deadline: bigint; nonce: bigint; signature: Hex };
    expect(auth.kind).toBe(0);
    expect(auth.deadline).toBe(0n);
    expect(auth.nonce).toBe(0n);
    expect(auth.signature).toBe("0x");
  });

  it("keeps the non-custodial approval flow: exact approve(executor, gross), never unlimited", () => {
    const approval = encodeExactApproval(8453, USDC, D.executor, 10_000_000n);
    expect(approval).toMatchObject({ chainId: 8453, to: USDC, value: "0" });
    expect(approval.data).toBe(EXPECTED_APPROVAL_CALLDATA);
    expect(approval.data).not.toContain("f".repeat(64)); // no type(uint256).max allowance
  });
});

describe("fallback behaviour is unchanged", () => {
  function mainnetDeps(over: Partial<McpDeps> = {}) {
    const state = newFakeState();
    return testDeps(state, {
      registry: MAINNET_REGISTRY,
      reader: (chainId) => fakeReader(state, chainId, chainId === BASE_MAINNET_CHAIN_ID ? MAINNET_EXECUTOR : undefined),
      mainnetEnabled: true,
      ...over,
    });
  }

  it("the proven USDC/WETH pair still goes to the executor, never to 0x", async () => {
    const zeroEx = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const deps = mainnetDeps({ zeroExFetch: zeroEx as unknown as typeof fetch });
    const q = await getQuote(deps, { chainId: 8453, taker: TAKER, sellToken: "USDC", buyToken: "WETH", sellAmount: "10000000" });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.data.provider).toBe("mpgr-executor");
    expect(zeroEx).not.toHaveBeenCalled();
  });

  it("an unregistered pair (B20 or any other ERC-20) falls back to 0x, never to the Uniswap V3 route", async () => {
    const body = (buyToken: string) => ({
      liquidityAvailable: true,
      sellToken: MAINNET_USDC,
      buyToken,
      sellAmount: "10000000",
      buyAmount: "3000000000000000",
      minBuyAmount: "2970000000000000",
      fees: { integratorFee: { amount: "25000", token: MAINNET_USDC } },
      issues: { allowance: { spender: ZERO_EX_ALLOWANCE_HOLDER_BASE } },
      transaction: { to: ZERO_EX_ALLOWANCE_HOLDER_BASE, data: "0xabcdef", value: "0" },
    });
    const prevKey = process.env.ZERO_EX_API_KEY;
    process.env.ZERO_EX_API_KEY = "k";
    try {
      for (const buyToken of [B20_AAPL, OTHER_ERC20]) {
        const zeroEx = vi.fn(async () => new Response(JSON.stringify(body(buyToken)), { status: 200 }));
        const deps = mainnetDeps({
          mainnetFeeRecipient: getAddress("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4"),
          zeroExFetch: zeroEx as unknown as typeof fetch,
        });
        const q = await getQuote(deps, { chainId: 8453, taker: TAKER, sellToken: MAINNET_USDC, buyToken, sellAmount: "10000000" });
        expect(q.ok).toBe(true);
        if (q.ok) {
          expect(q.data.provider).toBe("0x-native-fee");
          expect(q.data).not.toHaveProperty("executor");
          expect(q.data.feeAmount).toBe("25000");
        }
        expect(zeroEx).toHaveBeenCalled();
      }
    } finally {
      if (prevKey === undefined) delete process.env.ZERO_EX_API_KEY;
      else process.env.ZERO_EX_API_KEY = prevKey;
    }
  });

  it("native ETH in/out stays on the same single Uniswap V3 route", () => {
    expect(findExecutorRoute(D, WETH, USDC)).toBe(findExecutorRoute(D, USDC, WETH));
    const ethOut = buildExecutorIntent({
      deployment: D,
      taker: TAKER,
      sellToken: USDC,
      buyToken: WETH,
      buyNative: true,
      sellAmount: 10_000_000n,
      expectedBuyAmount: 3_000_000_000_000_000n,
      slippageBps: 100,
      authorization: "APPROVAL",
      nowSeconds: 1_800_000_000,
      quoteId: "q1.eth",
      feeBps: 25,
      feeRecipient: D.feeRecipient,
    });
    expect(ethOut.ok).toBe(true);
    if (ethOut.ok) {
      expect(ethOut.value.buyNative).toBe(true);
      expect(ethOut.value.poolFee).toBe(3000);
      expect(ethOut.value.router).toBe(BASE_MAINNET_UNISWAP_V3.swapRouter02);
      // Native ETH out is still unwrapped by the executor — the swap tx carries no value.
      expect(encodeExecutorSwap(ethOut.value, approvalAuthorization()).value).toBe("0");
    }
  });

  it("WETH is still the only native-ETH bridge token", () => {
    expect(D.tokens.filter((t) => t.isWeth).map((t) => t.address)).toEqual([WETH]);
    expect(MAINNET_WETH).toBe(WETH);
  });
});
