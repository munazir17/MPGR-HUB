"use client";

import { motion } from "framer-motion";
import { Bot } from "lucide-react";

// Phase 3A.6 — Typing Indicator, extracted from AgentChatWindow.tsx's
// former inline ThinkingBubble (same markup/animation, zero visual
// change) so it can also be reused wherever else a "typing" state needs
// showing, without duplicating the animation definition.
export function AgentTypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-end gap-2"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold ring-1 ring-white/10">
        <Bot className="h-3.5 w-3.5 text-white" aria-hidden="true" />
      </span>
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
