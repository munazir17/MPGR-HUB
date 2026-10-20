import { isNativeEthSentinel, TRADE_QUOTE_MAX_AGE_MS } from "@/lib/trade/trade-config";
import { inspectExecutorSwapTransaction } from "@/lib/executor/executor-intent";
import { swapPathExecutor } from "./swap-executor-config";
import { inspectSwapExecutorTransaction } from "./swap-executor-intent";
import { inspectSwapV2Proposal } from "@/lib/swap/v2/v2-inspect";
import type { TradeProposal } from "@/lib/trade/trade-types";

// Preserve the response timestamps. Never renew a quote by changing its clock.
// Executor AMM quotes have a local freshness policy AND a calldata deadline;
// neither an earlier provider expiry nor the route deadline may be exceeded.
// Both executor families share provider "mpgr-executor"; the transaction
// TARGET picks the decoder (the same discriminator swap-policy uses) —
// swap-path calldata is undecodable by the legacy ABI and vice versa, and
// each branch stays fail-closed on the other's calldata.
export function swapQuoteExpiry(p: TradeProposal): number {
  const created = Date.parse(p.quotedAt), expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) return 0;
  let end = Math.min(expires, created + TRADE_QUOTE_MAX_AGE_MS);
  if (p.provider === "mpgr-executor") {
    if (!p.transaction) return 0;
    // V2 calldata is undecodable by the V1 and legacy ABIs, so it must be
    // recognised first; otherwise its deadline reads as 0 and the quote can
    // never be confirmed. Null while the V2 gate is dormant, leaving the two
    // branches below exactly as they were.
    const v2 = inspectSwapV2Proposal(p);
    if (v2 !== null) {
      if (!v2.ok) return 0;
      end = Math.min(end, Number(v2.value.deadline) * 1000);
      return end;
    }
    const swapPathDeployment = swapPathExecutor();
    if (swapPathDeployment && p.transaction.to.toLowerCase() === swapPathDeployment.executor.toLowerCase()) {
      const path = inspectSwapExecutorTransaction(p.transaction, { deployment: swapPathDeployment, fromAddress: p.from.address, toAddress: p.to.address, taker: p.taker, nativeIn: isNativeEthSentinel(p.from.address), nativeOut: isNativeEthSentinel(p.to.address) });
      if (!path.ok) return 0;
      end = Math.min(end, path.value.deadline * 1000);
    } else {
      const route = inspectExecutorSwapTransaction(p.transaction);
      if (!route.ok) return 0;
      end = Math.min(end, Number(route.value.deadline) * 1000);
    }
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
