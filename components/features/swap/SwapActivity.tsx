"use client";
import { useState } from "react";
import type { useSwapExecution } from "@/hooks/useSwapExecution";
import { SwapDialog } from "./SwapDialog";
import { swapAmount } from "./SwapDetails";
export function SwapActivity({ trade, onClose }: { trade: ReturnType<typeof useSwapExecution>; onClose: () => void }) {
  const [copy, setCopy] = useState<string | null>(null);
  return <SwapDialog title="Recent swaps" onClose={onClose}>
    <p className="text-xs leading-relaxed text-zinc-400">Up to 20 recent transactions submitted from this browser session, for the connected wallet on Base. External wallet history is not indexed here. Closing the page clears this session list.</p>
    <button type="button" onClick={() => void trade.checkHistory()} disabled={trade.checking || !trade.activities.length} className="min-h-11 rounded-xl border border-white/10 px-3 text-xs text-zinc-300 disabled:opacity-40">{trade.checking ? "Checking receipts…" : "Refresh transaction status"}</button>
    {trade.historyError && <p role="alert" className="text-xs text-amber-200">{trade.historyError}</p>}
    {!trade.activities.length && <p className="rounded-2xl bg-white/5 p-5 text-sm text-zinc-400">No swaps submitted from this wallet in this browser session.</p>}
    {trade.activities.map(a => <article key={a.id} className="space-y-3 rounded-2xl border border-white/10 p-4 text-xs">
      <header className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{a.proposal.from.symbol} → {a.proposal.to.symbol}</h3><time title="Browser submission time" className="text-zinc-500" dateTime={new Date(a.startedAt).toISOString()}>{new Date(a.startedAt).toLocaleString()}</time></header>
      <p className="break-words text-zinc-300">Pay: {swapAmount(a.proposal.fromAmount, a.proposal.from)}</p>
      <p className="break-words text-zinc-300">Received: {a.proof?.verified && a.proof.amountOut ? swapAmount(a.proof.amountOut, a.proposal.to) : "Not verified"}</p>
      <p className="break-words text-zinc-400">MPGR fee: {a.proof?.verified ? `${swapAmount(a.proof.feeAmount!, a.proposal.from)} · collection verified` : a.swapStatus === "reverted" ? "Not collected — swap reverted" : a.swapHash ? "Submitted; collection not verified" : "Not submitted / not collected by approval"}</p>
      {a.proof?.verified && <p className="break-all text-[10px] text-zinc-500">Fee recipient: {a.proof.feeRecipient}</p>}
      {([["Approval", a.approvalHash, a.approvalStatus], ["Swap", a.swapHash, a.swapStatus]] as const).map(([label, hash, status]) => hash && <div key={label} className="space-y-1 border-t border-white/5 pt-2">
        <p className="text-zinc-300">{label} · {status === "unverified" || status === "unknown" ? "verification unavailable" : status}</p>
        <p className="break-all font-mono text-[10px] text-zinc-500">{hash}</p>
        <div className="flex gap-4"><a className="inline-flex min-h-11 items-center text-emerald-300 underline" href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noopener noreferrer">View {label.toLowerCase()} on BaseScan</a>
          <button type="button" className="min-h-11 text-zinc-400" onClick={async () => { try { await navigator.clipboard.writeText(hash); setCopy(`${label} hash copied`); } catch { setCopy("Copy unavailable. Select the hash above."); } }}>Copy {label.toLowerCase()} hash</button></div>
      </div>)}
    </article>)}
    {copy && <p role="status" className="text-xs text-zinc-400">{copy}</p>}
    <p className="text-[11px] leading-relaxed text-zinc-500">Pending or unavailable receipts are not proof of failure. A confirmed approval is not a confirmed swap. Fees are not labelled collected without the exact Executor event.</p>
  </SwapDialog>;
}
