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
    return trimmed.length > 0 ? `\( {whole}. \){trimmed}` : whole;
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
 * Human token units → atomic. Accepts "10", "10.5", "$10", "1,000.25".
 * Used when the agent/user says "$10 of COINc" instead of 10000000.
 */
export function parseHumanTokenAmount(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const raw = String(value).trim().replace(/,/g, "").replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  try {
    const n = parseUnits(raw, decimals);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}
