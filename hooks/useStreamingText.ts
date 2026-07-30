"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_CHARS_PER_TICK = 3;
const DEFAULT_TICK_MS = 16;

// Phase 3A.6 — Streaming Responses.
//
// There is no model/network call to stream from today (see
// lib/agent-intelligence.ts's own header: reply generation is
// deterministic and local until the Phase 3B model swap). This hook does
// NOT fake a network stream — it reveals an already-fully-generated
// reply progressively on the client, which is an honest UI affordance
// (matches the "typing" feel users expect from chat) rather than a
// simulated backend behavior. When Phase 3B introduces a real streaming
// model call, this hook's `fullText` input simply starts arriving
// incrementally instead of all at once — its external shape doesn't
// need to change.
export function useStreamingText(fullText: string, active: boolean) {
  const [revealed, setRevealed] = useState(active ? "" : fullText);
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setRevealed(fullText);
      return;
    }
    indexRef.current = 0;
    setRevealed("");
    const interval = setInterval(() => {
      indexRef.current = Math.min(indexRef.current + DEFAULT_CHARS_PER_TICK, fullText.length);
      setRevealed(fullText.slice(0, indexRef.current));
      if (indexRef.current >= fullText.length) clearInterval(interval);
    }, DEFAULT_TICK_MS);
    return () => clearInterval(interval);
    // Deliberately keyed on fullText + active only — a new reply (new
    // fullText) always restarts the reveal; toggling active off snaps to
    // the complete text immediately (handled by the branch above).
  }, [fullText, active]);

  const done = revealed.length >= fullText.length;
  return { text: revealed, done };
}
