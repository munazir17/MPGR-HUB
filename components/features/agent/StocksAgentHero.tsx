"use client";

// components/features/agent/StocksAgentHero.tsx
//
// The Home MPGR AGENT hero — deliberately sparse: the name and its
// honest runtime status, nothing else. The supporting description
// (what the agent covers + "Agent prepares the transaction. You sign.")
// and the non-US disclaimer live in the lower contextual area on Home
// (HomeInfoSection), so the top of the screen stays spacious and
// focused. Status badges stay (online/thinking) because they are
// honest runtime state, not marketing. The name is always MPGR AGENT
// (MPGR_AGENT_TITLE).

import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";
import { MPGR_AGENT_TITLE } from "@/lib/agent-stocks-config";

interface StocksAgentHeroProps {
  statuses: AgentStatusId[];
}

export function StocksAgentHero({ statuses }: StocksAgentHeroProps) {
  return (
    <div className="relative px-1 pb-4 pt-6 md:pb-6 md:pt-10" data-testid="stocks-agent-hero">
      {/* Ambient light behind the hero — depth without noise. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 left-1/2 h-64 w-[min(560px,90vw)] -translate-x-1/2 rounded-full bg-primary/[0.07] blur-3xl"
      />
      <div className="relative flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <h1 className="text-[28px] font-semibold leading-9 tracking-[-0.03em] text-white md:text-[40px] md:leading-[48px]">
          {MPGR_AGENT_TITLE}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {statuses.map((status) => (
            <AgentStatusBadge key={status} status={status} />
          ))}
        </div>
      </div>
    </div>
  );
}
