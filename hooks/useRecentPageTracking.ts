"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { agentAIService } from "@/lib/architecture/ai/agent-ai-service-instance";
import { recordPageView } from "@/lib/architecture/memory/memory-engine";

// Phase 3B Part 3 — Personalization: "recent pages visited".
//
// Records through agentAIService.enqueueBackgroundTask() — the same
// TaskQueue every other Memory Engine write already goes through —
// rather than importing agentTaskQueue directly, keeping AgentAIService
// the single composition root for background work (see
// lib/architecture/ai/agent-ai-service-instance.ts).
//
// A ref (not state) dedupes repeated effect runs for the same
// address+path pair (e.g. React StrictMode's double-invoke in dev)
// without introducing a second render.
export function useRecentPageTracking(): void {
  const { address, isConnected } = useAccount();
  const pathname = usePathname();
  const lastRecordedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || !address || !pathname) return;

    const key = `${address.toLowerCase()}:${pathname}`;
    if (lastRecordedRef.current === key) return;
    lastRecordedRef.current = key;

    agentAIService.enqueueBackgroundTask("memory.recordPageView", () => recordPageView(address, pathname));
  }, [address, isConnected, pathname]);
}
