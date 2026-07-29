"use client";

import { formatRelativeTime } from "@/lib/format";

interface AgentDateSeparatorProps {
  iso: string;
}

// Phase 3A.4 Batch 2 — centered chat-style date divider ("Today" /
// "Yesterday" / "3 days ago" / short date). Mirrors the same day-grouping
// convention components/ui/RewardTimeline.tsx already uses (dayKey +
// formatRelativeTime from lib/format.ts) — just rendered as an inline
// divider instead of a section label, since this sits inside a scrolling
// message list rather than a grouped card list.
//
// Deliberately dumb: this component only knows how to render ONE divider
// for a given ISO timestamp. Deciding *when* a divider is needed (i.e.
// grouping AgentMessage[] by calendar day) is view logic that belongs to
// the caller (AgentChatWindow, wired in Batch 3) — not duplicated here and
// not pushed into lib/agent-engine.ts, since "which day boundary to draw"
// is a rendering concern, not conversation state.
export function AgentDateSeparator({ iso }: AgentDateSeparatorProps) {
  const label = formatRelativeTime(iso);

  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 py-1"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-white/[0.08]" />
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

// Small pure helper for Batch 3's wiring — groups messages by calendar day
// so AgentChatWindow can decide where to insert an <AgentDateSeparator />.
// Exported from here (not lib/) because "how messages are visually
// grouped" is display grouping, not persisted conversation state; it takes
// only the `timestamp` field AgentMessage already exposes and returns a
// day key, nothing storage- or provider-specific.
export function getMessageDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
