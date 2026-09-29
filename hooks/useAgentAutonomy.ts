"use client";

// hooks/useAgentAutonomy.ts
//
// Client seam for the Autonomous Agent Runtime UI (spec §19). Strictly
// read/control only: the hook lists goals and policies, pauses / resumes /
// cancels, submits an explicit authorization, and runs a bounded heartbeat
// tick. It NEVER receives key material, never signs, and shows no raw MCP /
// RPC payloads.
//
// The heartbeat only runs when ALL of these hold:
//   * the runtime is enabled server-side (config.enabled),
//   * the wallet has at least one non-terminal goal,
//   * the tab is visible.
// Interval is fixed at 60s (the server's own cooldown floor) — the runtime
// enforces its own bounds regardless.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";

export interface AutonomyConfig {
  enabled: boolean;
  emergencyDisabled: boolean;
  executionAvailable: boolean;
  limits: {
    maxGoalsPerWallet: number;
    minCooldownSeconds: number;
    maxPolicyTtlDays: number;
    maxPerTradeHuman: string;
    maxDailyHuman: string;
    maxSlippageBps: number;
  };
}

export interface AutonomyGoalView {
  id: string;
  policyId: string;
  description: string;
  status: string;
  condition: { kind: string; threshold: string };
  trade: { sellToken: string; buyToken: string; sellAmountRaw: string; slippageBps: number };
  cooldownSeconds: number;
  maxTrades: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  nextEvaluationAt: string;
  lastEvaluationAt: string | null;
  lastAction: string | null;
  lastResult: { at: string; outcome: string; code: string | null; message: string } | null;
  pendingTxHash: string | null;
  stats: { evaluations: number; triggered: number; verified: number; consecutiveFailures: number };
  recentActions?: Array<{ status: string; outcome: string; verified: boolean; txHash: string | null; failureCode: string | null; createdAt: string }>;
}

export interface AutonomyPolicyView {
  id: string;
  sellToken: string;
  buyToken: string;
  maxPerTradeRaw: string;
  maxDailyRaw: string;
  maxSlippageBps: number;
  maxActionsPerDay: number;
  enabled: boolean;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AutonomyTokenOption {
  address: string;
  symbol: string;
  decimals: number;
}

const HEARTBEAT_MS = 60_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"]);

/** Goal counts for the agent's autonomous-status reply — total and non-terminal. */
export function summarizeAutonomyGoals(goals: AutonomyGoalView[]): { total: number; active: number } {
  return { total: goals.length, active: goals.filter((g) => !TERMINAL.has(g.status)).length };
}

export interface AgentAutonomyDraftInput {
  sellToken: string;
  buyToken: string;
  maxPerTrade: string;
  maxDaily: string;
  maxSlippageBps: number;
  maxActionsPerDay: number;
  ttlDays: number;
  condition: { kind: "price_below" | "price_above"; threshold: string };
  sellAmount: string;
  cooldownSeconds: number;
  maxTrades?: number;
  description?: string;
}

export function useAgentAutonomy() {
  const { address } = useAccount();
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [goals, setGoals] = useState<AutonomyGoalView[]>([]);
  const [policies, setPolicies] = useState<AutonomyPolicyView[]>([]);
  const [tokens, setTokens] = useState<AutonomyTokenOption[]>([]);
  const [draft, setDraft] = useState<AutonomyGoalDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walletKey = address?.toLowerCase();
  const hasPendingRef = useRef(false);
  const tokensFetchedRef = useRef(false);
  const loadedWalletRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!walletKey) return;
    // Wallet switched (or first load): drop the previous wallet's state
    // before applying the fresh fetch so stale goals/policies never
    // flash. The reset happens in the async continuation (never
    // synchronously inside an effect), and a stale in-flight refresh for
    // a previous wallet is discarded.
    const walletChanged = loadedWalletRef.current !== walletKey;
    loadedWalletRef.current = walletKey;
    const [configRes, goalsRes] = await Promise.all([
      fetchWithSession("/api/agent/autonomy/config", { method: "GET" }).then((r) => r.json()).catch(() => null),
      fetchWithSession("/api/agent/autonomy/goals", { method: "GET" }).then((r) => r.json()).catch(() => null),
    ]);
    if (loadedWalletRef.current !== walletKey) return; // a newer wallet took over
    if (walletChanged) {
      setConfig(null);
      setGoals([]);
      setPolicies([]);
      setTokens([]);
      tokensFetchedRef.current = false;
      hasPendingRef.current = false;
      setError(null);
    }
    if (configRes && typeof configRes.enabled === "boolean") setConfig(configRes as AutonomyConfig);
    if (configRes?.enabled && !tokensFetchedRef.current) {
      const tokensRes = await fetchWithSession("/api/agent/autonomy/tokens", { method: "GET" }).then((r) => r.json()).catch(() => null);
      if (tokensRes && Array.isArray(tokensRes.tokens)) {
        tokensFetchedRef.current = true;
        setTokens(tokensRes.tokens as AutonomyTokenOption[]);
      }
    }
    if (goalsRes && Array.isArray(goalsRes.goals)) {
      const list = goalsRes.goals as AutonomyGoalView[];
      setGoals(list);
      hasPendingRef.current = list.some((g) => !TERMINAL.has(g.status) || g.pendingTxHash);
      const policyRes = await fetchWithSession("/api/agent/autonomy/policy", { method: "GET" }).then((r) => r.json()).catch(() => null);
      if (policyRes && Array.isArray(policyRes.policies)) setPolicies(policyRes.policies as AutonomyPolicyView[]);
    } else {
      setGoals([]);
    }
  }, [walletKey]);

  useEffect(() => {
    // Load session-scoped autonomy state (an external system: the API +
    // Redis store) whenever the wallet changes. All setState calls run in
    // async continuations of refresh(), never synchronously in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // A chat turn that produced a REVIEW-ONLY goal draft can open the panel
  // pre-filled. Nothing here authorizes anything — the user still has to
  // press the explicit authorize button in the panel.
  const openWithDraft = useCallback((next: AutonomyGoalDraft) => setDraft(next), []);
  const clearDraft = useCallback(() => setDraft(null), []);

  const mutate = useCallback(
    async (goalId: string, body: Record<string, unknown>, method: "PATCH" | "DELETE" = "PATCH") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchWithSession(`/api/agent/autonomy/goals/${encodeURIComponent(goalId)}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}),
        });
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) setError(payload?.error ?? "That action could not be completed.");
        await refresh();
        return res.ok;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const pause = useCallback((goalId: string) => mutate(goalId, { action: "pause" }), [mutate]);
  const resume = useCallback((goalId: string) => mutate(goalId, { action: "resume" }), [mutate]);
  const cancel = useCallback((goalId: string) => mutate(goalId, { action: "cancel" }, "DELETE"), [mutate]);

  const revokePolicy = useCallback(
    async (policyId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchWithSession(`/api/agent/autonomy/policy?id=${encodeURIComponent(policyId)}`, { method: "DELETE" });
        if (!res.ok) setError("The authorization could not be revoked right now.");
        await refresh();
        return res.ok;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /**
   * Explicit two-step authorization: create the policy (with the explicit
   * authorized flag) and then bind a goal to it. The server re-validates
   * everything deterministically; this call is the user's opt-in.
   */
  const authorizeGoal = useCallback(
    async (draft: AgentAutonomyDraftInput): Promise<{ ok: boolean; message?: string }> => {
      setBusy(true);
      setError(null);
      try {
        const policyRes = await fetchWithSession("/api/agent/autonomy/policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, authorized: true }),
        });
        const policyPayload = (await policyRes.json().catch(() => null)) as { policy?: { id: string }; error?: string; details?: string[] } | null;
        if (!policyRes.ok || !policyPayload?.policy) {
          const detail = policyPayload?.details?.join(" ") ?? policyPayload?.error ?? "Authorization could not be created.";
          setError(detail);
          return { ok: false, message: detail };
        }
        const goalRes = await fetchWithSession("/api/agent/autonomy/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            policyId: policyPayload.policy.id,
            condition: draft.condition,
            sellAmount: draft.sellAmount,
            cooldownSeconds: draft.cooldownSeconds,
            maxTrades: draft.maxTrades,
            description: draft.description,
          }),
        });
        const goalPayload = (await goalRes.json().catch(() => null)) as { error?: string; details?: string[] } | null;
        if (!goalRes.ok) {
          const detail = goalPayload?.details?.join(" ") ?? goalPayload?.error ?? "The goal could not be created.";
          setError(detail);
          return { ok: false, message: detail };
        }
        await refresh();
        return { ok: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Bounded heartbeat — see the header comment for the exact conditions.
  useEffect(() => {
    if (!config?.enabled || !walletKey || !hasPendingRef.current) return;
    let stopped = false;
    const beat = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void fetchWithSession("/api/agent/autonomy/tick", { method: "POST" })
        .then(() => refresh())
        .catch(() => {});
    };
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [config?.enabled, walletKey, goals, refresh]);

  return {
    config,
    goals,
    policies,
    tokens,
    busy,
    error,
    dismissError: useCallback(() => setError(null), []),
    refresh,
    pause,
    resume,
    cancel,
    revokePolicy,
    authorizeGoal,
    mutate,
    draft,
    openWithDraft,
    clearDraft,
  };
}
