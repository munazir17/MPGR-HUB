"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

interface AgentFollowUpChipsProps {
  followUps: string[];
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}

// Context-aware follow-up suggestions shown under the most recent assistant
// reply — distinct from components/features/agent/AgentPromptSuggestions.tsx
// (which is a static, topic-agnostic list). These come from
// lib/agent-actions.ts's getFollowUpPrompts(intent), so they change based
// on what was just discussed, nudging the conversation forward instead of
// back to the same six generic starters every time.
export function AgentFollowUpChips({ followUps, onSelect, disabled }: AgentFollowUpChipsProps) {
  if (followUps.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-9">
      <Sparkles className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
      {followUps.map((prompt, i) => (
        <motion.button
          key={prompt}
          type="button"
          disabled={disabled}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.2 }}
          onClick={() => onSelect(prompt)}
          className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-muted transition-colors duration-200 hover:border-primary/25 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {prompt}
        </motion.button>
      ))}
    </div>
  );
}
