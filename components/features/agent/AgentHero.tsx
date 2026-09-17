"use client";

import { useEffect, useState } from "react";
import { AgentOrb } from "./AgentOrb";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";
import { formatAgentUserCount } from "@/lib/agent/format-agent-user-count";
import { useAgentVisitorCount } from "@/hooks/useAgentVisitorCount";

interface AgentHeroProps {
  statuses: AgentStatusId[];
  compact?: boolean;
}

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function AgentUserCount({ count, align }: { count: number | null; align: "center" | "end" }) {
  if (count === null) return null;
  return (
    <p
      className={
        align === "end"
          ? "text-right text-[10px] font-medium tabular-nums tracking-wide text-muted"
          : "text-[11px] font-medium tabular-nums tracking-wide text-muted"
      }
    >
      {formatAgentUserCount(count)} Users
    </p>
  );
}

export function AgentHero({ statuses, compact }: AgentHeroProps) {
  const [greeting, setGreeting] = useState("Welcome");
  const thinking = statuses.includes("thinking");
  const userCount = useAgentVisitorCount();

  useEffect(() => {
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-surface px-3 py-2.5">
        <AgentOrb size="sm" thinking={thinking} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">MPGR Agent</p>
          <p className="text-[11px] text-muted">Your AI command center</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1.5">
            {statuses.map((status) => (
              <AgentStatusBadge key={status} status={status} />
            ))}
          </div>
          <AgentUserCount count={userCount} align="end" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center px-2 pb-1 pt-3 text-center md:pt-6">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        MPGR Agent
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
        {greeting}
      </h1>
      <p className="mt-1.5 text-sm text-muted">Your AI agent is ready.</p>
      <div className="mt-5">
        <AgentOrb thinking={thinking} />
      </div>
      <div className="mt-4 flex flex-col items-center gap-1">
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {statuses.map((status) => (
            <AgentStatusBadge key={status} status={status} />
          ))}
        </div>
        <AgentUserCount count={userCount} align="center" />
      </div>
    </div>
  );
}
