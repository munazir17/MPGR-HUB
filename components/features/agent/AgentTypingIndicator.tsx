"use client";

import { motion } from "framer-motion";

import { AgentCore } from "./AgentCore";

// Phase 3A.6 — Typing Indicator, extracted from AgentChatWindow.tsx's
// former inline ThinkingBubble. The agent's avatar is now the AgentCore
// jewel (the same 28px object the hero shrinks to) so the "thinking"
// identity is carried by the product's own object, not a second mascot.
export function AgentTypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-end gap-2"
    >
      <AgentCore variant="jewel" state="thinking" className="mb-0.5" />
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-white/[0.08] bg-white/[0.04] px-4 py-3 backdrop-blur-xl">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-primary-glow"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          />
        ))}
      </div>
    </motion.div>
  );
}
