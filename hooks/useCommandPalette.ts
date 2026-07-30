"use client";

import { useMemo, useState } from "react";
import { agentCommandRegistry } from "@/lib/agent-commands/command-registry";
import type { SlashCommand } from "@/lib/agent-commands/types";

// Phase 3A.6 — Command Palette state.
//
// Pure UI state (open/query/highlighted index) — reads the shared
// agentCommandRegistry singleton but never mutates it. Kept as its own
// hook (rather than folded into useAgentChat.ts) so the palette's
// open/filter/keyboard-nav concerns don't bloat the chat hook's already
// substantial surface area.
export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const results = useMemo<SlashCommand[]>(() => agentCommandRegistry.search(query), [query]);

  const open = (initialQuery = "") => {
    setQuery(initialQuery);
    setHighlightedIndex(0);
    setIsOpen(true);
  };

  const close = () => {
    setIsOpen(false);
    setQuery("");
    setHighlightedIndex(0);
  };

  const moveHighlight = (delta: number) => {
    if (results.length === 0) return;
    setHighlightedIndex((prev) => (prev + delta + results.length) % results.length);
  };

  const highlighted = results[highlightedIndex] ?? null;

  return { isOpen, query, setQuery, results, highlightedIndex, highlighted, open, close, moveHighlight };
}
