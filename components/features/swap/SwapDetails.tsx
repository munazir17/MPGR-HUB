import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import { swapFeePolicyError } from "@/lib/swap/swap-policy";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
export const swapAmount = (atomic: string, token: TradeProposal["from"]) => `${formatAtomicAmount(atomic, token.decimals, token.decimals)} ${token.symbol}`;
export function SwapDetails({ proposal: p, feeState = "quoted", issue, payToken }: { proposal: TradeProposal | null; feeState?: "quoted" | "submitted" | "verified" | "reverted"; issue?: string | null; payToken?: TradeTokenRef }) {
  const row = (label: string, value: string) => <div data-testid={label === "MPGR fee (0.25%)" ? "mpgr-fee-row" : undefined} className="flex justify-between gap-4"><dt className="shrink-0 text-zinc-400">{label}</dt><dd className="min-w-0 break-words text-right">{value}</dd></div>;
  if (!p) return <details open={!!issue} className="rounded-2xl border border-white/[0.07] text-xs">
    <summary className="min-h-11 cursor-pointer px-4 py-3 text-zinc-300">Costs &amp; execution details</summary>
    <dl className="space-y-3 px-4 pb-4">{row("MPGR fee (0.25%)", `Amount unavailable${payToken ? ` (${payToken.symbol})` : ""} · unsupported/unverified — swap blocked until an executable quote is validated`)}</dl>
    {issue && <p role="alert" className="break-words px-4 pb-4 text-red-200">{issue}</p>}
  </details>;
  const valid = swapFeePolicyError(p) === null;
  const status = !valid ? "Not applied on this route — swap blocked" : feeState === "verified" ? "collection verified" : feeState === "reverted" ? "not collected (swap reverted)" : feeState === "submitted" ? "submitted, unverified" : swapQuoteFresh(p) ? "included in executable route; collection not verified" : "quote expired — collection unverified";
  const fee = (value: { amount: string; token: string } | undefined) => {
    if (!value) return "Not supplied by provider";
    const token = [p.from, p.to].find(t => t.address.toLowerCase() === value.token.toLowerCase()) ?? findKnownTradeToken(value.token);
    return token ? `${formatAtomicAmount(value.amount, token.decimals, token.decimals)} ${token.symbol}` : `${value.amount} base units (asset not identified)`;
  };
  // These exact approval facts are already shown contextually by the form and
  // confirmation. Do not reprint their fee explanation in a second location.
  const warnings = p.warnings.filter(w => !p.risk.some(r => ["executor-approval", "router-approval", "permit2-approval"].includes(r.id) && w === `${r.title}: ${r.detail}`));
  return <details className="rounded-2xl border border-white/[0.07] text-xs">
    <summary className="min-h-11 cursor-pointer px-4 py-3 text-zinc-300">Costs &amp; execution details</summary>
    <dl className="space-y-3 px-4 pb-4">
      {row("Provider", p.providerLabel)}
      {row("Minimum received", swapAmount(p.minToAmount, p.to))}
      {row("Slippage", `${p.slippageBps / 100}%`)}
      {row("MPGR fee (0.25%)", `${valid ? swapAmount(p.agentFee!.amountAtomic, p.from) : `Amount unverified (${p.from.symbol})`} · ${status}`)}
      {row("Provider fee", fee(p.fees.protocolFee))}
      {row("Est. network fee", fee(p.fees.gasFee))}
      {row("Receive address", p.taker)}
      {row("Collection recipient", valid ? p.agentFee!.recipient! : "Unverified")}
      {row(isNativeEthSentinel(p.from.address) ? "Pay asset" : "Pay contract", isNativeEthSentinel(p.from.address) ? "Native ETH on Base (8453) · no ERC-20 contract" : p.from.address)}
      {row(isNativeEthSentinel(p.to.address) ? "Receive asset" : "Receive contract", isNativeEthSentinel(p.to.address) ? "Native ETH on Base (8453) · no ERC-20 contract" : p.to.address)}
    </dl>
    <div className="space-y-3 px-4 pb-4 text-zinc-400">
      <p>Network fees, including L1 data costs, are re-estimated before each signature. Signing is blocked if verification is unavailable.</p>
      <p>Provider-priority route. Executable alternatives were not compared.</p>
      {warnings.map((warning, i) => <p key={i} className="break-words text-amber-200">{warning}</p>)}
      {issue && <p role="alert" className="break-words text-red-200">{issue}</p>}
    </div>
  </details>;
}
