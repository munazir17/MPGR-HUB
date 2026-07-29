"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { clsx } from "clsx";
import { AGENT_ICON_MAP } from "./agent-icon-map";
import type { AgentAction } from "@/lib/agent-actions";

interface AgentActionCardProps {
  action: AgentAction;
}

// A single tappable "smart action" surfaced under an assistant reply —
// deep-links straight into the relevant feature page (Staking, Token Lock,
// Rewards, etc). Primary/secondary variants reuse the same visual
// vocabulary as the rest of the Agent feature (bg-gradient-premium /
// shadow-glow-gold for the emphasized action, subtle bordered tile for
// supporting ones) rather than introducing a new button style.
export function AgentActionCard({ action }: AgentActionCardProps) {
  const Icon = AGENT_ICON_MAP[action.icon];
  const isPrimary = action.variant === "primary";

  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
      <Link
        href={action.href}
        className={clsx(
          "group flex items-center gap-3 rounded-xl border p-3 transition-colors duration-200",
          isPrimary
            ? "border-primary/25 bg-gradient-to-br from-primary-glow/10 to-primary/5 hover:border-primary/40 hover:bg-primary/10"
            : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.05]"
        )}
      >
        <span
          className={clsx(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1",
            isPrimary
              ? "bg-gradient-premium shadow-glow-gold ring-white/10"
              : "bg-white/[0.06] ring-white/10"
          )}
        >
          <Icon className={clsx("h-4 w-4", isPrimary ? "text-white" : "text-primary")} aria-hidden="true" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-white sm:text-sm">{action.label}</span>
          <span className="block truncate text-[11px] text-muted sm:text-xs">{action.description}</span>
        </span>

        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white"
          aria-hidden="true"
        />
      </Link>
    </motion.div>
  );
}
