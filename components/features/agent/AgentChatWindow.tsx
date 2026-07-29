"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { AgentChatBubble } from "./AgentChatBubble";
import type { AgentMessage } from "@/lib/agent-engine";

interface AgentChatWindowProps {
  messages: AgentMessage[];
  thinking: boolean;
}

function ThinkingBubble() {
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

// Auto-scrolling message list. Kept dumb/presentational — all persistence
// and reply generation lives in hooks/useAgentChat.ts + lib/agent-engine.ts.
export function AgentChatWindow({ messages, thinking }: AgentChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
      {messages.map((message) => (
        <AgentChatBubble key={message.id} message={message} />
      ))}
      {thinking && <ThinkingBubble />}
      <div ref={bottomRef} />
    </div>
  );
}
