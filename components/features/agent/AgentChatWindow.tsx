"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { AgentChatBubble } from "./AgentChatBubble";
import { AgentFollowUpChips } from "./AgentFollowUpChips";
import type { AgentMessage } from "@/lib/agent-engine";

interface AgentChatWindowProps {
  messages: AgentMessage[];
  thinking: boolean;
  onSelectPrompt: (prompt: string) => void;
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
// offer. Follow-ups are only ever shown for this one message — never for
// every assistant turn in the history, and never while a new reply is
// being generated (see the `!thinking` check below) so they don't sit
// underneath a stale reply the person has already moved past.
function findLastFollowUpIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.followUps && message.followUps.length > 0) return i;
  }
  return -1;
}

// Auto-scrolling message list. Kept dumb/presentational — all persistence
// and reply generation lives in hooks/useAgentChat.ts + lib/agent-engine.ts.
//
// Phase 3A.3: now also renders AgentFollowUpChips under the latest
// assistant reply, wired straight to the same onSelectPrompt (= sendMessage
// from hooks/useAgentChat.ts) that AgentInput and AgentPromptSuggestions
// already use — tapping a follow-up behaves identically to typing it.
export function AgentChatWindow({ messages, thinking, onSelectPrompt }: AgentChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  const lastFollowUpIndex = thinking ? -1 : findLastFollowUpIndex(messages);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
      {messages.map((message, i) => (
        <div key={message.id} className="space-y-2">
          <AgentChatBubble message={message} />
          {i === lastFollowUpIndex && (
            <AgentFollowUpChips followUps={message.followUps!} onSelect={onSelectPrompt} disabled={thinking} />
          )}
        </div>
      ))}
      {thinking && <ThinkingBubble />}
      <div ref={bottomRef} />
    </div>
  );
}
