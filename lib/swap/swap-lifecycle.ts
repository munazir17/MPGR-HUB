import { TRADE_QUOTE_MAX_AGE_MS } from "@/lib/trade/trade-config";
import { inspectExecutorSwapTransaction } from "@/lib/executor/executor-intent";
import type { TradeProposal } from "@/lib/trade/trade-types";

// Preserve the response timestamps. Never renew a quote by changing its clock.
// Executor AMM quotes have a local freshness policy AND a calldata deadline;
// neither an earlier provider expiry nor the route deadline may be exceeded.
export function swapQuoteExpiry(p: TradeProposal): number {
  const created = Date.parse(p.quotedAt), expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) return 0;
  let end = Math.min(expires, created + TRADE_QUOTE_MAX_AGE_MS);
  if (p.provider === "mpgr-executor") {
    if (!p.transaction) return 0;
    const route = inspectExecutorSwapTransaction(p.transaction);
    if (!route.ok) return 0;
    end = Math.min(end, Number(route.value.deadline) * 1000);
  }
  return end;
}
export function swapQuoteFresh(p: TradeProposal, now = Date.now()): boolean {
  return Date.parse(p.quotedAt) <= now + 5000 && swapQuoteExpiry(p) > now;
}
export function swapQuoteNeedsRefresh(p: TradeProposal, now = Date.now()): boolean {
  // Scale the safety margin to genuinely short-lived responses. A fixed 5s
  // threshold would otherwise make every 1s quote permanently unconfirmable.
  const lifetime = swapQuoteExpiry(p) - Date.parse(p.quotedAt);
  return !swapQuoteFresh(p, now) || swapQuoteExpiry(p) - now <= Math.min(5000, lifetime / 4);
}
