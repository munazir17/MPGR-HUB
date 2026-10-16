"use client";

import { useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { useTradeQuote } from "@/hooks/useTradeQuote";
import { AgentTradeConfirmationModal } from "@/components/features/agent/AgentTradeConfirmationModal";
import { formatTradeSuccess } from "@/lib/trade/trade-chat";
import { SwapForm } from "./SwapForm";

export function SwapExperience() {
  const { authenticated, authenticate } = useWalletAuth();
  const { openConnectModal } = useConnectModal();
  const [status, setStatus] = useState<string | null>(null);
  const trade = useTradeQuote((proposal, hash) => setStatus(formatTradeSuccess(proposal, hash)));
  return <main className="mx-auto w-full max-w-xl space-y-5 px-4 py-8 text-white">
    <header><p className="text-xs text-muted">Base Mainnet · Chain 8453</p><h1 className="mt-1 text-2xl font-semibold">MPGR Swap</h1>
      <p className="mt-2 text-sm text-muted">Manual swaps with live executable quotes. Your wallet stays in control.</p></header>
    <section className="min-w-0 rounded-2xl border border-white/10 bg-surface p-4" aria-label="Spot swap">
      <SwapForm authenticated={authenticated} signIn={authenticate} onConnect={() => openConnectModal?.()} onReview={proposal => { setStatus(null); trade.openProposal(proposal); }} />
    </section>
    <section className="rounded-2xl border border-white/10 bg-surface p-4" aria-label="Limit order availability">
      <h2 className="text-sm font-semibold">Limit orders — not available</h2>
      <p className="mt-2 text-xs text-muted">A genuine Base order-signing and settlement integration is pending approval. No executable limit order is created here. Conditional Agent goals are review-only until separately authorized, and are not limit orders.</p>
    </section>
    {status && <p data-testid="swap-status" role="status" className="whitespace-pre-line break-words text-sm">{status}</p>}
    <AgentTradeConfirmationModal {...trade} onClose={trade.close} onConfirmAndSwap={trade.confirmAndSwap} />
  </main>;
}
