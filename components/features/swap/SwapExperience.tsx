"use client";
import { useState } from "react";
import { History } from "lucide-react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { useSwapExecution } from "@/hooks/useSwapExecution";
import { SwapBackButton } from "./SwapBackButton";
import { SwapForm } from "./SwapForm";
import { SwapActivity } from "./SwapActivity";
import { SwapExecutionDialog } from "./SwapExecutionDialog";
export function SwapExperience() {
  const { authenticated, authenticate } = useWalletAuth();
  const { openConnectModal } = useConnectModal();
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [activity, setActivity] = useState(false);
  const trade = useSwapExecution(() => setBalanceRevision(n => n + 1), authenticate);
  return <main className="relative mx-auto w-full max-w-[520px] px-3 py-4 text-white sm:px-5 sm:py-12">
    <header className="mb-3 flex items-start justify-between gap-2 px-1"><SwapBackButton disabled={trade.isBusy} /><div className="min-w-0 flex-1"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300/75">Onchain. On your terms.</p>
      <div className="flex items-center gap-3">
        <img src="/brand/paigerswap.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-xl object-cover shadow-[0_0_24px_rgba(56,189,248,0.35)]" />
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">PaigerSwap</h1>
          <p className="mt-1 text-xs text-zinc-500">Your assets. Your wallet. Your signature.</p>
        </div>
      </div></div>
      <button type="button" aria-label="Recent swaps" onClick={() => { setActivity(true); void trade.checkHistory(); }} className="mt-5 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-zinc-400 hover:bg-white/5"><History size={19} /></button>
    </header>
    <section className="min-w-0 rounded-[28px] border border-white/[0.08] bg-[#10151f] p-3 shadow-[0_20px_80px_-40px_rgba(0,0,0,0.8)] sm:p-4" aria-label="Spot swap">
      <SwapForm authenticated={authenticated} signIn={authenticate} onConnect={() => openConnectModal?.()} onReview={trade.open} balanceRevision={balanceRevision} executionBusy={trade.isBusy} reviewOpen={!!trade.proposal || activity} settledHash={trade.snapshot.state === "SUCCESS" ? trade.snapshot.swapHash : null} />
    </section>
    <details className="mt-6 rounded-2xl border border-white/5 text-xs text-zinc-500"><summary className="min-h-11 cursor-pointer p-4">Limit orders — not available</summary><p className="px-4 pb-4 leading-relaxed">A genuine Base order-signing and settlement integration is pending approval. No executable limit order is created here. Conditional Agent goals are review-only until separately authorized, not limit orders.</p></details>
    {trade.proposal && <SwapExecutionDialog trade={trade} />}
    {activity && <SwapActivity trade={trade} onClose={() => setActivity(false)} />}
  </main>;
}
