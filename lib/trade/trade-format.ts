// lib/trade/trade-format.ts
//
// Display-only amount formatting. Never changes atomic amounts used
// for quotes or transactions.

import { formatUnits, parseUnits } from "viem";

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

// Parses a human-readable decimal amount (e.g. "1.5") into atomic
// units (bigint) using the token's decimals. Inverse of
// formatAtomicAmount. Returns null on invalid input or non-positive
// amounts.
export function parseHumanTokenAmount(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  try {
    const atomic = parseUnits(raw, decimals);
    return atomic > 0n ? atomic : null;
  } catch {
    return null;
  }
}
