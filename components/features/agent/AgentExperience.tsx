"use client";

// components/features/agent/AgentExperience.tsx
//
// The ONE canonical MPGR AGENT chat — rebuilt as the product's STAGE.
//
// MPGR HUB's product IS the agent, so Home's first screen IS this stage:
// a full-viewport workstation card, not a short chat card floating under
// a page title. Three internal zones:
//
//   ┌ STAGE ────────────────────────────────────────────────┐
//   │ TOP BAR  MPGR AGENT · ● status · [core jewel] · Clear │  48/56px
//   │ BODY     State A: AgentCore + one line + chips        │  flex-1
//   │          State B: the conversation thread             │  scroll
//   │ DOCK     chips row (State B) + 56px composer          │  pinned
//   └───────────────────────────────────────────────────────┘
//
// Height contract (replaces the old "no min-height anywhere" rule —
// that contract is why the product felt small): the stage is exactly
// the first viewport's remainder (100dvh − navbar − tape − gutters),
// with a generous min-height. The BODY is flex-1/min-h-0 and owns the
// scrolling, so the composer never leaves the viewport on any device.
//
// State A (disconnected OR connected+empty) is a real workspace: the
// 3D AgentCore object, one existing line of copy, all six chips, and —
// while disconnected — a 56px physical Connect CTA. Chips are VISIBLE
// while disconnected; tapping one opens the SAME RainbowKit connect
// modal (there is no send path without a wallet). State B shrinks the
// core to a 28px jewel in the top bar and fills the body with the
// existing conversation components (bubbles, action cards, modals).
//
// Everything behavioral is untouched: useAgentChat, x402/trade/transfer
// flows, the /commands palette, tape "Prepare swap" wiring, persistence.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { AgentChatWindow } from "@/components/features/agent/AgentChatWindow";
import { AgentCore } from "@/components/features/agent/AgentCore";
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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useX402Payment } from "@/hooks/useX402Payment";
import { useTradeQuote } from "@/hooks/useTradeQuote";
import { useTransferQuote } from "@/hooks/useTransferQuote";
import type { AgentStatusId } from "@/lib/agent-config";

export interface AgentStageHeroOptions {
  /** A conversation thread exists → the hero shows the 28px core jewel. */
  thread: boolean;
}

export interface AgentExperienceProps {
  /** The MPGR AGENT identity row — rendered INSIDE the stage top bar. */
  heroSlot: (statuses: AgentStatusId[], opts: AgentStageHeroOptions) => ReactNode;
  /**
   * The ONE canonical suggested-prompt set. All chips render in State A
   * (even disconnected — tap opens the connect modal); in State B they
   * become the dock's horizontal chip row.
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

  const { openConnectModal } = useConnectModal();
  const reduceMotion = useReducedMotion();

  const x402Payment = useX402Payment();
  const tradeQuote = useTradeQuote(appendTradeExecutionResult);
  const transferQuote = useTransferQuote(appendTransferExecutionResult);

  const heroStatuses: AgentStatusId[] = thinking ? ["thinking"] : ["online"];
  const hasMessages = messages.length > 0;

  // Send squash — the core compresses ~200ms on every outgoing message
  // (both the hero object and the top-bar jewel listen to this signal).
  const [squashSignal, setSquashSignal] = useState(0);
  const handleSend = useCallback(
    (prompt: string) => {
      setSquashSignal((n) => n + 1);
      sendMessage(prompt);
    },
    [sendMessage],
  );

  // While disconnected a chip tap is a connect prompt, not a send —
  // sendMessage is a no-op without an address, so we route the tap to
  // the SAME RainbowKit connect modal the navbar uses.
  const handleChipSelect = useCallback(
    (prompt: string) => {
      if (isConnected) handleSend(prompt);
      else openConnectModal?.();
    },
    [isConnected, handleSend, openConnectModal],
  );

  // Home wires the tape's "Prepare swap" action into the chat through
  // this callback. The ref keeps re-renders from re-firing it when
  // onReady isn't memoized.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current?.({ sendMessage: handleSend });
  }, [handleSend]);

  // Home entrance stagger: topbar 0 / core 80 / line 160 / chips+dock 240ms.
  const rise = (delay: number) => ({
    initial: reduceMotion ? false : ({ opacity: 0, y: 12 } as const),
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.44, ease: "easeOut" as const },
  });

  // STATE A chips — centered + wrapping on desktop, snap-scrolled row on
  // phones. STATE B chips — the dock's horizontal row.
  const stageChips =
    suggestions.length > 0 ? (
      <AgentPromptSuggestions
        variant="stage"
        items={suggestions}
        onSelect={handleChipSelect}
        disabled={thinking}
      />
    ) : null;

  const dockChips =
    isConnected && hasLoaded && hasMessages && suggestions.length > 0 ? (
      <AgentPromptSuggestions
        variant="row"
        items={suggestions}
        onSelect={handleSend}
        disabled={thinking}
        className="pb-0"
      />
    ) : null;

  const emptyState = (
    <>
      {/* Inner radial — sits BEHIND the core only, never site-wide. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[36%] h-[min(60%,460px)] w-[min(72%,560px)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/[0.07] blur-3xl"
      />
      <div className="relative flex min-h-full flex-col items-center justify-center gap-5 px-4 py-6 text-center sm:gap-6 sm:py-8">
        <motion.div {...rise(0.08)}>
          <AgentCore
            state={thinking ? "thinking" : "idle"}
            squashSignal={squashSignal}
          />
        </motion.div>

        <motion.div {...rise(0.16)} className="max-w-xl">
          <p className="text-[18px] font-semibold leading-snug tracking-[-0.02em] text-white md:text-[20px]">
            {emptyStateText}
          </p>
          {!isConnected && (
            <p className="mx-auto mt-2.5 max-w-md text-[13px] leading-relaxed text-muted">
              The agent researches Coinbase wrapped assets and tokenized
              stocks, and prepares on-chain actions for review — nothing
              is signed without your confirmation.
            </p>
          )}
        </motion.div>

        <motion.div {...rise(0.24)} className="w-full">
          {stageChips}
        </motion.div>

        {!isConnected && (
          <motion.div {...rise(0.3)} className="w-full max-w-[320px]">
            <button
              type="button"
              onClick={() => openConnectModal?.()}
              className="btn-primary w-full text-sm"
            >
              Connect Wallet
            </button>
          </motion.div>
        )}
      </div>
    </>
  );

  return (
    <>
      <main className="mx-auto w-full max-w-[1320px] px-3 pt-3 sm:px-4 md:pt-4 lg:px-[clamp(24px,4vw,64px)]">
        <AgentErrorBoundary>
          {/* ── THE STAGE ──────────────────────────────────────────────
              Opaque surface, hairline, inner top highlight, deep shadow.
              Height = the first viewport's remainder; the BODY owns the
              scroll so the DOCK (composer) never leaves the viewport. */}
          <div
            className="stage-grain relative flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_24px_80px_-32px_rgba(0,0,0,0.72)] md:rounded-[20px] h-[calc(100dvh_-_116px_-_env(safe-area-inset-top))] min-h-[480px] sm:min-h-[520px] md:h-[calc(100dvh_-_120px_-_env(safe-area-inset-top))] lg:h-[calc(100dvh_-_128px_-_env(safe-area-inset-top))] lg:min-h-[640px]"
            data-testid="agent-chat-surface"
          >
            {/* TOP BAR — the folded hero lives here (testid inside the
                hero component). Clear appears once a thread exists. */}
            <motion.div
              {...rise(0)}
              className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 sm:px-4 md:h-14 lg:px-5"
            >
              {heroSlot(heroStatuses, { thread: hasMessages })}
              {hasMessages && (
                <button
                  type="button"
                  onClick={clearChat}
                  disabled={thinking}
                  className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 text-[11px] font-medium text-muted transition-colors duration-200 hover:border-white/[0.16] hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Clear
                </button>
              )}
            </motion.div>

            {/* BODY — flex-1, owns the scrolling. */}
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              {!isConnected ? (
                emptyState
              ) : !hasLoaded ? (
                <div className="flex min-h-full items-center justify-center px-4 py-8">
                  <p className="text-[13px] text-muted">Loading conversation...</p>
                </div>
              ) : hasMessages ? (
                <AgentChatWindow
                  messages={messages}
                  thinking={thinking}
                  onSelectPrompt={handleSend}
                  onFeedback={sendFeedback}
                  onRegenerate={regenerateLastMessage}
                  canRegenerate={canRegenerate}
                  streamingMessageId={streamingMessageId}
                  onReviewX402Proposal={x402Payment.openProposal}
                  onReviewTradeProposal={tradeQuote.openProposal}
                  onReviewTransferProposal={transferQuote.openProposal}
                />
              ) : (
                emptyState
              )}
            </div>

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

            {/* DOCK — pinned to the stage bottom (the stage, not the
                document). Composer + State B chip row live here. */}
            <motion.div
              {...rise(0.24)}
              className="shrink-0 border-t border-white/[0.06] bg-white/[0.02] p-2 sm:p-3"
              style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
            >
              <AgentInput
                onSend={handleSend}
                disabled={thinking}
                locked={!isConnected || !hasLoaded}
                placeholder={isConnected ? "Ask anything..." : "Connect a wallet to chat..."}
                onStop={stopGeneration}
                commandPalette={commandPalette}
                onSelectCommand={selectPaletteCommand}
                suggestionsSlot={dockChips}
                embedded
              />
              <p className="pt-1.5 text-center text-[10px] text-muted/70">
                Try <span className="font-medium text-primary">/help</span> for commands.
              </p>
            </motion.div>
          </div>
        </AgentErrorBoundary>
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
