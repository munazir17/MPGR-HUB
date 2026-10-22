import { autonomySettingsReadError, type AutonomySettingsDiagnostic } from "@/lib/api/autonomy-settings";
// Chat-only review metadata/validation. Never used by the Manual form.
// The registry is the same Base allowlist used by the existing tokens API;
// showing review options does not enable the runtime or authorize anything.
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { TRADE_QUOTE_MAX_AGE_MS } from "@/lib/trade/trade-config";
import { isSupportedTradeProvider, type TradeProposal } from "@/lib/trade/trade-types";
import { formatUnits, isAddress } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as registry } from "@/lib/executor/executor-config";
import { AUTONOMY_LIMITS, AUTONOMY_SLIPPAGE_BOUNDS } from "@/lib/autonomy/config";
import { normalizeCondition, parseBaseUnits } from "@/lib/autonomy/policy-engine";
import type { AutonomyConfig, AutonomyTokenOption } from "@/hooks/useAgentAutonomy";
import { isLiveAutonomyPair } from "@/lib/autonomy/chat-draft";
import { findBasePairByAddress } from "@/lib/markets/base-pairs";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { autonomyDraftToForm, type AutonomyAuthorizeFormState } from "./autonomy-authorize-form";

export const CHAT_REVIEW_TOKENS: AutonomyTokenOption[] = registry.tokens.filter((t) => findBasePairByAddress(t.address)?.live === true).map(({ address, symbol, decimals }) => ({ address, symbol, decimals }));

export function chatDraftToForm(draft: AutonomyGoalDraft): AutonomyAuthorizeFormState {
  const form = autonomyDraftToForm(draft, CHAT_REVIEW_TOKENS);
  // Missing spend is incomplete, not permission to invent the Manual default.
  return { ...form, sellAmount: draft.amountPerTrade ?? "" };
}

export function chatQuoteKey(form: Pick<AutonomyAuthorizeFormState, "sell" | "buy" | "sellAmount" | "slippageBps">): string {
  return JSON.stringify([form.sell, form.buy, form.sellAmount, form.slippageBps]);
}

/** UI preflight only; server policy/goal/slot validation remains authoritative. */
export function validateChatReviewForm(form: AutonomyAuthorizeFormState, limits: AutonomyConfig["limits"] | undefined): string | null {
  const sell = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.sell.toLowerCase());
  const buy = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.buy.toLowerCase());
  if (!sell || !buy) return "Select both supported Base tokens.";
  if (!isLiveAutonomyPair(sell.address, buy.address)) return "Select a pair with a registered Base route.";
  if (!limits) return "Autonomy settings are still loading. Retry loading settings.";
  if (![limits.minCooldownSeconds, limits.maxPolicyTtlDays, limits.maxSlippageBps].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return "Autonomy limits are unavailable. Retry loading settings.";
  }
  const amount = parseBaseUnits(form.sellAmount, sell.decimals);
  const daily = parseBaseUnits(form.maxDaily, sell.decimals);
  const amountCeiling = parseBaseUnits(limits.maxPerTradeHuman, sell.decimals);
  const dailyCeiling = parseBaseUnits(limits.maxDailyHuman, sell.decimals);
  if (!amount || !amountCeiling || BigInt(amount) > BigInt(amountCeiling)) return "Enter a positive per-trade amount within the policy cap and token precision.";
  if (!daily || !dailyCeiling || BigInt(daily) < BigInt(amount) || BigInt(daily) > BigInt(dailyCeiling)) return "Daily cap must cover one trade and stay within the policy cap.";
  const condition = normalizeCondition({ kind: form.kind, threshold: form.threshold });
  if (!condition.ok) return "Enter a valid trigger direction and positive trigger price.";
  if (!Number.isInteger(form.slippageBps) || form.slippageBps < AUTONOMY_SLIPPAGE_BOUNDS.minBps ||
      form.slippageBps > Math.min(limits.maxSlippageBps, AUTONOMY_SLIPPAGE_BOUNDS.maxBps)) return "Slippage is outside the approved limits.";
  // Preserve the existing maxActionsPerDay = max(maxTrades * 2, 10) mapping.
  if (!Number.isInteger(form.maxTrades) || form.maxTrades < 1 || Math.max(form.maxTrades * 2, 10) > 50) return "Max trades must be an integer from 1 to 25 within the action limit.";
  if (!Number.isInteger(form.ttlDays) || form.ttlDays < 1 || form.ttlDays > Math.min(limits.maxPolicyTtlDays, AUTONOMY_LIMITS.maxPolicyTtlDays)) return "Authorization expiry is outside the approved limits.";
  if (!Number.isInteger(form.cooldownSeconds) || form.cooldownSeconds < Math.max(limits.minCooldownSeconds, AUTONOMY_LIMITS.minCooldownSeconds) ||
      form.cooldownSeconds > AUTONOMY_LIMITS.maxCooldownSeconds) return "Cooldown is outside the approved limits.";
  return null;
}

export interface ChatReviewQuote { key: string; minOutAtomic: string; buyDecimals: number; proposal?: TradeProposal; error?: string }

/** Canonical API atomic floor -> existing human-unit signing seam, exactly once. */
export function chatQuoteMinOutHuman(quote: ChatReviewQuote | null, decimals: number): string | null {
  if (!quote || quote.buyDecimals !== decimals || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 ||
      !/^[0-9]+$/.test(quote.minOutAtomic) || BigInt(quote.minOutAtomic) <= 0n) return null;
  return formatUnits(BigInt(quote.minOutAtomic), decimals);
}

/** Fail closed on partial API fixtures, mismapped identities and stale quotes. */
export function chatReviewQuoteFromProposal(value: unknown, form: Pick<AutonomyAuthorizeFormState, "sell" | "buy" | "sellAmount" | "slippageBps">): ChatReviewQuote {
  const p = value as TradeProposal | null;
  const sell = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.sell.toLowerCase());
  const buy = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.buy.toLowerCase());
  if (!sell || !buy || !p || p.chainId !== registry.chainId || p.network !== "base" ||
      p.from?.address?.toLowerCase() !== sell.address.toLowerCase() || p.to?.address?.toLowerCase() !== buy.address.toLowerCase() ||
      p.from.decimals !== sell.decimals || p.to.decimals !== buy.decimals ||
      p.from.symbol !== sell.symbol || p.to.symbol !== buy.symbol ||
      p.fromAmount !== parseBaseUnits(form.sellAmount, sell.decimals) || p.slippageBps !== form.slippageBps ||
      !isSupportedTradeProvider(p.provider) || typeof p.providerLabel !== "string" ||
      typeof p.toAmount !== "string" || !/^[0-9]+$/.test(p.toAmount) || BigInt(p.toAmount) <= 0n ||
      typeof p.minToAmount !== "string" || !/^[0-9]+$/.test(p.minToAmount) || BigInt(p.minToAmount) <= 0n || BigInt(p.minToAmount) > BigInt(p.toAmount) ||
      typeof p.quotedAt !== "string" || !Number.isFinite(Date.parse(p.quotedAt)) ||
      typeof p.expiresAt !== "string" || !(Date.parse(p.expiresAt) > Date.parse(p.quotedAt)) ||
      !Array.isArray(p.risk) || !p.risk.every((r) => r && ["info", "warning", "critical"].includes(r.severity) && typeof r.title === "string" && typeof r.detail === "string") ||
      !Array.isArray(p.warnings) || !p.warnings.every((w) => typeof w === "string") || !p.fees || typeof p.fees !== "object") {
    throw new Error("Invalid or mismatched quote details");
  }
  for (const fee of [p.fees.gasFee, p.fees.protocolFee]) {
    if (fee && (typeof fee.amount !== "string" || !/^[0-9]+$/.test(fee.amount) || typeof fee.token !== "string")) throw new Error("Invalid fee details");
  }
  if (p.agentFee && (typeof p.agentFee.amountAtomic !== "string" || !/^[0-9]+$/.test(p.agentFee.amountAtomic) ||
      !["applied", "skipped"].includes(p.agentFee.status) || (p.agentFee.displayAmount !== null && typeof p.agentFee.displayAmount !== "string") ||
      (p.agentFee.bps !== null && !Number.isSafeInteger(p.agentFee.bps)))) throw new Error("Invalid agent fee details");
  return { key: chatQuoteKey(form), minOutAtomic: p.minToAmount, buyDecimals: buy.decimals, proposal: p };
}

export function chatQuoteExpiry(quote: ChatReviewQuote): number {
  return quote.proposal ? Math.min(Date.parse(quote.proposal.expiresAt), Date.parse(quote.proposal.quotedAt) + TRADE_QUOTE_MAX_AGE_MS) : 0;
}

export function chatQuoteReviewError(quote: ChatReviewQuote | null, form: AutonomyAuthorizeFormState, walletAddress?: `0x${string}`): string | null {
  if (!quote || quote.key !== chatQuoteKey(form) || !quote.proposal) return quote?.key === chatQuoteKey(form) && quote.error ? quote.error : "A valid live quote for this pair, amount and slippage is required before authorization.";
  try { chatReviewQuoteFromProposal(quote.proposal, form); } catch { return "Quote details do not match this review. Refresh the quote."; }
  if (quote.minOutAtomic !== quote.proposal.minToAmount || quote.buyDecimals !== quote.proposal.to.decimals) return "Quote floor or decimals do not match this review. Refresh the quote.";
  const now = Date.now();
  if (chatQuoteExpiry(quote) <= now || Date.parse(quote.proposal.quotedAt) > now + 1000) return "Quote expired or its freshness could not be confirmed. Refresh the quote before confirming.";
  const checked = revalidateTradeProposal(quote.proposal, walletAddress);
  if (checked.error) return checked.error.message;
  if (quote.proposal.risk.some((risk) => risk.severity === "critical")) return "Critical quote risks block authorization. Review the risks and refresh.";
  return null;
}

export function chatReviewAuthorizationError(args: {
  form: AutonomyAuthorizeFormState;
  config: AutonomyConfig | null;
  settingsRead?: AutonomySettingsDiagnostic;
  tokens: AutonomyTokenOption[];
  quote: ChatReviewQuote | null;
  authenticated: boolean;
  walletChainId: number | undefined;
  walletAddress?: `0x${string}`;
}): string | null {
  const { form, config, tokens, quote, authenticated, walletChainId } = args;
  const readError = autonomySettingsReadError(args.settingsRead);
  if (readError) return readError;
  if (!config) return "Autonomy settings have not loaded. Retry loading settings; no goal was created.";
  const where = args.settingsRead?.deploymentEnvironment === "preview" ? "in Preview" : "on this deployment";
  const unavailable = `Mainnet autonomous authorization is unavailable ${where}. Use PaigerSwap for user-confirmed swaps.`;
  const runtimeGate = args.settingsRead?.runtimeGate;
  const productionGate = args.settingsRead?.productionGate;
  const runtimeNote = runtimeGate && runtimeGate !== "unknown" ? `runtime flag: ${runtimeGate}` : "";
  const productionNote = config.productionGate !== true && productionGate && productionGate !== "unknown" ? `production flag: ${productionGate}` : "";
  const notes = [runtimeNote, productionNote].filter(Boolean).join("; ");
  if (!config.enabled) return `Autonomous runtime is not enabled${notes ? ` (${notes})` : ""}. ${unavailable} Retrying or signing in cannot enable these gates. No goal was created.`;
  if (config.emergencyDisabled) return "Autonomous goals are disabled by the operator.";
  if (config.productionGate !== true) return `The production safety gate is not enabled${productionNote ? ` (${productionNote})` : ""}. ${unavailable} Retrying or signing in cannot enable execution.`;
  if (config.executionAvailable !== true) return "Autonomous execution is not ready on this deployment. An operator must review runtime/adapter readiness; the draft remains inactive.";
  const invalid = validateChatReviewForm(form, config.limits);
  if (invalid) return invalid;
  if (walletChainId !== registry.chainId) return "Connect your wallet on Base Mainnet to authorize this draft.";
  if (config.delegated?.chainId !== registry.chainId || !config.delegated.walletSigningSupported ||
      !isAddress(config.delegated.executor ?? "")) return "Delegated authorization is unavailable on Base Mainnet. The draft remains inactive.";
  const ready = [form.sell, form.buy].every((address) => {
    const expected = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase())!;
    return tokens.some((t) => t && typeof t.address === "string" && t.address.toLowerCase() === expected.address.toLowerCase() && t.symbol === expected.symbol && t.decimals === expected.decimals);
  });
  if (!ready) return "Runtime token details are unavailable. Retry loading settings; the review values are preserved.";
  if (!authenticated) return "Sign in to load the live quote. Sign-in alone does not authorize a goal.";
  return chatQuoteReviewError(quote, form, args.walletAddress);
}
