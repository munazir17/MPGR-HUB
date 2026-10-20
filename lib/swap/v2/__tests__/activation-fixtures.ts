// lib/swap/v2/__tests__/activation-fixtures.ts
// Builds the exact JSON an ACTIVATED /api/swap/v2/quote would return, using the
// real encoder (`buildV2Transaction`) and the real intent-id derivation. Wiring
// tests therefore exercise genuine calldata rather than a hand-waved stub, so a
// change to the encoder that breaks the client is caught here.
//
// Offline only: no RPC, no fork, no broadcast.
import { keccak256, type Address, type Hex } from "viem";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { buildV2Transaction } from "../transaction";
import { v2IntentId } from "../execution";
import { V2_FEE_RECIPIENT, type V2Quote } from "../discovery";
import { SWAP_V2_SEALED_MANIFEST } from "../deployment";
import { TAKER, TOKEN_A, TOKEN_B, directQuote } from "./helpers";

export const BLOCK = { number: 52_900_000n, hash: `0x${"12".repeat(32)}` as Hex, timestamp: 1_760_000_000n };
export const DEADLINE = 9_999_999_999n;
export const SETTLEMENT_NOTE =
  "Simulation is not a settlement proof. The receipt is verified against the committed minimum and the actual fee event after the wallet broadcasts.";

export interface ActivationFixtureOptions {
  quote?: V2Quote;
  slippageBps?: number;
  taker?: Address;
  deadline?: bigint;
  nativeIn?: boolean;
  nativeOut?: boolean;
  block?: typeof BLOCK;
}

const s = (value: bigint) => value.toString();

/** The activated route response for a quote, with real calldata. */
export function activatedResponse(options: ActivationFixtureOptions = {}): Record<string, unknown> {
  const quote = options.quote ?? directQuote();
  const slippageBps = options.slippageBps ?? 100;
  const taker = options.taker ?? TAKER;
  const deadline = options.deadline ?? DEADLINE;
  const block = options.block ?? BLOCK;
  const nativeIn = options.nativeIn ?? false;
  const nativeOut = options.nativeOut ?? false;
  const intentId = v2IntentId(SWAP_V2_SEALED_MANIFEST, quote, taker, slippageBps, block);
  const built = buildV2Transaction(quote, SWAP_V2_SEALED_MANIFEST.executor, taker, deadline, slippageBps, nativeIn, nativeOut, intentId);
  return {
    quote: {
      tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, gross: s(quote.gross), feeBps: quote.feeBps,
      feeRecipient: quote.feeRecipient, fee: s(quote.fee), net: s(quote.net), amountOut: s(quote.amountOut),
      legs: quote.legs.map((leg) => ({
        pools: leg.pools.map((pool) => ({ pool: pool.pool, kind: pool.kind, router: pool.router })),
        tokens: leg.tokens, amountIn: s(leg.amountIn), amountOut: s(leg.amountOut),
      })),
    },
    blockNumber: s(block.number), blockHash: block.hash,
    preview: false, executable: true,
    executionSimulation: "eth-call-succeeded-no-settlement-proof",
    transaction: { to: built.to, data: built.data, value: s(built.value) },
    executor: SWAP_V2_SEALED_MANIFEST.executor, spender: SWAP_V2_SEALED_MANIFEST.executor, chainId: 8453,
    intentId, entry: quote.legs.length > 1 ? "swapExactInputSplit" : "swapExactInput",
    minToAmount: s(built.minimum), toAmount: s(quote.amountOut),
    fee: s(quote.fee), feeBps: 25, feeRecipient: V2_FEE_RECIPIENT,
    slippageBps, deadline: s(deadline), nativeIn, nativeOut,
    hops: quote.legs[0].pools.length, settlementNote: SETTLEMENT_NOTE,
  };
}

/** The dormant response: byte-identical shape the route returns today. */
export function dormantResponse(quote: V2Quote = directQuote()): Record<string, unknown> {
  const activated = activatedResponse({ quote });
  return {
    quote: activated.quote, blockNumber: activated.blockNumber, blockHash: activated.blockHash,
    preview: true, executable: false, executionSimulation: "not-run-unreleased", transaction: null,
  };
}

export const tokenRef = (address: Address, symbol: string, decimals: number, verified = false): TradeTokenRef =>
  ({ address, symbol, name: symbol, decimals, kind: "erc20", verified });

/** A SELL of TOKEN_A for TOKEN_B, and the reverse BUY, as the UI would hold them. */
export const sellTokens = { from: tokenRef(TOKEN_A, "TKA", 18), to: tokenRef(TOKEN_B, "TKB", 6) };
export const buyTokens = { from: tokenRef(TOKEN_B, "TKB", 6), to: tokenRef(TOKEN_A, "TKA", 18) };

export const calldataHash = (data: Hex) => keccak256(data);

// ---------------------------------------------------------------------------
// Raw receipt log encoding, so settlement can be tested end-to-end through
// swap-policy.verifySwapSettlement rather than only against pre-parsed events.
// ---------------------------------------------------------------------------
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { SWAP_V2_ABI } from "../abi";
import { SWAP_V2_POSTURE_ABI } from "../posture-abi";

export interface SwapExecutedLogInput {
  taker: Address; router: Address; intentId: Hex;
  tokenIn: Address; tokenOut: Address;
  grossAmountIn: bigint; feeAmount: bigint; swapAmountIn: bigint; amountOut: bigint;
  feeRecipient: Address; feeBps?: number; routerKind?: number; flags?: number;
}

/** Encodes a real `SwapExecuted` log exactly as the executor emits it:
 * taker/router/intentId indexed, the rest in the non-indexed data word order. */
export function swapExecutedLog(input: SwapExecutedLogInput): { address: Address; topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: SWAP_V2_ABI, eventName: "SwapExecuted",
    args: { taker: input.taker, router: input.router, intentId: input.intentId },
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint16" },
      { type: "uint8" }, { type: "uint8" },
    ],
    [
      input.tokenIn, input.tokenOut, input.grossAmountIn, input.feeAmount, input.swapAmountIn,
      input.amountOut, input.feeRecipient, input.feeBps ?? 25, input.routerKind ?? 2, input.flags ?? 0,
    ],
  );
  return { address: SWAP_V2_SEALED_MANIFEST.executor, topics, data };
}

/** Encodes a real `SwapPathExecuted` log (intentId/pathHash indexed, hops not). */
export function swapPathExecutedLog(intentId: Hex, pathHash: Hex, hops: number): { address: Address; topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: SWAP_V2_POSTURE_ABI, eventName: "SwapPathExecuted",
    args: { intentId, pathHash },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint256" }], [BigInt(hops)]);
  return { address: SWAP_V2_SEALED_MANIFEST.executor, topics, data };
}
