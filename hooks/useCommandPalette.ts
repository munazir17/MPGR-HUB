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
//
// Phase 3B Part 3 — Personalization. Optional `mostUsedCommandNames`
// (most-used-first, from lib/architecture/memory/memory-engine.ts's
// getPersonalizationSnapshot via hooks/useAgentChat.ts) reorders only the
// DEFAULT (empty-query) view so a returning user's frequent commands
// surface first. Any active search query is completely unaffected, and
// omitting the argument reproduces the exact previous behavior — the
// default parameter is `[]`, which is a no-op reorder.
export function useCommandPalette(mostUsedCommandNames: string[] = []) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const results = useMemo<SlashCommand[]>(() => {
    const matches = agentCommandRegistry.search(query);
    if (query.trim() || mostUsedCommandNames.length === 0) return matches;

    const rank = new Map(mostUsedCommandNames.map((name, index) => [name, index]));
    return [...matches].sort((a, b) => {
      const rankA = rank.has(a.name) ? (rank.get(a.name) as number) : Number.MAX_SAFE_INTEGER;
      const rankB = rank.has(b.name) ? (rank.get(b.name) as number) : Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
  }, [query, mostUsedCommandNames]);

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
