import { formatAtomicAmount } from "@/lib/trade/trade-format";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import type { TradeProposal } from "@/lib/trade/trade-types";
export const swapAmount = (atomic: string, token: TradeProposal["from"]) => `${formatAtomicAmount(atomic, token.decimals, token.decimals)} ${token.symbol}`;
export function SwapDetails({ proposal: p, feeState = "quoted" }: { proposal: TradeProposal; feeState?: "quoted" | "submitted" | "verified" | "reverted" }) {
  const fee = (value: { amount: string; token: string } | undefined) => {
    if (!value) return "Not supplied by provider";
    const token = [p.from, p.to].find(t => t.address.toLowerCase() === value.token.toLowerCase()) ?? findKnownTradeToken(value.token);
    return token ? `${formatAtomicAmount(value.amount, token.decimals, token.decimals)} ${token.symbol}` : `${value.amount} base units (asset not identified)`;
  };
  const row = (label: string, value: string) => <div className="flex justify-between gap-4"><dt className="shrink-0 text-zinc-400">{label}</dt><dd className="min-w-0 break-words text-right">{value}</dd></div>;
  return <details className="rounded-2xl border border-white/[0.07] text-xs">
    <summary className="min-h-11 cursor-pointer px-4 py-3 text-zinc-300">Costs &amp; execution details</summary>
    <dl className="space-y-3 px-4 pb-4">
      {row("Provider", p.providerLabel)}
      {row("Minimum received", swapAmount(p.minToAmount, p.to))}
      {row("Slippage", `${p.slippageBps / 100}%`)}
      {row("MPGR fee (0.25%)", `${swapAmount(p.agentFee!.amountAtomic, p.from)} · ${feeState === "verified" ? "collection verified" : feeState === "reverted" ? "not collected (swap reverted)" : feeState === "submitted" ? "submitted, unverified" : "quoted, not paid"}`)}
      {row("Provider fee", fee(p.fees.protocolFee))}
      {row("Est. network fee", fee(p.fees.gasFee))}
      <p className="text-zinc-400">Gas is re-estimated on Base before each signature, including L1 data costs. If unavailable, signing is blocked. Provider pool costs may already be reflected in output; they are not an extra MPGR charge.</p>
      {row("Receive address", p.taker)}
      {row("Fee recipient (Executor)", p.agentFee!.recipient!)}
      {row("Pay contract", p.from.address)}{row("Receive contract", p.to.address)}
      <p className="text-zinc-400">Provider-priority route. Executable alternatives were not compared. MPGR fee collection is verified only after the Executor receipt, never from this quote.</p>
      {p.warnings.map((warning, i) => <p key={i} className="break-words text-amber-200">{warning}</p>)}
    </dl>
  </details>;
}
