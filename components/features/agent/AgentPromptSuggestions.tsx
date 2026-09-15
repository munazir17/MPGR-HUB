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

export function AgentPromptSuggestions({
  onSelect,
  disabled,
  variant = "grid",
  className,
}: AgentPromptSuggestionsProps) {
  if (variant === "row") {
    return (
      <div className={clsx("flex gap-1.5 overflow-x-auto pb-1 md:gap-2", className)}>
        {AGENT_PROMPT_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(suggestion.prompt)}
            className="flex shrink-0 items-center rounded-full border border-white/[0.08] bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors duration-200 hover:border-primary/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={clsx("flex w-full max-w-md flex-col gap-2", className)}>
      {AGENT_PROMPT_SUGGESTIONS.map((suggestion, i) => (
        <motion.button
          key={suggestion.id}
          type="button"
          disabled={disabled}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.28 }}
          onClick={() => onSelect(suggestion.prompt)}
          className="min-h-[44px] rounded-full border border-white/[0.08] bg-surface px-4 py-2.5 text-left text-sm text-white/90 transition-colors hover:border-primary/30 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {suggestion.label}
        </motion.button>
      ))}
    </div>
  );
}
