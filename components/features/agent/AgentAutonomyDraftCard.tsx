"use client";

// components/features/agent/AgentAutonomyDraftCard.tsx
//
// Autonomous Agent Runtime (ADDITIVE, spec §20) — the card rendered under
// an assistant reply that detected recurring/conditional trade phrasing.
// REVIEW-ONLY: tapping opens the Autonomous Goals panel with the draft
// pre-filled. It never activates, authorizes, or executes anything, and it
// shows no raw MCP/RPC payloads — just a plain-language summary.

import { motion } from "framer-motion";
import { Repeat, ChevronRight } from "lucide-react";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";

interface AgentAutonomyDraftCardProps {
  draft: AutonomyGoalDraft;
  onReview: (draft: AutonomyGoalDraft) => void;
}

export function AgentAutonomyDraftCard({ draft, onReview }: AgentAutonomyDraftCardProps) {
  const verb = draft.triggerKind === "price_below" ? "Buy" : "Sell";
  const direction = draft.triggerKind === "price_below" ? "falls below" : "rises above";
  const amount = draft.amountPerTrade ? ` · up to ${draft.amountPerTrade} ${draft.spendAsset} per trade` : "";
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
      <button
        type="button"
        onClick={() => onReview(draft)}
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
            {verb} {draft.targetAsset} when the price {direction} {draft.triggerPrice} {draft.spendAsset}
            {amount}
          </span>
        </span>

        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white"
          aria-hidden="true"
        />
      </button>
    </motion.div>
  );
}
