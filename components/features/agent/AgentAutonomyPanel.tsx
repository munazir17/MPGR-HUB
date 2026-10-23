"use client";

// components/features/agent/AgentAutonomyPanel.tsx
//
// Autonomous Agent Runtime — MINIMAL UI (spec §19). A collapsible drawer
// rendered outside the chat stage through the shared trading launcher. It contains exactly what the spec
// asks for and nothing more:
//
//   1. MODE DISPLAY   — whether the runtime is available, and that it is
//                       OFF until the user authorizes a goal.
//   2. GOAL LIST      — pause / resume / cancel + per-goal limits editing
//                       (cooldown, trade cap) and live status/result lines.
//   3. EXECUTION HIST — recent actions per goal (outcome, verified, link).
//   4. AUTHORIZATIONS — active policies with revoke.
//   5. AUTHORIZATION  — the MANUAL entry point for autonomous trading:
//                       an explicit form the user fills from scratch.
//                       Chat-created drafts are reviewed in
//                       AgentAutonomyDraftReview, not here.
//
// No raw MCP/RPC JSON is ever rendered; amounts are human-readable; keys
// and signatures never appear here (watch mode only, signing stays in the
// existing user-signature flow).

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, PenLine, Repeat, ShieldCheck, ShieldOff, X } from "lucide-react";
import { clsx } from "clsx";
import {
  useAgentAutonomy,
  type AutonomyConfig,
  type AutonomyGoalView,
  type AutonomyTokenOption,
} from "@/hooks/useAgentAutonomy";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@/lib/executor/executor-config";
import { findLiveSlotBoundToGoal } from "@/lib/autonomy/draft-activation";
import { formatTokenAmount } from "@/lib/format";
import {
  autonomyDraftToForm,
  autonomyFormToDraftInput,
  type AutonomyAuthorizeFormState,
} from "./autonomy-authorize-form";

interface AgentAutonomyPanelProps {
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Inside the Conditional goals section: no second header, no essay. */
  embedded?: boolean;
  commandNotice?: string | null;
  autonomy: ReturnType<typeof useAgentAutonomy>;
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  WAITING: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  EXECUTING: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  PAUSED: "bg-white/[0.06] text-muted ring-white/15",
  COMPLETED: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  FAILED: "bg-red-500/10 text-red-300 ring-red-400/30",
  EXPIRED: "bg-white/[0.06] text-muted ring-white/15",
  CANCELLED: "bg-white/[0.06] text-muted ring-white/15",
  DRAFT: "bg-white/[0.06] text-muted ring-white/15",
};

const OUTCOME_LABEL: Record<string, string> = {
  CONDITION_NOT_MET: "Condition not met",
  POLICY_REJECTED: "Blocked by your limits",
  AUTHORIZATION_MISSING: "Authorization missing",
  TRADE_EXECUTED: "Trade submitted",
  VERIFIED: "Trade verified",
  WAITING_VERIFICATION: "Awaiting confirmation",
  FAILED: "Failed",
  EXPIRED: "Expired",
};

function tokenOf(tokens: AutonomyTokenOption[], address: string): AutonomyTokenOption | undefined {
  return tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

function humanAmount(tokens: AutonomyTokenOption[], address: string, raw: string): string {
  const token = tokenOf(tokens, address);
  if (!token) return raw;
  try {
    const value = BigInt(raw) / 10n ** BigInt(token.decimals);
    const remainder = BigInt(raw) % 10n ** BigInt(token.decimals);
    const fraction = remainder === 0n ? "" : `.${remainder.toString().padStart(token.decimals, "0").replace(/0+$/, "")}`;
    return `${value}${fraction}`;
  } catch {
    return formatTokenAmount(raw);
  }
}

/** Network identity comes from the runtime status payload, never a UI default. */
function delegatedNetworkLabel(config: AutonomyConfig): string {
  const chainId = config.delegated?.chainId;
  if (chainId == null) return "No adapter configured";
  const network = chainId === BASE_MAINNET_CHAIN_ID
    ? "Base Mainnet"
    : chainId === BASE_SEPOLIA_CHAIN_ID
      ? "Base Sepolia"
      : `Chain ${chainId}`;
  return `${network} · Chain ID ${chainId}`;
}

/**
 * Keep adapter selection/configuration separate from permission to execute.
 * In particular, executionAvailable is false on Mainnet while the explicit
 * production gate is OFF; that is watch-only by design, not a missing adapter.
 */
function delegatedExecutionStatus(config: AutonomyConfig): string {
  const chainId = config.delegated?.chainId;
  if (chainId == null) return "Not configured · no delegated adapter is selected.";
  if (!config.delegated?.executor) return "Not configured · no executor is pinned for this network.";
  if (config.emergencyDisabled) return "Emergency disable active · execution blocked.";
  if (chainId === BASE_MAINNET_CHAIN_ID && config.productionGate === false) {
    return "Watch-only · production gate OFF.";
  }
  if (chainId === BASE_MAINNET_CHAIN_ID && config.productionGate !== true) {
    return "Execution unavailable · production gate status not confirmed.";
  }
  if (config.executionAvailable) return "Execution checks passed.";
  return "Execution unavailable · fail-closed checks are incomplete.";
}

function relative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function GoalSwitch({
  activeCount,
  pausedCount,
  runtimeLabel,
  busy,
  enabled,
  onToggle,
}: {
  activeCount: number;
  pausedCount: number;
  runtimeLabel: string;
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="agent-autonomy-switch">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeCount > 0 ? "bg-good" : "bg-white/30"}`} aria-hidden="true" />
      <span className="text-[11px] font-semibold text-white">Autonomous Goals</span>
      <span className="min-w-0 truncate text-[11px] text-muted">
        {activeCount} on{pausedCount ? ` · ${pausedCount} paused` : ""} · {runtimeLabel}
      </span>
      <button
        type="button"
        data-testid="agent-autonomy-toggle"
        disabled={!enabled || busy}
        onClick={onToggle}
        className="ml-auto min-h-[32px] shrink-0 rounded-lg border border-white/15 bg-white/[0.04] px-3 text-[11px] font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {activeCount > 0 ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}

export function AgentAutonomyPanel({ autonomy, expanded, onExpandedChange, embedded = false, commandNotice = null }: AgentAutonomyPanelProps) {
  const { config, goals, policies, tokens, busy, error, dismissError, pause, resume, cancel, revokePolicy, revokeSlot, signDelegatedSlots, slots, slotsSigningSupported, authorizeGoal, mutate, authenticated, authenticating, signIn, setGoalsArmed } =
    autonomy;
  const [localOpen, setOpen] = useState(false);
  const open = expanded ?? localOpen;
  const [form, setForm] = useState<AutonomyAuthorizeFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [delegatedGoalId, setDelegatedGoalId] = useState("");
  const [delegatedCount, setDelegatedCount] = useState(1);
  const [delegatedMinOut, setDelegatedMinOut] = useState("");
  const [delegatedHours, setDelegatedHours] = useState(24);

  const activeCount = useMemo(() => goals.filter((g) => ["ACTIVE", "WAITING", "EXECUTING"].includes(g.status)).length, [goals]);
  const pausedCount = useMemo(() => goals.filter((g) => g.status === "PAUSED").length, [goals]);
  const runtimeLabel = !config ? "Checking…" : !config.enabled ? "Runtime off" : config.emergencyDisabled ? "Emergency stop" : config.executionAvailable ? "Execution live" : "Checks pending";

  // Manual entry point only — never pre-filled from a chat draft.
  const formState = form ?? autonomyDraftToForm(null, tokens);
  const formDirty = form !== null;
  const setField = (patch: Partial<AutonomyAuthorizeFormState>) => setForm({ ...formState, ...patch });

  const handleAuthorize = async () => {
    if (!formState.sell || !formState.buy) {
      setNotice("Pick both tokens first.");
      return;
    }
    // If the wallet is connected but has no server-side SIWE session,
    // initiate the existing wallet-auth flow first. After successful
    // authentication, automatically continue the authorization the user
    // explicitly requested — signing in alone never auto-authorizes.
    if (!authenticated) {
      const signedIn = await signIn();
      if (!signedIn) return;
    }
    const result = await authorizeGoal(autonomyFormToDraftInput(formState));
    if (result.ok) {
      setForm(null);
      setNotice("Draft saved — awaiting goal-bound authorization. It is not active yet.");
    }
  };

  const symbol = (address: string) => tokenOf(tokens, address)?.symbol ?? "token";

  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-white/[0.02]" data-testid="agent-autonomy-panel">
      {!embedded && (
      <button
        type="button"
        onClick={() => onExpandedChange ? onExpandedChange(!open) : setOpen((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left sm:px-4 md:px-5"
        aria-expanded={open}
      >
        <Repeat className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="text-xs font-semibold text-white">Autonomous Goals</span>
        {config === null ? (
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-muted ring-1 ring-white/10">
            Unavailable
          </span>
        ) : config.emergencyDisabled ? (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300 ring-1 ring-red-400/30">
            Disabled by operator
          </span>
        ) : config.enabled ? (
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-muted ring-1 ring-white/10">
            {activeCount > 0 ? `${activeCount} active / awaiting trigger` : "No active goals"}
          </span>
        ) : null}
        <span className="flex-1" />
        <ChevronDown className={clsx("h-3.5 w-3.5 text-muted transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
      </button>
      )}

      {embedded && (
        <div className="space-y-1 px-3 py-2">
          <GoalSwitch
            activeCount={activeCount}
            pausedCount={pausedCount}
            runtimeLabel={runtimeLabel}
            busy={busy}
            enabled={Boolean(config?.enabled) && !config?.emergencyDisabled && Boolean(setGoalsArmed)}
            onToggle={() => void setGoalsArmed?.(!activeCount)}
          />
          <p className="text-[11px] text-muted">{commandNotice ?? "Chat sets the goal. One signature. Swaps: ETH, cbBTC, DEGEN, VIRTUAL, stocks. Goals: USDC into WETH or a live stock."}</p>
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="max-h-[65dvh] space-y-3 overflow-y-auto px-3 pb-3 sm:px-4 md:px-5">
              {!embedded && (
                <>
                  <GoalSwitch
                    activeCount={activeCount}
                    pausedCount={pausedCount}
                    runtimeLabel={runtimeLabel}
                    busy={busy}
                    enabled={Boolean(config?.enabled) && !config?.emergencyDisabled && Boolean(setGoalsArmed)}
                    onToggle={() => void setGoalsArmed?.(!activeCount)}
                  />
                  <p className="text-[11px] text-muted">{commandNotice ?? "Chat sets the goal. One signature. Turn off pauses every goal. Chat swaps ETH, cbBTC, DEGEN, VIRTUAL, and live stocks. Autonomous goals: USDC into WETH or a live stock."}</p>
                </>
              )}
              {error && (
                <div className="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  <span className="min-w-0 flex-1">{error}</span>
                  <button type="button" onClick={dismissError} aria-label="Dismiss error">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {notice && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{notice}</span>
                  <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* GOALS */}
              {goals.length === 0 ? (
                <p className="text-xs text-muted">No goals yet. Set one in chat, or use the form. Nothing runs until you sign.</p>
              ) : (
                <ul className="space-y-2">
                  {goals.map((goal) => (
                    <GoalRow
                      key={goal.id}
                      goal={goal}
                      symbolFor={symbol}
                      humanFor={(addr, raw) => humanAmount(tokens, addr, raw)}
                      busy={busy}
                      onPause={() => pause(goal.id)}
                      onResume={() => resume(goal.id)}
                      onCancel={() => cancel(goal.id)}
                      onSaveLimits={(patch) =>
                        mutate(goal.id, {
                          action: "limits",
                          ...(patch.cooldownSeconds !== undefined ? { cooldownSeconds: patch.cooldownSeconds } : {}),
                          ...(patch.maxTrades !== undefined ? { maxTrades: patch.maxTrades } : {}),
                        })
                      }
                    />
                  ))}
                </ul>
              )}

              {/* AUTHORIZATIONS */}
              {policies.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Authorizations</p>
                  <ul className="space-y-1.5">
                    {policies.map((policy) => (
                      <li
                        key={policy.id}
                        className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-2 px-3 py-2 text-xs"
                      >
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-white">
                          {symbol(policy.sellToken)} → {symbol(policy.buyToken)} · max {humanAmount(tokens, policy.sellToken, policy.maxPerTradeRaw)}/trade ·{" "}
                          {humanAmount(tokens, policy.sellToken, policy.maxDailyRaw)}/day · expires {new Date(policy.expiresAt).toLocaleDateString()}
                        </span>
                        <button
                          type="button"
                          onClick={() => revokePolicy(policy.id)}
                          disabled={busy}
                          className="flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
                        >
                          <ShieldOff className="h-3 w-3" aria-hidden="true" />
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* DELEGATED EXECUTION (server-selected chain, explicit sign, revocable) */}
              {config?.enabled && (
                <div className="space-y-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.04] p-3" data-testid="delegated-execution-section">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted" data-testid="delegated-execution-network">
                    Delegated execution · {delegatedNetworkLabel(config)}
                  </p>
                  {config.delegated?.executor && (
                    <p className="break-all text-[10px] text-muted">
                      Pinned executor: <code data-testid="delegated-execution-executor">{config.delegated.executor}</code>
                    </p>
                  )}
                  <p className="text-[11px] font-medium text-sky-200" data-testid="delegated-execution-readiness">
                    {delegatedExecutionStatus(config)}
                  </p>
                  <p className="text-[11px] text-muted">Each signed slot runs once. Revoke anytime.</p>

                  {slots.length > 0 && (
                    <ul className="space-y-1.5">
                      {slots.map((slot) => (
                        <li key={slot.id} className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-2 px-3 py-2 text-xs">
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-white">
                            {symbol(slot.sellToken)} → {symbol(slot.buyToken)} · exact {humanAmount(tokens, slot.sellToken, slot.amountRaw)} · min out{" "}
                            {humanAmount(tokens, slot.buyToken, slot.minAmountOutRaw)} · expires {new Date(slot.deadlineIso).toLocaleString()}
                          </span>
                          <span
                            className={clsx(
                              "shrink-0 rounded-full px-2 py-0.5 text-[10px] ring-1",
                              slot.status === "active" && "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
                              slot.status === "consumed" && "bg-white/[0.06] text-muted ring-white/10",
                              slot.status === "revoked" && "bg-red-500/10 text-red-300 ring-red-400/30",
                              slot.status === "expired" && "bg-white/[0.06] text-muted ring-white/10",
                            )}
                          >
                            {slot.status}
                          </span>
                          {(slot.status === "active" || slot.status === "expired") && (
                            <button
                              type="button"
                              onClick={() => revokeSlot(slot.id)}
                              disabled={busy}
                              className="flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
                            >
                              <ShieldOff className="h-3 w-3" aria-hidden="true" />
                              Revoke
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {slots.length === 0 && (
                    <p className="text-[11px] text-muted">No signed slots yet.</p>
                  )}

                  {(() => {
                    const eligibleGoals = goals.filter((g) => {
                      const policy = policies.find((p) => p.id === g.policyId);
                      return (
                        !["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"].includes(g.status) &&
                        policy &&
                        // CHAIN BINDING (MC-1 remediation): a goal is eligible for
                        // delegated pre-authorization when its policy targets a
                        // delegated chain (Base 8453 or Base Sepolia 84532) AND
                        // the server reports a PINNED executor for exactly that
                        // chain. Without a pinned executor the user would be
                        // signing for a contract that does not exist, so the
                        // control is not offered at all.
                        (policy.chainId === 8453 || policy.chainId === 84532) &&
                        config.delegated?.chainId === policy.chainId &&
                        Boolean(config.delegated?.executor) &&
                        !policy.revokedAt &&
                        new Date(policy.expiresAt).getTime() > Date.now()
                      );
                    });
                    // A stale selection simply falls back to the first eligible goal.
                    if (eligibleGoals.length === 0 || config.emergencyDisabled) return null;
                    const goal = eligibleGoals.find((g) => g.id === delegatedGoalId) ?? eligibleGoals[0];
                    const usedCount = slots.filter((s) => s.goalId === goal.id).length;
                    const savedPermission = goal.status === "DRAFT" && !!findLiveSlotBoundToGoal(
                      policies.filter((p) => p.id === goal.policyId), slots.filter((s) => s.policyId === goal.policyId), { id: goal.id, ...goal.trade }, new Date());
                    return (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <label className="col-span-2 space-y-1">
                          <span className="text-muted">Goal to pre-authorize</span>
                          <select
                            value={goal.id}
                            onChange={(e) => setDelegatedGoalId(e.target.value)}
                            className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                          >
                            {eligibleGoals.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.description}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="min-w-0 space-y-1">
                          <span className="text-muted">Slots ({Math.max(0, 5 - usedCount)} unused indexes)</span>
                          <select
                            value={delegatedCount}
                            onChange={(e) => setDelegatedCount(Number(e.target.value))}
                            className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                          >
                            {[1, 2, 3, 4, 5].filter((n) => n <= 5 - usedCount).map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="min-w-0 space-y-1">
                          <span className="text-muted">Expires in</span>
                          <select
                            value={delegatedHours}
                            onChange={(e) => setDelegatedHours(Number(e.target.value))}
                            className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                          >
                            <option value={1}>1 hour</option>
                            <option value={6}>6 hours</option>
                            <option value={24}>24 hours</option>
                            <option value={72}>3 days</option>
                          </select>
                        </label>
                        <label className="col-span-2 space-y-1">
                          <span className="text-muted">
                            Minimum output per trade ({symbol(goal.trade.buyToken)}) — the signed floor
                          </span>
                          <input
                            value={delegatedMinOut}
                            onChange={(e) => setDelegatedMinOut(e.target.value)}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                          />
                        </label>
                        <button
                          type="button"
                          data-testid="delegated-sign-button"
                          disabled={busy || (!savedPermission && (!slotsSigningSupported || usedCount >= 5))}
                          onClick={async () => {
                            const result = await signDelegatedSlots({
                              policyId: goal.policyId,
                              goalId: goal.id,
                              count: delegatedCount,
                              minAmountOutHuman: delegatedMinOut,
                              expiresInHours: delegatedHours,
                            });
                            if (result.ok) {
                              setDelegatedMinOut("");
                              setNotice(savedPermission ? "Activation confirmed with this goal’s saved permission. No new signature was requested." : "Delegated slots signed and registered. Each executes at most once, exactly as signed.");
                            }
                          }}
                          className="col-span-2 flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 text-[11px] font-semibold text-sky-200 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
                        >
                          <PenLine className="h-3 w-3" aria-hidden="true" />
                          {savedPermission ? "Activate with saved permission (no new signature)" : slotsSigningSupported
                            ? `Sign ${delegatedCount} slot${delegatedCount > 1 ? "s" : ""} with wallet`
                            : "Wallet signing unavailable for this executor build"}
                        </button>
                        {usedCount >= 5 && <p className="col-span-2 text-[10px] text-muted">All five goal-bound nonce indexes have been used. Revocation cannot recycle them.</p>}
                        {!slotsSigningSupported && (
                          <p className="col-span-2 text-[10px] leading-relaxed text-muted">
                            The deployed executor&apos;s witness type string is not signable by standard wallets — signing opens
                            automatically once the executor is updated. Everything else (limits, revocation) works today.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* AUTHORIZATION FORM */}
              {config?.enabled && !config.emergencyDisabled && (
                <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3" data-testid="agent-autonomy-manual-form">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    New autonomous goal
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Sell (spend)</span>
                      <select
                        value={formState.sell}
                        onChange={(e) => setField({ sell: e.target.value })}
                        className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="">Select…</option>
                        {tokens.map((t) => (
                          <option key={t.address} value={t.address}>
                            {t.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Buy (receive)</span>
                      <select
                        value={formState.buy}
                        onChange={(e) => setField({ buy: e.target.value })}
                        className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="">Select…</option>
                        {tokens.map((t) => (
                          <option key={t.address} value={t.address}>
                            {t.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Amount per trade</span>
                      <input
                        value={formState.sellAmount}
                        onChange={(e) => setField({ sellAmount: e.target.value })}
                        inputMode="decimal"
                        className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Trigger</span>
                      <span className="flex gap-1">
                        <select
                          value={formState.kind}
                          onChange={(e) => setField({ kind: e.target.value as AutonomyAuthorizeFormState["kind"] })}
                          className="min-w-0 w-full rounded-l-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                        >
                          <option value="price_below">below</option>
                          <option value="price_above">above</option>
                        </select>
                        <input
                          value={formState.threshold}
                          onChange={(e) => setField({ threshold: e.target.value })}
                          inputMode="decimal"
                          placeholder="200"
                          className="min-w-0 w-full rounded-r-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                        />
                      </span>
                    </label>
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Daily cap (spend)</span>
                      <input
                        value={formState.maxDaily}
                        onChange={(e) => setField({ maxDaily: e.target.value })}
                        inputMode="decimal"
                        className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                    <label className="min-w-0 space-y-1">
                      <span className="text-muted">Max trades total</span>
                      <input
                        value={formState.maxTrades}
                        onChange={(e) => setField({ maxTrades: Number(e.target.value) || 0 })}
                        inputMode="numeric"
                        className="min-w-0 w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                  </div>
                  <p className="text-[10px] text-muted">
                    {formState.slippageBps / 100}% slippage · {formState.cooldownSeconds / 60} min cooldown · {formState.ttlDays} day expiry. You sign. MPGR never holds keys.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleAuthorize}
                      disabled={busy}
                      className="min-h-[36px] flex-1 rounded-lg bg-gradient-blue px-3 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {busy && authenticating ? "Signing in…" : busy ? "Working…" : !authenticated ? "Sign in & save draft" : "Save draft (inactive)"}
                    </button>
                    {formDirty && (
                      <button
                        type="button"
                        onClick={() => {
                          setForm(null);
                        }}
                        className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
                      >
                        Discard
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface GoalLimitsPatch {
  cooldownSeconds?: number;
  maxTrades?: number | null;
}

interface GoalRowProps {
  goal: AutonomyGoalView;
  symbolFor: (address: string) => string;
  humanFor: (address: string, raw: string) => string;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onSaveLimits: (patch: GoalLimitsPatch) => Promise<boolean>;
}

function GoalRow({ goal, symbolFor, humanFor, busy, onPause, onResume, onCancel, onSaveLimits }: GoalRowProps) {
  const [editing, setEditing] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState(String(Math.round(goal.cooldownSeconds / 60)));
  const [maxTrades, setMaxTrades] = useState(String(goal.maxTrades ?? ""));
  const [saving, setSaving] = useState(false);

  const amount = humanFor(goal.trade.sellToken, goal.trade.sellAmountRaw);
  const verb = goal.condition.kind === "price_below" ? "Buy" : "Sell";
  const direction = goal.condition.kind === "price_below" ? "below" : "above";
  const canPause = goal.status === "ACTIVE" || goal.status === "WAITING";
  const canResume = goal.status === "PAUSED";
  const canCancel = ["ACTIVE", "WAITING", "PAUSED", "DRAFT"].includes(goal.status);

  const saveLimits = async (patch: GoalLimitsPatch) => {
    setSaving(true);
    const ok = await onSaveLimits(patch);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <li className="space-y-1.5 rounded-xl border border-white/[0.08] bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-medium ring-1", STATUS_STYLES[goal.status] ?? STATUS_STYLES.DRAFT)}>
          {goal.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-white">
          {verb} {amount} {symbolFor(goal.trade.sellToken)} → {symbolFor(goal.trade.buyToken)} when price {direction} {goal.condition.threshold}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
        <span>
          {goal.stats.triggered} triggered · {goal.stats.verified} verified
        </span>
        <span>
          checks ≥ {Math.round(goal.cooldownSeconds / 60)} min apart
          {goal.maxTrades ? ` · stops after ${goal.maxTrades} trades` : ""}
        </span>
        <span>· expires {new Date(goal.expiresAt).toLocaleDateString()}</span>
      </div>

      {goal.lastResult && (
        <p className="text-[10px] text-muted">
          Last check {relative(goal.lastResult.at)}: {OUTCOME_LABEL[goal.lastResult.outcome] ?? goal.lastResult.outcome}
          {goal.lastResult.message ? ` — ${goal.lastResult.message}` : ""}
        </p>
      )}

      {goal.pendingTxHash && goal.lastResult?.outcome === "WAITING_VERIFICATION" && (
        <p className="text-[10px] text-amber-300">
          Verifying transaction…{" "}
          <a
            href={`https://basescan.org/tx/${goal.pendingTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-glow underline"
          >
            View on BaseScan
          </a>
        </p>
      )}

      {goal.recentActions && goal.recentActions.length > 0 && (
        <details className="text-[10px] text-muted">
          <summary className="cursor-pointer select-none">Recent activity ({goal.recentActions.length})</summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {goal.recentActions.slice(0, 5).map((action, i) => (
              <li key={`${action.createdAt}-${i}`} className="flex items-center gap-1.5">
                <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", action.verified ? "bg-emerald-400" : action.status === "FAILED" ? "bg-red-400" : "bg-white/30")} />
                <span className="truncate">
                  {relative(action.createdAt)} — {OUTCOME_LABEL[action.outcome] ?? action.outcome}
                  {action.failureCode ? ` (${action.failureCode})` : ""}
                  {action.txHash && (
                    <>
                      {" "}
                      <a href={`https://basescan.org/tx/${action.txHash}`} target="_blank" rel="noopener noreferrer" className="text-primary-glow underline">
                        tx
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {canPause && (
          <button type="button" onClick={onPause} disabled={busy} className="min-h-[28px] rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-white/[0.2] hover:text-white disabled:opacity-50">
            Pause
          </button>
        )}
        {canResume && (
          <button type="button" onClick={onResume} disabled={busy} className="min-h-[28px] rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-white/[0.2] hover:text-white disabled:opacity-50">
            Resume
          </button>
        )}
        {canCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[28px] rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-50">
            Cancel
          </button>
        )}
        {editing ? (
          <span className="flex flex-wrap items-center gap-1">
            <input
              value={cooldownMinutes}
              onChange={(e) => setCooldownMinutes(e.target.value)}
              inputMode="numeric"
              aria-label="Minutes between checks"
              className="h-7 w-16 rounded-lg border border-white/[0.1] bg-surface-2 px-2 text-[11px] text-white"
            />
            <span className="text-[10px] text-muted">min</span>
            <input
              value={maxTrades}
              onChange={(e) => setMaxTrades(e.target.value)}
              inputMode="numeric"
              aria-label="Max total trades"
              className="h-7 w-16 rounded-lg border border-white/[0.1] bg-surface-2 px-2 text-[11px] text-white"
            />
            <span className="text-[10px] text-muted">trades max</span>
            <button
              type="button"
              disabled={busy || saving}
              onClick={() =>
                saveLimits({
                  cooldownSeconds: Math.round(Number(cooldownMinutes) * 60),
                  maxTrades: maxTrades.trim() === "" ? null : Number(maxTrades),
                })
              }
              className="min-h-[28px] rounded-lg bg-gradient-blue px-2 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </span>
        ) : (
          canCancel && (
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className="min-h-[28px] rounded-lg border border-white/[0.08] px-2 text-[11px] text-muted transition-colors hover:border-white/[0.2] hover:text-white disabled:opacity-50">
              Edit limits
            </button>
          )
        )}
      </div>
    </li>
  );
}
