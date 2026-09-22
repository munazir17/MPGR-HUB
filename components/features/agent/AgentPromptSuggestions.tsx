"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { AGENT_PROMPT_SUGGESTIONS } from "@/lib/agent-config";
import { clsx } from "clsx";

export interface AgentPromptSuggestionItem {
  id: string;
  label: string;
  prompt: string;
  /**
   * Optional click-time prompt builder (browser only). Used when the
   * prompt needs runtime context — e.g. the absolute https URL of this
   * deployment, which x402 discovery/prepare requires.
   */
  buildPrompt?: (origin: string) => string;
}

interface AgentPromptSuggestionsProps {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
  variant?: "grid" | "row";
  className?: string;
  /** Overrides the default MPGR suggestions (used by Home's MPGR AGENT stocks chips). */
  items?: readonly AgentPromptSuggestionItem[];
}

export function AgentPromptSuggestions({
  onSelect,
  disabled,
  variant = "grid",
  className,
  items,
}: AgentPromptSuggestionsProps) {
  const suggestions: readonly AgentPromptSuggestionItem[] = items ?? AGENT_PROMPT_SUGGESTIONS;
  if (variant === "row") {
    return (
      <div className={clsx("flex gap-1.5 overflow-x-auto pb-1 md:gap-2", className)}>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(suggestion.buildPrompt?.(window.location.origin) ?? suggestion.prompt)}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-xs font-medium text-white/70 transition-colors duration-200 hover:border-white/[0.18] hover:bg-white/[0.06] hover:text-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={clsx("flex w-full max-w-md flex-col gap-2", className)}>
      {suggestions.map((suggestion, i) => (
        <motion.button
          key={suggestion.id}
          type="button"
          disabled={disabled}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.28 }}
          onClick={() => onSelect(suggestion.buildPrompt?.(window.location.origin) ?? suggestion.prompt)}
          className="flex min-h-[44px] cursor-pointer items-center justify-between rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-left text-sm text-white/90 transition-colors hover:border-white/[0.18] hover:bg-white/[0.06] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span>{suggestion.label}</span>
          <ChevronRight className="h-3.5 w-3.5 text-primary" aria-hidden />
        </motion.button>
      ))}
    </div>
  );
}
