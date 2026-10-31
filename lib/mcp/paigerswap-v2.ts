// lib/mcp/paigerswap-v2.ts
//
// The MPGR Agent adapter for the sealed PaigerSwap V2 executor.
// This module does not discover pools, encode calldata, or simulate. The
// runtime in paigerswap-v2-runtime.ts calls discoverV2Quote and
// prepareV2Execution, and this file only checks that what came back is the
// same transaction the wallet will be asked to sign.
//
// Nothing here signs or broadcasts. Permit modes are refused: V2 settlement
// is an exact ERC-20 approval to the executor, or native ETH sent as value.

import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/sealed-manifest";
import { V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { inspectV2SwapTransaction, type V2SwapIntent } from "@/lib/swap/v2/intent";
import { verifyV2Receipt, type V2ReceiptLike } from "@/lib/swap/v2/settlement";
import type { QuotePayload } from "./quote-id";

export interface PaigerSwapV2Binding {
  executor: Address;
  transaction: { to: Address; data: Hex; value: string };
  minBuyAmount: string;
  intentId: Hex;
  deadline: string;
  blockNumber: string;
  blockHash: Hex;
  executionSimulation: "eth-call-succeeded-no-settlement-proof" | "quoted-before-approval";
  entry: "swapExactInput" | "swapExactInputSplit";
  hops: number;
  pools: string[];
}

export interface PaigerSwapV2QuoteRequest {
  sellToken: Address;
  buyToken: Address;
  gross: bigint;
  taker: Address;
  slippageBps: number;
  nativeIn: boolean;
  nativeOut: boolean;
  deadline: bigint;
}

export type PaigerSwapV2QuoteResult =
  | { ok: true; fee: bigint; amountOut: bigint; priceImpactBps: number | null; binding: PaigerSwapV2Binding }
  | { ok: false; code: string; message: string; fallThrough: boolean };

export interface PaigerSwapV2Port {
  /** Source gate. False means Agent must not attempt V2. */
  activated: boolean;
  /** Pinned executor. A quote for any other contract is refused. */
  executor: Address;
  quote(input: PaigerSwapV2QuoteRequest): Promise<PaigerSwapV2QuoteResult>;
  /** Re-check live posture and, when the quote was simulated, the same calldata. */
  confirm(binding: PaigerSwapV2Binding, taker: Address): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

const ATOMIC = /^\d+$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const DATA = /^0x[0-9a-fA-F]*$/;

export function parsePaigerSwapV2Binding(raw: unknown): PaigerSwapV2Binding | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<PaigerSwapV2Binding> & { transaction?: Partial<PaigerSwapV2Binding["transaction"]> };
  const tx = v.transaction;
  if (!tx || typeof tx.to !== "string" || typeof tx.data !== "string" || typeof tx.value !== "string") return null;
  if (!ATOMIC.test(tx.value) || !DATA.test(tx.data) || tx.data.length < 10) return null;
  if (typeof v.executor !== "string" || typeof v.minBuyAmount !== "string" || !ATOMIC.test(v.minBuyAmount) || v.minBuyAmount === "0") return null;
  if (typeof v.intentId !== "string" || !HASH32.test(v.intentId)) return null;
  if (typeof v.deadline !== "string" || !ATOMIC.test(v.deadline) || v.deadline === "0") return null;
  if (typeof v.blockNumber !== "string" || !ATOMIC.test(v.blockNumber)) return null;
  if (typeof v.blockHash !== "string" || !HASH32.test(v.blockHash)) return null;
  if (v.executionSimulation !== "eth-call-succeeded-no-settlement-proof" && v.executionSimulation !== "quoted-before-approval") return null;
  if (v.entry !== "swapExactInput" && v.entry !== "swapExactInputSplit") return null;
  if (!Number.isInteger(v.hops) || (v.hops as number) < 1 || (v.hops as number) > 12) return null;
  if (!Array.isArray(v.pools) || v.pools.length === 0 || v.pools.some((p) => typeof p !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p))) return null;
  try {
    return {
      executor: getAddress(v.executor),
      transaction: { to: getAddress(tx.to), data: tx.data as Hex, value: tx.value },
      minBuyAmount: v.minBuyAmount,
      intentId: v.intentId as Hex,
      deadline: v.deadline,
      blockNumber: v.blockNumber,
      blockHash: v.blockHash as Hex,
      executionSimulation: v.executionSimulation,
      entry: v.entry,
      hops: v.hops as number,
      pools: v.pools,
    };
  } catch {
    return null;
  }
}

/** Independent check that a V2 quote's calldata is the sealed executor's swap
 * for this exact taker, fee and minimum. Returns the inspected intent. */
export function inspectPaigerSwapV2Binding(
  binding: PaigerSwapV2Binding,
  input: { taker: Address; sellToken: Address; buyToken: Address; nativeIn: boolean; nativeOut: boolean; gross: bigint; fee: bigint; minBuyAmount: bigint },
): { ok: true; intent: V2SwapIntent } | { ok: false; reason: string } {
  if (binding.executor.toLowerCase() !== SWAP_V2_SEALED_MANIFEST.executor.toLowerCase()) {
    return { ok: false, reason: "Quote executor is not the sealed PaigerSwap V2 contract." };
  }
  if (binding.transaction.to.toLowerCase() !== binding.executor.toLowerCase()) {
    return { ok: false, reason: "Quote transaction does not target the V2 executor." };
  }
  const inspected = inspectV2SwapTransaction(
    { to: binding.transaction.to, data: binding.transaction.data, value: BigInt(binding.transaction.value) },
    {
      deployment: SWAP_V2_SEALED_MANIFEST,
      taker: input.taker,
      feeBps: 25,
      feeRecipient: V2_FEE_RECIPIENT,
      fromAddress: input.sellToken,
      toAddress: input.buyToken,
      nativeIn: input.nativeIn,
      nativeOut: input.nativeOut,
    },
  );
  if (!inspected.ok) return { ok: false, reason: inspected.reason };
  const intent = inspected.value;
  if (intent.grossAmountIn !== input.gross) return { ok: false, reason: "Calldata gross does not match the sell amount." };
  if (intent.expectedFeeAmount !== input.fee) return { ok: false, reason: "Calldata fee is not the single 0.25% trading fee on gross." };
  if (intent.amountOutMinimum !== input.minBuyAmount) return { ok: false, reason: "Calldata minimum does not match the quoted slippage." };
  if (intent.intentId.toLowerCase() !== binding.intentId.toLowerCase()) return { ok: false, reason: "Calldata intent id does not match the quote." };
  if (intent.deadline.toString() !== binding.deadline) return { ok: false, reason: "Calldata deadline does not match the quote." };
  if (intent.entry !== binding.entry) return { ok: false, reason: "Calldata entry point does not match the quote." };
  return { ok: true, intent };
}

export function paigerSwapV2QuoteView(args: {
  quoteId: string;
  payload: QuotePayload;
  binding: PaigerSwapV2Binding;
  sell: { address: Address; symbol: string; decimals: number };
  buy: { address: Address; symbol: string; decimals: number };
  balance: bigint;
  priceImpactBps: number | null;
}): Record<string, unknown> {
  const p = args.payload;
  const sellAmount = BigInt(p.sellAmount);
  const expected = BigInt(p.expectedBuyAmount);
  const min = BigInt(args.binding.minBuyAmount);
  const fee = BigInt(p.feeAmount);
  return {
    quoteId: args.quoteId,
    chainId: 8453,
    provider: "paigerswap-v2",
    taker: p.taker,
    recipient: p.taker,
    sellToken: { address: args.sell.address, symbol: args.sell.symbol, decimals: args.sell.decimals },
    buyToken: { address: args.buy.address, symbol: args.buy.symbol, decimals: args.buy.decimals },
    sellNative: p.sellNative,
    buyNative: p.buyNative,
    sellAmount: p.sellAmount,
    sellAmountHuman: formatUnits(sellAmount, args.sell.decimals),
    expectedBuyAmount: p.expectedBuyAmount,
    expectedBuyAmountHuman: formatUnits(expected, args.buy.decimals),
    minBuyAmount: args.binding.minBuyAmount,
    minBuyAmountHuman: formatUnits(min, args.buy.decimals),
    slippageBps: p.slippageBps,
    feeBps: 25,
    feeAmount: p.feeAmount,
    feeAmountHuman: formatUnits(fee, args.sell.decimals),
    feeToken: p.sellNative ? "ETH" : args.sell.address,
    feeRecipient: p.feeRecipient,
    feeCollection: "same-transaction (PaigerSwap V2 executor, on-chain, exact, once on gross)",
    swapAmount: (sellAmount - fee).toString(),
    route: {
      provider: "paigerswap-v2",
      executor: args.binding.executor,
      entry: args.binding.entry,
      hops: args.binding.hops,
      pools: args.binding.pools,
      executionSimulation: args.binding.executionSimulation,
    },
    executor: args.binding.executor,
    spender: args.binding.executor,
    authorization: "APPROVAL",
    deadline: Number(args.binding.deadline),
    expiresAt: p.exp,
    balanceSufficient: args.balance >= sellAmount,
    takerBalance: args.balance.toString(),
    priceImpactBps: args.priceImpactBps,
    transactionRequest: {
      chainId: 8453,
      to: args.binding.transaction.to,
      data: args.binding.transaction.data,
      value: args.binding.transaction.value,
    },
    nextStep: "Call mpgr_prepare_trade with this quoteId and authorization APPROVAL. The wallet must confirm. This server does not sign or send.",
    settlementNote: "Simulation is not a settlement proof. The wallet confirms the unsigned transaction. The receipt is verified against the committed minimum and the actual fee event.",
  };
}

export function verifyPaigerSwapV2Trade(
  payload: QuotePayload,
  receipt: V2ReceiptLike & { to?: string | null; transactionHash?: Hex },
): { verified: boolean; reason: string | null; settlement: ReturnType<typeof verifyV2Receipt> | null } {
  const binding = parsePaigerSwapV2Binding(payload.v2);
  if (!binding) return { verified: false, reason: "Quote is missing its PaigerSwap V2 binding.", settlement: null };
  if (!receipt.to || receipt.to.toLowerCase() !== SWAP_V2_SEALED_MANIFEST.executor.toLowerCase()) {
    return { verified: false, reason: "Receipt was not sent to the sealed PaigerSwap V2 executor.", settlement: null };
  }
  const inspected = inspectPaigerSwapV2Binding(binding, {
    taker: getAddress(payload.taker),
    sellToken: getAddress(payload.sellToken),
    buyToken: getAddress(payload.buyToken),
    nativeIn: payload.sellNative,
    nativeOut: payload.buyNative,
    gross: BigInt(payload.sellAmount),
    fee: BigInt(payload.feeAmount),
    minBuyAmount: BigInt(binding.minBuyAmount),
  });
  if (!inspected.ok) return { verified: false, reason: inspected.reason, settlement: null };
  const settlement = verifyV2Receipt(inspected.intent, receipt, SWAP_V2_SEALED_MANIFEST);
  return { verified: settlement.verified, reason: settlement.reason, settlement };
}
