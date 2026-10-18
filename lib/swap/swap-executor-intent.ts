// lib/swap/swap-executor-intent.ts
// Calldata + receipt verification for the fixed-fee MPGRSwapExecutor release
// candidate. Swap-only module: the deployed Executor inspectors are untouched.
import { decodeFunctionData, keccak256, parseEventLogs, type Address, type Hex } from "viem";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "./swap-executor-abi";
import {
  SWAP_FEE_BPS, SWAP_FEE_RECIPIENT, SWAP_MAX_PATH_HOPS, SWAP_PATH_VENUES, swapV3PoolFees,
  type SwapPathExecutorDeployment, type SwapVenueKind,
} from "./swap-executor-config";
import { swapPathAsset } from "./swap-path-candidates";

export const SWAP_FEE_DENOMINATOR = 10_000n;
export const swapPathFeeFloor = (gross: bigint): bigint => (gross * BigInt(SWAP_FEE_BPS)) / SWAP_FEE_DENOMINATOR;

export interface SwapPathHopIntent {
  kind: SwapVenueKind;
  router: Address;
  pool: Address;
  tokenOut: Address;
  poolFee?: number;
  tickSpacing?: number;
  stable?: boolean;
}
export interface SwapExecutorIntent {
  executor: Address;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  grossAmountIn: bigint;
  expectedFeeAmount: bigint;
  amountOutMinimum: bigint;
  recipient: Address;
  deadline: number;
  intentId: Hex;
  unwrapNativeOut: boolean;
  nativeIn: boolean;
  hops: readonly SwapPathHopIntent[];
}
export type SwapIntentResult = { ok: true; value: SwapExecutorIntent } | { ok: false; reason: string };

const venueOf = (deployment: SwapPathExecutorDeployment, router: string, kind: number) =>
  deployment.venues.find(v => v.router.toLowerCase() === router.toLowerCase() && v.kind === kind);

/** Decodes and bounds a swapExactInput call. Never trusts caller-supplied facts
 * beyond the calldata itself; every economic term is re-derived here. */
export function inspectSwapExecutorTransaction(
  tx: { to: string; data: string; value?: string },
  ctx: { deployment: SwapPathExecutorDeployment; fromAddress: string; toAddress: string; taker: string; nativeIn: boolean; nativeOut: boolean },
): SwapIntentResult {
  const fail = (reason: string): SwapIntentResult => ({ ok: false, reason });
  try {
    if (tx.to.toLowerCase() !== ctx.deployment.executor.toLowerCase()) return fail("The transaction does not target the reviewed Swap executor.");
    const decoded = decodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, data: tx.data as Hex });
    if (decoded.functionName !== "swapExactInput") return fail("Unsupported Swap executor selector.");
    const [p, path, auth] = decoded.args;
    if (auth.kind !== 0 || auth.nonce !== 0n || auth.v !== 0 || auth.deadline !== 0n || auth.signature !== "0x") return fail("Only standing-allowance authorization is supported for Swap paths.");
    if (BigInt(tx.value ?? "0") !== (ctx.nativeIn ? p.grossAmountIn : 0n)) return fail("Native value does not match the gross sell amount.");
    const tokenIn = swapPathAsset(ctx.fromAddress), tokenOut = swapPathAsset(ctx.toAddress);
    if (p.tokenIn.toLowerCase() !== tokenIn.toLowerCase() || p.tokenOut.toLowerCase() !== tokenOut.toLowerCase()) return fail("Swap path tokens differ from the reviewed pair.");
    if (p.recipient.toLowerCase() !== ctx.taker.toLowerCase()) return fail("Swap output recipient must be the quoted taker.");
    if (p.unwrapNativeOut !== ctx.nativeOut) return fail("Native unwrap flag does not match the reviewed pair.");
    if (p.expectedFeeAmount !== swapPathFeeFloor(p.grossAmountIn)) return fail("The committed fee is not floor(gross*25/10000).");
    if (p.amountOutMinimum <= 0n) return fail("Invalid minimum output.");
    if (!Array.isArray(path) || path.length === 0 || path.length > SWAP_MAX_PATH_HOPS) return fail("Swap path must contain one to three typed hops.");
    if (p.router.toLowerCase() !== path[0].router.toLowerCase()) return fail("First hop router must equal the swap router parameter.");
    const hops: SwapPathHopIntent[] = [];
    const seen = new Set<string>([tokenIn.toLowerCase()]);
    for (let i = 0; i < path.length; i++) {
      const h = path[i];
      const venue = venueOf(ctx.deployment, h.router, Number(h.kind));
      if (!venue) return fail("Hop router/kind is not allowlisted on the Swap executor.");
      const kind = Number(h.kind) as SwapVenueKind;
      if (kind === SWAP_PATH_VENUES.uniswapV3.kind && !swapV3PoolFees.includes(Number(h.poolFee) as typeof swapV3PoolFees[number])) return fail("Invalid Uniswap V3 fee tier in hop.");
      if (kind === SWAP_PATH_VENUES.slipstream.kind && Number(h.tickSpacing) <= 0) return fail("Invalid Slipstream tick spacing in hop.");
      if ((kind === SWAP_PATH_VENUES.uniswapV2.kind || kind === SWAP_PATH_VENUES.aerodromeClassic.kind) && (Number(h.poolFee) !== 0 || Number(h.tickSpacing) !== 0)) return fail("Invalid V2/Classic hop parameters.");
      const out = h.tokenOut.toLowerCase();
      if (i === path.length - 1 ? out !== tokenOut.toLowerCase() : out === tokenOut.toLowerCase()) return fail("Swap path must end at the buy token exactly once.");
      if (seen.has(out)) return fail("Swap path repeats an asset.");
      seen.add(out);
      if (h.pool === "0x0000000000000000000000000000000000000000") return fail("Swap hop pool is unset.");
      hops.push({
        kind, router: h.router, pool: h.pool, tokenOut: h.tokenOut,
        poolFee: Number(h.poolFee) || undefined, tickSpacing: Number(h.tickSpacing) || undefined, stable: h.stable || undefined,
      });
    }
    return { ok: true, value: {
      executor: ctx.deployment.executor, router: p.router, tokenIn: p.tokenIn, tokenOut: p.tokenOut,
      grossAmountIn: p.grossAmountIn, expectedFeeAmount: p.expectedFeeAmount, amountOutMinimum: p.amountOutMinimum,
      recipient: p.recipient, deadline: Number(p.deadline), intentId: p.intentId, unwrapNativeOut: p.unwrapNativeOut,
      nativeIn: ctx.nativeIn, hops,
    } };
  } catch { return fail("Malformed Swap executor transaction."); }
}

export interface SwapPathSettlement {
  verified: boolean;
  amountIn: string | null;
  amountOut: string | null;
  feeAmount: string | null;
  feeRecipient: Address | null;
  hops: number | null;
  reason: string | null;
}
/** Receipt proof: the executor's own events must state the exact gross, fee,
 * recipient and a measured output at/above the committed minimum. */
export function verifySwapPathSettlement(
  p: TradeProposal,
  deployment: SwapPathExecutorDeployment,
  receipt: { logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]; status: "success" | "reverted" },
): SwapPathSettlement {
  const unknown = (reason: string): SwapPathSettlement => ({ verified: false, amountIn: null, amountOut: null, feeAmount: null, feeRecipient: null, hops: null, reason });
  try {
    if (receipt.status !== "success") return unknown("The Swap transaction reverted.");
    const nativeIn = isNativeEthSentinel(p.from.address);
    const intent = p.transaction ? inspectSwapExecutorTransaction(p.transaction, { deployment, fromAddress: p.from.address, toAddress: p.to.address, taker: p.taker, nativeIn, nativeOut: isNativeEthSentinel(p.to.address) }) : null;
    const logs = parseEventLogs({ abi: MPGR_SWAP_EXECUTOR_ABI, logs: receipt.logs as never, strict: false })
      .filter(l => (l as { address?: string }).address?.toLowerCase() === deployment.executor.toLowerCase());
    const executed = logs.filter(l => l.eventName === "SwapExecuted") as unknown as { args: Record<string, unknown> }[];
    const pathEvents = logs.filter(l => l.eventName === "SwapPathExecuted") as unknown as { args: Record<string, unknown> }[];
    if (executed.length !== 1 || pathEvents.length !== 1) return unknown("Receipt did not contain exactly one Swap executor trade event.");
    const e = executed[0].args, pe = pathEvents[0].args;
    const gross = BigInt(p.fromAmount);
    const fee = swapPathFeeFloor(gross);
    if (BigInt(String(e.grossAmountIn)) !== gross) return unknown("Settled gross amount differs from the reviewed swap.");
    if (BigInt(String(e.feeAmount)) !== fee || BigInt(String(e.swapAmountIn)) !== gross - fee) return unknown("Settled fee differs from floor(gross*25/10000).");
    if (String(e.feeRecipient).toLowerCase() !== SWAP_FEE_RECIPIENT.toLowerCase() || Number(e.feeBps) !== SWAP_FEE_BPS) return unknown("Settled fee recipient/terms differ from the required fee.");
    if (BigInt(String(e.amountOut)) < BigInt(p.minToAmount)) return unknown("Settled output is below the committed minimum.");
    if (String(e.tokenIn).toLowerCase() !== swapPathAsset(p.from.address).toLowerCase() || String(e.tokenOut).toLowerCase() !== swapPathAsset(p.to.address).toLowerCase()) return unknown("Settled tokens differ from the reviewed pair.");
    if (String(e.taker).toLowerCase() !== p.taker.toLowerCase()) return unknown("Settled taker differs from the reviewed swap.");
    if (intent && intent.ok && String(pe.intentId).toLowerCase() !== intent.value.intentId.toLowerCase()) return unknown("Settled intent id differs from the reviewed path.");
    const hops = Number(pe.hops);
    if (!intent || !intent.ok) return unknown("The reviewed transaction could not be re-inspected.");
    if (hops !== intent.value.hops.length) return unknown("Settled hop count differs from the reviewed path.");
    return { verified: true, amountIn: String(e.grossAmountIn), amountOut: String(e.amountOut), feeAmount: String(e.feeAmount), feeRecipient: String(e.feeRecipient) as Address, hops, reason: null };
  } catch { return unknown("Swap settlement evidence is unavailable. No output or fee collection has been verified."); }
}
export const swapPathCalldataHash = (data: Hex): Hex => keccak256(data);
