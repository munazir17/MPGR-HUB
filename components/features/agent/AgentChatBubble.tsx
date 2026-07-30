"use client";

import { motion } from "framer-motion";
import { Bot, User } from "lucide-react";
import { clsx } from "clsx";
import { AgentHighlightChips } from "./AgentHighlightChips";
import { AgentActionCard } from "./AgentActionCard";
import { AgentMessageToolbar } from "./AgentMessageToolbar";
import { useStreamingText } from "@/hooks/useStreamingText";
import type { AgentFeedback, AgentMessage } from "@/lib/agent-engine";

interface AgentChatBubbleProps {
  message: AgentMessage;
  onFeedback?: (messageId: string, feedback: AgentFeedback) => void;
  onRegenerate?: () => void;
  showRegenerate?: boolean;
  disabled?: boolean;
  // Phase 3A.6 — optional; only the freshest assistant message is ever
  // marked streaming (see AgentChatWindow's streamingMessageId).
  isStreaming?: boolean;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Phase 3A.3: highlights/actions rendering unchanged.
//
// Phase 3A.4 Batch 3: assistant bubbles now render AgentMessageToolbar
// (copy / feedback / regenerate) next to the timestamp.
//
// Phase 3A.6: assistant messages reveal via useStreamingText when
// isStreaming is true (freshest message only — see AgentChatWindow).
// Highlights/actions/toolbar only appear once the reveal finishes
// (`streamDone`), so action cards don't pop in mid-sentence.
export function AgentChatBubble({
  message,
  onFeedback,
  onRegenerate,
  showRegenerate,
  disabled,
  isStreaming,
}: AgentChatBubbleProps) {
  const isUser = message.role === "user";
  const { text: streamedContent, done: streamDone } = useStreamingText(message.content, !isUser && !!isStreaming);
  const displayContent = !isUser && isStreaming ? streamedContent : message.content;
  const revealComplete = isUser || !isStreaming || streamDone;

  const hasHighlights = !isUser && revealComplete && !!message.highlights && message.highlights.length > 0;
  const hasActions = !isUser && revealComplete && !!message.actions && message.actions.length > 0;

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
          {displayContent}
        </div>

        {hasActions && (
          <div className="flex w-full flex-col gap-1.5 pt-0.5">
            {message.actions!.map((action) => (
              <AgentActionCard key={action.id} action={action} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-1 px-1">
          <span className="text-[10px] text-muted">{formatTime(message.timestamp)}</span>
          {!isUser && onFeedback && revealComplete && (
            <AgentMessageToolbar
              content={message.content}
              feedback={message.feedback}
              onFeedback={(feedback) => onFeedback(message.id, feedback)}
              showRegenerate={showRegenerate}
              onRegenerate={onRegenerate}
              disabled={disabled}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}
