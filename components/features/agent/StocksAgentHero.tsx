"use client";

// components/features/agent/StocksAgentHero.tsx
//
// The Home MPGR AGENT hero (the old /agent terminal heading): a
// trading-terminal heading, not a chatbot greeting. No "Welcome", no
// "Your AI agent is ready", no XP/OS copy — title, one-line subtitle,
// sign line, and the always-visible non-US disclaimer. Status badges
// stay (online/thinking) because they are honest runtime state, not
// marketing. The name is always MPGR AGENT (MPGR_AGENT_TITLE) — the
// stocks tooling lives inside the agent, it did not rename it.

import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";
import {
  MPGR_AGENT_TITLE,
  STOCKS_AGENT_DISCLAIMER,
  STOCKS_AGENT_SIGN_LINE,
  STOCKS_AGENT_SUBTITLE,
} from "@/lib/agent-stocks-config";

interface StocksAgentHeroProps {
  statuses: AgentStatusId[];
}

export function StocksAgentHero({ statuses }: StocksAgentHeroProps) {
  return (
    <div className="px-1 pb-1 pt-3 md:pt-4" data-testid="stocks-agent-hero">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          {MPGR_AGENT_TITLE}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {statuses.map((status) => (
            <AgentStatusBadge key={status} status={status} />
          ))}
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">
        {STOCKS_AGENT_SUBTITLE}{" "}
        <span className="font-medium text-white/80">{STOCKS_AGENT_SIGN_LINE}</span>
      </p>
      <p className="mt-2 max-w-3xl rounded-lg border border-white/[0.06] bg-surface/60 px-2.5 py-1.5 text-[10px] leading-relaxed text-muted">
        {STOCKS_AGENT_DISCLAIMER}
      </p>
    </div>
  );
}
