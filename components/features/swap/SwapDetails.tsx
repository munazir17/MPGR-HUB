import { swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import { swapRoutingEvidence } from "@/lib/swap/swap-route-candidates";
import { swapFeePolicyError } from "@/lib/swap/swap-policy";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
export const swapAmount = (atomic: string, token: TradeProposal["from"]) => `${formatAtomicAmount(atomic, token.decimals, token.decimals)} ${token.symbol}`;
export function SwapDetails({ proposal: p, feeState = "quoted", issue }: { proposal: TradeProposal | null; feeState?: "quoted" | "submitted" | "verified" | "reverted"; issue?: string | null; payToken?: TradeTokenRef }) {
  const row = (label: string, value: string) => <div data-testid={label === "Paiger fee (0.25%)" ? "mpgr-fee-row" : undefined} className="flex justify-between gap-4"><dt className="shrink-0 text-zinc-400">{label}</dt><dd className="min-w-0 break-words text-right">{value}</dd></div>;
  if (!p) return <details open={!!issue} className="rounded-2xl border border-white/[0.07] text-xs">
    <summary className="min-h-11 cursor-pointer px-4 py-3 text-zinc-300">Costs</summary>
    <dl className="space-y-3 px-4 pb-4">{row("Paiger fee (0.25%)", "Quote required")}</dl>
    {issue && <p role="alert" className="break-words px-4 pb-4 text-red-200">{issue}</p>}
  </details>;
  const valid = swapFeePolicyError(p) === null;
  const routing = valid ? swapRoutingEvidence(p) : undefined;
  const status = !valid ? "not applied" : feeState === "verified" ? "collection verified" : feeState === "reverted" ? "not collected" : feeState === "submitted" ? "submitted, unverified" : swapQuoteFresh(p) ? "included" : "quote expired";
  const route = !routing ? null : routing.route.kind === 2
    ? `Uniswap v3${routing.route.poolFee !== undefined ? ` · ${routing.route.poolFee / 10000}%` : ""}`
    : `Aerodrome${routing.route.tickSpacing !== undefined ? ` · tick ${routing.route.tickSpacing}` : ""}`;
  return <details className="rounded-2xl border border-white/[0.07] text-xs">
    <summary className="min-h-11 cursor-pointer px-4 py-3 text-zinc-300">Costs</summary>
    <dl className="space-y-3 px-4 pb-4">
      {row("Minimum received", swapAmount(p.minToAmount, p.to))}
      {row("Slippage", `${p.slippageBps / 100}%`)}
      {row("Paiger fee (0.25%)", `${valid ? swapAmount(p.agentFee!.amountAtomic, p.from) : p.from.symbol} · ${status}`)}
      {route && row("Route", route)}
    </dl>
    {issue && <p role="alert" className="break-words px-4 pb-4 text-red-200">{issue}</p>}
  </details>;
}
