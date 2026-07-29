"use client";

import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { AgentPromptSuggestions } from "./AgentPromptSuggestions";

interface AgentEmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}

// Shown before the first message in a conversation. More elaborate than the
// generic components/ui/EmptyState.tsx by design — this is the flagship
// feature's welcome moment — but reuses the same glow/float/gradient
// vocabulary so it still feels native to MPGR HUB.
export function AgentEmptyState({ onSelectPrompt }: AgentEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/25 shadow-glow animate-float"
      >
        <Bot className="h-6 w-6 text-primary" aria-hidden="true" />
      </motion.div>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="text-base font-semibold text-white"
      >
        Ask the MPGR Agent anything
      </motion.p>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.14 }}
        className="mx-auto mt-2 max-w-sm text-sm text-muted"
      >
        Try one of these to get started, or type your own question below.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-6 w-full max-w-md"
      >
        <AgentPromptSuggestions onSelect={onSelectPrompt} />
      </motion.div>
    </div>
  );
}
