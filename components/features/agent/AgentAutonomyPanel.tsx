"use client";

// components/features/agent/AgentAutonomyPanel.tsx
//
// Autonomous Agent Runtime — MINIMAL UI (spec §19). A collapsible drawer
// rendered below the chat stage body. It contains exactly what the spec
// asks for and nothing more:
//
//   1. MODE DISPLAY   — whether the runtime is available, and that it is
//                       OFF until the user authorizes a goal.
//   2. GOAL LIST      — pause / resume / cancel + per-goal limits editing
//                       (cooldown, trade cap) and live status/result lines.
//   3. EXECUTION HIST — recent actions per goal (outcome, verified, link).
//   4. AUTHORIZATIONS — active policies with revoke.
//   5. AUTHORIZATION  — the ONLY place autonomous trading is activated:
//                       an explicit form pre-filled from a chat draft.
//
// No raw MCP/RPC JSON is ever rendered; amounts are human-readable; keys
// and signatures never appear here (watch mode only, signing stays in the
// existing user-signature flow).

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Repeat, ShieldCheck, ShieldOff, X } from "lucide-react";
import { clsx } from "clsx";
import {
  useAgentAutonomy,
  type AutonomyGoalView,
  type AutonomyTokenOption,
} from "@/hooks/useAgentAutonomy";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { formatTokenAmount } from "@/lib/format";

interface AgentAutonomyPanelProps {
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

function relative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface AuthorizeFormState {
  sell: string;
  buy: string;
  sellAmount: string;
  threshold: string;
  kind: "price_below" | "price_above";
  maxDaily: string;
  slippageBps: number;
  maxTrades: number;
  cooldownSeconds: number;
  ttlDays: number;
}

function draftToForm(draft: AutonomyGoalDraft | null, tokens: AutonomyTokenOption[]): AuthorizeFormState {
  const usdc = tokens.find((t) => t.symbol.toUpperCase() === "USDC");
  const target =
    draft && tokens.find((t) => t.symbol.toLowerCase() === draft.targetAsset.toLowerCase());
  const spend =
    draft && tokens.find((t) => t.symbol.toLowerCase() === draft.spendAsset.toLowerCase());
  const sellAmount = draft?.amountPerTrade ?? "50";
  const perTrade = Number(sellAmount);
  return {
    sell: spend?.address ?? usdc?.address ?? "",
    buy: target?.address ?? "",
    sellAmount,
    threshold: draft?.triggerPrice ?? "",
    kind: draft?.triggerKind ?? "price_below",
    maxDaily: Number.isFinite(perTrade) && perTrade > 0 ? String(Math.max(perTrade * 2, 10)) : "100",
    slippageBps: 100,
    maxTrades: 10,
    cooldownSeconds: 3600,
    ttlDays: 30,
  };
}

export function AgentAutonomyPanel({ autonomy }: AgentAutonomyPanelProps) {
  const { config, goals, policies, tokens, busy, error, dismissError, refresh, pause, resume, cancel, revokePolicy, authorizeGoal, draft, clearDraft, mutate } =
    autonomy;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AuthorizeFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCount = useMemo(() => goals.filter((g) => !["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"].includes(g.status)).length, [goals]);

  // Pre-fill (or reset) the authorization form whenever a draft arrives or
  // the token catalog loads. Never auto-submits.
  const formState = form ?? draftToForm(draft, tokens);
  const formDirty = form !== null;
  const setField = (patch: Partial<AuthorizeFormState>) => setForm({ ...formState, ...patch });

  const handleAuthorize = async () => {
    if (!formState.sell || !formState.buy) {
      setNotice("Pick both tokens first.");
      return;
    }
    const result = await authorizeGoal({
      sellToken: formState.sell,
      buyToken: formState.buy,
      maxPerTrade: formState.sellAmount,
      maxDaily: formState.maxDaily,
      maxSlippageBps: formState.slippageBps,
      maxActionsPerDay: Math.max(formState.maxTrades * 2, 10),
      ttlDays: formState.ttlDays,
      condition: { kind: formState.kind, threshold: formState.threshold },
      sellAmount: formState.sellAmount,
      cooldownSeconds: formState.cooldownSeconds,
      maxTrades: formState.maxTrades,
      description: `${formState.kind === "price_below" ? "Buy" : "Sell"} when price ${
        formState.kind === "price_below" ? "falls below" : "rises above"
      } ${formState.threshold}`,
    });
    if (result.ok) {
      setForm(null);
      clearDraft();
      setNotice("Goal activated. It stays inside the limits you set.");
    }
  };

  const symbol = (address: string) => tokenOf(tokens, address)?.symbol ?? "token";

  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-white/[0.02]" data-testid="agent-autonomy-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
            Off until you activate a goal{activeCount > 0 ? ` · ${activeCount} active` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <ChevronDown className={clsx("h-3.5 w-3.5 text-muted transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="max-h-72 space-y-3 overflow-y-auto px-3 pb-3 sm:px-4 md:px-5">
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
                <p className="text-xs text-muted">
                  No goals yet. When the agent chat detects a recurring request (e.g. “Buy AAPLc whenever it falls
                  below $200”), it drafts a goal here — nothing runs until you set limits and authorize it.
                </p>
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

              {/* AUTHORIZATION FORM */}
              {config?.enabled && !config.emergencyDisabled && (
                <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {draft ? "Draft from chat — review, adjust, then authorize" : "New autonomous goal"}
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-1">
                      <span className="text-muted">Sell (spend)</span>
                      <select
                        value={formState.sell}
                        onChange={(e) => setField({ sell: e.target.value })}
                        className="w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="">Select…</option>
                        {tokens.map((t) => (
                          <option key={t.address} value={t.address}>
                            {t.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Buy (receive)</span>
                      <select
                        value={formState.buy}
                        onChange={(e) => setField({ buy: e.target.value })}
                        className="w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="">Select…</option>
                        {tokens.map((t) => (
                          <option key={t.address} value={t.address}>
                            {t.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Amount per trade</span>
                      <input
                        value={formState.sellAmount}
                        onChange={(e) => setField({ sellAmount: e.target.value })}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Trigger</span>
                      <span className="flex gap-1">
                        <select
                          value={formState.kind}
                          onChange={(e) => setField({ kind: e.target.value as AuthorizeFormState["kind"] })}
                          className="w-full rounded-l-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                        >
                          <option value="price_below">below</option>
                          <option value="price_above">above</option>
                        </select>
                        <input
                          value={formState.threshold}
                          onChange={(e) => setField({ threshold: e.target.value })}
                          inputMode="decimal"
                          placeholder="200"
                          className="w-full rounded-r-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                        />
                      </span>
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Daily cap (spend)</span>
                      <input
                        value={formState.maxDaily}
                        onChange={(e) => setField({ maxDaily: e.target.value })}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Max trades total</span>
                      <input
                        value={formState.maxTrades}
                        onChange={(e) => setField({ maxTrades: Number(e.target.value) || 0 })}
                        inputMode="numeric"
                        className="w-full rounded-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      />
                    </label>
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted">
                    Slippage limit {formState.slippageBps / 100}% · at least {formState.cooldownSeconds / 60} min between checks · authorization expires in{" "}
                    {formState.ttlDays} days. MPGR never holds your keys — the goal executes only through the
                    non-custodial executor inside these limits.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleAuthorize}
                      disabled={busy}
                      className="min-h-[36px] flex-1 rounded-lg bg-gradient-blue px-3 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {busy ? "Working…" : "Authorize & activate goal"}
                    </button>
                    {(formDirty || draft) && (
                      <button
                        type="button"
                        onClick={() => {
                          setForm(null);
                          clearDraft();
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
  const canCancel = ["ACTIVE", "WAITING", "PAUSED"].includes(goal.status);

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
