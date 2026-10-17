"use client";

import { useState, type FormEvent } from "react";
import { buildGoalDraft, checkAutonomyTarget, type AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { parseBaseUnits } from "@/lib/autonomy/policy-engine";
import { CHAT_REVIEW_TOKENS, chatDraftToForm, validateChatReviewForm } from "./chat-autonomy-review";
import type { AutonomyConfig } from "@/hooks/useAgentAutonomy";

/** Local authoring only. No wallet prompt, quote fetch, persistence or activation. */
export function AgentAutonomyDraftComposer({ onReview, config }: { onReview: (draft: AutonomyGoalDraft) => void; config: AutonomyConfig | null }) {
  const targets = CHAT_REVIEW_TOKENS.filter(t => checkAutonomyTarget(t.symbol).ok);
  const [target, setTarget] = useState(() => targets.find(t => t.symbol === "AAPLc")?.symbol ?? targets[0]?.symbol ?? "");
  const [amount, setAmount] = useState("");
  const [threshold, setThreshold] = useState("");
  const [kind, setKind] = useState<"price_below" | "price_above">("price_below");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError(null);
    if (!parseBaseUnits(amount, 6) || !/^\d+(?:\.\d+)?$/.test(threshold) || !/[1-9]/.test(threshold) || !checkAutonomyTarget(target).ok) {
      setError("Select a supported asset, positive USDC amount (up to 6 decimals), and a positive absolute trigger price."); return;
    }
    const draft = buildGoalDraft({ side: "buy", targetAsset: target, spendAsset: "USDC", amountPerTrade: amount,
      triggerKind: kind, triggerPrice: threshold, percentDrop: null }, `Buy ${target} ${kind === "price_below" ? "below" : "above"} ${threshold} USD; spend ${amount} USDC per trade`);
    if (config) { const invalid = validateChatReviewForm(chatDraftToForm(draft), config.limits); if (invalid) { setError(invalid); return; } }
    onReview(draft);
  };
  const field = "min-h-[44px] min-w-0 w-full rounded-lg border border-white/10 bg-surface-2 px-2 py-2 text-sm text-white";
  return <form onSubmit={submit} aria-label="Draft a conditional goal" className="space-y-3 border-t border-white/10 p-3">
    <h2 className="text-sm font-semibold text-white">Draft a conditional goal</h2>
    <p className="text-xs text-muted">Local draft and review only, available even while the runtime is off. No goal or permission is saved. Mainnet authorization remains blocked in Preview while its runtime/production gates are off. A draft is not a simulation of live execution.</p>
    <div className="grid grid-cols-2 gap-2">
      <label className="min-w-0 text-xs text-muted">Goal buy token<select aria-label="Goal buy token" className={field} value={target} onChange={e => setTarget(e.target.value)}>{targets.map(t => <option key={t.address}>{t.symbol}</option>)}</select></label>
      <label className="min-w-0 text-xs text-muted">USDC per trade<input className={field} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="min-w-0 text-xs text-muted">Price trigger<select aria-label="Price trigger" className={field} value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="price_below">Below</option><option value="price_above">Above</option></select></label>
      <label className="min-w-0 text-xs text-muted">Trigger price (USD)<input className={field} inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
    </div>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    <button type="submit" className={field}>Review local draft</button>
  </form>;
}
