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
