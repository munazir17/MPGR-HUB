// lib/architecture/tools/yield-math.ts
//
// P2 — Deterministic Yield Calculations.
//
// Pure calculation module. No RPC, no wallet, no transaction execution.
// All token-amount arithmetic uses bigint. The LLM never performs
// financial arithmetic itself.

import { parseUnits } from "viem";

const BPS_DENOMINATOR = 10_000n;
const DAYS_PER_YEAR = 365n;

export class YieldMathInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YieldMathInputError";
  }
}

/**
 * Converts basis points to an exact 2-decimal percentage string.
 *
 * Examples:
 * 1000n -> "10.00"
 * 1234n -> "12.34"
 * 5n    -> "0.05"
 */
export function bpsToPercentString(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;

  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");

  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/**
 * Parses a user-facing decimal token amount into raw token units.
 *
 * Uses viem's parseUnits, which returns bigint and therefore does not
 * introduce floating-point precision loss.
 */
export function parseTokenAmount(
  amountDecimalString: string,
  decimals: number
): bigint {
  const trimmed = amountDecimalString.trim();

  if (trimmed.length === 0) {
    throw new YieldMathInputError("amount must not be empty.");
  }

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new YieldMathInputError(
      'amount must be a non-negative decimal number, e.g. "1000" or "1000.5".'
    );
  }

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new YieldMathInputError(
      "token decimals must be a non-negative integer."
    );
  }

  try {
    return parseUnits(trimmed, decimals);
  } catch {
    throw new YieldMathInputError(
      `amount could not be parsed with ${decimals} token decimals.`
    );
  }
}

export interface LinearAprEstimate {
  estimatedRewardRaw: bigint;
}

/**
 * Estimates reward using a simple linear APR projection:
 *
 * principal × APR(bps) × days
 * --------------------------------
 *        10,000 × 365
 *
 * This is an estimate, not a guaranteed future reward.
 */
export function estimateLinearAprReward(
  principalRaw: bigint,
  aprBps: bigint,
  durationDays: number
): LinearAprEstimate {
  if (principalRaw < 0n) {
    throw new YieldMathInputError(
      "principal must not be negative."
    );
  }

  if (aprBps < 0n) {
    throw new YieldMathInputError(
      "aprBps must not be negative."
    );
  }

  if (
    !Number.isFinite(durationDays) ||
    durationDays < 0
  ) {
    throw new YieldMathInputError(
      "durationDays must be a non-negative finite number."
    );
  }

  const days = BigInt(Math.trunc(durationDays));

  const estimatedRewardRaw =
    (principalRaw * aprBps * days) /
    (BPS_DENOMINATOR * DAYS_PER_YEAR);

  return {
    estimatedRewardRaw,
  };
}

/**
 * Ranks entries by known APR descending.
 *
 * Unknown APR values remain unknown and are moved to the end rather
 * than being treated as 0%.
 */
export function rankByAprDescending<
  T extends { aprBps: bigint | null },
>(entries: readonly T[]): T[] {
  const known = entries.filter(
    (entry): entry is T & { aprBps: bigint } =>
      entry.aprBps !== null
  );

  const unknown = entries.filter(
    (entry) => entry.aprBps === null
  );

  known.sort((a, b) => {
    if (a.aprBps === b.aprBps) return 0;
    return a.aprBps > b.aprBps ? -1 : 1;
  });

  return [...known, ...unknown];
}
