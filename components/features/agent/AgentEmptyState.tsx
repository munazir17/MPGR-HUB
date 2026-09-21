"use client";

import { AgentPromptSuggestions } from "./AgentPromptSuggestions";

interface AgentEmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}

export function AgentEmptyState({ onSelectPrompt }: AgentEmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-1 py-6">
      <AgentPromptSuggestions onSelect={onSelectPrompt} />
    </div>
  );
}
