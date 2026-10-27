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

import { useEffect, useId, useRef, useState } from "react";
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
import { AutonomyQuoteSummary, AutonomyQuoteDetails } from "./AutonomyQuoteSummary";
import { CHAT_REVIEW_TOKENS, chatQuoteReviewError, chatReviewQuoteFromProposal, chatQuoteExpiry, chatQuoteMinOutHuman, chatDraftToForm, chatQuoteKey, chatReviewAuthorizationError, validateChatReviewForm, type ChatReviewQuote } from "./chat-autonomy-review";

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
  const { tokens: runtimeTokens, busy: controllerBusy, error, dismissError, activateDraft, config, settingsRead, authenticated, authenticating, signIn } = autonomy;
  const tokens = CHAT_REVIEW_TOKENS;
  const settingsState = settingsRead?.state;
  const [form, setForm] = useState<AutonomyAuthorizeFormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const authorizationInFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busy = controllerBusy || submitting;
  const [notice, setNotice] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [activatedMode, setActivatedMode] = useState<"standing" | "signed" | null>(null);
  // Only the modal owns focus/body scrolling. The embedded review stays in
  // Chat's existing scroll container and must not trap keyboard navigation.
  useEffect(() => {
    if (embedded || !dialogRef.current) return;
    const opener = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [embedded]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (embedded || !dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
      )].filter((node) => node.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || (event.shiftKey && (document.activeElement === first || document.activeElement === dialog))) {
        event.preventDefault();
        (last ?? dialog).focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [embedded, busy, onClose]);
  // Minimum output per trade, prefilled from the LIVE quote — never zero.
  const [quote, setQuote] = useState<(ChatReviewQuote & { contextKey: string }) | null>(null);
  const [quoteRetry, setQuoteRetry] = useState(0);
  const [quoteExpired, setQuoteExpired] = useState(false);
  useEffect(() => {
    if (!quote?.proposal) return;
    const timer = setTimeout(() => setQuoteExpired(true), Math.max(0, chatQuoteExpiry(quote) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [quote]);
  const formState = form ?? chatDraftToForm(draft);
  const setField = (patch: Partial<AutonomyAuthorizeFormState>) => setForm({ ...formState, ...patch });
  const quoteContext = JSON.stringify([walletAddress, walletChainId, isConnected, authenticated]);
  const currentQuote = quote?.contextKey === quoteContext && quote.key === chatQuoteKey(formState) ? quote : null;
  const expiryError = quoteExpired ? "Quote expired. Refresh the quote before confirming." : null;
  const formError = validateChatReviewForm(formState, config?.limits);
  const authorizationError = chatReviewAuthorizationError({ form: formState, config, settingsRead, tokens: runtimeTokens, quote: currentQuote, authenticated, walletAddress, walletChainId: isConnected ? walletChainId : undefined }) ?? expiryError;
  const canAuthorize = !authorizationError && draft.supported !== false;
  const sellTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.sell.toLowerCase());
  const buyTokenInfo = tokens.find((t) => t.address.toLowerCase() === formState.buy.toLowerCase());

  // A quote belongs to exactly these inputs. Editing the amount/pair/slippage
  // immediately invalidates the floor, even if the replacement request fails.
  const quoteKey = chatQuoteKey(formState);
  const quotedMinOut = currentQuote && buyTokenInfo ? chatQuoteMinOutHuman(currentQuote, buyTokenInfo.decimals) ?? "" : "";

  // Quote reads require a session: wait for explicit sign-in, never sign in
  // from this effect. A failed/invalid prefill leaves authorization disabled
  // with a retry message, never a zero floor.
  // NOTE: every new goal signs its OWN slot — a slot from another goal can
  // never fund this one (witness actionId binding) — so the quote is always
  // needed before activating.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Clear the old snapshot on every context/retry transition. The render
      // also checks context synchronously, so an old wallet/network cannot
      // appear ready while this async effect catches up.
      await Promise.resolve();
      if (cancelled) return;
      setQuote(null);
      if (draft.supported === false || !authenticated || !isConnected || walletChainId !== 8453 || formError || (settingsState && settingsState !== "loaded") || !sellTokenInfo || !buyTokenInfo) return;
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
        if (!cancelled) { setQuoteExpired(false); setQuote({ ...next, contextKey: quoteContext }); }
      } catch {
        if (!cancelled) setQuote({ key: quoteKey, minOutAtomic: "", buyDecimals: buyTokenInfo.decimals, error: "Could not load a valid live quote. Retry the quote; no goal was created.", contextKey: quoteContext });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [draft.supported, authenticated, formError, settingsState, sellTokenInfo, buyTokenInfo, formState.sellAmount, formState.slippageBps, quoteKey, quoteRetry, walletAddress, walletChainId, isConnected, quoteContext]);

  const handleAuthorize = async () => {
    // Guard the handler as well as the button. No auth/policy/goal/signing
    // action is allowed for an incomplete or stale-input review.
    const currentError = chatReviewAuthorizationError({ form: formState, config, settingsRead, tokens: runtimeTokens, quote: currentQuote, authenticated, walletAddress, walletChainId: isConnected ? walletChainId : undefined }) ?? expiryError;
    if (authorizationInFlight.current) return;
    if (currentError || !canAuthorize || busy) {
      setNotice(currentError ?? authorizationError ?? "This draft cannot be authorized.");
      return;
    }
    authorizationInFlight.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
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
    } catch {
      setNotice("Activation could not be confirmed. Retry this same draft to reconcile its saved state; do not create a second goal.");
    } finally {
      authorizationInFlight.current = false;
      setSubmitting(false);
    }
  };

  const quoteError = chatQuoteReviewError(currentQuote, formState, walletAddress) ?? expiryError;
  const quoteValid = isConnected && walletChainId === 8453 && !quoteExpired && !quoteError;
  const quoteMessage = !isConnected ? "Connect your wallet for a quote." : walletChainId !== 8453 ? "Switch to Base Mainnet for a quote."
    : !authenticated ? "Sign in for a quote." : formError ? "Complete trade setup for a quote."
    : currentQuote ? (quoteError ?? "Quote ready · not a settlement") : "Loading quote…";

  const feedback = <>
    {error && <div role="alert" className="mb-3 flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
      <span className="min-w-0 flex-1">{error}</span>
      <button type="button" onClick={dismissError} aria-label="Dismiss error"><X className="h-3.5 w-3.5" /></button>
    </div>}
    {notice && notice !== error && <div role={activated ? "status" : "alert"} className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${activated ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-200" : "border-red-400/20 bg-red-500/10 text-red-200"}`}>
      {activated ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ShieldOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1">{notice}</span>
    </div>}
  </>;

  return (
    <motion.div
      className={embedded ? "w-full px-3 py-4 sm:px-4" : "fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        ref={dialogRef}
        tabIndex={-1}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-labelledby={titleId}
        aria-busy={busy}
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

        <p role="status" className="mb-3 text-xs text-muted">{activated
          ? "Active — awaiting trigger. Execution still requires fresh runtime checks and saved permission. Settlement is not yet verified."
          : "Draft — inactive. Review, then explicitly confirm."}</p>

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
            <AutonomyQuoteSummary form={formState} sellSymbol={sellTokenInfo?.symbol ?? draft.spendAsset}
              buySymbol={buyTokenInfo?.symbol ?? draft.targetAsset} proposal={currentQuote?.proposal}
              valid={quoteValid} message={quoteMessage} busy={busy} onRefresh={authenticated && !formError ? () => { setQuote(null); setQuoteRetry((n) => n + 1); } : undefined} expiresAt={currentQuote ? chatQuoteExpiry(currentQuote) : undefined} />

            {activated ? null : (
              <>
                <details data-testid="review-edit" className="rounded-xl border border-white/10">
                  <summary className="min-h-[44px] cursor-pointer px-3 py-3 text-xs font-medium text-white">Edit trade &amp; limits</summary>
                  <fieldset disabled={busy} className="grid min-w-0 grid-cols-2 gap-2 p-3 pt-0 text-xs">
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
                          aria-label="Trigger price (USDC)"
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
                  </fieldset>
                </details>
                <AutonomyQuoteDetails form={formState} proposal={currentQuote?.proposal} expiresAt={currentQuote ? chatQuoteExpiry(currentQuote) : undefined}
                  referenceLabel={draft.referencePrice && draft.percentDrop != null ? `${draft.targetAsset} is ${draft.referencePrice}; requested move ${draft.percentDrop}%.` : undefined}
                  sourcePrompt={draft.sourcePrompt} diagnostics={settingsRead && <div data-testid="autonomy-settings-diagnostics"><p>
                    Settings GET /api/agent/autonomy/config: {settingsRead.state}{settingsRead.deploymentEnvironment && settingsRead.deploymentEnvironment !== "unknown" ? ` · environment ${settingsRead.deploymentEnvironment}` : ""}{settingsRead.httpStatus !== undefined ? ` · HTTP ${settingsRead.httpStatus}` : ""}
                    {settingsRead.runtimeGate ? ` · runtime flag ${settingsRead.runtimeGate}` : ""}{settingsRead.productionGate ? ` · production flag ${settingsRead.productionGate}` : ""}
                  </p><button type="button" disabled={busy} onClick={() => { void autonomy.refresh(); }} className="mt-2 min-h-[44px] rounded-lg border border-white/10 px-3">Retry loading settings</button></div>} />
                <div className="sticky bottom-0 z-10 -mx-1 border-t border-white/10 bg-surface px-1 pt-2 pb-1" aria-label="Authorization controls">
                  {feedback}

                  <p data-testid="agent-autonomy-draft-authorization-mode" className="mb-2 text-[11px] text-muted"><span data-testid="agent-autonomy-draft-mode-text">One execution per saved goal-bound permission.</span></p>
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
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid="agent-autonomy-draft-authorize"
                      onClick={handleAuthorize}
                      disabled={busy || !canAuthorize}
                      className="min-h-[44px] flex-1 rounded-lg bg-gradient-blue px-3 text-xs font-semibold text-white disabled:opacity-50"
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
                      disabled={busy}
                      className="min-h-[44px] rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {activated && (
          <>
            {feedback}
            <button
              type="button"
              onClick={onClose}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-lg border border-white/[0.1] px-3 text-xs text-muted transition-colors hover:text-white"
            >
              Close{activatedMode === "standing" ? " (activated with existing delegation)" : ""}
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
