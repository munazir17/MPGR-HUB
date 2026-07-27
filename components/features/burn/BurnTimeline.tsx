"use client";

import { useState } from "react";
import { BurnHistoryItem } from "@/components/features/burn/BurnHistoryItem";
import { formatRelativeTime } from "@/lib/format";
import type { BurnTransaction } from "@/lib/burn-types";

interface BurnTimelineProps {
  transactions: BurnTransaction[];
  pageSize?: number;
}

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

// Same day-grouped structure as RewardTimeline, with a "Load more" cursor
// (visibleCount) so it's ready to become true infinite-scroll later —
// swap the button's onClick for an IntersectionObserver trigger, nothing
// else about the grouping logic needs to change.
export function BurnTimeline({ transactions, pageSize = 12 }: BurnTimelineProps) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const entries = transactions.slice(0, visibleCount);
  const hasMore = transactions.length > visibleCount;

  const groups: { key: string; label: string; entries: BurnTransaction[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, label: formatRelativeTime(entry.timestamp), entries: [entry] });
    }
  }

  let renderedIndex = 0;

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.key}>
          <p className="mb-2 pl-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {group.label}
          </p>
          <div className="relative space-y-2 pl-4">
            <div
              aria-hidden="true"
              className="absolute bottom-1 left-[7px] top-1 w-px bg-gradient-to-b from-white/15 via-white/10 to-transparent"
            />
            {group.entries.map((entry) => {
              const delay = Math.min(renderedIndex, 10) * 0.03;
              renderedIndex += 1;
              return <BurnHistoryItem key={entry.id} transaction={entry} delay={delay} />;
            })}
          </div>
        </div>
      ))}

      {hasMore && (
        <button
          onClick={() => setVisibleCount((c) => c + pageSize)}
          className="mx-auto flex min-h-[44px] items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-5 text-xs font-semibold text-muted transition-colors hover:text-white"
        >
          Load more
        </button>
      )}
    </div>
  );
}
