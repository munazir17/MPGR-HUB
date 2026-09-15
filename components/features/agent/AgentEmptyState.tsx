"use client";

import { AgentPromptSuggestions } from "./AgentPromptSuggestions";

interface AgentEmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}

export function AgentEmptyState({ onSelectPrompt }: AgentEmptyStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-1 pb-2">
      <AgentPromptSuggestions onSelect={onSelectPrompt} />
    </div>
  );
}
