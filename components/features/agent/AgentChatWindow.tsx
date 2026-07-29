"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { AgentChatBubble } from "./AgentChatBubble";
import { AgentFollowUpChips } from "./AgentFollowUpChips";
import { AgentDateSeparator, getMessageDayKey } from "./AgentDateSeparator";
import type { AgentFeedback, AgentMessage } from "@/lib/agent-engine";

interface AgentChatWindowProps {
  messages: AgentMessage[];
  thinking: boolean;
  onSelectPrompt: (prompt: string) => void;
  onFeedback: (messageId: string, feedback: AgentFeedback) => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
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

// Finds the last assistant message that actually has follow-up prompts to
// offer — unchanged from 3A.3.
function findLastFollowUpIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.followUps && message.followUps.length > 0) return i;
  }
  return -1;
}

// Auto-scrolling message list. Persistence and reply generation still live
// entirely in hooks/useAgentChat.ts + lib/agent-engine.ts — this component
// only decides what to render and forwards callbacks.
//
// Phase 3A.4 Batch 3:
// - Inserts an <AgentDateSeparator> whenever a message's calendar day
//   differs from the previous one (via AgentDateSeparator.tsx's
//   getMessageDayKey), so a multi-day conversation reads like a normal
//   chat history instead of one undifferentiated scroll.
// - Forwards onFeedback/onRegenerate to each AgentChatBubble, and computes
//   `showRegenerate` per-message (true only for the actual last message,
//   and only when the hook says regeneration is currently valid) rather
//   than trusting each bubble to know its own position in the list.
export function AgentChatWindow({
  messages,
  thinking,
  onSelectPrompt,
  onFeedback,
  onRegenerate,
  canRegenerate,
}: AgentChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  const lastFollowUpIndex = thinking ? -1 : findLastFollowUpIndex(messages);
  const lastMessageIndex = messages.length - 1;

  let previousDayKey: string | null = null;

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
      {messages.map((message, i) => {
        const dayKey = getMessageDayKey(message.timestamp);
        const showSeparator = dayKey !== previousDayKey;
        previousDayKey = dayKey;
        const isLastAssistant = i === lastMessageIndex && message.role === "assistant";

        return (
          <div key={message.id} className="space-y-2">
            {showSeparator && <AgentDateSeparator iso={message.timestamp} />}
            <AgentChatBubble
              message={message}
              onFeedback={onFeedback}
              onRegenerate={onRegenerate}
              showRegenerate={isLastAssistant && canRegenerate}
              disabled={thinking}
            />
            {i === lastFollowUpIndex && (
              <AgentFollowUpChips followUps={message.followUps!} onSelect={onSelectPrompt} disabled={thinking} />
            )}
          </div>
        );
      })}
      {thinking && <ThinkingBubble />}
      <div ref={bottomRef} />
    </div>
  );
}
