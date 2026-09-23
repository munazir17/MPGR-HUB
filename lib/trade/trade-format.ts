// lib/trade/trade-format.ts
//
// Display-only amount formatting. Never changes atomic amounts used
// for quotes or transactions.

import { formatUnits } from "viem";

export function formatAtomicAmount(
  atomic: string,
  decimals: number,
  maxFractionDigits = 6,
): string {
  try {
    const formatted = formatUnits(BigInt(atomic), decimals);
    const [whole, frac = ""] = formatted.split(".");
    if (!frac) return whole;
    const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
    return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
  } catch {
    return atomic;
  }
}

export function parseAtomicAmount(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!/^[0-9]+$/.test(raw)) return null;

  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Exact decimal → (integer, scale) parts, so money math never touches
 * IEEE-754 floats.
 *
 * This is a real-funds correctness fix: "$5 of my AAPLc" used to be
 * converted as `Number("5") / Number("337.595`) → `String(0.014810...)`,
 * a float whose decimal expansion runs past AAPLc's 8 on-chain decimals,
 * so parseHumanTokenAmount() correctly refused it ("Could not convert
 * that dollar amount into a B20 token size") and the order never
 * prepared. Flooring the exact rational instead gives the same intent
 * with no rounding surprises.
 */
function decimalParts(value: string): { int: bigint; scale: number } | null {
  const raw = String(value).trim().replace(/,/g, "").replace(/^\$/, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 60) return null; // bound the exponent, never guess
  const int = BigInt(whole + fraction);
  return { int, scale: fraction.length };
}

/**
 * floor(usdAmount / unitPriceUsd × 10^tokenDecimals) — the atomic token
 * size that a dollar-denominated stock order buys/sells.
 *
 * Floor (never round up) so a "$5" order can never spend more than $5
 * worth, and the result always lands exactly on the token's own decimals.
 */
export function usdToTokenAtomic(
  usdAmount: string,
  unitPriceUsd: string,
  tokenDecimals: number,
): bigint | null {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) return null;
  const usd = decimalParts(usdAmount);
  const price = decimalParts(unitPriceUsd);
  if (!usd || !price || price.int <= 0n) return null;

  const numerator = usd.int * 10n ** BigInt(price.scale + tokenDecimals);
  const denominator = price.int * 10n ** BigInt(usd.scale);
  if (denominator <= 0n) return null;

  const atomic = numerator / denominator;
  return atomic > 0n ? atomic : null;
}

/**
 * floor(tokenAtomic / 10^tokenDecimals × unitPriceUsd × 10^usdDecimals) —
 * the USDC budget for a token-denominated order ("Buy 0.01 AAPLc").
 */
export function tokenAtomicToUsdAtomic(
  tokenAtomic: bigint,
  unitPriceUsd: string,
  tokenDecimals: number,
  usdDecimals: number,
): bigint | null {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) return null;
  if (!Number.isInteger(usdDecimals) || usdDecimals < 0) return null;
  if (tokenAtomic <= 0n) return null;
  const price = decimalParts(unitPriceUsd);
  if (!price || price.int <= 0n) return null;

  const numerator = tokenAtomic * price.int * 10n ** BigInt(usdDecimals);
  const denominator = 10n ** BigInt(tokenDecimals + price.scale);
  if (denominator <= 0n) return null;

  const atomic = numerator / denominator;
  return atomic > 0n ? atomic : null;
}

export function parseHumanTokenAmount(
  value: unknown,
  decimals: number,
): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!Number.isInteger(decimals) || decimals < 0) return null;

  const raw = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;

  const [whole, fraction = ""] = raw.split(".");

  // Never silently round/truncate user-supplied token precision.
  if (fraction.length > decimals) return null;

  try {
    const paddedFraction = fraction.padEnd(decimals, "0");
    const atomic = BigInt(whole) * 10n ** BigInt(decimals) +
      (paddedFraction ? BigInt(paddedFraction) : 0n);

    return atomic > 0n ? atomic : null;
  } catch {
    return null;
  }
}
