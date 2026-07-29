"use client";

import { clsx } from "clsx";
import { Skeleton } from "@/components/ui/Skeleton";

// Phase 3A.4 — shown in place of the old plain-text "Loading
// conversation..." message while hooks/useAgentChat.ts's `hasLoaded` gate
// is reading the wallet's persisted history from storage. Built from the
// same Skeleton primitive the rest of the app already uses
// (components/ui/Skeleton.tsx / SkeletonCard.tsx), shaped to roughly match
// real chat bubbles so there's no layout jump when the actual conversation
// mounts a moment later.
export function AgentChatSkeleton() {
  const rows = [
    { align: "start" as const, width: "w-2/3" },
    { align: "end" as const, width: "w-1/2" },
    { align: "start" as const, width: "w-3/4" },
    { align: "start" as const, width: "w-1/3" },
  ];

  return (
    <div className="flex-1 space-y-4 overflow-hidden px-4 py-5 sm:px-6" aria-hidden="true">
      {rows.map((row, i) => (
        <div key={i} className={clsx("flex items-end gap-2", row.align === "end" && "flex-row-reverse")}>
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <Skeleton className={clsx("h-10 rounded-2xl", row.width)} />
        </div>
      ))}
    </div>
  );
}
