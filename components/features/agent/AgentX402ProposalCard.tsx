"use client";

import { motion } from "framer-motion";
import { ChevronRight, ShieldCheck } from "lucide-react";

import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";

interface AgentX402ProposalCardProps {
  proposal: X402PaymentProposal;
  onReview: (proposal: X402PaymentProposal) => void;
}

// P3 — the tappable surface an x402 proposal gets under an assistant
// chat message, mirroring AgentActionCard.tsx's own visual vocabulary
// exactly (same tile shape, same hover lift) rather than inventing a
// new card style. Tapping it ONLY opens AgentX402PaymentModal for
// review — see hooks/useX402Payment.ts's openProposal, which itself
// only re-validates (never signs/submits). Nothing here can sign or pay
// on its own; there is no click handler in this file that reaches
// useX402Execution at all.
export function AgentX402ProposalCard({ proposal, onReview }: AgentX402ProposalCardProps) {
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
      <button
        type="button"
        onClick={() => onReview(proposal)}
        className="group flex w-full items-center gap-3 rounded-xl border border-primary/25 bg-gradient-to-br from-primary-glow/10 to-primary/5 p-3 text-left transition-colors duration-200 hover:border-primary/40 hover:bg-primary/10"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold ring-1 ring-white/10">
          <ShieldCheck className="h-4 w-4 text-white" aria-hidden="true" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-white sm:text-sm">
            Payment proposal ready
          </span>
          <span className="block truncate text-[11px] text-muted sm:text-xs">
            {proposal.displayAmount ?? proposal.requirement.maxAmountRequired} — tap to review and confirm
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
