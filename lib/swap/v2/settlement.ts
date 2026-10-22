// lib/swap/v2/settlement.ts
// Receipt and settlement verification for MPGRSwapExecutorV2 swaps.
//
// Mirrors the V1 `verifySwapPathSettlement` role. Verification uses the
// COMMITTED minimum and the ACTUAL on-chain event output — never a
// reconstructed "expected quote" from an amount that happened to settle.
// A receipt that does not prove exactly one fee-bearing swap to the pinned
// treasury is a failure, not a partial success.
//
// Parsing is split from verification so the economic rules can be tested
// deterministically without fabricating receipt encodings.
// Isomorphic on purpose: pure receipt/event decoding and arithmetic, no I/O and no
// secrets, so the client can verify settlement from a receipt it already holds.
// The server-side settlement route independently re-fetches the receipt, so a
// client-side result is never the only proof.
import { parseEventLogs, type Address, type Hex } from "viem";
import { SWAP_V2_ABI } from "./abi";
import { SWAP_V2_POSTURE_ABI } from "./posture-abi";
import {
  SWAP_V2_FLAG_NATIVE_IN, SWAP_V2_FLAG_NATIVE_OUT, SWAP_V2_V4_POOL_MANAGER,
  type SwapV2ExecutorDeployment,
} from "./deployment";
import { v2FeeFloor, type V2SwapIntent } from "./intent";

const SETTLEMENT_ABI = [...SWAP_V2_ABI, ...SWAP_V2_POSTURE_ABI] as unknown as Parameters<typeof parseEventLogs>[0]["abi"];

export interface V2SwapExecutedArgs {
  taker: Address; router: Address; intentId: Hex; tokenIn: Address; tokenOut: Address;
  grossAmountIn: bigint; feeAmount: bigint; swapAmountIn: bigint; amountOut: bigint;
  feeRecipient: Address; feeBps: number; routerKind: number; flags: number;
}
export interface V2PathExecutedArgs { intentId: Hex; pathHash: Hex; hops: number }

export interface V2SettlementEvents {
  executed: readonly V2SwapExecutedArgs[];
  pathExecuted: readonly V2PathExecutedArgs[];
}

export interface V2ReceiptLike {
  status: "success" | "reverted" | boolean | string;
  logs: readonly { address?: Address | string; topics?: readonly Hex[]; data?: Hex }[];
  transactionHash?: Hex;
}

export interface V2Settlement {
  verified: boolean;
  amountIn: string | null;
  amountOut: string | null;
  feeAmount: string | null;
  feeBps: number | null;
  feeRecipient: Address | null;
  entry: V2SwapIntent["entry"] | null;
  hops: number | null;
  reason: string | null;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unknown = (reason: string): V2Settlement => ({
  verified: false, amountIn: null, amountOut: null, feeAmount: null, feeBps: null,
  feeRecipient: null, entry: null, hops: null, reason,
});

/** `parseEventLogs` returns a union that includes undecoded logs, which carry no
 * `eventName`/`args`. Narrow to the decoded shape we branch on; every value read
 * out of `args` is still coerced and validated below, so this cast adds no trust. */
type DecodedV2Log = { eventName?: string; args?: Record<string, unknown> };

/** Decodes the V2 settlement events from a receipt. Throws on malformed logs so
 * a decoding failure can never be reported as "no swap happened". */
export function parseV2SettlementEvents(receipt: V2ReceiptLike): V2SettlementEvents {
  const logs = parseEventLogs({ abi: SETTLEMENT_ABI, logs: receipt.logs as never }) as unknown as readonly DecodedV2Log[];
  const executed: V2SwapExecutedArgs[] = [];
  const pathExecuted: V2PathExecutedArgs[] = [];
  for (const log of logs) {
    if (log.eventName === "SwapExecuted") {
      const a = log.args as unknown as Omit<V2SwapExecutedArgs, "feeBps" | "routerKind" | "flags"> & { feeBps: number; routerKind: number; flags: number };
      executed.push({
        taker: a.taker, router: a.router, intentId: a.intentId, tokenIn: a.tokenIn, tokenOut: a.tokenOut,
        grossAmountIn: BigInt(a.grossAmountIn), feeAmount: BigInt(a.feeAmount), swapAmountIn: BigInt(a.swapAmountIn),
        amountOut: BigInt(a.amountOut), feeRecipient: a.feeRecipient,
        feeBps: Number(a.feeBps), routerKind: Number(a.routerKind), flags: Number(a.flags),
      });
    } else if (log.eventName === "SwapPathExecuted") {
      const a = log.args as unknown as { intentId: Hex; pathHash: Hex; hops: number };
      pathExecuted.push({ intentId: a.intentId, pathHash: a.pathHash, hops: Number(a.hops) });
    }
  }
  return { executed, pathExecuted };
}

/** Verifies settlement economics against the inspected intent.
 * `feeRecipientDelta`, when supplied, must be the treasury's measured token
 * balance change over the transaction — the strongest fee proof available. */
export function verifyV2Settlement(
  intent: V2SwapIntent,
  events: V2SettlementEvents,
  receipt: Pick<V2ReceiptLike, "status">,
  // `deployment` is optional so a caller with no sealed manifest gets an honest
  // "cannot attribute" result rather than a fabricated one — no unsafe cast.
  options: { deployment?: SwapV2ExecutorDeployment | null; feeRecipientDelta?: bigint | null } = {},
): V2Settlement {
  const deployment = options.deployment;
  if (!deployment) return unknown("No sealed V2 deployment; settlement cannot be attributed to a known executor.");
  const succeeded = receipt.status === "success" || receipt.status === true;
  if (!succeeded) return unknown("The transaction did not succeed. Nothing was verified; do not resubmit without inspecting it.");

  const mine = events.executed.filter((e) => eq(e.intentId, intent.intentId));
  if (mine.length === 0) return unknown("The receipt contains no V2 SwapExecuted event for this intent. No swap or fee collection is verified.");
  // Exactly one fee-bearing swap per intent: a duplicated event would mean the
  // fee or the output was taken twice.
  if (mine.length > 1) return unknown("The receipt contains more than one SwapExecuted event for this intent. Refusing to verify a duplicated settlement.");
  const event = mine[0];

  if (!eq(event.taker, intent.taker)) return unknown("The settled taker is not the wallet that signed this transaction.");
  if (!eq(event.feeRecipient, intent.feeRecipient) || !eq(event.feeRecipient, deployment.feeRecipient)) {
    return unknown("The fee was not delivered to the pinned treasury. Settlement rejected.");
  }
  if (event.feeBps !== intent.feeBps || event.feeBps !== 25) return unknown(`The settled fee was ${event.feeBps} bps, not the required 25 bps.`);
  if (event.grossAmountIn !== intent.grossAmountIn) return unknown("The settled gross input differs from the committed gross sell amount.");

  const expectedFee = v2FeeFloor(intent.grossAmountIn, event.feeBps);
  if (event.feeAmount !== expectedFee) return unknown("The settled fee is not floor(gross*feeBps/10000). There is no fee-less V2 swap.");
  if (event.feeAmount <= 0n) return unknown("A zero fee was settled; the mandatory 25 bps fee was skipped.");
  if (event.swapAmountIn !== intent.grossAmountIn - event.feeAmount) return unknown("The swapped amount is not gross minus fee.");
  if (options.feeRecipientDelta !== undefined && options.feeRecipientDelta !== null && options.feeRecipientDelta !== event.feeAmount) {
    return unknown("The treasury's measured balance delta does not equal the settled fee.");
  }

  if (!eq(event.tokenIn, intent.tokenIn) || !eq(event.tokenOut, intent.tokenOut)) return unknown("The settled tokens differ from the reviewed pair.");
  if (!eq(event.router, intent.router)) return unknown("The settled router differs from the reviewed allowlisted router.");
  if (event.routerKind !== intent.routerKind) return unknown("The settled router kind differs from the reviewed venue.");
  if (intent.routerKind === 7 && !eq(intent.router, SWAP_V2_V4_POOL_MANAGER)) return unknown("A v4 settlement must route through the canonical PoolManager.");

  if (event.amountOut < intent.amountOutMinimum) {
    return unknown("The settled output is below the committed minimum. Slippage protection bound this trade; do not resubmit blindly.");
  }

  const expectedFlags = (intent.nativeIn ? SWAP_V2_FLAG_NATIVE_IN : 0) | (intent.unwrapNativeOut ? SWAP_V2_FLAG_NATIVE_OUT : 0);
  if (event.flags !== expectedFlags) return unknown("The settled native-input/native-output flags differ from the reviewed transaction.");

  const pathEvent = events.pathExecuted.filter((p) => eq(p.intentId, intent.intentId));
  let hops: number | null = null;
  if (intent.entry === "swapExactInputSplit") {
    if (pathEvent.length !== 1) return unknown("A split settlement must emit exactly one SwapPathExecuted event.");
    if (pathEvent[0].hops !== intent.paths.length) return unknown("The settled leg count differs from the reviewed split route.");
    hops = intent.hops;
  } else if (pathEvent.length > 0) {
    if (pathEvent[0].hops !== intent.paths[0].length) return unknown("The settled hop count differs from the reviewed path.");
    hops = pathEvent[0].hops;
  } else {
    hops = intent.hops;
  }

  return {
    verified: true, amountIn: event.grossAmountIn.toString(), amountOut: event.amountOut.toString(),
    feeAmount: event.feeAmount.toString(), feeBps: event.feeBps, feeRecipient: event.feeRecipient,
    entry: intent.entry, hops, reason: null,
  };
}

/** Convenience wrapper: parse then verify. */
export function verifyV2Receipt(
  intent: V2SwapIntent,
  receipt: V2ReceiptLike,
  deployment: SwapV2ExecutorDeployment,
  feeRecipientDelta?: bigint | null,
): V2Settlement {
  try {
    return verifyV2Settlement(intent, parseV2SettlementEvents(receipt), receipt, { deployment, feeRecipientDelta });
  } catch {
    return unknown("Settlement evidence could not be decoded. No output or fee collection has been verified.");
  }
}
