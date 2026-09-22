"use client";

// components/features/agent/AgentExperience.tsx
//
// The ONE canonical MPGR AGENT chat. This is the only chat
// implementation in the app — there is no second/legacy conversation
// component rendering alongside it.
//
// Structure (always exactly one of each):
//
//   hero (MPGR AGENT heading + status + disclaimer)
//   ONE chat surface card:
//     - "Conversation" header + Clear (when a conversation exists)
//     - the message thread (content-driven height, capped + scrolling)
//     - the composer strip: suggested prompt chips + "Ask anything..."
//       input — inside the same card, so chips, messages and composer
//       read as one interface
//
// The legacy disconnected-state UI (capabilities card with its own
// prompt-chip rows, quick-action grid, market ticker) was removed —
// the disconnected state is the same chat surface with a compact
// connect-wallet empty state and a locked composer.

import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { AgentChatWindow } from "@/components/features/agent/AgentChatWindow";
import { AgentInput } from "@/components/features/agent/AgentInput";
import {
  AgentPromptSuggestions,
  type AgentPromptSuggestionItem,
} from "@/components/features/agent/AgentPromptSuggestions";
import { AgentErrorBanner } from "@/components/features/agent/AgentErrorBanner";
import { AgentErrorBoundary } from "@/components/features/agent/AgentErrorBoundary";
import { AgentX402PaymentModal } from "@/components/features/agent/AgentX402PaymentModal";
import { AgentTradeConfirmationModal } from "@/components/features/agent/AgentTradeConfirmationModal";
import { AgentTransferConfirmationModal } from "@/components/features/agent/AgentTransferConfirmationModal";
import { useEffect, useRef, type ReactNode } from "react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useX402Payment } from "@/hooks/useX402Payment";
import { useTradeQuote } from "@/hooks/useTradeQuote";
import { useTransferQuote } from "@/hooks/useTransferQuote";
import type { AgentStatusId } from "@/lib/agent-config";

export interface AgentExperienceProps {
  /** The MPGR AGENT hero (heading/status/disclaimer). */
  heroSlot: (statuses: AgentStatusId[]) => ReactNode;
  /**
   * The ONE canonical suggested-prompt set, rendered inside the
   * composer strip. Empty array hides the chips.
   */
  suggestions: readonly AgentPromptSuggestionItem[];
  /** Copy shown in the chat body before the first message. */
  emptyStateText: string;
  /** Called with sendMessage once the chat controller is mounted (Home wires the tape's "Prepare swap" through it). */
  onReady?: (api: { sendMessage: (prompt: string) => void }) => void;
}

export function AgentExperience({
  heroSlot,
  suggestions,
  emptyStateText,
  onReady,
}: AgentExperienceProps) {
  const {
    messages,
    thinking,
    isConnected,
    hasLoaded,
    error,
    canRegenerate,
    sendMessage,
    clearChat,
    retryLastMessage,
    regenerateLastMessage,
    sendFeedback,
    dismissError,
    commandPalette,
    selectPaletteCommand,
    streamingMessageId,
    appendTradeExecutionResult,
    appendTransferExecutionResult,
    stopGeneration,
  } = useAgentChat();

  const x402Payment = useX402Payment();
  const tradeQuote = useTradeQuote(appendTradeExecutionResult);
  const transferQuote = useTransferQuote(appendTransferExecutionResult);

  const heroStatuses: AgentStatusId[] = thinking ? ["thinking"] : ["online"];
  const hasMessages = messages.length > 0;

  // ONE chip set, inside the composer strip. Hidden while the wallet is
  // disconnected (sendMessage is a no-op without an address) and while
  // the conversation is still loading.
  const composerChips =
    isConnected && hasLoaded && suggestions.length > 0 ? (
      <AgentPromptSuggestions
        variant="row"
        items={suggestions}
        onSelect={sendMessage}
        disabled={thinking}
        className="flex-wrap overflow-visible pb-0"
      />
    ) : null;

  // Home wires the tape's "Prepare swap" action into the chat through
  // this callback. The ref keeps re-renders from re-firing it when
  // onReady isn't memoized.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current?.({ sendMessage });
  }, [sendMessage]);

  return (
    <>
      <main className="mx-auto w-full flex-col px-3 pb-2 pt-1 md:max-w-3xl md:px-4 md:py-8 lg:max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col"
        >
          <div className="shrink-0">{heroSlot(heroStatuses)}</div>

          <AgentErrorBoundary>
            {/* ONE chat surface: header + thread + composer in a single
                card, so the conversation, chips and "Ask anything..."
                input are visually one interface. */}
            <div
              className="overflow-hidden rounded-2xl border border-white/[0.07] bg-surface"
              data-testid="agent-chat-surface"
            >
              {hasMessages && (
                <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
                  <p className="text-sm font-semibold text-white">Conversation</p>
                  <button
                    type="button"
                    onClick={clearChat}
                    disabled={thinking}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Clear
                  </button>
                </div>
              )}

              {/* Empty-state sizing contract (DOM chain audited): NO
                  min-height/height/flex-1/grow anywhere between <body> and
                  the composer — the whole chain is natural block/flex-auto
                  flow. The empty state is a plain text block with small
                  padding (py-4) and NO items/justify-center, so it occupies
                  only its text height and the chips + composer follow
                  immediately. Active threads stay content-driven
                  (AgentChatWindow keeps only the max-h caps + scrolling). */}
              {!isConnected ? (
                <div className="px-4 py-4 text-center sm:px-6">
                  <p className="text-sm font-semibold text-white">
                    Connect a wallet to chat with MPGR Agent
                  </p>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">
                    The agent researches Coinbase wrapped assets and tokenized
                    stocks, and prepares on-chain actions for review — nothing
                    is signed without your confirmation.
                  </p>
                </div>
              ) : !hasLoaded ? (
                <div className="px-4 py-4 text-center sm:px-6">
                  <p className="text-sm text-muted">Loading conversation...</p>
                </div>
              ) : hasMessages ? (
                <AgentChatWindow
                  messages={messages}
                  thinking={thinking}
                  onSelectPrompt={sendMessage}
                  onFeedback={sendFeedback}
                  onRegenerate={regenerateLastMessage}
                  canRegenerate={canRegenerate}
                  streamingMessageId={streamingMessageId}
                  onReviewX402Proposal={x402Payment.openProposal}
                  onReviewTradeProposal={tradeQuote.openProposal}
                  onReviewTransferProposal={transferQuote.openProposal}
                />
              ) : (
                <div className="px-4 py-4 text-center sm:px-6">
                  <p className="text-sm text-muted">{emptyStateText}</p>
                </div>
              )}

              <AnimatePresence>
                {error && (
                  <AgentErrorBanner
                    message={error}
                    lastUserMessage={[...messages].reverse().find((item) => item.role === "user")?.content}
                    onRetry={retryLastMessage}
                    onDismiss={dismissError}
                  />
                )}
              </AnimatePresence>

              <div className="border-t border-white/[0.06] bg-background/40 p-2 sm:p-2.5">
                <AgentInput
                  onSend={sendMessage}
                  disabled={thinking}
                  locked={!isConnected || !hasLoaded}
                  placeholder={isConnected ? "Ask anything..." : "Connect a wallet to chat..."}
                  onStop={stopGeneration}
                  commandPalette={commandPalette}
                  onSelectCommand={selectPaletteCommand}
                  suggestionsSlot={composerChips}
                  embedded
                />
              </div>
            </div>
          </AgentErrorBoundary>

          <p className="shrink-0 pt-2 text-center text-[11px] text-muted">
            Try <span className="text-primary">/help</span> for commands.
          </p>
        </motion.div>
      </main>

      <AgentX402PaymentModal
        open={x402Payment.open}
        onClose={x402Payment.close}
        proposal={x402Payment.proposal}
        confirmationState={x402Payment.confirmationState}
        confirmationError={x402Payment.confirmationError}
        executionState={x402Payment.executionState}
        executionError={x402Payment.executionError}
        settlement={x402Payment.settlement}
        onConfirmAndPay={x402Payment.confirmAndPay}
      />
      <AgentTradeConfirmationModal
        open={tradeQuote.open}
        onClose={tradeQuote.close}
        proposal={tradeQuote.proposal}
        confirmationState={tradeQuote.confirmationState}
        confirmationError={tradeQuote.confirmationError}
        executionState={tradeQuote.executionState}
        executionError={tradeQuote.executionError}
        approvalHash={tradeQuote.approvalHash}
        swapHash={tradeQuote.swapHash}
        stepLabel={tradeQuote.stepLabel}
        onConfirmAndSwap={tradeQuote.confirmAndSwap}
      />
      <AgentTransferConfirmationModal
        open={transferQuote.open}
        onClose={transferQuote.close}
        proposal={transferQuote.proposal}
        confirmationState={transferQuote.confirmationState}
        confirmationError={transferQuote.confirmationError}
        executionState={transferQuote.executionState}
        executionError={transferQuote.executionError}
        txHash={transferQuote.txHash}
        stepLabel={transferQuote.stepLabel}
        onConfirmAndSend={transferQuote.confirmAndSend}
      />
    </>
  );
}
