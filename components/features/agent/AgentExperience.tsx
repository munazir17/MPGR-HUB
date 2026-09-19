"use client";

import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { AgentHero } from "@/components/features/agent/AgentHero";
import { AgentCapabilities } from "@/components/features/agent/AgentCapabilities";
import { MpgrMarketTicker } from "@/components/features/market/MpgrMarketTicker";
import { AgentChatWindow } from "@/components/features/agent/AgentChatWindow";
import { AgentEmptyState } from "@/components/features/agent/AgentEmptyState";
import { AgentInput } from "@/components/features/agent/AgentInput";
import { AgentPromptSuggestions } from "@/components/features/agent/AgentPromptSuggestions";
import { AgentQuickActions } from "@/components/features/agent/AgentQuickActions";
import { AgentErrorBanner } from "@/components/features/agent/AgentErrorBanner";
import { AgentErrorBoundary } from "@/components/features/agent/AgentErrorBoundary";
import { AgentX402PaymentModal } from "@/components/features/agent/AgentX402PaymentModal";
import { AgentTradeConfirmationModal } from "@/components/features/agent/AgentTradeConfirmationModal";
import { AgentTransferConfirmationModal } from "@/components/features/agent/AgentTransferConfirmationModal";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useX402Payment } from "@/hooks/useX402Payment";
import { useTradeQuote } from "@/hooks/useTradeQuote";
import { useTransferQuote } from "@/hooks/useTransferQuote";
import type { AgentStatusId } from "@/lib/agent-config";

export function AgentExperience() {
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

  return (
    <>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2 pt-1 md:mx-auto md:max-w-3xl md:overflow-visible md:px-4 md:py-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="shrink-0">
            <AgentHero statuses={heroStatuses} compact={hasMessages} />
          </div>

          {!isConnected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mt-3">
                <MpgrMarketTicker compact />
              </div>
              <AgentCapabilities
                connected={false}
                onSelectPrompt={sendMessage}
                onNeedWallet={() => {
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
              <p className="mt-3 text-center text-xs text-muted">
                Connect a wallet in the header to chat. Research is explained above;
                onchain actions still require your signature.
              </p>
            </div>
          ) : !hasLoaded ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-muted">Loading conversation...</p>
            </div>
          ) : (
            <AgentErrorBoundary>
              <div className="flex min-h-0 flex-1 flex-col">
                {hasMessages && (
                  <div className="flex shrink-0 items-center justify-between px-1 py-2">
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

                {hasMessages ? (
                  <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-surface">
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
                  </div>
                ) : (
                  <AgentEmptyState onSelectPrompt={sendMessage} />
                )}

                {hasMessages && (
                  <div className="shrink-0 px-1 pt-2">
                    <AgentPromptSuggestions variant="row" onSelect={sendMessage} disabled={thinking} />
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

                <div className="shrink-0 pt-2">
                  <AgentInput
                    onSend={sendMessage}
                    disabled={thinking}
                    onStop={stopGeneration}
                    commandPalette={commandPalette}
                    onSelectCommand={selectPaletteCommand}
                  />
                </div>

                {!hasMessages && (
                  <div className="shrink-0 pt-3">
                    <AgentQuickActions onSelectPrompt={sendMessage} disabled={thinking} />
                  </div>
                )}
              </div>
            </AgentErrorBoundary>
          )}

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
