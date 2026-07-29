"use client";

import { motion } from "framer-motion";
import { Bot, User } from "lucide-react";
import { clsx } from "clsx";
import type { AgentMessage } from "@/lib/agent-engine";

interface AgentChatBubbleProps {
  message: AgentMessage;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AgentChatBubble({ message }: AgentChatBubbleProps) {
  const isUser = message.role === "user";

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

      <div className={clsx("flex max-w-[80%] flex-col gap-1", isUser ? "items-end" : "items-start")}>
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
        <span className="px-1 text-[10px] text-muted">{formatTime(message.timestamp)}</span>
      </div>
    </motion.div>
  );
}
