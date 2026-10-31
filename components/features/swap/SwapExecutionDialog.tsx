"use client";
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, ExternalLink } from "lucide-react";
import { swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import type { useSwapExecution } from "@/hooks/useSwapExecution";
import { SwapDialog } from "./SwapDialog";
import { SwapDetails, swapAmount } from "./SwapDetails";
import { publicSwapMessage } from "@/lib/swap/public-message";
import { APPROVAL_VERIFICATION_DELAYED } from "@/lib/swap/approval-verification";
export function SwapExecutionDialog({ trade }: { trade: ReturnType<typeof useSwapExecution> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const p = trade.proposal;
  if (!p) return null;
  const { snapshot: s, proof } = trade;
  const success = s.state === "SUCCESS" && proof?.verified;
  const submitted = !!s.swapHash;
  const reverted = submitted && s.error?.code === "SEND_FAILED";
  const approvalStatus = trade.activities.find(a => a.approvalHash === s.approvalHash)?.approvalStatus;
  const approvalUnknown = !!s.approvalHash && (approvalStatus === "pending" || approvalStatus === "unknown");
  const verificationDelayed = s.error?.message === APPROVAL_VERIFICATION_DELAYED;
  if (success) return <SwapDialog title="Transaction overview" onClose={trade.close}>
    <div role="status" data-testid="swap-status" className="flex items-center gap-2 text-emerald-200"><CheckCircle2 size={20} />Swap confirmed · output verified</div>
    <dl className="space-y-4 rounded-2xl border border-white/10 p-4">
      <div><dt className="text-xs text-zinc-400">You paid · verified</dt><dd className="mt-1 break-words text-xl">{swapAmount(proof.amountIn!, p.from)}</dd></div>
      <div><dt className="text-xs text-zinc-400">You received · verified</dt><dd className="mt-1 break-words text-xl text-emerald-200">{swapAmount(proof.amountOut!, p.to)}</dd></div>
      <div data-testid="mpgr-fee-row"><dt className="text-xs text-zinc-400">0.25% Trading Fee · collection verified</dt><dd className="break-words text-sm">{swapAmount(proof.feeAmount!, p.from)} · included in amount paid</dd></div>
      <div><dt className="text-xs text-zinc-400">Network</dt><dd>Base</dd></div>
      <div><dt className="text-xs text-zinc-400">Receive address</dt><dd className="break-all text-xs">{p.taker}</dd></div>
    </dl>
    <p className="text-xs text-zinc-400">Network gas is extra and is not included above.</p>
    <a className="inline-flex min-h-11 items-center gap-1 text-sm text-emerald-300 underline" href={`https://basescan.org/tx/${s.swapHash}`} target="_blank" rel="noopener noreferrer">View swap on BaseScan<ExternalLink size={14} /></a>
    {s.approvalHash && <a className="inline-flex min-h-11 items-center gap-1 text-xs text-zinc-400 underline" href={`https://basescan.org/tx/${s.approvalHash}`} target="_blank" rel="noopener noreferrer">View approval<ExternalLink size={12} /></a>}
    <button type="button" onClick={trade.close} className="min-h-12 w-full rounded-2xl bg-emerald-300 font-semibold text-[#071710]">Done</button>
  </SwapDialog>;
  return <SwapDialog title="Confirm Swap" onClose={trade.close} busy={trade.isBusy}>
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div><p className="text-xs text-zinc-400">You pay</p><p className="mt-1 break-words text-xl font-medium">{swapAmount(p.fromAmount, p.from)}</p></div>
      <div className="border-t border-white/5 pt-3"><p className="text-xs text-zinc-400">{success ? "You received · verified" : "You receive · estimated"}</p>
        <p className="mt-1 break-words text-xl font-medium text-emerald-200">{swapAmount(success ? proof.amountOut! : p.toAmount, p.to)}</p></div>
      <p className="break-words text-xs text-zinc-400">Minimum: {swapAmount(p.minToAmount, p.to)} · Slippage {p.slippageBps / 100}%</p>
    </div>
    <SwapDetails proposal={p} feeState={success ? "verified" : reverted ? "reverted" : submitted ? "submitted" : "quoted"} />
    {p.risk.filter(r => r.severity !== "info" && !["executor-approval", "router-approval", "permit2-approval"].includes(r.id)).map(r => <p key={r.id} className="text-xs text-amber-200">{r.detail}</p>)}
    {!submitted && s.state === "IDLE" && <p className="text-xs text-zinc-400">{p.needsPermit2Approval ? "Your wallet may ask for approval of this amount first. Approval is not a swap." : "Your wallet will ask you to confirm this swap."}</p>}
    {trade.quoteUpdated && !trade.isBusy && <p role="status" className="text-xs text-emerald-200">Quote updated — review new output.</p>}
    {trade.isBusy && <p role="status" className="flex items-center gap-2 text-sm text-zinc-300"><Loader2 size={17} className="shrink-0 animate-spin" />{s.stepLabel ?? "Refreshing quote…"}</p>}
    {!swapQuoteFresh(p, now) && !submitted && !trade.isBusy && <p role="status" className="text-xs text-amber-200">Quote needs updating.</p>}
    {s.error && !verificationDelayed && <p role="alert" className="break-words rounded-xl border border-red-300/10 bg-red-300/5 p-3 text-xs leading-relaxed text-red-200">{publicSwapMessage(s.error.message)}</p>}
    {verificationDelayed && <p role="status" className="break-words rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-zinc-200">{s.error?.message}</p>}
    {s.approvalHash && <div className="flex items-start justify-between gap-3 text-xs"><p className="text-zinc-400">Approval transaction<br /><span className="text-zinc-500">Not a swap or fee payment</span></p><a className="inline-flex min-h-11 items-center gap-1 text-emerald-300 underline" href={`https://basescan.org/tx/${s.approvalHash}`} target="_blank" rel="noopener noreferrer">View approval<ExternalLink size={12} /></a></div>}
    {s.swapHash && <a className="inline-flex min-h-11 items-center gap-1 text-xs text-emerald-300 underline" href={`https://basescan.org/tx/${s.swapHash}`} target="_blank" rel="noopener noreferrer">View swap on BaseScan<ExternalLink size={12} /></a>}
    {success && <p role="status" data-testid="swap-status" className="flex items-center gap-2 text-sm text-emerald-200"><CheckCircle2 size={18} />Swap confirmed · output verified</p>}
    {!success && !submitted && !approvalUnknown && !verificationDelayed && <>
      {s.state === "ERROR" || !swapQuoteFresh(p, now) ? <button type="button" disabled={trade.isBusy} onClick={() => void trade.retryQuote()} className="min-h-12 w-full rounded-2xl bg-emerald-300 px-3 font-semibold text-[#071710] disabled:opacity-40">{trade.sessionExpired ? "Sign in & refresh quote" : "Refresh quote & retry"}</button>
        : <button type="button" disabled={trade.isBusy} onClick={() => void trade.confirm()} className="min-h-12 w-full rounded-2xl bg-emerald-300 px-3 font-semibold text-[#071710] disabled:opacity-40">{trade.isBusy ? "Waiting for confirmation…" : "Confirm & Swap"}</button>}
    </>}
    {verificationDelayed && !submitted && <button type="button" disabled={trade.isBusy || trade.checking} onClick={() => void trade.retryAllowanceCheck()} className="min-h-12 w-full rounded-2xl bg-emerald-300 px-3 font-semibold text-[#071710] disabled:opacity-40">{trade.isBusy || trade.checking ? "Checking allowance…" : "Retry status check"}</button>}
    {approvalUnknown && !submitted && !trade.isBusy && <button type="button" disabled={trade.checking} onClick={() => void trade.checkHistory()} className="min-h-12 w-full rounded-xl bg-white/10 text-sm">{trade.checking ? "Checking approval…" : "Check approval status"}</button>}
    {!success && submitted && !trade.isBusy && <button type="button" disabled={trade.checking} onClick={() => void trade.checkHistory()} className="min-h-12 w-full rounded-xl bg-white/10 text-sm">{trade.checking ? "Checking receipt…" : "Check submitted swap status"}</button>}
  </SwapDialog>;
}
