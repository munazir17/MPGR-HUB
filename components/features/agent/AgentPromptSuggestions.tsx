"use client";

import { motion } from "framer-motion";
import { AGENT_PROMPT_SUGGESTIONS } from "@/lib/agent-config";
import { clsx } from "clsx";

interface AgentPromptSuggestionsProps {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
  variant?: "grid" | "row";
  className?: string;
}

// Tappable prompt chips that fill and (optionally) auto-send a suggested
// question. "grid" variant is used inside the empty state; "row" variant is
// a compact horizontally-scrollable strip shown above the input once a
// conversation is underway.
export function AgentPromptSuggestions({
  onSelect,
  disabled,
  variant = "grid",
  className,
}: AgentPromptSuggestionsProps) {
  if (variant === "row") {
    return (
      <div className={clsx("flex gap-1.5 overflow-x-auto pb-1 md:gap-2", className)}>
        {AGENT_PROMPT_SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(suggestion.prompt)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted transition-colors duration-200 hover:border-primary/25 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              {suggestion.label}
            </button>
          );
        })}
      </div>
    );
  }

  // Grid variant (empty state): cards, icon, and gap all shrink below
  // md/768px so several fit without pushing the page taller — the parent
  // (AgentEmptyState) makes this list scroll internally if it still
  // overflows. Tap targets stay comfortable: each card keeps ~44px+ row
  // height via padding even at the smaller mobile sizes. Everything
  // reverts to the original desktop sizing at md and up.
  return (
    <div className={clsx("grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:gap-2.5", className)}>
      {AGENT_PROMPT_SUGGESTIONS.map((suggestion, i) => {
        const Icon = suggestion.icon;
        return (
          <motion.button
            key={suggestion.id}
            type="button"
            disabled={disabled}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.3 }}
            whileHover={{ y: -2 }}
            onClick={() => onSelect(suggestion.prompt)}
            className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-left transition-colors duration-200 hover:border-primary/25 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 md:gap-2.5 md:p-3"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/20 md:h-9 md:w-9">
              <Icon className="h-3.5 w-3.5 text-primary md:h-4 md:w-4" aria-hidden="true" />
            </span>
            <span className="text-xs font-medium text-white sm:text-sm">{suggestion.label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}
