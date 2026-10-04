// components/features/agent/autonomy-authorize-form.ts
//
// UI mapping only: turn a REVIEW-ONLY AutonomyGoalDraft (and the token
// catalog) into the authorization form the user submits. This does not
// create policies, sign, or execute — both the chat-draft review and the
// manual Autonomous Goals form call the same authorizeGoal seam.

import type { AgentAutonomyDraftInput, AutonomyTokenOption } from "@/hooks/useAgentAutonomy";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";

export interface AutonomyAuthorizeFormState {
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

export function autonomyDraftToForm(
  draft: AutonomyGoalDraft | null,
  tokens: AutonomyTokenOption[],
): AutonomyAuthorizeFormState {
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

export function autonomyFormToDraftInput(form: AutonomyAuthorizeFormState): AgentAutonomyDraftInput {
  return {
    sellToken: form.sell,
    buyToken: form.buy,
    maxPerTrade: form.sellAmount,
    maxDaily: form.maxDaily,
    maxSlippageBps: form.slippageBps,
    maxActionsPerDay: Math.max(form.maxTrades * 2, 10),
    ttlDays: form.ttlDays,
    condition: { kind: form.kind, threshold: form.threshold },
    sellAmount: form.sellAmount,
    cooldownSeconds: form.cooldownSeconds,
    maxTrades: form.maxTrades,
    description: `${form.kind === "price_below" ? "Buy" : "Sell"} when price ${
      form.kind === "price_below" ? "falls below" : "rises above"
    } ${form.threshold}`,
  };
}
