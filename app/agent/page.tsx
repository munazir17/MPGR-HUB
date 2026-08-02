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
import { useAgentChat } from "@/hooks/useAgentChat";
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

  const heroStatuses: AgentStatusId[] = thinking ? ["thinking", "beta"] : ["online", "beta"];
  const hasMessages = messages.length > 0;

  const diagnostics = getAIProviderDiagnostics();
  const providerStatusText = buildProviderStatusText(diagnostics);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-6"
        >
          <AgentHero statuses={heroStatuses} />

          {!isConnected ? (
            <EmptyState
              icon={Wallet}
              title="Connect your wallet"
              description="Connect to start a conversation with the MPGR Agent."
            />
          ) : !hasLoaded ? (
            <GlassCard className="flex h-[420px] items-center justify-center p-6">
              <p className="text-sm text-muted">Loading conversation...</p>
            </GlassCard>
          ) : (
            <AgentErrorBoundary>
              <GlassCard className="flex h-[560px] flex-col overflow-hidden p-0 sm:h-[600px]">
                <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3 sm:px-6">
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
                  />
                ) : (
                  <AgentEmptyState onSelectPrompt={sendMessage} />
                )}

                {hasMessages && (
                  <div className="px-4 pt-3 sm:px-6">
                    <AgentPromptSuggestions variant="row" onSelect={sendMessage} disabled={thinking} />
                  </div>
                )}

                <AnimatePresence>
                  {error && (
                    <AgentErrorBanner message={error} onRetry={retryLastMessage} onDismiss={dismissError} />
                  )}
                </AnimatePresence>

                <AgentInput
                  onSend={sendMessage}
                  disabled={thinking}
                  commandPalette={commandPalette}
                  onSelectCommand={selectPaletteCommand}
                />
              </GlassCard>
            </AgentErrorBoundary>
          )}

          <p className="text-center text-[11px] text-muted">
            {providerStatusText} Try <span className="text-primary-glow">/help</span> for available commands.
          </p>
        </motion.div>
      </main>
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
    return `MPGR Agent replies are generated by ${diagnostics.name} (${diagnostics.failureCount} recent call${diagnostics.failureCount === 1 ? "" : "s"} fell back to the on-device engine).`;
  }

  return `MPGR Agent replies are generated by ${diagnostics.name}.`;
}
