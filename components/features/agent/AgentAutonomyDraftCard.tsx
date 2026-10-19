"use client";

// components/features/agent/AgentAutonomyDraftCard.tsx
//
// Autonomous Agent Runtime (ADDITIVE, spec §20) — the card rendered under
// an assistant reply that detected recurring/conditional trade phrasing.
// REVIEW-ONLY: tapping opens the dedicated chat-draft review UI for THIS
// draft (AgentAutonomyDraftReview). It never opens the manual Autonomous
// Goals form, and it never activates, authorizes, or executes anything.
// No raw MCP/RPC payloads — just a plain-language summary.
//
// Percent-trigger drafts show BOTH anchored numbers ("AAPLc is 347 — 1%
// down is 343.53"). Drafts whose asset is NOT on the delegated allowlist
// render as a refusal: no review, no activation — the card only SAYS the
// asset is not available for autonomous trading.

import { motion } from "framer-motion";
import { Repeat, ShieldOff, ChevronRight } from "lucide-react";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";

interface AgentAutonomyDraftCardProps {
  draft: AutonomyGoalDraft;
  onReview: (draft: AutonomyGoalDraft) => void;
}

export function AgentAutonomyDraftCard({ draft, onReview }: AgentAutonomyDraftCardProps) {
  // NOT available for autonomous trading — the draft exists purely to say
  // so. Rendered inert: no review, no activation, ever.
  if (draft.supported === false) {
    return (
      <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
        <div
          data-testid="agent-autonomy-draft-card-unavailable"
          className="flex w-full items-center gap-3 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3 text-left"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/15 ring-1 ring-red-400/30">
            <ShieldOff className="h-4 w-4 text-red-300" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-white sm:text-sm">
              {draft.targetAsset} is not available for autonomous trading
            </span>
            <span className="block truncate text-[11px] text-muted sm:text-xs">
              Autonomous goals only support delegated-allowlist assets with a registered USDC route.
            </span>
          </span>
        </div>
      </motion.div>
    );
  }

  const verb = draft.side === "sell" ? "Sell" : "Buy";
  const direction = draft.triggerKind === "price_below" ? "falls below" : "rises above";
  const amount = draft.amountPerTrade ? ` · up to ${draft.amountPerTrade} ${draft.spendAsset} per trade` : "";
  const anchor =
    draft.referencePrice && draft.triggerPrice
      ? ` · ${draft.targetAsset} is ${draft.referencePrice}, ${draft.percentDrop ?? 1}% ${draft.triggerKind === "price_below" ? "down" : "up"} is ${draft.triggerPrice}`
      : "";
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
      <button
        type="button"
        onClick={() => onReview(draft)}
        data-testid="agent-autonomy-draft-card"
        className="group flex w-full items-center gap-3 rounded-xl border border-primary/25 bg-gradient-to-br from-primary-glow/10 to-primary/5 p-3 text-left transition-colors duration-200 hover:border-primary/40 hover:bg-primary/10"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold ring-1 ring-white/10">
          <Repeat className="h-4 w-4 text-white" aria-hidden="true" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-white sm:text-sm">
            Autonomous goal draft — inactive until you authorize it
          </span>
          <span className="block truncate text-[11px] text-muted sm:text-xs">
            {verb} {draft.targetAsset} when the price {direction} {draft.triggerPrice} USDC
            {amount}
          </span>
          {anchor && (
            <span data-testid="agent-autonomy-draft-anchor" className="block truncate text-[11px] text-muted sm:text-xs">
              {anchor.replace(" · ", "")}
            </span>
          )}
        </span>

        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white"
          aria-hidden="true"
        />
      </button>
    </motion.div>
  );
}
