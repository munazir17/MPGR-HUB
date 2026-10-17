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
  const selling = draft?.side === "sell";
  // Runtime conditions compare sell-token / buy-token. For a sell to USDC
  // that ratio is the reciprocal of the user's USDC-per-asset trigger.
  const condition = selling && draft ? sellCondition(draft) : {
    kind: draft?.triggerKind ?? "price_below" as const, threshold: draft?.triggerPrice ?? "",
  };
  const sellAmount = draft?.amountPerTrade ?? "50";
  const perTrade = Number(sellAmount);
  return {
    sell: selling ? target?.address ?? "" : spend?.address ?? usdc?.address ?? "",
    buy: selling ? usdc?.address ?? "" : target?.address ?? "",
    sellAmount,
    threshold: condition.threshold,
    kind: condition.kind,
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

/** Decimal-safe inverse, rounded conservatively so conversion never fires early. */
function sellCondition(draft: AutonomyGoalDraft): { kind: "price_below" | "price_above"; threshold: string } {
  const kind = draft.triggerKind === "price_below" ? "price_above" : "price_below";
  const text = draft.triggerPrice;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { kind, threshold: "" };
  const [whole, fraction = ""] = text.split(".");
  const scale = 10n ** 18n;
  const price = BigInt(whole + fraction.padEnd(18, "0").slice(0, 18));
  if (price <= 0n) return { kind, threshold: "" };
  const numerator = scale * scale;
  const inverse = kind === "price_above" ? (numerator + price - 1n) / price : numerator / price;
  if (inverse <= 0n) return { kind, threshold: "" };
  const frac = (inverse % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return { kind, threshold: `${inverse / scale}${frac ? "." + frac : ""}` };
}
