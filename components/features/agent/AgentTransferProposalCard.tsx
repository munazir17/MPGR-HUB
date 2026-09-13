"use client";

import { motion } from "framer-motion";
import { Send, ChevronRight } from "lucide-react";

import { formatAddress } from "@/lib/format";
import type { TransferProposal } from "@/lib/trade/transfer-types";

interface AgentTransferProposalCardProps {
  proposal: TransferProposal;
  onReview: (proposal: TransferProposal) => void;
}

export function AgentTransferProposalCard({ proposal, onReview }: AgentTransferProposalCardProps) {
  const destinationLabel = proposal.recipient.basename ?? formatAddress(proposal.recipient.address);
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
      <button
        type="button"
        onClick={() => onReview(proposal)}
        className="group flex w-full items-center gap-3 rounded-xl border border-primary/25 bg-gradient-to-br from-primary-glow/10 to-primary/5 p-3 text-left transition-colors duration-200 hover:border-primary/40 hover:bg-primary/10"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold ring-1 ring-white/10">
          <Send className="h-4 w-4 text-white" aria-hidden="true" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-white sm:text-sm">
            {proposal.sufficientBalance ? "Transfer proposal ready" : "Transfer unavailable — insufficient balance"}
          </span>
          <span className="block truncate text-[11px] text-muted sm:text-xs">
            Send {proposal.displayAmount} to {destinationLabel} on Base
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
