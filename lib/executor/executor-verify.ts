// lib/executor/executor-verify.ts
//
// Post-trade verification from a transaction receipt. Proves — from the
// executor's own SwapExecuted event, emitted only by the allowlisted executor
// address — that the trade matched the prepared intent exactly:
//   taker, router, tokens, gross in, EXACT fee, fee recipient, output >= minOut.

import { getAddress, parseEventLogs, type Address, type Hex, type Log } from "viem";

import type { ExecutorSwapIntent } from "./executor-intent";
import { MPGR_EXECUTOR_ABI } from "./mpgr-executor-abi";

export interface ReceiptLike {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  logs: readonly Log[];
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface ExecutorVerification {
  verified: boolean;
  transactionHash: Hex;
  blockNumber: string;
  checks: VerificationCheck[];
  event: null | {
    taker: Address;
    router: Address;
    intentId: Hex;
    tokenIn: Address;
    tokenOut: Address;
    grossAmountIn: string;
    feeAmount: string;
    swapAmountIn: string;
    amountOut: string;
    feeRecipient: Address;
    feeBps: number;
    routerKind: number;
    flags: number;
  };
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function verifyExecutorReceipt(receipt: ReceiptLike, intent: ExecutorSwapIntent): ExecutorVerification {
  const checks: VerificationCheck[] = [];
  const push = (name: string, ok: boolean, expected: unknown, actual: unknown) =>
    checks.push({ name, ok, expected: String(expected), actual: String(actual) });

  push("receipt.status", receipt.status === "success", "success", receipt.status);
  push("tx.from == taker", eq(receipt.from, intent.taker), intent.taker, receipt.from);
  push("tx.to == executor", receipt.to !== null && eq(receipt.to, intent.executor), intent.executor, receipt.to ?? "null");

  // Only logs emitted BY the executor address count (a malicious contract
  // could emit a look-alike event).
  const executorLogs = receipt.logs.filter((l) => eq(l.address, intent.executor));
  const events = parseEventLogs({ abi: MPGR_EXECUTOR_ABI, eventName: "SwapExecuted", logs: executorLogs as Log[] });
  const matching = events.filter((e) => eq(e.args.intentId, intent.intentId));
  push("exactly one SwapExecuted for intentId", matching.length === 1, 1, matching.length);

  const ev = matching.length === 1 ? matching[0].args : null;
  if (ev) {
    const expectedFlags = (intent.sellNative ? 1 : 0) | (intent.buyNative ? 2 : 0);
    push("taker", eq(ev.taker, intent.taker), intent.taker, ev.taker);
    push("router", eq(ev.router, intent.router), intent.router, ev.router);
    push("tokenIn", eq(ev.tokenIn, intent.sellToken.address), intent.sellToken.address, ev.tokenIn);
    push("tokenOut", eq(ev.tokenOut, intent.buyToken.address), intent.buyToken.address, ev.tokenOut);
    push("grossAmountIn", ev.grossAmountIn.toString() === intent.sellAmount, intent.sellAmount, ev.grossAmountIn);
    push("feeAmount (exact)", ev.feeAmount.toString() === intent.feeAmount, intent.feeAmount, ev.feeAmount);
    push("feeBps", Number(ev.feeBps) === intent.feeBps, intent.feeBps, ev.feeBps);
    push("feeAmount + swapAmountIn == gross", ev.feeAmount + ev.swapAmountIn === ev.grossAmountIn, ev.grossAmountIn, ev.feeAmount + ev.swapAmountIn);
    push("feeRecipient", eq(ev.feeRecipient, intent.feeRecipient), intent.feeRecipient, ev.feeRecipient);
    push("amountOut >= minBuyAmount", ev.amountOut >= BigInt(intent.minBuyAmount), `>= ${intent.minBuyAmount}`, ev.amountOut);
    push("routerKind", Number(ev.routerKind) === intent.routerKind, intent.routerKind, ev.routerKind);
    push("native flags", Number(ev.flags) === expectedFlags, expectedFlags, ev.flags);
  }

  return {
    verified: checks.every((c) => c.ok),
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    checks,
    event: ev
      ? {
          taker: getAddress(ev.taker),
          router: getAddress(ev.router),
          intentId: ev.intentId,
          tokenIn: getAddress(ev.tokenIn),
          tokenOut: getAddress(ev.tokenOut),
          grossAmountIn: ev.grossAmountIn.toString(),
          feeAmount: ev.feeAmount.toString(),
          swapAmountIn: ev.swapAmountIn.toString(),
          amountOut: ev.amountOut.toString(),
          feeRecipient: getAddress(ev.feeRecipient),
          feeBps: Number(ev.feeBps),
          routerKind: Number(ev.routerKind),
          flags: Number(ev.flags),
        }
      : null,
  };
}
