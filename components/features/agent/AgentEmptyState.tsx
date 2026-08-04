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
//
// Mobile UX polish (below md/768px only): icon/heading/description and
// vertical padding are all scaled down (~50% less padding) so this state
// fits inside the compact Conversation card without pushing the input off
// screen. The intro (icon + heading + description) stays pinned at
// shrink-0 size; only the suggestions list below it scrolls internally
// (min-h-0 + overflow-y-auto) if it doesn't fully fit, so a long list of
// suggestions never grows the page itself. Nothing changes at md and up.
export function AgentEmptyState({ onSelectPrompt }: AgentEmptyStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-start px-4 py-5 text-center sm:px-8 md:justify-center md:py-10">
      <div className="shrink-0">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/25 shadow-glow animate-float md:mb-4 md:h-14 md:w-14"
        >
          <Bot className="h-4 w-4 text-primary md:h-6 md:w-6" aria-hidden="true" />
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="text-xs font-semibold text-white md:text-base"
        >
          Ask the MPGR Agent anything
        </motion.p>

        {/* Shorter copy on mobile to save vertical space; original wording preserved at md+. */}
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="mx-auto mt-0.5 block max-w-xs text-[11px] text-muted md:hidden"
        >
          Tap a suggestion or type below.
        </motion.p>
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="mx-auto mt-2 hidden max-w-sm text-sm text-muted md:block"
        >
          Try one of these to get started, or type your own question below.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-2 min-h-0 w-full max-w-md flex-1 overflow-y-auto md:mt-6 md:flex-none md:overflow-visible"
      >
        <AgentPromptSuggestions onSelect={onSelectPrompt} />
      </motion.div>
    </div>
  );
}
