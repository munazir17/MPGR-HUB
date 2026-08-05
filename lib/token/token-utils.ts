// lib/token/token-utils.ts

import { parseUnits, formatUnits, type Address } from "viem";

// Phase 3E Part 1 — Token Utility Helpers.
//
// Pure functions for token math, formatting, validation, and parsing.
// No external dependencies — all are reusable across token-service,
// balance-service, transaction-service, and hooks.

export const tokenUtils = {
  // Validates a wallet address string (0x-prefixed, 42 characters, hex-only).
  isValidAddress(address: unknown): address is Address {
    if (typeof address !== "string") return false;
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  },

  // Parses a human-readable token amount string (e.g., "1.5") into its
  // raw bigint representation using the given decimals. Returns 0n if parsing fails.
  parseTokenAmount(amount: string, decimals: number): bigint {
    try {
      return parseUnits(amount, decimals);
    } catch {
      return 0n;
    }
  },

  // Formats a raw bigint balance into a decimal string using decimals.
  // Optionally trims trailing zeros for display.
  formatTokenAmount(raw: bigint, decimals: number, trimZeros = false): string {
    try {
      let formatted = formatUnits(raw, decimals);
      if (trimZeros) {
        formatted = parseFloat(formatted).toString();
      }
      return formatted;
    } catch {
      return "0";
    }
  },

  // Abbreviates a balance for compact display (e.g., "1.234B" for billions).
  // Returns a string with up to 3 decimal places of precision.
  abbreviateBalance(raw: bigint, decimals: number): string {
    const num = parseFloat(formatUnits(raw, decimals));
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(2);
  },

  // Checks if two balances are equal (bigint comparison, no floating point).
  areBalancesEqual(a: bigint, b: bigint): boolean {
    return a === b;
  },

  // Computes the difference between two balances. Positive if `new > old`,
  // negative if `new < old`.
  getBalanceDelta(oldBalance: bigint, newBalance: bigint): bigint {
    return newBalance - oldBalance;
  },

  // Checks if a balance string looks like a valid number.
  isValidBalanceString(value: string): boolean {
    if (!value || typeof value !== "string") return false;
    return /^\d+\.?\d*$/.test(value.trim());
  },
} as const;
