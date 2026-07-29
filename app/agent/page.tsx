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
import { useAgentChat } from "@/hooks/useAgentChat";
import type { AgentStatusId } from "@/lib/agent-config";

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
  } = useAgentChat();

  const heroStatuses: AgentStatusId[] = thinking ? ["thinking", "beta"] : ["online", "beta"];
  const hasMessages = messages.length > 0;

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

              <AgentInput onSend={sendMessage} disabled={thinking} />
            </GlassCard>
          )}

          <p className="text-center text-[11px] text-muted">
            MPGR Agent is in local preview — replies are generated on-device. No external AI
            services are connected in this phase.
          </p>
        </motion.div>
      </main>
    </>
  );
}
