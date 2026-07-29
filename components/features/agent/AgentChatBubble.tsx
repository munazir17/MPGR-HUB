"use client";

import { motion } from "framer-motion";
import { Bot, User } from "lucide-react";
import { clsx } from "clsx";
import { AgentHighlightChips } from "./AgentHighlightChips";
import { AgentActionCard } from "./AgentActionCard";
import type { AgentMessage } from "@/lib/agent-engine";

interface AgentChatBubbleProps {
  message: AgentMessage;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Phase 3A.3: assistant messages can now carry `highlights` (key-stat
// chips, shown above the bubble) and `actions` (smart action cards, shown
// below it). Both are optional and independently omitted when empty
// (lib/agent-engine.ts's createMessage never stores an empty array), so a
// plain-text reply like a greeting renders exactly as it did in 3A.2 with
// no extra spacing.
export function AgentChatBubble({ message }: AgentChatBubbleProps) {
  const isUser = message.role === "user";
  const hasHighlights = !isUser && !!message.highlights && message.highlights.length > 0;
  const hasActions = !isUser && !!message.actions && message.actions.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={clsx("flex items-end gap-2", isUser ? "flex-row-reverse" : "flex-row")}
    >
      <span
        className={clsx(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1",
          isUser
            ? "bg-white/[0.06] ring-white/10"
            : "bg-gradient-premium shadow-glow-gold ring-white/10"
        )}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-white" aria-hidden="true" />
        )}
      </span>

      <div className={clsx("flex max-w-[80%] flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
        {hasHighlights && <AgentHighlightChips highlights={message.highlights!} />}

        <div
          className={clsx(
            "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
            isUser
              ? "rounded-br-sm bg-gradient-premium text-white shadow-glow-gold"
              : "rounded-bl-sm border border-white/[0.08] bg-white/[0.04] text-white backdrop-blur-xl"
          )}
        >
          {message.content}
        </div>

        {hasActions && (
          <div className="flex w-full flex-col gap-1.5 pt-0.5">
            {message.actions!.map((action) => (
              <AgentActionCard key={action.id} action={action} />
            ))}
          </div>
        )}

        <span className="px-1 text-[10px] text-muted">{formatTime(message.timestamp)}</span>
      </div>
    </motion.div>
  );
}
