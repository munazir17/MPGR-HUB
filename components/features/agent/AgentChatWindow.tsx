"use client";

import { useEffect, useRef } from "react";
import { AgentChatBubble } from "./AgentChatBubble";
import { AgentFollowUpChips } from "./AgentFollowUpChips";
import { AgentDateSeparator, getMessageDayKey } from "./AgentDateSeparator";
import { AgentTypingIndicator } from "./AgentTypingIndicator";
import type { AgentFeedback, AgentMessage } from "@/lib/agent-engine";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TradeProposal } from "@/lib/trade/trade-types";

interface AgentChatWindowProps {
  messages: AgentMessage[];
  thinking: boolean;
  onSelectPrompt: (prompt: string) => void;
  onFeedback: (messageId: string, feedback: AgentFeedback) => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
  // Phase 3A.6 — id of the message currently being revealed via
  // useStreamingText. Optional so this component still renders correctly
  // with no streaming behavior if unset (e.g. isolated preview).
  streamingMessageId?: string | null;
  // P3 — optional, forwarded straight to AgentChatBubble. See that
  // component's own prop doc.
  onReviewX402Proposal?: (proposal: X402PaymentProposal) => void;
  onReviewTradeProposal?: (proposal: TradeProposal) => void;
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
//   differs from the previous one.
// - Forwards onFeedback/onRegenerate to each AgentChatBubble, computes
//   `showRegenerate` per-message.
//
// Phase 3A.6:
// - ThinkingBubble extracted to AgentTypingIndicator.tsx (same markup,
//   reusable) — no visual change here.
// - The message matching streamingMessageId is passed through as
//   `isStreaming` to AgentChatBubble, which owns the actual reveal via
//   useStreamingText.
export function AgentChatWindow({
  messages,
  thinking,
  onSelectPrompt,
  onFeedback,
  onRegenerate,
  canRegenerate,
  streamingMessageId,
  onReviewX402Proposal,
  onReviewTradeProposal,
}: AgentChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  const lastFollowUpIndex = thinking ? -1 : findLastFollowUpIndex(messages);
  const lastMessageIndex = messages.length - 1;

  let previousDayKey: string | null = null;

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4 md:space-y-4 md:px-6 md:py-5">
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
              isStreaming={message.id === streamingMessageId}
              onReviewX402Proposal={onReviewX402Proposal}
              onReviewTradeProposal={onReviewTradeProposal}
            />
            {i === lastFollowUpIndex && (
              <AgentFollowUpChips followUps={message.followUps!} onSelect={onSelectPrompt} disabled={thinking} />
            )}
          </div>
        );
      })}
      {thinking && <AgentTypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
