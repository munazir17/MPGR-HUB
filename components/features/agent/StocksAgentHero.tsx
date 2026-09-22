"use client";

// components/features/agent/StocksAgentHero.tsx
//
// The MPGR AGENT identity row, folded INTO the Agent stage's top bar
// (it used to be a separate block floating above the chat card, which
// is exactly why the agent read like a footnote). It is now the left
// side of the stage's 48/56px top bar:
//
//   [core jewel · once a thread exists]  MPGR AGENT  ● Online|Thinking
//
// The name is always MPGR AGENT (MPGR_AGENT_TITLE) — unchanged copy.
// Status badges stay (online/thinking) because they are honest runtime
// state, not marketing. When a conversation exists the hero also mounts
// the 28px AgentCore jewel — the big empty-state core "shrinks" into
// the top bar for the duration of the thread.

import { AgentCore } from "./AgentCore";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";
import { MPGR_AGENT_TITLE } from "@/lib/agent-stocks-config";

interface StocksAgentHeroProps {
  statuses: AgentStatusId[];
  /** True once a thread exists — the AgentCore shrinks to a top-bar jewel. */
  thread?: boolean;
}

export function StocksAgentHero({ statuses, thread = false }: StocksAgentHeroProps) {
  const thinking = statuses.includes("thinking");

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-x-3 gap-y-1"
      data-testid="stocks-agent-hero"
    >
      {thread && <AgentCore variant="jewel" state={thinking ? "thinking" : "idle"} />}
      <h1 className="display-xl truncate text-[22px] text-white md:text-[24px] lg:text-[30px]">
        {MPGR_AGENT_TITLE}
      </h1>
      <div className="flex flex-wrap items-center gap-1.5">
        {statuses.map((status) => (
          <AgentStatusBadge key={status} status={status} />
        ))}
      </div>
    </div>
  );
}
