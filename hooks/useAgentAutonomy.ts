"use client";

// hooks/useAgentAutonomy.ts
//
// Client seam for the Autonomous Agent Runtime UI (spec §19). Strictly
// read/control only: the hook lists goals and policies, pauses / resumes /
// cancels, submits an explicit authorization, and runs a bounded heartbeat
// tick. It NEVER receives key material and shows no raw MCP / RPC payloads.
//
// Phase 2 (delegated execution, Base Sepolia): the hook also lists bounded
// Permit2 authorization SLOTS, revokes them, and — only when the user
// presses the explicit sign button — asks the CONNECTED USER WALLET to sign
// pre-authorized single-trade slots. The only signature involved is the
// user's own, over exactly the bounded details shown in the UI.
//
// The heartbeat only runs when ALL of these hold:
//   * the runtime is enabled server-side (config.enabled),
//   * the wallet has at least one non-terminal goal,
//   * the tab is visible.
// Interval is fixed at 60s (the server's own cooldown floor) — the runtime
// enforces its own bounds regardless.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import {
  delegatedActionId,
  delegatedChainLabel,
  delegatedPermitNonce,
  delegatedPermitTypedData,
  delegatedPolicyHash,
  isDelegatedChainId,
} from "@/lib/executor/delegated-executor";

export interface AutonomyConfig {
  enabled: boolean;
  emergencyDisabled: boolean;
  executionAvailable: boolean;
  /**
   * Per-chain delegated capability reported by the server. `executor` is the
   * PINNED delegated contract the user's signature must name as Permit2
   * spender — on Base mainnet it is operator-supplied, so the client cannot
   * know it any other way. `null` means delegated execution is not deployed on
   * that chain and slots must not be offered (the server refuses them too).
   */
  delegated?: {
    chainId: number | null;
    executor: string | null;
    walletSigningSupported: boolean;
  };
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
  chainId: number;
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

/** Public view of a delegated authorization slot (never carries the signature). */
export interface DelegatedSlotView {
  id: string;
  policyId: string;
  goalId: string;
  slotIndex: number;
  chainId: number;
  wallet: string;
  sellToken: string;
  amountRaw: string;
  buyToken: string;
  minAmountOutRaw: string;
  deadline: number;
  deadlineIso: string;
  status: "active" | "consumed" | "revoked" | "expired";
  consumedAt: string | null;
  consumedByTxHash: string | null;
  revokedAt: string | null;
  createdAt: string;
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

export interface DelegatedSlotsInput {
  policyId: string;
  goalId: string;
  /** How many slots to sign (bounded server-side by MAX_DELEGATED_SLOTS). */
  count: number;
  /** Human-unit minimum output PER TRADE — the signed floor. */
  minAmountOutHuman: string;
  /** Slot expiry in hours (capped by the policy expiry server-side). */
  expiresInHours: number;
}

export function useAgentAutonomy() {
  const { address, chainId: connectedChainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { authenticated: walletAuthenticated, authenticating: walletAuthenticating, authenticate: walletAuthenticate } = useWalletAuth();
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [goals, setGoals] = useState<AutonomyGoalView[]>([]);
  const [policies, setPolicies] = useState<AutonomyPolicyView[]>([]);
  const [slots, setSlots] = useState<DelegatedSlotView[]>([]);
  const [slotsSigningSupported, setSlotsSigningSupported] = useState(false);
  const [tokens, setTokens] = useState<AutonomyTokenOption[]>([]);
  const [draft, setDraft] = useState<AutonomyGoalDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walletKey = address?.toLowerCase();
  const hasPendingRef = useRef(false);
  const tokensFetchedRef = useRef(false);
  const loadedWalletRef = useRef<string | undefined>(undefined);

  /**
   * Ensure the connected wallet has a valid server-side SIWE session before
   * making any authenticated API call. Returns true when the session is
   * ready (already existed or just established); false when the wallet is
   * not connected or the sign-in flow failed/was cancelled. This mirrors
   * the same pattern used by useCampaign and prevents "Authentication
   * required" errors from silently hitting the autonomy API routes.
   */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (walletAuthenticated) return true;
    return walletAuthenticate();
  }, [walletAuthenticated, walletAuthenticate]);

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
      setSlots([]);
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
      const [policyRes, slotsRes] = await Promise.all([
        fetchWithSession("/api/agent/autonomy/policy", { method: "GET" }).then((r) => r.json()).catch(() => null),
        fetchWithSession("/api/agent/autonomy/authorization", { method: "GET" }).then((r) => r.json()).catch(() => null),
      ]);
      if (policyRes && Array.isArray(policyRes.policies)) setPolicies(policyRes.policies as AutonomyPolicyView[]);
      if (slotsRes && Array.isArray(slotsRes.slots)) {
        setSlots(slotsRes.slots as DelegatedSlotView[]);
        setSlotsSigningSupported(slotsRes.walletSigningSupported === true);
      }
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

  // A chat turn that produced a REVIEW-ONLY goal draft opens the dedicated
  // draft review UI (not the manual Autonomous Goals panel). Nothing here
  // authorizes anything — the user still has to press the explicit
  // authorize button in that review.
  const openWithDraft = useCallback((next: AutonomyGoalDraft) => setDraft(next), []);
  const clearDraft = useCallback(() => setDraft(null), []);

  const mutate = useCallback(
    async (goalId: string, body: Record<string, unknown>, method: "PATCH" | "DELETE" = "PATCH") => {
      setBusy(true);
      setError(null);
      try {
        if (!(await ensureSession())) {
          setError("Sign in with your wallet first.");
          return false;
        }
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
    [refresh, ensureSession],
  );

  const pause = useCallback((goalId: string) => mutate(goalId, { action: "pause" }), [mutate]);
  const resume = useCallback((goalId: string) => mutate(goalId, { action: "resume" }), [mutate]);
  const cancel = useCallback((goalId: string) => mutate(goalId, { action: "cancel" }, "DELETE"), [mutate]);

  const revokePolicy = useCallback(
    async (policyId: string) => {
      setBusy(true);
      setError(null);
      try {
        if (!(await ensureSession())) {
          setError("Sign in with your wallet first.");
          return false;
        }
        const res = await fetchWithSession(`/api/agent/autonomy/policy?id=${encodeURIComponent(policyId)}`, { method: "DELETE" });
        if (!res.ok) setError("The authorization could not be revoked right now.");
        await refresh();
        return res.ok;
      } finally {
        setBusy(false);
      }
    },
    [refresh, ensureSession],
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
        // The autonomy API routes require a live SIWE session. If the wallet
        // is connected but has no server session (the user never signed in),
        // initiate the existing wallet-auth flow first. After successful
        // authentication, the authorization proceeds — the user still had to
        // press the explicit "Authorize & activate goal" button, and signing
        // in alone never auto-authorizes anything.
        if (!(await ensureSession())) {
          const message = "Sign in with your wallet to authorize this goal.";
          setError(message);
          return { ok: false, message };
        }
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
    [refresh, ensureSession],
  );

  /** Revoke a delegated authorization slot (server enforces ownership). */
  const revokeSlot = useCallback(
    async (slotId: string) => {
      setBusy(true);
      setError(null);
      try {
        if (!(await ensureSession())) {
          setError("Sign in with your wallet first.");
          return false;
        }
        const res = await fetchWithSession(`/api/agent/autonomy/authorization?id=${encodeURIComponent(slotId)}`, { method: "DELETE" });
        if (!res.ok) setError("The authorization slot could not be revoked right now.");
        await refresh();
        return res.ok;
      } finally {
        setBusy(false);
      }
    },
    [refresh, ensureSession],
  );

  /**
   * Explicit delegated-slot signing: builds the canonical Permit2 witness
   * typed data for EXACTLY the bounded details the UI shows, asks the
   * connected USER wallet to sign, and registers the slots server-side
   * (which re-validates everything and recovers the signature). The server
   * never sees a private key and the runtime can only ever broadcast what
   * these slots literally say.
   */
  // Hoisted to plain locals so the memo dependency list below stays
  // compiler-friendly. `delegatedExecutor` is the PINNED contract the user's
  // signature names as Permit2 spender, so it is a genuine dependency: a stale
  // callback could sign against an outdated executor.
  const delegatedChainId = config?.delegated?.chainId ?? null;
  const delegatedExecutor = config?.delegated?.executor ?? null;

  const signDelegatedSlots = useCallback(
    async (input: DelegatedSlotsInput): Promise<{ ok: boolean; message?: string }> => {
      const wallet = address;
      if (!wallet) return { ok: false, message: "Connect your wallet first." };
      if (!(await ensureSession())) {
        return { ok: false, message: "Sign in with your wallet to sign delegated slots." };
      }
      const policy = policies.find((p) => p.id === input.policyId);
      const goal = goals.find((g) => g.id === input.goalId);
      if (!policy || !goal) return { ok: false, message: "Pick the goal to authorize." };

      // CHAIN BINDING (MC-1 remediation). The signature is produced over the
      // POLICY'S OWN chain, with the executor the SERVER pinned for that chain
      // as the Permit2 spender. The client cannot invent or substitute that
      // address: on Base mainnet it is operator-supplied and only knowable from
      // the config endpoint, and a signature over the wrong chain/spender
      // simply fails server-side recovery.
      const chainId = policy.chainId;
      if (!isDelegatedChainId(chainId)) {
        return { ok: false, message: "This policy's chain does not support delegated authorization." };
      }
      const chainLabel = delegatedChainLabel(chainId);
      // Only the executor the server pinned for EXACTLY this chain may be used.
      const executor = delegatedChainId === chainId ? delegatedExecutor : null;
      if (!executor) {
        return {
          ok: false,
          message: `Delegated execution is not deployed on ${chainLabel} yet, so slots cannot be signed for it. Your goal stays watch-only.`,
        };
      }
      if (connectedChainId !== undefined && connectedChainId !== chainId) {
        return { ok: false, message: `Switch your wallet to ${chainLabel} to sign delegated slots.` };
      }
      const buyTokenDecimals = tokens.find((t) => t.address.toLowerCase() === goal.trade.buyToken.toLowerCase())?.decimals;
      if (!buyTokenDecimals) return { ok: false, message: "Token details are still loading — try again." };
      const cleaned = input.minAmountOutHuman.trim();
      if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === ".") {
        return { ok: false, message: "Enter the minimum output per trade." };
      }
      const [whole = "0", frac = ""] = cleaned.split(".");
      const fracPadded = frac.padEnd(buyTokenDecimals, "0").slice(0, buyTokenDecimals);
      const minAmountOut = BigInt(whole + fracPadded);
      if (minAmountOut <= 0n) return { ok: false, message: "The minimum output must be above zero." };
      const count = Math.max(1, Math.min(5, Math.floor(input.count)));
      const deadlineCap = Math.floor(new Date(policy.expiresAt).getTime() / 1000);
      const deadline = Math.min(Math.floor(Date.now() / 1000) + Math.floor(input.expiresInHours * 3600), deadlineCap);
      if (deadline <= Math.floor(Date.now() / 1000)) return { ok: false, message: "This policy has already expired." };
      const usedIndexes = new Set(slots.filter((s) => s.policyId === input.policyId && !s.revokedAt && !s.consumedAt).map((s) => s.slotIndex));
      const free = [0, 1, 2, 3, 4].filter((i) => !usedIndexes.has(i)).slice(0, count);
      if (free.length === 0) return { ok: false, message: "No free authorization slots left for this policy — revoke one first." };

      setBusy(true);
      setError(null);
      try {
        const payloadSlots = free.map((slotIndex) => {
          const permit = {
            token: policy.sellToken as `0x${string}`,
            amount: goal.trade.sellAmountRaw, // EXACT goal trade amount (base units, decimal string)
            nonce: delegatedPermitNonce(input.goalId, slotIndex), // deterministic Permit2 nonce
            deadline, // unix seconds
          };
          const witness = {
            owner: (wallet.toLowerCase() as `0x${string}`),
            buyToken: policy.buyToken as `0x${string}`,
            minAmountOut: minAmountOut.toString(),
            deadline,
            actionId: delegatedActionId(input.goalId),
            policyHash: delegatedPolicyHash({
              id: policy.id,
              wallet: (wallet.toLowerCase() as `0x${string}`),
              chainId,
              sellToken: policy.sellToken as `0x${string}`,
              buyToken: policy.buyToken as `0x${string}`,
              maxPerTradeRaw: policy.maxPerTradeRaw,
              maxSlippageBps: policy.maxSlippageBps,
              expiresAt: policy.expiresAt,
            }),
          };
          return { slotIndex, permit, witness };
        });
        const signed = [];
        for (const item of payloadSlots) {
          const typed = delegatedPermitTypedData({ permit: item.permit, witness: item.witness }, chainId, executor as `0x${string}`);
          const signature = await signTypedDataAsync({ ...typed, domain: { ...typed.domain, chainId: BigInt(chainId) } } as Parameters<typeof signTypedDataAsync>[0]);
          signed.push({
            slotIndex: item.slotIndex,
            permit: {
              token: item.permit.token,
              amount: item.permit.amount.toString(),
              nonce: item.permit.nonce.toString(),
              deadline: Number(item.permit.deadline),
            },
            witness: {
              owner: item.witness.owner,
              buyToken: item.witness.buyToken,
              minAmountOut: item.witness.minAmountOut.toString(),
              deadline: Number(item.witness.deadline),
              actionId: item.witness.actionId,
              policyHash: item.witness.policyHash,
            },
            signature,
          });
        }
        const res = await fetchWithSession("/api/agent/autonomy/authorization", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policyId: input.policyId, goalId: input.goalId, slots: signed }),
        });
        const payload2 = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        if (!res.ok) {
          const detail = payload2?.error ?? "The authorization could not be registered.";
          setError(detail);
          return { ok: false, message: detail };
        }
        await refresh();
        return { ok: true };
      } catch (signError) {
        const message = signError instanceof Error && signError.message ? signError.message : "Signing was cancelled or failed.";
        setError(message);
        return { ok: false, message };
      } finally {
        setBusy(false);
      }
    },
    [address, delegatedChainId, delegatedExecutor, connectedChainId, ensureSession, goals, policies, refresh, signTypedDataAsync, slots, tokens],
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
    revokeSlot,
    signDelegatedSlots,
    slots,
    slotsSigningSupported,
    authorizeGoal,
    mutate,
    draft,
    openWithDraft,
    clearDraft,
    authenticated: walletAuthenticated,
    authenticating: walletAuthenticating,
    signIn: walletAuthenticate,
    ensureSession,
  };
}
