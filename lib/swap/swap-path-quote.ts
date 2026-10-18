// lib/swap/swap-path-quote.ts
// Server-only quote builder for the fixed-fee MPGRSwapExecutor paths.
// Read-only pool/quote reads + typed calldata; never signs, sends or grants.
import "server-only";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "./swap-executor-abi";
import {
  SWAP_PATH_VENUES, swapPathExecutor, swapPathTokenAllowed, type SwapPathExecutorDeployment,
} from "./swap-executor-config";
import { swapPathFeeFloor } from "./swap-executor-intent";
import { swapPathCandidates, swapPathKey, type SwapPathCandidate, type SwapPathHop } from "./swap-path-candidates";
import type { SwapRouteReadClient } from "./swap-route-selection";

const FACTORY_ABI = [
  { type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "int24" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "bool" }], outputs: [{ type: "address" }] },
] as const;
const V2_QUOTE_ABI = [
  { type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] },
] as const;
const CLASSIC_QUOTE_ABI = [
  { type: "function", name: "getAmountsOut", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "tuple[]", components: [{ type: "address" }, { type: "address" }, { type: "bool" }, { type: "address" }] }],
    outputs: [{ type: "uint256[]" }] },
] as const;
const QUOTER_ABI = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{ type: "tuple", components: [
      { type: "address", name: "tokenIn" }, { type: "address", name: "tokenOut" }, { type: "uint256", name: "amountIn" },
      { type: "uint24", name: "fee" }, { type: "int24", name: "tickSpacing" }, { type: "uint160", name: "sqrtPriceLimitX96" }] }],
    outputs: [{ type: "uint256", name: "amountOut" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] },
] as const;

export interface SwapPathQuoteInput {
  from: TradeTokenRef; to: TradeTokenRef; fromAmount: string; slippageBps: number; taker: Address;
}
export interface SwapPathQuote {
  candidate: SwapPathCandidate;
  pools: readonly Address[];
  quotedOut: bigint;
  blockNumber: bigint;
  blockHash: Hex;
}
export class SwapPathQuoteError extends Error {
  constructor(public code: string, message: string, public status: 422 | 503 = 422) { super(message); this.name = "SwapPathQuoteError"; }
}

const venueFor = (hop: SwapPathHop) =>
  hop.kind === SWAP_PATH_VENUES.uniswapV2.kind ? SWAP_PATH_VENUES.uniswapV2
  : hop.kind === SWAP_PATH_VENUES.aerodromeClassic.kind ? SWAP_PATH_VENUES.aerodromeClassic
  : hop.kind === SWAP_PATH_VENUES.uniswapV3.kind ? SWAP_PATH_VENUES.uniswapV3
  : SWAP_PATH_VENUES.slipstream;

async function resolvePool(reader: SwapRouteReadClient, hop: SwapPathHop, tokenIn: Address): Promise<Address> {
  const venue = venueFor(hop);
  const args = hop.kind === SWAP_PATH_VENUES.uniswapV3.kind ? [tokenIn, hop.tokenOut, hop.poolFee as number]
    : hop.kind === SWAP_PATH_VENUES.slipstream.kind ? [tokenIn, hop.tokenOut, hop.tickSpacing as number]
    : hop.kind === SWAP_PATH_VENUES.aerodromeClassic.kind ? [tokenIn, hop.tokenOut, hop.stable === true]
    : [tokenIn, hop.tokenOut];
  const pool = await reader.readContract({ address: venue.factory, abi: FACTORY_ABI, functionName: hop.kind === SWAP_PATH_VENUES.uniswapV2.kind ? "getPair" : "getPool", args: args as never });
  if (typeof pool !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(pool) || BigInt(pool) === 0n) throw new SwapPathQuoteError("POOL_UNAVAILABLE", "A typed pool for this hop could not be found on Base.");
  return pool as Address;
}

async function quoteHop(reader: SwapRouteReadClient, hop: SwapPathHop, tokenIn: Address, pool: Address, amount: bigint): Promise<bigint> {
  const venue = venueFor(hop);
  if (hop.kind === SWAP_PATH_VENUES.uniswapV2.kind) {
    const amounts = await reader.readContract({ address: venue.router, abi: V2_QUOTE_ABI, functionName: "getAmountsOut", args: [amount, [tokenIn, hop.tokenOut]] });
    const out = (amounts as bigint[])[1];
    if (typeof out !== "bigint" || out <= 0n) throw new SwapPathQuoteError("LIQUIDITY_UNAVAILABLE", "The V2 pool quote is zero for this amount.");
    return out;
  }
  if (hop.kind === SWAP_PATH_VENUES.aerodromeClassic.kind) {
    const amounts = await reader.readContract({ address: venue.router, abi: CLASSIC_QUOTE_ABI, functionName: "getAmountsOut", args: [amount, [[tokenIn, hop.tokenOut, hop.stable === true, venue.factory]] as never] });
    const list = amounts as bigint[];
    const out = list[list.length - 1];
    if (typeof out !== "bigint" || out <= 0n) throw new SwapPathQuoteError("LIQUIDITY_UNAVAILABLE", "The Classic pool quote is zero for this amount.");
    return out;
  }
  const params = hop.kind === SWAP_PATH_VENUES.uniswapV3.kind
    ? { tokenIn, tokenOut: hop.tokenOut, amountIn: amount, fee: hop.poolFee as number, tickSpacing: 0, sqrtPriceLimitX96: 0 }
    : { tokenIn, tokenOut: hop.tokenOut, amountIn: amount, fee: 0, tickSpacing: hop.tickSpacing as number, sqrtPriceLimitX96: 0 };
  const result = await reader.readContract({ address: venue.quoter as Address, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [params] });
  const out = (result as readonly bigint[])[0];
  if (typeof out !== "bigint" || out <= 0n) throw new SwapPathQuoteError("LIQUIDITY_UNAVAILABLE", "The concentrated pool quote is zero for this amount.");
  return out;
}

/** Quotes one typed path at the pinned block. Pools and outputs are read from
 * Base venues; a quote is still not execution permission. */
export async function quoteSwapPath(reader: SwapRouteReadClient, input: SwapPathQuoteInput, candidate: SwapPathCandidate, block: { number: bigint; hash: Hex }): Promise<SwapPathQuote> {
  const deployment = swapPathExecutor();
  if (!deployment) throw new SwapPathQuoteError("EXECUTOR_NOT_DEPLOYED", "The fixed-fee Swap executor is not deployed; no path route is executable.", 422);
  const gross = BigInt(input.fromAmount);
  const fee = swapPathFeeFloor(gross);
  if (fee <= 0n) throw new SwapPathQuoteError("INVALID_INPUT", "The sell amount is too small to collect the mandatory fee in atomic units.");
  let tokenIn = (isNativeEthSentinel(input.from.address) ? deployment.weth : input.from.address) as Address;
  let amount = gross - fee;
  const pools: Address[] = [];
  for (const hop of candidate.hops) {
    const pool = await resolvePool(reader, hop, tokenIn);
    pools.push(pool);
    amount = await quoteHop(reader, hop, tokenIn, pool, amount);
    tokenIn = hop.tokenOut;
  }
  return { candidate, pools, quotedOut: amount, blockNumber: block.number, blockHash: block.hash };
}

/** Builds the exact typed transaction for a quoted path. */
export function buildSwapPathTransaction(deployment: SwapPathExecutorDeployment, input: SwapPathQuoteInput, quote: SwapPathQuote, deadline: number, intentId: Hex) {
  const nativeIn = isNativeEthSentinel(input.from.address);
  const nativeOut = isNativeEthSentinel(input.to.address);
  const gross = BigInt(input.fromAmount);
  const fee = swapPathFeeFloor(gross);
  const minOut = (quote.quotedOut * BigInt(10000 - input.slippageBps)) / 10000n;
  if (minOut <= 0n) throw new SwapPathQuoteError("INVALID_INPUT", "The quoted output is too small for the selected slippage protection.");
  const path = quote.candidate.hops.map((hop, i) => ({
    router: hop.router, tokenOut: hop.tokenOut, kind: hop.kind, poolFee: hop.poolFee ?? 0, tickSpacing: hop.tickSpacing ?? 0, stable: hop.stable === true, pool: quote.pools[i],
  }));
  const data = encodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "swapExactInput", args: [{
    router: path[0].router,
    tokenIn: (nativeIn ? deployment.weth : input.from.address) as Address,
    tokenOut: (nativeOut ? deployment.weth : input.to.address) as Address,
    grossAmountIn: gross, expectedFeeAmount: fee, amountOutMinimum: minOut,
    recipient: input.taker, deadline: BigInt(deadline), intentId, unwrapNativeOut: nativeOut,
  }, path, { kind: 0, deadline: 0n, nonce: 0n, v: 0, r: ("0x" + "0".repeat(64)) as Hex, s: ("0x" + "0".repeat(64)) as Hex, signature: "0x" as Hex }] });
  return { data, value: nativeIn ? gross : 0n, quotedOut: quote.quotedOut, minOut, fee };
}
export const swapPathCandidatesFor = (from: string, to: string) => swapPathCandidates(from, to);
export const swapPathKeyOf = swapPathKey;
/** Eligibility for the path surface: deployed manifest + allowlisted tokens. */
export function swapPathPairEligible(from: string, to: string, deployment: SwapPathExecutorDeployment | null = swapPathExecutor()): boolean {
  if (!deployment) return false;
  const assets = [from, to].map(a => (isNativeEthSentinel(a) ? deployment.weth : a));
  if (!assets.every(a => swapPathTokenAllowed(deployment, a))) return false;
  return swapPathCandidates(from, to).length > 0;
}
export type { TradeProposal };
