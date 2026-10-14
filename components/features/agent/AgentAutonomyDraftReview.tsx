"use client";

// components/features/agent/AgentAutonomyDraftReview.tsx
//
// Dedicated review/authorization UI for a chat-created autonomous goal
// draft. Opened from the in-chat draft card — NEVER from the manual
// Autonomous Goals panel, and never the other way around.
//
// ACTIVATION MODEL (production fix):
//   * STANDING DELEGATION — when this wallet already holds a live policy +
//     unexpired, unconsumed slot covering the draft's pair, exact amount and
//     daily cap, activation creates the goal with NO wallet popup.
//   * ONE SIGNATURE — otherwise the Authorize button creates the policy +
//     goal and opens the wallet for EXACTLY ONE delegated-slot signature
//     (draft amount, minimum output prefilled from the LIVE QUOTE — never
//     zero). One popup, then the goal is ACTIVE.
//   * Nothing is broadcast at prompt time: the runtime's cron executes only
//     when the condition is true, inside the signed slot.
//
// Drafts whose asset is not on the delegated allowlist are REFUSED here —
// no form, no activation. This component never signs by itself and never
// bypasses limits: activation goes through useAgentAutonomy.activateDraft,
// which the server re-validates end to end.

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Repeat, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useAgentAutonomy } from "@/hooks/useAgentAutonomy";
import { findCoveringDelegation } from "@/lib/autonomy/draft-activation";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import {
  autonomyDraftToForm,
  autonomyFormToDraftInput,
  type AutonomyAuthorizeFormState,
} from "./autonomy-authorize-form";

interface AgentAutonomyDraftReviewProps {
  autonomy: ReturnType<typeof useAgentAutonomy>;
}

export function AgentAutonomyDraftReview({ autonomy }: AgentAutonomyDraftReviewProps) {
  const { draft, clearDraft } = autonomy;
  return (
    <AnimatePresence>
      {draft && <DraftReviewDialog key={draft.sourcePrompt} draft={draft} autonomy={autonomy} onClose={clearDraft} />}
    </AnimatePresence>
  );
}

interface DraftReviewDialogProps {
  draft: AutonomyGoalDraft;
  autonomy: ReturnType<typeof useAgentAutonomy>;
  onClose: () => void;
}

function DraftReviewDialog({ draft, autonomy, onClose }: DraftReviewDialogProps) {
  const titleId = useId();
  const { tokens, busy, error, dismissError, activateDraft, config, authenticated, authenticating, signIn } = autonomy;
  const [form, setForm] = useState<AutonomyAuthorizeFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [activatedMode, setActivatedMode] = useState<"standing" | "signed" | null>(null);
  // Minimum output per trade, prefilled from the LIVE quote — never zero.
  const [quotedMinOut, setQuotedMinOut] = useState<string>("");
  const formState = form ?? autonomyDraftToForm(draft, tokens);
  const setField = (patch: Partial<AutonomyAuthorizeFormState>) => setForm({ ...formState, ...patch });
  const canAuthorize = Boolean(config?.enabled && !config.emergencyDisabled) && draft.supported !== false;
  const verb = draft.triggerKind === "price_below" ? "Buy" : "Sell";
  const direction = draft.triggerKind === "price_below" ? "falls below" : "rises above";
  const triggerLabel = draft.triggerKind === "price_below" ? "below" : "above";
  const amountLabel = draft.amountPerTrade ? `${draft.amountPerTrade} ${draft.spendAsset}` : "";

  const sellTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.sell.toLowerCase());
  const buyTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.buy.toLowerCase());

  // STANDING-DELEGATION CHECK (same predicates the activation uses): a live
  // policy + unexpired, unconsumed slot already covering pair, exact amount
  // and daily cap means activation needs NO wallet popup.
  const covering = (() => {
    if (!config?.delegated?.chainId || !sellTokenInfo || !buyTokenInfo) return null;
    const toBaseUnits = (human: string): string | null => {
      const cleaned = human.trim();
      if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === ".") return null;
      const [whole = "0", frac = ""] = cleaned.split(".");
      const fracPadded = frac.padEnd(sellTokenInfo.decimals, "0").slice(0, sellTokenInfo.decimals);
      try {
        return BigInt(whole + fracPadded).toString();
      } catch {
        return null;
      }
    };
    const sellAmountRaw = toBaseUnits(formState.sellAmount);
    const maxDailyRaw = toBaseUnits(formState.maxDaily);
    if (!sellAmountRaw || !maxDailyRaw) return null;
    return findCoveringDelegation(autonomy.policies, autonomy.slots, {
      chainId: config.delegated.chainId,
      sellToken: formState.sell,
      buyToken: formState.buy,
      sellAmountRaw,
      maxDailyRaw,
      now: new Date(),
    });
  })();

  // LIVE QUOTE prefill for the one-signature slot floor. Silent on failure:
  // the activate step refuses to sign with an empty minimum output, so a
  // failed prefill degrades to a clear message instead of a zero floor.
  useEffect(() => {
    if (draft.supported === false) return;
    if (!sellTokenInfo || !buyTokenInfo) return;
    if (covering) return; // no signature will be requested — no quote needed
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchWithSession("/api/trade/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromToken: sellTokenInfo.address,
            toToken: buyTokenInfo.address,
            amount: formState.sellAmount,
            slippageBps: formState.slippageBps,
          }),
        });
        if (!res.ok) return;
        const payload = (await res.json().catch(() => null)) as { proposal?: { minToAmount?: string } } | null;
        const minOut = payload?.proposal?.minToAmount;
        if (!cancelled && typeof minOut === "string" && Number.parseFloat(minOut) > 0) {
          setQuotedMinOut((current) => (current === minOut ? current : minOut));
        }
      } catch {
        /* prefill stays empty; the explicit message covers activation */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [draft.supported, sellTokenInfo, buyTokenInfo, formState.sellAmount, formState.slippageBps, covering]);

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
    const result = await activateDraft({
      sellToken: formState.sell,
      buyToken: formState.buy,
      condition: { kind: formState.kind, threshold: formState.threshold },
      sellAmount: formState.sellAmount,
      maxDaily: formState.maxDaily,
      maxSlippageBps: formState.slippageBps,
      maxActionsPerDay: Math.max(formState.maxTrades * 2, 10),
      ttlDays: formState.ttlDays,
      cooldownSeconds: formState.cooldownSeconds,
      maxTrades: formState.maxTrades,
      description: autonomyFormToDraftInput(formState).description,
      // Minimum output from the LIVE QUOTE — never zero (validated again in
      // the hook and re-validated server-side when the slot is registered).
      minAmountOutHuman: quotedMinOut,
    });
    if (result.ok) {
      setActivated(true);
      setActivatedMode(result.mode);
      setNotice(
        result.mode === "standing"
          ? "Goal activated with your existing delegation — no signature was needed. It stays inside the limits you set."
          : "Goal activated. One slot signature covers it, and it stays inside the limits you set.",
      );
    }
  };

  const anchorLabel =
    draft.referencePrice && draft.triggerPrice
      ? `${draft.targetAsset} is ${draft.referencePrice} — ${draft.percentDrop ?? 1}% ${draft.triggerKind === "price_below" ? "down" : "up"} is ${draft.triggerPrice}`
      : null;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="agent-autonomy-draft-review"
        className="max-h-[90dvh] w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-t-3xl border border-white/[0.08] bg-surface bg-gradient-surface p-6 shadow-glow-lg sm:rounded-3xl sm:p-8"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 20, opacity: 0 }}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Repeat className="h-5 w-5 text-primary-glow" aria-hidden="true" />
            <h2 id={titleId} className="text-sm font-semibold text-white">
              Review autonomous goal
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            data-testid="agent-autonomy-draft-review-close"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-zinc-400 hover:text-white disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mb-3 text-xs text-muted">Inactive until you authorize it. This reviews the chat draft — it is not the manual Autonomous Goals form.</p>

        {draft.supported === false ? (
          <div
            data-testid="agent-autonomy-draft-unavailable"
            className="mb-4 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          >
            <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {draft.unsupportedReason ??
                `${draft.targetAsset} is not available for autonomous trading. Autonomous goals support only delegated-allowlist assets with a registered USDC route.`}
            </span>
          </div>
        ) : (
          <>
            <p
              data-testid="agent-autonomy-draft-summary"
              className="mb-3 text-sm font-medium leading-relaxed text-white"
            >
              {verb} {draft.targetAsset} when the price {direction} {draft.triggerPrice} {draft.spendAsset}
              {amountLabel ? ` · up to ${amountLabel} per trade` : ""}
            </p>

            {anchorLabel && (
              <p
                data-testid="agent-autonomy-draft-anchor"
                className="mb-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white"
              >
                {anchorLabel}
              </p>
            )}

            {draft.sourcePrompt && (
              <p className="mb-4 truncate text-[11px] text-muted">From chat: {draft.sourcePrompt}</p>
            )}

            <dl
              data-testid="agent-autonomy-draft-values"
              className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs"
            >
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Sell/spend token</dt>
                <dd className="font-medium text-white">{draft.spendAsset}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Buy/receive token</dt>
                <dd className="font-medium text-white">{draft.targetAsset}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Trigger</dt>
                <dd className="font-medium text-white">{triggerLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Trigger price</dt>
                <dd className="font-medium text-white">{draft.triggerPrice}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Amount per trade</dt>
                <dd className="font-medium text-white">{amountLabel || "—"}</dd>
              </div>
            </dl>

            {/* ACTIVATION MODE — standing delegation vs exactly one signature */}
            <div
              data-testid="agent-autonomy-draft-authorization-mode"
              className="mb-4 flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-sky-100"
            >
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1" data-testid="agent-autonomy-draft-mode-text">
                {covering
                  ? "Covered by your existing delegation: activating creates the goal with no wallet signature. Your live slot (same pair, same amount) is what the runtime redeems when the trigger fires."
                  : `One wallet signature will be requested: a single delegated slot for ${amountLabel || "the draft amount"}${
                      quotedMinOut ? ` with minimum output ≥ ${quotedMinOut} ${draft.targetAsset} (live quote)` : " with the minimum output set from the live quote"
                    }. One popup, then the goal is active. Nothing is broadcast until the condition is true.`}
              </span>
            </div>

            {error && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                <span className="min-w-0 flex-1">{error}</span>
                <button type="button" onClick={dismissError} aria-label="Dismiss error">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {notice && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{notice}</span>
              </div>
            )}

            {activated ? (
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-[36px] w-full items-center justify-center rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
              >
                Close
              </button>
            ) : (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <label className="space-y-1">
                    <span className="text-muted">Sell/spend token</span>
                    <select
                      data-testid="autonomy-draft-sell"
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
                    <span className="text-muted">Buy/receive token</span>
                    <select
                      data-testid="autonomy-draft-buy"
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
                      data-testid="autonomy-draft-amount"
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
                        data-testid="autonomy-draft-trigger"
                        value={formState.kind}
                        onChange={(e) => setField({ kind: e.target.value as AutonomyAuthorizeFormState["kind"] })}
                        className="w-full rounded-l-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="price_below">below</option>
                        <option value="price_above">above</option>
                      </select>
                      <input
                        data-testid="autonomy-draft-price"
                        value={formState.threshold}
                        onChange={(e) => setField({ threshold: e.target.value })}
                        inputMode="decimal"
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
                <p className="mb-3 text-[10px] leading-relaxed text-muted">
                  Slippage limit {formState.slippageBps / 100}% · at least {formState.cooldownSeconds / 60} min between checks · authorization expires in{" "}
                  {formState.ttlDays} days. MPGR never holds your keys — the goal executes only through the non-custodial executor inside these limits.
                </p>
                {!canAuthorize && (
                  <p className="mb-3 text-[11px] text-muted">
                    {config?.emergencyDisabled ? "Autonomous goals are disabled by the operator." : "Autonomous goals are unavailable right now."}
                  </p>
                )}
                {!authenticated && (
                  <p className="mb-3 text-[11px] text-amber-200" data-testid="agent-autonomy-draft-auth-notice">
                    Sign in with your wallet to authorize this goal.
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="agent-autonomy-draft-authorize"
                    onClick={handleAuthorize}
                    disabled={busy || !canAuthorize}
                    className="min-h-[36px] flex-1 rounded-lg bg-gradient-blue px-3 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {busy && authenticating
                      ? "Signing in…"
                      : busy
                        ? "Working…"
                        : !authenticated
                          ? "Sign in & authorize"
                          : covering
                            ? "Activate goal — no signature needed"
                            : "Authorize & sign once"}
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {activated && (
          <button
            type="button"
            onClick={onClose}
            className="mt-3 flex min-h-[36px] w-full items-center justify-center rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
          >
            Close{activatedMode === "standing" ? " (activated with existing delegation)" : ""}
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}
