// lib/trade/trade-balance.ts
//
// Wallet balance sufficiency for real-funds Base swaps.
//
// Why this module exists (root cause of the on-chain `STF` revert):
// the Aerodrome Slipstream route used for Coinbase B20 tokenized stocks
// pays tokenOut out of the pool BEFORE pulling tokenIn. When the wallet
// cannot cover `amountIn`, the router's inner
// `USDC.transferFrom(wallet → pool, amountIn)` reverts with
// "ERC20: transfer amount exceeds balance" and the pool callback
// re-reverts it as a bare `STF` — after the user has already signed and
// paid gas. The quote already carries the wallet's live balance in
// `issues.balance` (read server-side by the Aerodrome provider), but
// nothing in the prepare → confirm → execute chain treated it as a
// blocker: it was surfaced in no risk fact, was not part of
// `executionAvailable`, and was never re-checked before broadcasting.
//
// These helpers turn that read into a hard, amount-exact gate, exactly
// mirroring lib/trade/transfer-proposal.ts (`sufficientBalance` +
// INSUFFICIENT_BALANCE) which already works this way.
//
// Pure functions only: no RPC, no wallet, no signing, no broadcasting.

import { formatAtomicAmount } from "./trade-format";
import type { CdpBalanceIssue } from "./trade-types";

export interface TradeBalanceShortfall {
  token: string;
  currentBalance: string;
  requiredBalance: string;
}

/** Parse an atomic-unit amount that must be a plain non-negative integer. */
function parseAtomic(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * A shortfall is recomputed from the raw atomic numbers instead of
 * trusting `issues.balance` to have been populated correctly: a stale,
 * replayed, or hand-built payload cannot claim "sufficient" merely by
 * omitting or garbling the field.
 *
 * Returns null when the balance is unknown (nothing was read) or when
 * the wallet covers the amount. Unknown is never treated as a shortfall
 * here — the execution layer re-reads the balance live before signing.
 */
export function tradeBalanceShortfall(
  issue: CdpBalanceIssue | null | undefined,
): TradeBalanceShortfall | null {
  if (!issue) return null;
  const current = parseAtomic(issue.currentBalance);
  const required = parseAtomic(issue.requiredBalance);
  if (current === null || required === null) return null;
  if (current >= required) return null;
  return {
    token: issue.token,
    currentBalance: current.toString(),
    requiredBalance: required.toString(),
  };
}

/**
 * One message for both the risk fact and the blocking error, so the
 * confirmation modal and the execution guard never disagree.
 */
export function balanceShortfallMessage(input: {
  symbol: string;
  decimals: number;
  shortfall: TradeBalanceShortfall;
}): string {
  const have = formatAtomicAmount(input.shortfall.currentBalance, input.decimals);
  const need = formatAtomicAmount(input.shortfall.requiredBalance, input.decimals);
  return `Your wallet holds ${have} ${input.symbol}, but this swap needs ${need} ${input.symbol}. Nothing was signed — add ${input.symbol} or lower the amount.`;
}
