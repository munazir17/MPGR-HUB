// lib/executor/executor-fee.ts
//
// Exact fee math, bit-for-bit identical to MPGRExecutor._begin:
//   fee        = floor(grossAmountIn * feeBps / 10_000)
//   swapAmount = grossAmountIn - fee
// bigint only (AGENTS.md). Never rounds up, never silently skips the fee.

import { EXECUTOR_BPS_DENOMINATOR, EXECUTOR_MAX_FEE_BPS } from "./executor-config";

export type ExecutorFeeError =
  | { code: "INVALID_FEE_BPS"; message: string }
  | { code: "ZERO_AMOUNT"; message: string }
  | { code: "FEE_ROUNDS_TO_ZERO"; message: string; minimumGross: bigint };

export interface ExecutorFeeBreakdown {
  grossAmountIn: bigint;
  feeBps: number;
  feeAmount: bigint;
  swapAmountIn: bigint;
}

export function assertValidFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > EXECUTOR_MAX_FEE_BPS) {
    throw new RangeError(`feeBps must be an integer in [0, ${EXECUTOR_MAX_FEE_BPS}], got ${feeBps}`);
  }
}

/** Smallest gross amount whose fee is non-zero at `feeBps` (ceil(10_000 / feeBps)). */
export function minimumFeeableAmount(feeBps: number): bigint {
  assertValidFeeBps(feeBps);
  if (feeBps === 0) return 1n;
  const bps = BigInt(feeBps);
  return (EXECUTOR_BPS_DENOMINATOR + bps - 1n) / bps;
}

export function computeExecutorFee(
  grossAmountIn: bigint,
  feeBps: number,
): { ok: true; value: ExecutorFeeBreakdown } | { ok: false; error: ExecutorFeeError } {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > EXECUTOR_MAX_FEE_BPS) {
    return {
      ok: false,
      error: { code: "INVALID_FEE_BPS", message: `feeBps must be an integer in [0, ${EXECUTOR_MAX_FEE_BPS}].` },
    };
  }
  if (grossAmountIn <= 0n) {
    return { ok: false, error: { code: "ZERO_AMOUNT", message: "Sell amount must be greater than zero." } };
  }
  const feeAmount = (grossAmountIn * BigInt(feeBps)) / EXECUTOR_BPS_DENOMINATOR;
  if (feeBps !== 0 && feeAmount === 0n) {
    // The contract reverts FeeRoundsToZero — never let a trade skip the fee.
    return {
      ok: false,
      error: {
        code: "FEE_ROUNDS_TO_ZERO",
        message: "Sell amount is too small for the 0.25% fee to be at least 1 base unit.",
        minimumGross: minimumFeeableAmount(feeBps),
      },
    };
  }
  return {
    ok: true,
    value: { grossAmountIn, feeBps, feeAmount, swapAmountIn: grossAmountIn - feeAmount },
  };
}

/** Minimum output after slippage: floor(expected * (10_000 - slippageBps) / 10_000). */
export function applySlippage(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new RangeError("slippageBps must be an integer in [0, 9999]");
  }
  return (expectedOut * (EXECUTOR_BPS_DENOMINATOR - BigInt(slippageBps))) / EXECUTOR_BPS_DENOMINATOR;
}
