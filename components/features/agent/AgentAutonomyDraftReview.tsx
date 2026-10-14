"use client";

// components/features/agent/AgentAutonomyDraftReview.tsx
//
// Dedicated review/authorization UI for a chat-created autonomous goal
// draft. Opened from the in-chat draft card — NEVER from the manual
// Autonomous Goals panel, and never the other way around.
//
// Goal-bound authorization only. Reservation stays DRAFT until a saved slot
// and server activation are confirmed. Each slot permits one execution.
// This component never broadcasts or chooses signing-domain semantics.

import { formatUnits } from "viem";
import { useEffect, useId, useState } from "react";
import { useAccount } from "wagmi";
import { AnimatePresence, motion } from "framer-motion";
import { Repeat, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useAgentAutonomy } from "@/hooks/useAgentAutonomy";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import {
  autonomyFormToDraftInput,
  type AutonomyAuthorizeFormState,
} from "./autonomy-authorize-form";
import { CHAT_REVIEW_TOKENS, chatReviewQuoteFromProposal, chatQuoteExpiry, chatQuoteMinOutHuman, chatDraftToForm, chatQuoteKey, chatReviewAuthorizationError, validateChatReviewForm, type ChatReviewQuote } from "./chat-autonomy-review";

interface AgentAutonomyDraftReviewProps {
  autonomy: ReturnType<typeof useAgentAutonomy>;
  embedded?: boolean;
}

export function AgentAutonomyDraftReview({ autonomy, embedded = false }: AgentAutonomyDraftReviewProps) {
  const { draft, clearDraft } = autonomy;
  return (
    <AnimatePresence>
      {draft && <DraftReviewDialog embedded={embedded} key={JSON.stringify(draft)} draft={draft} autonomy={autonomy} onClose={clearDraft} />}
    </AnimatePresence>
  );
}

interface DraftReviewDialogProps {
  embedded?: boolean;
  draft: AutonomyGoalDraft;
  autonomy: ReturnType<typeof useAgentAutonomy>;
  onClose: () => void;
}

function DraftReviewDialog({ draft, autonomy, onClose, embedded }: DraftReviewDialogProps) {
  const titleId = useId();
  const { address: walletAddress, chainId: walletChainId, isConnected } = useAccount();
  const { tokens: runtimeTokens, busy, error, dismissError, activateDraft, config, settingsRead, authenticated, authenticating, signIn } = autonomy;
  const tokens = CHAT_REVIEW_TOKENS;
  const settingsState = settingsRead?.state;
  const [form, setForm] = useState<AutonomyAuthorizeFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [activatedMode, setActivatedMode] = useState<"standing" | "signed" | null>(null);
  // Minimum output per trade, prefilled from the LIVE quote — never zero.
  const [quote, setQuote] = useState<ChatReviewQuote | null>(null);
  const [quoteRetry, setQuoteRetry] = useState(0);
  const [quoteExpired, setQuoteExpired] = useState(false);
  useEffect(() => {
    if (!quote?.proposal) return;
    const timer = setTimeout(() => setQuoteExpired(true), Math.max(0, chatQuoteExpiry(quote) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [quote]);
  const formState = form ?? chatDraftToForm(draft);
  const setField = (patch: Partial<AutonomyAuthorizeFormState>) => setForm({ ...formState, ...patch });
  const formError = validateChatReviewForm(formState, config?.limits);
  const authorizationError = chatReviewAuthorizationError({ form: formState, config, settingsRead, tokens: runtimeTokens, quote, authenticated, walletAddress, walletChainId: isConnected ? walletChainId : undefined });
  const canAuthorize = !authorizationError && draft.supported !== false;
  const verb = draft.side === "sell" ? "Sell" : "Buy";
  const direction = draft.triggerKind === "price_below" ? "falls below" : "rises above";

  const sellTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.sell.toLowerCase());
  const buyTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.buy.toLowerCase());

  const amountLabel = formState.sellAmount ? `${formState.sellAmount} ${sellTokenInfo?.symbol ?? draft.spendAsset}` : "";

  // A quote belongs to exactly these inputs. Editing the amount/pair/slippage
  // immediately invalidates the floor, even if the replacement request fails.
  const quoteKey = chatQuoteKey(formState);
  const quotedMinOut = quote?.key === quoteKey && buyTokenInfo ? chatQuoteMinOutHuman(quote, buyTokenInfo.decimals) ?? "" : "";

  // Quote reads require a session: wait for explicit sign-in, never sign in
  // from this effect. A failed/invalid prefill leaves authorization disabled
  // with a retry message, never a zero floor.
  // NOTE: every new goal signs its OWN slot — a slot from another goal can
  // never fund this one (witness actionId binding) — so the quote is always
  // needed before activating.
  useEffect(() => {
    if (draft.supported === false || !authenticated || formError || (settingsState && settingsState !== "loaded")) return;
    if (!sellTokenInfo || !buyTokenInfo) return;
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
        if (!res.ok) throw new Error("Quote unavailable");
        const payload = (await res.json().catch(() => null)) as { proposal?: unknown } | null;
        const next = chatReviewQuoteFromProposal(payload?.proposal, { sell: sellTokenInfo.address, buy: buyTokenInfo.address, sellAmount: formState.sellAmount, slippageBps: formState.slippageBps });
        if (!cancelled) { setQuoteExpired(false); setQuote(next); }
      } catch {
        if (!cancelled) setQuote({ key: quoteKey, minOutAtomic: "", buyDecimals: buyTokenInfo.decimals, error: "Could not load a valid live quote. Retry the quote; no goal was created." });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [draft.supported, authenticated, formError, settingsState, sellTokenInfo, buyTokenInfo, formState.sellAmount, formState.slippageBps, quoteKey, quoteRetry]);

  const handleAuthorize = async () => {
    // Guard the handler as well as the button. No auth/policy/goal/signing
    // action is allowed for an incomplete or stale-input review.
    const currentError = chatReviewAuthorizationError({ form: formState, config, settingsRead, tokens: runtimeTokens, quote, authenticated, walletAddress, walletChainId: isConnected ? walletChainId : undefined });
    if (currentError || !canAuthorize || busy) {
      setNotice(currentError ?? authorizationError ?? "This draft cannot be authorized.");
      return;
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
    if (!result.ok) setNotice(result.message);
    if (result.ok) {
      setActivated(true);
      setActivatedMode(result.mode);
      setNotice(
        result.mode === "standing"
          ? "Active — awaiting trigger, using this goal’s own saved permission. No new signature was needed. Settlement is not yet verified."
          : "Active — awaiting trigger. One saved slot permits one execution only, not the entire recurring schedule. Settlement is not yet verified.",
      );
    }
  };

  const anchorLabel =
    draft.referencePrice && draft.triggerPrice
      ? `${draft.targetAsset} is ${draft.referencePrice} — ${draft.percentDrop ?? 1}% ${draft.triggerKind === "price_below" ? "down" : "up"} is ${draft.triggerPrice}`
      : null;

  return (
    <motion.div
      className={embedded ? "w-full px-3 py-4 sm:px-4" : "fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-labelledby={titleId}
        data-testid="agent-autonomy-draft-review"
        className={embedded ? "mx-auto w-full min-w-0 max-w-[600px] rounded-2xl border border-white/10 bg-surface p-3 sm:p-5" : "max-h-[90dvh] w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-t-3xl border border-white/[0.08] bg-surface bg-gradient-surface p-6 shadow-glow-lg sm:rounded-3xl sm:p-8"}
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

        <p className="mb-3 text-xs text-muted">Draft — inactive. Review and explicitly confirm below. Nothing is broadcast by this review; it is not the manual Autonomous Goals form.</p>

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
              {verb} {draft.targetAsset} when the price {direction} {draft.triggerPrice} USDC
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
                <dd className="font-medium text-white">{sellTokenInfo?.symbol ?? draft.spendAsset}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Buy/receive token</dt>
                <dd className="font-medium text-white">{buyTokenInfo?.symbol ?? (draft.side === "sell" ? "USDC" : draft.targetAsset)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Trigger</dt>
                <dd className="font-medium text-white">{formState.kind === "price_below" ? "below" : "above"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Trigger price</dt>
                <dd className="font-medium text-white">{formState.threshold}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Amount per trade</dt>
                <dd className="font-medium text-white">{formState.sellAmount ? `${formState.sellAmount} ${sellTokenInfo?.symbol ?? draft.spendAsset}` : "—"}</dd>
              </div>
            </dl>

            {quote?.key === quoteKey && quote.proposal && (
              <section data-testid="chat-quote-details" className="mb-4 space-y-2 break-words rounded-xl border border-white/10 p-3 text-xs text-muted" aria-label="Executable quote review">
                <p className="font-medium text-white">{!quoteExpired ? "Quote snapshot — not a settlement" : "Quote expired — refresh before confirming"}</p>
                <p>Expected output: {formatUnits(BigInt(quote.proposal.toAmount), quote.buyDecimals)} {buyTokenInfo?.symbol}</p>
                <p>Minimum output: {quotedMinOut} {buyTokenInfo?.symbol} · Slippage: {formState.slippageBps / 100}%</p>
                <p>Provider: {quote.proposal.providerLabel} · Base Mainnet (8453)</p>
                <p>Quoted: {quote.proposal.quotedAt} · Expires: {new Date(chatQuoteExpiry(quote)).toISOString()}</p>
                <p>Agent fee: {quote.proposal.agentFee?.displayAmount ?? "No applied fee quoted"}{quote.proposal.agentFee?.bps != null ? ` (${quote.proposal.agentFee.bps} bps, inside swap)` : ""}</p>
                <p>Gas fee: {quote.proposal.fees.gasFee ? `${quote.proposal.fees.gasFee.amount} atomic units (${quote.proposal.fees.gasFee.token})` : "Not quoted; wallet/network cost may apply"}</p>
                <p>Protocol fee: {quote.proposal.fees.protocolFee ? `${quote.proposal.fees.protocolFee.amount} atomic units (${quote.proposal.fees.protocolFee.token})` : "Not quoted"}</p>
                <p>Read-only quote availability is separate from autonomous execution readiness. Runtime obtains a fresh quote at the trigger and must still meet your signed floor.</p>
                {quote.proposal.risk.map((risk, i) => <p key={i}>{risk.severity}: {risk.title} — {risk.detail}</p>)}
                {quote.proposal.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
              </section>
            )}

            {/* ACTIVATION MODE — standing delegation vs exactly one signature */}
            <div
              data-testid="agent-autonomy-draft-authorization-mode"
              className="mb-4 flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-sky-100"
            >
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1" data-testid="agent-autonomy-draft-mode-text">
                {`One wallet signature will be requested: a single delegated slot bound to THIS goal for ${amountLabel || "the draft amount"}${
                      quotedMinOut ? ` with minimum output ≥ ${quotedMinOut} ${buyTokenInfo?.symbol ?? ""} (live quote)` : " with the minimum output set from the live quote"
                  }. The goal stays draft/awaiting authorization until persistence and activation are confirmed. A slot is single-use, not recurring schedule permission. Additional executions need additional goal-bound permission. Nothing is broadcast until the condition is true.`}
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
                  <label className="min-w-0 space-y-1">
                    <span className="text-muted">Sell/spend token</span>
                    <select
                      data-testid="autonomy-draft-sell"
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
                    <span className="text-muted">Buy/receive token</span>
                    <select
                      data-testid="autonomy-draft-buy"
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
                      data-testid="autonomy-draft-amount"
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
                        data-testid="autonomy-draft-trigger"
                        value={formState.kind}
                        onChange={(e) => setField({ kind: e.target.value as AutonomyAuthorizeFormState["kind"] })}
                        className="min-w-0 w-full rounded-l-lg border border-white/[0.1] bg-surface-2 px-2 py-1.5 text-white"
                      >
                        <option value="price_below">below</option>
                        <option value="price_above">above</option>
                      </select>
                      <input
                        data-testid="autonomy-draft-price"
                        value={formState.threshold}
                        onChange={(e) => setField({ threshold: e.target.value })}
                        inputMode="decimal"
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
                <p className="mb-3 text-[10px] leading-relaxed text-muted">
                  Slippage limit {formState.slippageBps / 100}% · at least {formState.cooldownSeconds / 60} min between checks · authorization expires in{" "}
                  {formState.ttlDays} days. MPGR never holds your keys — the goal executes only through the non-custodial executor inside these limits.
                </p>
                {!canAuthorize && (
                  <p className="mb-3 text-[11px] text-muted">
                    {authorizationError}
                  </p>
                )}
                {!authenticated && (
                  <div className="mb-3 text-[11px] text-amber-200" data-testid="agent-autonomy-draft-auth-notice">
                    <p>Sign in to load the live quote. Sign-in alone does not authorize a goal.</p>
                    <button type="button" data-testid="agent-autonomy-draft-sign-in" disabled={busy || authenticating || !isConnected}
                      onClick={() => { void signIn().then((signedIn) => { if (signedIn) return autonomy.refresh(); }); }}
                      className="mt-2 min-h-[44px] rounded-lg border border-white/10 px-3 disabled:opacity-50">
                      {authenticating ? "Signing in…" : "Sign in with wallet"}
                    </button>
                  </div>
                )}
                <div className="mb-3 flex gap-2 text-[11px]">
                  <button type="button" disabled={busy} onClick={() => { void autonomy.refresh(); }} className="min-h-[44px] rounded-lg border border-white/10 px-3">Retry loading settings</button>
                  {authenticated && !formError && <button type="button" disabled={busy} onClick={() => { setQuote(null); setQuoteRetry((n) => n + 1); }} className="min-h-[44px] rounded-lg border border-white/10 px-3">Refresh live quote</button>}
                </div>
                {settingsRead && <p data-testid="autonomy-settings-diagnostics" className="mb-3 text-[11px] text-muted">
                  Settings GET /api/agent/autonomy/config: {settingsRead.state}{settingsRead.httpStatus !== undefined ? ` · HTTP ${settingsRead.httpStatus}` : ""}
                  {settingsRead.runtimeGate ? ` · runtime flag ${settingsRead.runtimeGate}` : ""}{settingsRead.productionGate ? ` · production flag ${settingsRead.productionGate}` : ""}
                </p>}
                {config?.productionGate === false && <p className="mb-3 text-[11px] text-muted">Base Mainnet autonomous execution is disabled by the production safety gate. Live authorization remains blocked; retrying or signing in cannot enable execution.</p>}
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
                        : "Confirm & authorize one execution"}
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
