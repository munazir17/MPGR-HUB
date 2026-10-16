"use client";

import { RefreshCw } from "lucide-react";
import { formatUnits } from "viem";
import type { ReactNode } from "react";
import type { TradeProposal, TradeRiskFact } from "@/lib/trade/trade-types";
import { findBasePairByAddress } from "@/lib/markets/base-pairs";
import type { AutonomyAuthorizeFormState } from "./autonomy-authorize-form";

interface QuoteProps {
  form: AutonomyAuthorizeFormState;
  sellSymbol: string;
  buySymbol: string;
  proposal?: TradeProposal;
  valid: boolean;
  message: string;
  expiresAt?: number;
  onRefresh?: () => void;
  busy?: boolean;
}
const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const unique = (lines: string[]) => [...new Map(lines.map((line) => [normalized(line), line])).values()];
const canonicalRisk: Record<string, { title: string; detail: string; short: string }> = {
  "executor-approval": {
    title: "Executor spending approval required",
    detail: "Your wallet must first approve the MPGR Executor for the gross sell amount so the swap can pull it (the executor takes its fee from that amount and swaps the rest). Approval is a separate Base transaction you will sign once; later swaps with a sufficient allowance go straight to the swap.",
    short: "Separate Executor approval required for the gross sell amount (a Base transaction).",
  },
  "router-approval": {
    title: "Aerodrome router approval required",
    detail: "Your wallet must first approve the Aerodrome Slipstream SwapRouter so the swap can pull the sell token. Approval is a separate Base transaction you will sign.",
    short: "Separate Aerodrome router approval required (a Base transaction).",
  },
  "permit2-approval": {
    title: "Permit2 approval required",
    detail: "Your wallet must first approve the canonical Permit2 contract so the swap can pull the sell token. Approval is a separate Base transaction you will sign.",
    short: "Separate Permit2 approval required (a Base transaction).",
  },
  "tokenized-swap": {
    title: "", // token symbol is checked separately below
    detail: "This is a DEX swap of a Coinbase tokenized stock (B20), not an issuer subscription. Liquidity can be thin. Price may differ from the Chainlink equity oracle.",
    short: "Tokenized stock, not direct shares or issuer subscription. Liquidity may be thin; prices may differ from Chainlink.",
  },
};
function compactRisk(risk: TradeRiskFact, proposal?: TradeProposal) {
  const known = canonicalRisk[risk.id];
  const stock = proposal?.to.kind === "b20-tokenized-stock" ? proposal.to : proposal?.from;
  const title = risk.id === "tokenized-swap" ? `Swapping ${stock?.symbol} on Base` : known?.title;
  // New wording may carry new restrictions even under an existing id. Fail
  // visibly: only abbreviate the exact known source, never arbitrary prose.
  return risk.severity === "warning" && known?.detail === risk.detail && title === risk.title ? known.short : null;
}
/** Only exact duplicate warning prose is removed. Unknown/material warnings
 * stay visible; critical facts are NEVER abbreviated or put behind a disclosure. */
export function quoteRiskPresentation(proposal?: TradeProposal) {
  const risk = proposal?.risk ?? [];
  const represented = new Set(risk.filter((r) => r.severity !== "info").flatMap((r) => [r.title, r.detail, `${r.title}: ${r.detail}`]).map(normalized));
  return {
    visible: unique([
      ...risk.filter((r) => r.severity !== "info").map((r) => compactRisk(r, proposal) ?? `${r.title}: ${r.detail}`),
      ...(proposal?.warnings ?? []).filter((w) => !represented.has(normalized(w))),
    ]),
    details: risk.filter((r) => r.severity === "info" || compactRisk(r, proposal) !== null),
  };
}
function agentFee(proposal?: TradeProposal): string {
  const fee = proposal?.agentFee;
  if (!fee) return "Not quoted";
  if (fee.status === "skipped") return "Not charged";
  const amount = `${formatUnits(BigInt(fee.amountAtomic), proposal!.from.decimals)} ${proposal!.from.symbol}`;
  return `${fee.bps !== null ? `${fee.bps / 100}% · ` : ""}${amount}`;
}
export function AutonomyQuoteSummary({ form, sellSymbol, buySymbol, proposal, valid, message, expiresAt, onRefresh, busy }: QuoteProps) {
  const stock = [form.sell, form.buy].map(findBasePairByAddress).find((token) => token?.kind === "b20-stock");
  const risks = quoteRiskPresentation(proposal);
  const rows = [
    ["Pair", `${sellSymbol || "—"} → ${buySymbol || "—"}`],
    ["Trigger", `${form.kind === "price_below" ? "Below" : "Above"} ${sellSymbol === "USDC" ? "$" : ""}${form.threshold || "—"}${sellSymbol === "USDC" ? "" : ` ${sellSymbol}/${buySymbol}`}`],
    ["Trade amount", form.sellAmount ? `${form.sellAmount} ${sellSymbol}` : "—"],
    ["Expected output", valid && proposal ? `${formatUnits(BigInt(proposal.toAmount), proposal.to.decimals)} ${buySymbol}` : "—"],
    ["Minimum after slippage", valid && proposal ? `${formatUnits(BigInt(proposal.minToAmount), proposal.to.decimals)} ${buySymbol}` : "—"],
    ["Provider / network", valid && proposal ? `${proposal.providerLabel} · Base Mainnet` : "Not quoted"],
    ["Quote expiry", valid && expiresAt ? new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Not valid"],
    ["Agent fee", valid ? agentFee(proposal) : "Not quoted"],
    ["Gas / protocol", valid && proposal && (proposal.fees.gasFee || proposal.fees.protocolFee) ? `${proposal.fees.gasFee ? "Gas quoted" : "Gas not quoted"} · ${proposal.fees.protocolFee ? "Protocol quoted" : "protocol not quoted"}` : "Not quoted"],
  ];
  return <section data-testid="chat-quote-details" aria-label="Quote summary" className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs">
    <div className="mb-1 flex min-h-[44px] items-center justify-between gap-2">
      <p data-testid="quote-validity" role="status" className={`font-medium ${valid ? "text-sky-200" : "text-amber-200"}`}>{message}</p>
      {onRefresh && <button type="button" onClick={onRefresh} disabled={busy} aria-label="Refresh live quote" title="Refresh live quote" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 disabled:opacity-50"><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>}
    </div>
    <dl data-testid="agent-autonomy-draft-values" className="space-y-1">
      {rows.map(([label, value]) => <div key={label} className="flex min-w-0 justify-between gap-3 leading-5">
        <dt className="shrink-0 text-muted">{label}</dt><dd data-testid={`quote-${label.split(" ")[0].toLowerCase()}`} className="min-w-0 break-words text-right font-medium text-white">{value}</dd>
      </div>)}
    </dl>
    <div className="mt-2 space-y-1 border-t border-white/10 pt-2 leading-relaxed text-muted" data-testid="quote-safety">
      <p>Base Mainnet only. Nothing executes until required authorization and trigger conditions are satisfied.</p>
      {stock && !proposal?.risk.some((r) => r.id === "tokenized-swap" && compactRisk(r, proposal) !== null) && <p>{stock.symbol} is a tokenized stock token, not direct shares or issuer subscription. Liquidity may be thin; prices may differ from Chainlink.</p>}
      {proposal?.provider === "mpgr-executor" && !proposal.risk.some((r) => r.id === "executor-approval" && compactRisk(r, proposal) !== null) && <p>Separate Executor approval may be needed (a Base transaction).</p>}
      {risks.visible.map((line) => <p key={normalized(line)}>{line}</p>)}
    </div>
  </section>;
}
function RiskLines({ facts }: { facts: TradeRiskFact[] }) {
  return <>{unique(facts.map((r) => `${r.title}: ${r.detail}`)).map((line) => <p key={line}>{line}</p>)}</>;
}
export function AutonomyQuoteDetails({ form, proposal, expiresAt, diagnostics, sourcePrompt, referenceLabel }: {
  form: AutonomyAuthorizeFormState; proposal?: TradeProposal; expiresAt?: number; diagnostics: ReactNode; sourcePrompt: string; referenceLabel?: string;
}) {
  const risk = quoteRiskPresentation(proposal).details;
  const feeFacts = risk.filter((r) => ["provider", "executor-approval", "router-approval", "permit2-approval"].includes(r.id));
  const validityFacts = risk.filter((r) => ["slippage", "high-slippage"].includes(r.id));
  const otherFacts = risk.filter((r) => !feeFacts.includes(r) && !validityFacts.includes(r) && !["network", "mpgr-agent-fee"].includes(r.id));
  const panel = "rounded-xl border border-white/10 text-xs text-muted";
  return <div className="my-3 space-y-2 break-words" data-testid="quote-technical-details">
    <details className={panel}>
      <summary className="min-h-[44px] cursor-pointer px-3 py-3 font-medium text-white">Fee &amp; execution details</summary>
      <div className="space-y-2 px-3 pb-3 leading-relaxed">
        <p>One goal-bound permission permits one execution: single-use, not recurring schedule permission. A new goal requests its own signature; a valid saved permission for this same goal can be reused without a new signature. Activation requires confirmed persistence.</p>
        {proposal?.agentFee?.status === "applied" && <p>The agent fee is taken from the gross sell amount inside the Executor swap. The remainder is swapped; no separate fee transaction is created. The fee is not paid to your wallet. Fee recipient: {typeof proposal.agentFee.recipient === "string" ? proposal.agentFee.recipient : "Not quoted"}.</p>}
        {proposal?.agentFee?.status === "skipped" && proposal.agentFee.reason && <p>{proposal.agentFee.reason}</p>}
        <p>Gas: {proposal?.fees.gasFee ? `${proposal.fees.gasFee.amount} atomic units (${proposal.fees.gasFee.token})` : "Not quoted; wallet/network cost may apply."}</p>
        <p>Protocol: {proposal?.fees.protocolFee ? `${proposal.fees.protocolFee.amount} atomic units (${proposal.fees.protocolFee.token})` : "Not quoted."}</p>
        <p>Provider notes below describe the underlying Manual quote source, not autonomous signing or broadcasting. This review saves a goal-bound permission, not a signed swap. An authorized runtime may broadcast only after the trigger and all execution checks pass.</p>
        <RiskLines facts={feeFacts} />
      </div>
    </details>
    <details className={panel}>
      <summary className="min-h-[44px] cursor-pointer px-3 py-3 font-medium text-white">Slippage &amp; quote validity</summary>
      <div className="space-y-2 px-3 pb-3 leading-relaxed">
        <p>Slippage limit {form.slippageBps / 100}%. At least {form.cooldownSeconds / 60} min between checks; authorization expires in {form.ttlDays} days.</p>
        {referenceLabel && <p>Chat reference: {referenceLabel}</p>}
        <p>Quote snapshot — not settlement. Runtime obtains a fresh quote at the trigger and must still meet your signed floor. Read-only quoting does not establish execution readiness.</p>
        {proposal && <p>Quoted: {proposal.quotedAt}<br />Expires: {expiresAt ? new Date(expiresAt).toISOString() : "Not valid"}</p>}
        <RiskLines facts={validityFacts} />
      </div>
    </details>
    <details className={panel}>
      <summary className="min-h-[44px] cursor-pointer px-3 py-3 font-medium text-white">Risks &amp; network requirements</summary>
      <div className="space-y-2 px-3 pb-3 leading-relaxed">
        <p>MPGR never holds your keys. A connected Base wallet, authenticated session, ready delegated adapter and all runtime/production safety gates are required.</p>
        <RiskLines facts={otherFacts} />
        {sourcePrompt && <p>From chat: {sourcePrompt}</p>}
        {diagnostics}
      </div>
    </details>
  </div>;
}
