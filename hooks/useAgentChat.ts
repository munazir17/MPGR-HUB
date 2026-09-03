"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { useXP } from "@/hooks/useXP";
import { useRewardClaim } from "@/hooks/useRewardClaim";
import { useStaking } from "@/hooks/useStaking";
import { useTokenLock } from "@/hooks/useTokenLock";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { useHolderTier } from "@/lib/useHolderTier";
import { buildAgentContext } from "@/lib/agent-context";
import { agentAIService } from "@/lib/architecture/ai/agent-ai-service-instance";
import { findInterruptedPrompt } from "@/lib/architecture/ai/crash-recovery";
import { isSlashCommand } from "@/lib/agent-commands/parser";
import { executeCommandInput } from "@/lib/agent-commands/action-executor";
import { getActionHistory, recordAction, clearActionHistory, type ActionHistoryEntry } from "@/lib/agent-commands/action-history";
import { useCommandPalette } from "@/hooks/useCommandPalette";
// Production audit addendum — subscribes to the same EventBus every AI
// provider decorator already emits on (lib/architecture/ai/fallback-ai-provider.ts,
// lib/architecture/core/types.ts:55). agentEventBus is the exact
// singleton injected into the active provider chain by
// lib/architecture/ai/ai-provider-registry.ts's buildDefaultProvider(),
// so listening here requires no change to that composition.
import { agentEventBus } from "@/lib/architecture/core/event-bus";
// Phase 3B Part 3 — Personalization snapshot (favorite topics, most-used
// commands, preferred token, recent pages). Read-only from this hook's
// perspective — every write into it happens in the background via
// lib/architecture/ai/agent-ai-service.ts and hooks/useRecentPageTracking.ts.
//
// Production audit addendum — runMemoryCleanup is Phase 3B Part 1's
// housekeeping pass (lib/architecture/memory/memory-cleanup.ts), fully
// implemented and exported from here, but until now never actually
// called anywhere in the app. Wired in below, alongside the
// personalization load this hook already performs on every address
// change.
import { getPersonalizationSnapshot, runMemoryCleanup, type PersonalizationSnapshot } from "@/lib/architecture/memory/memory-engine";
// Phase 3D — Smart Actions & AI Automation. Turns an AI-generated
// reply's `intent` into a real navigation side effect when that intent
// is one of lib/agent-actions.ts's whitelisted open_* intents — see
// lib/architecture/ai/smart-action-engine.ts's header for the full
// safety/performance/diagnostics rationale. Never used for the
// slash-command path (executeCommand below) — that path already
// navigates directly via its own CommandResult "navigate" kind, exactly
// as it did before Phase 3D.
import { executeSmartAction } from "@/lib/architecture/ai/smart-action-engine";
import type { AgentFeedback, AgentMessage } from "@/lib/agent-engine";
import type { SlashCommand } from "@/lib/agent-commands/types";

const THINKING_DELAY_MIN_MS = 600;
const THINKING_DELAY_MAX_MS = 1400;

const GENERATION_ERROR_MESSAGE = "Something went wrong generating a reply. Please try again.";

// Codes classifyGeminiUpstreamFailure() (lib/architecture/ai/gemini-function-declarations.ts)
// and gemini-ai-provider.ts's own empty-response/unreachable checks can
// attach to a thrown provider error. All of these mean the PROVIDER was
// unavailable — not that anything is broken in this app — and
// FallbackAIProvider has already returned a working reply from the
// deterministic fallback by the time this event fires. An error without
// one of these codes is an unexpected/programming error and must still
// surface to the user via the banner.
const EXPECTED_PROVIDER_FAILURE_CODES = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_AUTH_ERROR",
  "PROVIDER_ERROR",
  "PROVIDER_INVALID_JSON",
  "PROVIDER_EMPTY_RESPONSE",
]);

const EMPTY_PERSONALIZATION: PersonalizationSnapshot = {
  favoriteTopics: [],
  mostUsedCommands: [],
  preferredToken: "MPGR",
  recentPages: [],
  interactionCount: 0,
  isReturningUser: false,
};

// Phase 3A.2 — this hook is the only place in the Agent feature that calls
// other hooks (useXP, useRewardClaim, useStaking, useTokenLock, usePremium,
// useHolderTier, useSeasonPass); their results fold into a single
// AgentContext snapshot every render (lib/agent-context.ts).
//
// Phase 3A.4 — error/retry/regenerate/feedback state, unchanged in shape
// here.
//
// Phase 3A.5 — Production Architecture Hardening: this hook no longer
// imports lib/agent-engine.ts's mutation functions directly. Every
// read/write now goes through lib/architecture/ai/agent-ai-service-instance.ts's
// `agentAIService` — UI -> Hook -> AI Service -> Memory Provider ->
// Storage — which wraps the exact same agent-engine.ts logic with event
// emission, timing, and logging. The hook's PUBLIC return shape (messages,
// thinking, error, sendMessage, clearChat, retryLastMessage,
// regenerateLastMessage, sendFeedback, dismissError, canRegenerate) is
// UNCHANGED from 3A.5 — only additive fields below.
//
// Phase 3A.6 — Advanced Conversational UX. sendMessage now detects a
// leading "/" and routes through lib/agent-commands/action-executor.ts
// instead of agentAIService.generateReply(); every other message still
// goes through the exact same conversational path as before. New
// additive return fields: commandPalette, actionHistory,
// clearActionHistory, streamingMessageId.
//
// Phase 3B Part 3 — Personalization. Loads a PersonalizationSnapshot
// alongside the existing state/actionHistory load (same effect, same
// address-change trigger), feeds its mostUsedCommands into
// useCommandPalette() for usage-based ordering, and returns it as a new
// additive field (`personalization`). No existing return field changes
// shape or meaning.
//
// Production audit addendum — two additive fixes, neither changing this
// hook's public shape: (1) the address-load effect now also enqueues
// runMemoryCleanup() as a low-priority background task; (2) a new effect
// subscribes to `ai_provider_error` so a failing primary AI provider
// surfaces through the existing `error`/AgentErrorBanner path instead of
// silently degrading to the deterministic engine.
//
// Phase 3D — Smart Actions & AI Automation. Two additions, both fully
// additive to this hook's public shape:
//   1. Every AI-generated reply (sendMessage, retryLastMessage,
//      regenerateLastMessage — NOT the slash-command path, which already
//      had its own navigation) now calls
//      lib/architecture/ai/smart-action-engine.ts's executeSmartAction()
//      right after the new message is set, passing router.push as the
//      navigate callback. For the vast majority of intents this is a
//      no-op (getNavigateTarget returns undefined); for the six new
//      open_* intents it auto-navigates, mirroring the exact pattern
//      executeCommand below already used for slash commands (`if
//      (result.kind === "navigate") router.push(result.href)`) — not a
//      new interaction paradigm, the same one extended to conversational
//      phrasing.
//   2. executeCommand's existing recordAction() call now also measures
//      execution time and passes it through as `meta`, and the catch
//      block now ALSO records a (failed) history entry — previously a
//      failed command execution left no trace in Action History at all.
export function useAgentChat() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const { record: xpRecord } = useXP();
  const { claimableAmount: claimableTotal, claimedRewards, decimals: rewardVaultDecimals } = useRewardClaim();
  const totalClaimed = useMemo(
    () => claimedRewards.reduce((sum, r) => sum + Number(formatUnits(r.amount, rewardVaultDecimals)), 0),
    [claimedRewards, rewardVaultDecimals]
  );
  const {
    stakedBalanceRaw,
    earnedRewardsRaw,
    currentAPRPercent,
    decimals: stakingDecimals,
  } = useStaking();
  const { totalLocked, activeLocksCount, upcomingUnlockAt } = useTokenLock();
  const { status: premiumStatus } = usePremium();
  const { status: holderTierStatus } = useHolderTier();
  const { status: seasonStatus } = useSeasonPass();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEntry[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [personalization, setPersonalization] = useState<PersonalizationSnapshot>(EMPTY_PERSONALIZATION);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTokenRef = useRef(0);

  const commandPalette = useCommandPalette(personalization.mostUsedCommands);

  const totalStaked = useMemo(
    () => Number(formatUnits(stakedBalanceRaw, stakingDecimals)),
    [stakedBalanceRaw, stakingDecimals]
  );
  const earnedRewards = useMemo(
    () => Number(formatUnits(earnedRewardsRaw, stakingDecimals)),
    [earnedRewardsRaw, stakingDecimals]
  );

  const context = useMemo(
    () =>
      buildAgentContext({
        isConnected,
        xpRecord,
        premiumStatus,
        holderTierStatus,
        seasonStatus,
        staking: { totalStaked, earnedRewards, currentAPRPercent },
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
      earnedRewards,
      currentAPRPercent,
      totalLocked,
      activeLocksCount,
      upcomingUnlockAt,
      claimableTotal,
      totalClaimed,
    ]
  );

  useEffect(() => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;

    if (!isConnected || !address) {
      setMessages([]);
      setThinking(false);
      setHasLoaded(false);
      setError(null);
      setActionHistory([]);
      setPersonalization(EMPTY_PERSONALIZATION);
      return;
    }

    setHasLoaded(false);

    (async () => {
      const state = await agentAIService.loadState(address);
      if (loadTokenRef.current !== token) return;
      setMessages(state.messages);
      setHasLoaded(true);

      const history = await getActionHistory(address);
      if (loadTokenRef.current !== token) return;
      setActionHistory(history);

      // Phase 3B Part 3 — loaded alongside action history; failure here
      // is non-fatal to the chat itself, so it's wrapped so a broken
      // memory read can never block the conversation from loading.
      try {
        const snapshot = await getPersonalizationSnapshot(address);
        if (loadTokenRef.current !== token) return;
        setPersonalization(snapshot);
      } catch (err) {
        if (loadTokenRef.current !== token) return;
        console.error("MPGR Agent: failed to load personalization snapshot", err);
      }

      // Production audit addendum — completes Phase 3B Part 1's
      // documented-but-unwired cleanup pass. Enqueued (not awaited)
      // through the same background-task path every other Memory Engine
      // write already uses, at "low" priority, so it can never delay the
      // conversation load above or the crash-recovery branch below.
      agentAIService.enqueueBackgroundTask("memory.cleanup", () => runMemoryCleanup(address));

      const interruptedPrompt = findInterruptedPrompt(state);
      if (!interruptedPrompt) return;

      setThinking(true);
      try {
        const recovered = await agentAIService.generateReply(address, interruptedPrompt, context);
        if (loadTokenRef.current !== token) return;
        setMessages(recovered.messages);
        setError(null);
      } catch (err) {
        if (loadTokenRef.current !== token) return;
        console.error("MPGR Agent: crash recovery failed", err);
        setError(GENERATION_ERROR_MESSAGE);
      } finally {
        if (loadTokenRef.current === token) setThinking(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [address]);

  // Production audit addendum — subscribes to `ai_provider_error`
  // (lib/architecture/ai/fallback-ai-provider.ts,
  // lib/architecture/core/types.ts:55) whenever the primary provider
  // throws for any reason. Filters by the current address so a stale
  // subscription from a previous wallet can't set an error for the
  // wrong session. Reuses the existing `error` state — AgentErrorBanner
  // (already rendered in app/agent/page.tsx) picks this up exactly as it
  // does GENERATION_ERROR_MESSAGE below.
  //
  // Fix — do not bother the user with a banner for an EXPECTED
  // provider-availability failure that FallbackAIProvider has already
  // recovered from (the reply the user sees is the fallback's, which
  // succeeded). `payload.code` only carries one of these known codes
  // when the failure came from the classified Gemini route response
  // (see lib/architecture/ai/gemini-ai-provider.ts); a genuine
  // unexpected/programming error never sets it, so it still surfaces
  // here exactly as before. Diagnostics for every failure — expected or
  // not — are still logged internally by fallback-ai-provider.ts
  // regardless of what the UI shows.
  useEffect(() => {
    const unsubscribe = agentEventBus.on("ai_provider_error", (payload) => {
      if (payload.address !== address) return;
      if (payload.code && EXPECTED_PROVIDER_FAILURE_CODES.has(payload.code)) return;
      setError(`[${payload.provider}] ${payload.message}`);
    });
    return unsubscribe;
  }, [address]);

  // Phase 3A.6 — command path. Never touches lib/agent-intelligence.ts;
  // resolves instantly (no THINKING_DELAY), matching a command's
  // deterministic nature. "navigate" results also push a route change.
  const executeCommand = useCallback(
    (raw: string) => {
      if (!address) return;
      const executed = executeCommandInput(raw, context);
      if (!executed) return;

      const { commandName, result } = executed;
      const token = loadTokenRef.current;
      const startedAt = Date.now();

      (async () => {
        if (result.kind === "error") {
          setError(result.text);
          // Phase 3D — previously a failed command left no trace in
          // Action History at all. Recorded here (background-safe: this
          // whole IIFE is already fire-and-forget from React's
          // perspective) so "success: false" entries are actually
          // reachable via getActionHistoryByCategory("error", ...).
          void recordAction(address, commandName, result, {
            success: false,
            durationMs: Date.now() - startedAt,
            category: "error",
          });
          return;
        }

        const replyText = result.text;
        try {
          const state = await agentAIService.runCommand(address, commandName, replyText);
          if (loadTokenRef.current !== token) return;
          setMessages(state.messages);
          setError(null);
          const last = state.messages[state.messages.length - 1];
          setStreamingMessageId(last?.id ?? null);

          const history = await recordAction(address, commandName, result, {
            success: true,
            durationMs: Date.now() - startedAt,
          });
          if (loadTokenRef.current !== token) return;
          setActionHistory(history);
        } catch (err) {
          if (loadTokenRef.current !== token) return;
          console.error("MPGR Agent: command execution failed", err);
          setError(GENERATION_ERROR_MESSAGE);
          void recordAction(address, commandName, result, {
            success: false,
            durationMs: Date.now() - startedAt,
            category: "error",
          });
        }

        if (result.kind === "navigate") router.push(result.href);
      })();
    },
    [address, context, router]
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!address) return;
      const trimmed = content.trim();
      if (!trimmed || thinking) return;

      if (isSlashCommand(trimmed)) {
        executeCommand(trimmed);
        return;
      }

      const token = loadTokenRef.current;
      setThinking(true);
      setError(null);

      (async () => {
        try {
          const afterUser = await agentAIService.sendMessage(address, trimmed);
          if (loadTokenRef.current !== token) return;
          setMessages(afterUser.messages);
        } catch (err) {
          if (loadTokenRef.current !== token) return;
          console.error("MPGR Agent: failed to persist message", err);
          setError(GENERATION_ERROR_MESSAGE);
          setThinking(false);
          return;
        }

        const delay = THINKING_DELAY_MIN_MS + Math.random() * (THINKING_DELAY_MAX_MS - THINKING_DELAY_MIN_MS);
        timeoutRef.current = setTimeout(async () => {
          try {
            const afterAssistant = await agentAIService.generateReply(address, trimmed, context);
            if (loadTokenRef.current !== token) return;
            setMessages(afterAssistant.messages);
            setError(null);
            const last = afterAssistant.messages[afterAssistant.messages.length - 1];
            setStreamingMessageId(last?.id ?? null);
            // Phase 3D — no-op unless `last.intent` is one of
            // lib/agent-actions.ts's whitelisted open_* intents.
            if (last?.role === "assistant") {
              executeSmartAction(address, last.intent, (href) => router.push(href));
            }
          } catch (err) {
            if (loadTokenRef.current !== token) return;
            console.error("MPGR Agent: failed to generate a reply", err);
            setError(GENERATION_ERROR_MESSAGE);
          } finally {
            if (loadTokenRef.current === token) setThinking(false);
          }
        }, delay);
      })();
    },
    [address, thinking, context, executeCommand, router]
  );

  const retryLastMessage = useCallback(() => {
    if (!address || thinking) return;
    const token = loadTokenRef.current;
    setThinking(true);
    setError(null);

    (async () => {
      const current = await agentAIService.loadState(address);
      if (loadTokenRef.current !== token) return;
      const lastUser = [...current.messages].reverse().find((m) => m.role === "user");
      if (!lastUser) {
        setThinking(false);
        return;
      }

      timeoutRef.current = setTimeout(async () => {
        try {
          const afterAssistant = await agentAIService.generateReply(address, lastUser.content, context);
          if (loadTokenRef.current !== token) return;
          setMessages(afterAssistant.messages);
          setError(null);
          const last = afterAssistant.messages[afterAssistant.messages.length - 1];
          if (last?.role === "assistant") {
            executeSmartAction(address, last.intent, (href) => router.push(href));
          }
        } catch (err) {
          if (loadTokenRef.current !== token) return;
          console.error("MPGR Agent: retry failed", err);
          setError(GENERATION_ERROR_MESSAGE);
        } finally {
          if (loadTokenRef.current === token) setThinking(false);
        }
      }, THINKING_DELAY_MIN_MS);
    })();
  }, [address, thinking, context, router]);

  const regenerateLastMessage = useCallback(() => {
    if (!address || thinking) return;
    const token = loadTokenRef.current;
    setThinking(true);
    setError(null);
    timeoutRef.current = setTimeout(async () => {
      try {
        const result = await agentAIService.regenerate(address, context);
        if (loadTokenRef.current !== token) return;
        setMessages(result.messages);
        setError(null);
        const last = result.messages[result.messages.length - 1];
        if (last?.role === "assistant") {
          executeSmartAction(address, last.intent, (href) => router.push(href));
        }
      } catch (err) {
        if (loadTokenRef.current !== token) return;
        console.error("MPGR Agent: regenerate failed", err);
        setError(GENERATION_ERROR_MESSAGE);
      } finally {
        if (loadTokenRef.current === token) setThinking(false);
      }
    }, THINKING_DELAY_MIN_MS);
  }, [address, thinking, context, router]);

  const sendFeedback = useCallback(
    (messageId: string, feedback: AgentFeedback) => {
      if (!address) return;
      const token = loadTokenRef.current;
      (async () => {
        const updated = await agentAIService.setFeedback(address, messageId, feedback);
        if (loadTokenRef.current !== token) return;
        setMessages(updated.messages);
      })();
    },
    [address]
  );

  const dismissError = useCallback(() => setError(null), []);

  const clearChat = useCallback(() => {
    if (!address) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setThinking(false);
    setError(null);
    const token = loadTokenRef.current;
    (async () => {
      const cleared = await agentAIService.clear(address);
      if (loadTokenRef.current !== token) return;
      setMessages(cleared.messages);
    })();
  }, [address]);

  // Phase 3A.6
  const clearHistory = useCallback(() => {
    if (!address) return;
    (async () => {
      await clearActionHistory(address);
      setActionHistory([]);
    })();
  }, [address]);

  const selectPaletteCommand = useCallback(
    (command: SlashCommand) => {
      commandPalette.close();
      executeCommand(`/${command.name}`);
    },
    [commandPalette, executeCommand]
  );

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
    // Phase 3A.6 additions
    commandPalette,
    selectPaletteCommand,
    actionHistory,
    clearHistory,
    streamingMessageId,
    // Phase 3B Part 3 addition
    personalization,
  };
}
