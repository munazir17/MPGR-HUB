import "server-only";

// lib/trade/aerodrome-slipstream.ts
//
// Coinbase B20 tokenized stocks (AAPLc, TSLAc, …) on Base.
//
// CDP Trade API and 0x Swap API reject these tokens
// (`BUY/SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`). Secondary-market
// liquidity lives in Aerodrome Slipstream CL pools (Gauges V3 factory),
// paired with native USDC, tickSpacing 10, fee 0.05%.
//
// This module:
//   - quotes via Aerodrome QuoterV2 (struct ABI, not the legacy V1
//     positional quoter bound to factory 0x5e7BB1…)
//   - builds unsigned SwapRouter.exactInputSingle calldata
//   - never signs, never broadcasts
//
// ETH/WETH/other ↔ B20 is rejected: there is no direct B20 pool for
// those pairs in v1. User converts to USDC first.

import {
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { erc20Abi } from "@/lib/erc20-abi";
import {
  AERODROME_B20_TICK_SPACING,
  AERODROME_SLIPSTREAM_FACTORY,
  AERODROME_SLIPSTREAM_PROVIDER_ID,
  AERODROME_SLIPSTREAM_QUOTER_V2,
  AERODROME_SLIPSTREAM_SWAP_ROUTER,
  BASE_USDC,
  BASE_WETH,
  TRADE_DEFAULT_SLIPPAGE_BPS,
  isNativeEthSentinel,
} from "./trade-config";
import { getTradePublicClient } from "./trade-public-client";
import { findTokenizedStock } from "./tokenized-stocks";
import type {
  CdpSwapIssues,
  CdpSwapPrice,
  CdpSwapQuote,
  TradeError,
} from "./trade-types";

export const aerodromeSlipstreamFactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

export const aerodromeQuoterV2Abi = [
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
          { name: "tickSpacing", type: "int24" },
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

export const aerodromeSwapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** SwapRouter deadline buffer. Quotes expire in 30s; this leaves headroom to sign. */
export const AERODROME_SWAP_DEADLINE_SECONDS = 180;

export type AerodromeRouteResult<T> =
  | { ok: true; value: T; provider: typeof AERODROME_SLIPSTREAM_PROVIDER_ID }
  | { ok: false; error: TradeError };

export function applySlippageBps(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps <= 0) return amountOut;
  if (slippageBps >= 10_000) return 0n;
  return (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
}

export type ResolvedAerodromeB20Pair =
  | { ok: true; tokenIn: Address; tokenOut: Address; b20Ticker: string }
  | { ok: false; error: TradeError };

function parseHexAddress(value: string): Address | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  return getAddress(value.toLowerCase());
}

/**
 * v1 B20 path is a single-hop USDC ↔ B20 Slipstream pool.
 * Anything else (ETH, WETH, MPGR, B20-B20) is rejected with a
 * convert-to-USDC-first message — we do not invent a multi-hop.
 */
export function resolveAerodromeB20Pair(fromToken: string, toToken: string): ResolvedAerodromeB20Pair {
  const fromB20 = findTokenizedStock(fromToken);
  const toB20 = findTokenizedStock(toToken);
  if (!fromB20 && !toB20) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: "Aerodrome B20 routing requires a Coinbase tokenized stock on one side of the pair.",
      },
    };
  }
  if (fromB20 && toB20) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message:
          "B20-to-B20 swaps are not supported. Sell to USDC first, then buy the other tokenized stock.",
      },
    };
  }
  const b20 = fromB20 ?? toB20;
  if (!b20) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: "Aerodrome B20 routing requires a Coinbase tokenized stock on one side of the pair.",
      },
    };
  }
  const other = fromB20 ? toToken : fromToken;
  if (isNativeEthSentinel(other) || other.toLowerCase() === BASE_WETH.toLowerCase()) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: `Tokenized-stock swaps are USDC pairs on Aerodrome Slipstream. Convert ETH/WETH to USDC first, then swap USDC ↔ ${b20.ticker}. Coinbase CDP and 0x cannot legally quote these tokens.`,
      },
    };
  }
  if (other.toLowerCase() !== BASE_USDC.toLowerCase()) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: `Tokenized-stock swaps on Aerodrome Slipstream are USDC ↔ ${b20.ticker} only. The other token must be native USDC on Base.`,
      },
    };
  }
  const tokenIn = parseHexAddress(fromToken);
  const tokenOut = parseHexAddress(toToken);
  if (!tokenIn || !tokenOut) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Both swap tokens must be 0x addresses." },
    };
  }
  return {
    ok: true,
    tokenIn,
    tokenOut,
    b20Ticker: b20.ticker,
  };
}

export function encodeAerodromeExactInputSingle(params: {
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Hex {
  return encodeFunctionData({
    abi: aerodromeSwapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tickSpacing: AERODROME_B20_TICK_SPACING,
        recipient: params.recipient,
        deadline: params.deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

async function readOptional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function parseAmountIn(raw: string): bigint | null {
  try {
    const amount = BigInt(raw);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

async function quoteAerodromeExactInput(input: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  b20Ticker: string;
}): Promise<{ amountOut: bigint; pool: Address } | { error: TradeError }> {
  const client = getTradePublicClient();
  const pool = await readOptional(async () =>
    client.readContract({
      address: AERODROME_SLIPSTREAM_FACTORY,
      abi: aerodromeSlipstreamFactoryAbi,
      functionName: "getPool",
      args: [input.tokenIn, input.tokenOut, AERODROME_B20_TICK_SPACING],
    }),
  );
  if (!pool || pool.toLowerCase() === zeroAddress) {
    return {
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message: `No Aerodrome Slipstream USDC pool (tickSpacing ${AERODROME_B20_TICK_SPACING}) is deployed for ${input.b20Ticker} yet. Research only — nothing will be signed.`,
      },
    };
  }

  try {
    const { result } = await client.simulateContract({
      address: AERODROME_SLIPSTREAM_QUOTER_V2,
      abi: aerodromeQuoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          amountIn: input.amountIn,
          tickSpacing: AERODROME_B20_TICK_SPACING,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOut = result[0];
    if (amountOut <= 0n) {
      return {
        error: {
          code: "LIQUIDITY_UNAVAILABLE",
          message: `Aerodrome Slipstream quoted zero output for USDC ↔ ${input.b20Ticker}. The pool may have no in-range liquidity.`,
        },
      };
    }
    return { amountOut, pool };
  } catch {
    return {
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message: `Aerodrome Slipstream could not quote USDC ↔ ${input.b20Ticker} right now. The pool may be too thin or temporarily unusable.`,
      },
    };
  }
}

async function readSpenderIssues(input: {
  tokenIn: Address;
  taker: Address;
  amountIn: bigint;
}): Promise<CdpSwapIssues> {
  const client = getTradePublicClient();
  const allowance = await readOptional(async () =>
    client.readContract({
      address: input.tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [input.taker, AERODROME_SLIPSTREAM_SWAP_ROUTER],
    }),
  );
  const balance = await readOptional(async () =>
    client.readContract({
      address: input.tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [input.taker],
    }),
  );

  const issues: CdpSwapIssues = {
    allowance:
      allowance === null || allowance < input.amountIn
        ? {
            currentAllowance: (allowance ?? 0n).toString(),
            spender: AERODROME_SLIPSTREAM_SWAP_ROUTER,
          }
        : null,
    balance:
      balance !== null && balance < input.amountIn
        ? {
            token: input.tokenIn,
            currentBalance: balance.toString(),
            requiredBalance: input.amountIn.toString(),
          }
        : null,
    simulationIncomplete: false,
  };
  return issues;
}

function emptyIssues(): CdpSwapIssues {
  return { allowance: null, balance: null, simulationIncomplete: false };
}

async function buildAerodromePrice(input: {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
  withTransaction: boolean;
}): Promise<AerodromeRouteResult<CdpSwapQuote>> {
  const pair = resolveAerodromeB20Pair(input.fromToken, input.toToken);
  if (!pair.ok) return pair;

  const amountIn = parseAmountIn(input.fromAmount);
  if (amountIn === null) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Swap amount must be a positive atomic-unit integer." },
    };
  }

  const slippageBps = input.slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS;
  const quoted = await quoteAerodromeExactInput({
    tokenIn: pair.tokenIn,
    tokenOut: pair.tokenOut,
    amountIn,
    b20Ticker: pair.b20Ticker,
  });
  if ("error" in quoted) return { ok: false, error: quoted.error };

  const minToAmount = applySlippageBps(quoted.amountOut, slippageBps);
  const takerAddress = parseHexAddress(input.taker);
  const issues =
    takerAddress && input.withTransaction
      ? await readSpenderIssues({
          tokenIn: pair.tokenIn,
          taker: takerAddress,
          amountIn,
        })
      : emptyIssues();

  const price: CdpSwapPrice = {
    liquidityAvailable: true,
    fromToken: pair.tokenIn,
    toToken: pair.tokenOut,
    fromAmount: amountIn.toString(),
    toAmount: quoted.amountOut.toString(),
    minToAmount: minToAmount.toString(),
    issues,
  };

  if (!input.withTransaction) {
    return {
      ok: true,
      value: { ...price, transaction: null, permit2: null },
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    };
  }

  if (!takerAddress) {
    return {
      ok: false,
      error: {
        code: "WALLET_REQUIRED",
        message: "Connect a Base wallet to prepare this Aerodrome tokenized-stock swap.",
      },
    };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + AERODROME_SWAP_DEADLINE_SECONDS);
  const data = encodeAerodromeExactInputSingle({
    tokenIn: pair.tokenIn,
    tokenOut: pair.tokenOut,
    recipient: takerAddress,
    deadline,
    amountIn,
    amountOutMinimum: minToAmount,
  });

  const quote: CdpSwapQuote = {
    ...price,
    transaction: {
      to: AERODROME_SLIPSTREAM_SWAP_ROUTER,
      data,
      value: "0",
    },
    permit2: null,
  };

  return { ok: true, value: quote, provider: AERODROME_SLIPSTREAM_PROVIDER_ID };
}

export async function getAerodromeSlipstreamPrice(request: {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
}): Promise<AerodromeRouteResult<CdpSwapPrice>> {
  const result = await buildAerodromePrice({ ...request, withTransaction: false });
  if (!result.ok) return result;
  const { transaction: _tx, permit2: _p2, ...price } = result.value;
  return { ok: true, value: price, provider: AERODROME_SLIPSTREAM_PROVIDER_ID };
}

export async function createAerodromeSlipstreamQuote(request: {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
}): Promise<AerodromeRouteResult<CdpSwapQuote>> {
  return buildAerodromePrice({ ...request, withTransaction: true });
}

