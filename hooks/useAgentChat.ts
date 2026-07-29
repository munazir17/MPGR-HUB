"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useXP } from "@/hooks/useXP";
import { useRewards } from "@/hooks/useRewards";
import { useStaking } from "@/hooks/useStaking";
import { useTokenLock } from "@/hooks/useTokenLock";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { useHolderTier } from "@/lib/useHolderTier";
import { buildAgentContext } from "@/lib/agent-context";
import {
  appendAssistantReply,
  appendUserMessage,
  clearAgentState,
  getAgentState,
  regenerateLastReply,
  setMessageFeedback,
  type AgentFeedback,
  type AgentMessage,
} from "@/lib/agent-engine";

// Simulated "thinking" delay so the reply doesn't appear instantly —
// purely a local UX beat, not a network call.
const THINKING_DELAY_MIN_MS = 600;
const THINKING_DELAY_MAX_MS = 1400;

const GENERATION_ERROR_MESSAGE = "Something went wrong generating a reply. Please try again.";

// Phase 3A.2 — this hook is the only place in the Agent feature that calls
// other hooks (useXP, useRewards, useStaking, useTokenLock, usePremium,
// useHolderTier, useSeasonPass), matching how the Dashboard and Profile
// pages already read this same state. Their results are folded into a
// single AgentContext snapshot (lib/agent-context.ts) every render, so
// each sendMessage() call always reasons over the freshest values from
// existing app state.
//
// Phase 3A.4 — adds `error` + `retryLastMessage` (generation can now throw
// and be recovered from without losing or duplicating the user's message),
// `regenerateLastMessage` (wraps lib/agent-engine.ts's regenerateLastReply
// with the same thinking-delay UX as a normal send), and `sendFeedback`
// (👍/👎). None of the existing sendMessage/clearChat contract changed.
export function useAgentChat() {
  const { address, isConnected } = useAccount();
  const { record: xpRecord } = useXP();
  const { claimableTotal, totalClaimed } = useRewards();
  const { totalStaked, totalClaimableRewards, activePositionsCount } = useStaking();
  const { totalLocked, activeLocksCount, upcomingUnlockAt } = useTokenLock();
  const { status: premiumStatus } = usePremium();
  const { status: holderTierStatus } = useHolderTier();
  const { status: seasonStatus } = useSeasonPass();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const context = useMemo(
    () =>
      buildAgentContext({
        isConnected,
        xpRecord,
        premiumStatus,
        holderTierStatus,
        seasonStatus,
        staking: { totalStaked, totalClaimableRewards, activePositionsCount },
        tokenLock: { totalLocked, activeLocksCount, upcomingUnlockAt },
        rewards: { claimableTotal, totalClaimed },
      }),
    [
      isConnected,
      xpRecord,
      premiumStatus,
      holderTierStatus,
      seasonStatus,
      totalStaked,
      totalClaimableRewards,
      activePositionsCount,
      totalLocked,
      activeLocksCount,
      upcomingUnlockAt,
      claimableTotal,
      totalClaimed,
    ]
  );

  const refresh = useCallback(() => {
    if (!address) return;
    setMessages(getAgentState(address).messages);
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setMessages([]);
      setThinking(false);
      setHasLoaded(false);
      setError(null);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Clear any pending "thinking" timeout on unmount or address change so we
  // never call setState after the component/wallet has moved on.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [address]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!address) return;
      const trimmed = content.trim();
      if (!trimmed || thinking) return;

      const afterUser = appendUserMessage(address, trimmed);
      setMessages(afterUser.messages);
      setThinking(true);
      setError(null);

      const delay = THINKING_DELAY_MIN_MS + Math.random() * (THINKING_DELAY_MAX_MS - THINKING_DELAY_MIN_MS);
      timeoutRef.current = setTimeout(() => {
        try {
          const afterAssistant = appendAssistantReply(address, trimmed, context);
          setMessages(afterAssistant.messages);
          setError(null);
        } catch (err) {
          console.error("MPGR Agent: failed to generate a reply", err);
          setError(GENERATION_ERROR_MESSAGE);
        } finally {
          setThinking(false);
        }
      }, delay);
    },
    [address, thinking, context]
  );

  // Re-runs generation for the most recent user message without appending
  // a duplicate — that message is already persisted (appendUserMessage ran
  // before generation ever started), so a failed attempt never loses it.
  // Used by AgentErrorBanner's Retry action.
  const retryLastMessage = useCallback(() => {
    if (!address || thinking) return;
    const current = getAgentState(address);
    const lastUser = [...current.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;

    setThinking(true);
    setError(null);
    timeoutRef.current = setTimeout(() => {
      try {
        const afterAssistant = appendAssistantReply(address, lastUser.content, context);
        setMessages(afterAssistant.messages);
        setError(null);
      } catch (err) {
        console.error("MPGR Agent: retry failed", err);
        setError(GENERATION_ERROR_MESSAGE);
      } finally {
        setThinking(false);
      }
    }, THINKING_DELAY_MIN_MS);
  }, [address, thinking, context]);

  // Discards the last assistant reply and generates a fresh one for the
  // same prompt — see lib/agent-engine.ts's regenerateLastReply, which
  // guards against running on anything but the true last message.
  const regenerateLastMessage = useCallback(() => {
    if (!address || thinking) return;
    setThinking(true);
    setError(null);
    timeoutRef.current = setTimeout(() => {
      try {
        const result = regenerateLastReply(address, context);
        setMessages(result.messages);
        setError(null);
      } catch (err) {
        console.error("MPGR Agent: regenerate failed", err);
        setError(GENERATION_ERROR_MESSAGE);
      } finally {
        setThinking(false);
      }
    }, THINKING_DELAY_MIN_MS);
  }, [address, thinking, context]);

  const sendFeedback = useCallback(
    (messageId: string, feedback: AgentFeedback) => {
      if (!address) return;
      const updated = setMessageFeedback(address, messageId, feedback);
      setMessages(updated.messages);
    },
    [address]
  );

  const dismissError = useCallback(() => setError(null), []);

  const clearChat = useCallback(() => {
    if (!address) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setThinking(false);
    setError(null);
    const cleared = clearAgentState(address);
    setMessages(cleared.messages);
  }, [address]);

  const canRegenerate = !thinking && messages.length > 0 && messages[messages.length - 1]?.role === "assistant";

  return {
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
  };
}
