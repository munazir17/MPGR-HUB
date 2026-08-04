"use client";

import { clsx } from "clsx";
import { AGENT_STATUS, type AgentStatusId } from "@/lib/agent-config";

interface AgentStatusBadgeProps {
  status: AgentStatusId;
  className?: string;
}

// Small reusable status pill for the MPGR Agent — Online / Thinking / Beta.
// Styled to match the existing badge language (PremiumBadge, HolderTierBadge):
// soft tint background, ring, rounded-full pill.
export function AgentStatusBadge({ status, className }: AgentStatusBadgeProps) {
  const def = AGENT_STATUS[status];

  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 md:gap-1.5 md:px-2.5 md:py-1 md:text-xs",
        def.bgClass,
        def.textClass,
        def.ringClass,
        className
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", def.dotClass, def.pulse && "animate-pulse")} />
      {def.label}
    </span>
  );
}
