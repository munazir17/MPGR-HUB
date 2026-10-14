"use client";

import { useId, useState } from "react";
import type { useAgentAutonomy } from "@/hooks/useAgentAutonomy";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { AgentAutonomyPanel } from "./AgentAutonomyPanel";
import { AgentTradeProposalCard } from "./AgentTradeProposalCard";

interface Props {
  autonomy: ReturnType<typeof useAgentAutonomy>;
  connected: boolean;
  onConnect: () => void;
  proposals: TradeProposal[];
  onReviewTrade: (proposal: TradeProposal) => void;
}

/** Presentation only. Both flows retain the controllers owned by AgentExperience.
 * Manual is immediate proposal/confirmation, not the autonomy goal form.
 * Keep the Autonomy panel mounted when closed so its authoring state survives.
 */
export function AgentTradingLauncher({ autonomy, connected, onConnect, proposals, onReviewTrade }: Props) {
  const [mode, setMode] = useState<"manual" | "autonomy" | null>(null);
  const id = useId();
  return (
    <section data-testid="agent-trading-launcher" className="my-3 min-w-0 rounded-2xl border border-white/10 bg-surface" aria-label="Trading controls">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <span className="mr-auto text-xs text-muted">Trading controls</span>
        {(["manual", "autonomy"] as const).map((entry) => (
          <button key={entry} type="button" data-testid={`trading-launcher-${entry}`}
            aria-expanded={mode === entry} aria-controls={`${id}-${entry}`}
            className="min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-4 text-xs font-medium text-white hover:bg-white/10"
            onClick={() => setMode((current) => current === entry ? null : entry)}>
            {entry === "manual" ? "Manual" : "Autonomy"}
          </button>
        ))}
      </div>
      <div id={`${id}-manual`} data-testid="trading-manual-content" hidden={mode !== "manual"} className="space-y-3 border-t border-white/10 p-3 sm:p-4">
        <h2 className="text-sm font-semibold text-white">Manual — immediate swap review</h2>
        <p className="text-xs text-muted">Prepare an immediate swap in Chat or use the live tape’s Prepare swap action. Review a prepared proposal here in the existing confirmation screen. Quotes can expire; confirmation revalidates them. Nothing executes until you explicitly confirm and complete the required wallet steps.</p>
        {!connected && <button type="button" onClick={onConnect} className="min-h-[44px] rounded-lg border border-white/10 px-3 text-xs text-white">Connect wallet</button>}
        {proposals.length === 0 && <p className="text-xs text-muted">No immediate swap proposal prepared yet. This is not the manual autonomy goal form.</p>}
        {proposals.map((proposal) => <AgentTradeProposalCard key={proposal.id} proposal={proposal} onReview={onReviewTrade} />)}
      </div>
      <div id={`${id}-autonomy`} data-testid="trading-autonomy-content" hidden={mode !== "autonomy"}>
        <p className="px-3 pb-3 text-xs text-muted">Autonomy — author and manage conditional goals. Drafts remain inactive until their own goal-bound permission is saved and activation is confirmed. Each signed slot allows one execution only.</p>
        {connected ? <AgentAutonomyPanel autonomy={autonomy} expanded={mode === "autonomy"} onExpandedChange={(open) => setMode(open ? "autonomy" : null)} /> :
          <button type="button" onClick={onConnect} className="m-3 min-h-[44px] rounded-lg border border-white/10 px-3 text-xs text-white">Connect wallet to manage goals</button>}
      </div>
    </section>
  );
}
