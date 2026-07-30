"use client";

import { motion, AnimatePresence } from "framer-motion";
import { AGENT_COMMAND_ICON_MAP } from "./agent-command-icon-map";
import type { SlashCommand } from "@/lib/agent-commands/types";

interface AgentCommandPaletteProps {
  isOpen: boolean;
  results: SlashCommand[];
  highlightedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

// Phase 3A.6 — Command Palette UI. Anchored above AgentInput
// (app/agent/page.tsx positions it), styled to match the existing
// GlassCard/backdrop-blur language used throughout components/features/agent/*.
export function AgentCommandPalette({ isOpen, results, highlightedIndex, onSelect }: AgentCommandPaletteProps) {
  return (
    <AnimatePresence>
      {isOpen && results.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
          className="mx-3 mb-1 max-h-56 overflow-y-auto rounded-xl border border-white/[0.08] bg-background/95 p-1.5 backdrop-blur-xl sm:mx-4"
          role="listbox"
        >
          {results.map((command, i) => {
            const Icon = AGENT_COMMAND_ICON_MAP[command.icon];
            const isHighlighted = i === highlightedIndex;
            return (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                onClick={() => onSelect(command)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
                  isHighlighted ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
                  <Icon className="h-3.5 w-3.5 text-primary-glow" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium text-white">{command.usage}</span>
                  <span className="truncate text-[11px] text-muted">{command.description}</span>
                </span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
