"use client";

import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw, Wallet } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { AgentHero } from "@/components/features/agent/AgentHero";
import { AgentChatWindow } from "@/components/features/agent/AgentChatWindow";
import { AgentEmptyState } from "@/components/features/agent/AgentEmptyState";
import { AgentInput } from "@/components/features/agent/AgentInput";
import { AgentPromptSuggestions } from "@/components/features/agent/AgentPromptSuggestions";
import { AgentErrorBanner } from "@/components/features/agent/AgentErrorBanner";
import { AgentErrorBoundary } from "@/components/features/agent/AgentErrorBoundary";
import { AgentX402PaymentModal } from "@/components/features/agent/AgentX402PaymentModal";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useX402Payment } from "@/hooks/useX402Payment";
import type { AgentStatusId } from "@/lib/agent-config";
// Bug fix (post Phase 3C audit) — the footer disclaimer below used to be
// a hardcoded string claiming "no external AI services are connected in
// this phase" unconditionally, regardless of which AIProvider was
// actually active. lib/architecture/ai/ai-provider-registry.ts's
// getAIProviderDiagnostics() already existed (Phase 3C Part 3) but was
// never called from anywhere — it's wired in here instead of adding any
// new tracking. Called directly in the render body (not memoized) so it
// re-reads live stats on every re-render, which already happens after
// every message via useAgentChat()'s state updates.
import { getAIProviderDiagnostics } from "@/lib/architecture/ai/ai-provider-registry";

export default function AgentPage() {
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
    // Phase 3A.6
    commandPalette,
    selectPaletteCommand,
    streamingMessageId,
  } = useAgentChat();

  // P3 — the one adapter connecting an x402 proposal surfaced on a chat
  // message to the existing payment modal. See hooks/useX402Payment.ts's
  // header comment for why this lives here (not inside useAgentChat)
  // and exactly which call is the human-confirmation boundary.
  const x402Payment = useX402Payment();

  const heroStatuses: AgentStatusId[] = thinking ? ["thinking", "beta"] : ["online", "beta"];
  const hasMessages = messages.length > 0;

  const diagnostics = getAIProviderDiagnostics();
  const providerStatusText = buildProviderStatusText(diagnostics);

  return (
    <>
      {/*
        Mobile UX polish (below md/768px only): this wrapper + <main> pin
        the page to exactly the viewport height that's left after the
        (in-flow, sticky) Navbar and the (fixed) BottomNav, so the
        Conversation card can flex-grow to fill it instead of the page
        scrolling as a whole. At md (768px) and up every class below
        reverts to the original desktop layout (mx-auto max-w-3xl px-4
        py-8, natural height, page-level scroll) — nothing about the
        desktop experience changes.
      */}
      <div className="flex min-h-[calc(100dvh-5rem)] flex-col sm:min-h-[100dvh] md:block md:min-h-0">
        <Navbar />
        <main className="flex flex-1 flex-col overflow-hidden px-3 pb-2 pt-2 md:mx-auto md:block md:max-w-3xl md:flex-none md:overflow-visible md:px-4 md:py-8 lg:py-12">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="flex min-h-0 flex-1 flex-col space-y-1.5 md:block md:min-h-0 md:flex-none md:space-y-6"
          >
            <div className="shrink-0">
              <AgentHero statuses={heroStatuses} />
            </div>

            {!isConnected ? (
              <EmptyState
                icon={Wallet}
                title="Connect your wallet"
                description="Connect to start a conversation with the MPGR Agent."
              />
            ) : !hasLoaded ? (
              <GlassCard className="flex flex-1 items-center justify-center p-6 md:h-[420px] md:flex-none">
                <p className="text-sm text-muted">Loading conversation...</p>
              </GlassCard>
            ) : (
              <AgentErrorBoundary>
                <GlassCard className="flex min-h-0 flex-1 flex-col overflow-hidden p-0 md:h-[600px] md:flex-none">
                  <div className="flex shrink-0 items-center justify-between border-b border-white/[0.08] px-4 py-2.5 sm:px-6 md:py-3">
                    <p className="text-sm font-semibold text-white">Conversation</p>
                    {hasMessages && (
                      <button
                        type="button"
                        onClick={clearChat}
                        disabled={thinking}
                        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        Clear
                      </button>
                    )}
                  </div>

                  {hasMessages ? (
                    <AgentChatWindow
                      messages={messages}
                      thinking={thinking}
                      onSelectPrompt={sendMessage}
                      onFeedback={sendFeedback}
                      onRegenerate={regenerateLastMessage}
                      canRegenerate={canRegenerate}
                      streamingMessageId={streamingMessageId}
                      onReviewX402Proposal={x402Payment.openProposal}
                    />
                  ) : (
                    <AgentEmptyState onSelectPrompt={sendMessage} />
                  )}

                  {hasMessages && (
                    <div className="shrink-0 px-4 pt-2 sm:px-6 md:pt-3">
                      <AgentPromptSuggestions variant="row" onSelect={sendMessage} disabled={thinking} />
                    </div>
                  )}

                  <AnimatePresence>
                    {error && (
                      <AgentErrorBanner message={error} onRetry={retryLastMessage} onDismiss={dismissError} />
                    )}
                  </AnimatePresence>

                  <div className="shrink-0">
                    <AgentInput
                      onSend={sendMessage}
                      disabled={thinking}
                      commandPalette={commandPalette}
                      onSelectCommand={selectPaletteCommand}
                    />
                  </div>
                </GlassCard>
              </AgentErrorBoundary>
            )}

            <p className="shrink-0 text-center text-[11px] text-muted">
              {providerStatusText} Try <span className="text-primary-glow">/help</span> for available commands.
            </p>
          </motion.div>
        </main>
      </div>

      {/*
        P3 — one modal instance for the whole page, driven entirely by
        useX402Payment(). onConfirmAndPay is the ONLY wire into signing/
        submission in this entire page — see that hook's header comment.
      */}
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
    </>
  );
}

// Bug fix (post Phase 3C audit) — replaces the old hardcoded claim with a
// truthful, live status derived from lib/architecture/ai/ai-provider-registry.ts's
// getAIProviderDiagnostics(). Three states:
//   - No diagnostics available (shouldn't happen with the current
//     registry composition, but handled defensively): generic message.
//   - Configured provider is "deterministic": accurate local-only message
//     (this is the only case where the old text was ever actually true).
//   - Configured provider is anything else (e.g. "openai"): reports
//     whether calls so far have been succeeding, or whether they've all
//     been failing and silently falling back to the on-device engine —
//     the exact ambiguity the Phase 3C audit flagged as invisible before.
function buildProviderStatusText(diagnostics: ReturnType<typeof getAIProviderDiagnostics>): string {
  if (!diagnostics) {
    return "MPGR Agent reply source could not be determined.";
  }

  if (diagnostics.name === "deterministic") {
    return "MPGR Agent is in local preview — replies are generated on-device.";
  }

  if (diagnostics.totalCalls === 0) {
    return `MPGR Agent is connected to ${diagnostics.name} — no messages sent yet this session.`;
  }

  if (diagnostics.failureCount > 0 && diagnostics.successCount === 0) {
    return `MPGR Agent's ${diagnostics.name} connection is currently failing — replies are falling back to the on-device engine.`;
  }

  if (diagnostics.failureCount > 0) {
    return `MPGR Agent replies are generated by \( {diagnostics.name} ( \){diagnostics.failureCount} recent call${diagnostics.failureCount === 1 ? "" : "s"} fell back to the on-device engine).`;
  }

  return `MPGR Agent replies are generated by ${diagnostics.name}.`;
}
