// Chat-only review metadata/validation. Never used by the Manual form.
// The registry is the same Base allowlist used by the existing tokens API;
// showing review options does not enable the runtime or authorize anything.
import { isAddress } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as registry, findExecutorRoute } from "@/lib/executor/executor-config";
import { AUTONOMY_LIMITS, AUTONOMY_SLIPPAGE_BOUNDS } from "@/lib/autonomy/config";
import { normalizeCondition, parseBaseUnits } from "@/lib/autonomy/policy-engine";
import type { AutonomyConfig, AutonomyTokenOption } from "@/hooks/useAgentAutonomy";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { autonomyDraftToForm, type AutonomyAuthorizeFormState } from "./autonomy-authorize-form";

export const CHAT_REVIEW_TOKENS: AutonomyTokenOption[] = registry.tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals }));

export function chatDraftToForm(draft: AutonomyGoalDraft): AutonomyAuthorizeFormState {
  const form = autonomyDraftToForm(draft, CHAT_REVIEW_TOKENS);
  // Missing spend is incomplete, not permission to invent the Manual default.
  return { ...form, sellAmount: draft.amountPerTrade ?? "" };
}

export function chatQuoteKey(form: AutonomyAuthorizeFormState): string {
  return JSON.stringify([form.sell, form.buy, form.sellAmount, form.slippageBps]);
}

/** UI preflight only; server policy/goal/slot validation remains authoritative. */
export function validateChatReviewForm(form: AutonomyAuthorizeFormState, limits: AutonomyConfig["limits"] | undefined): string | null {
  const sell = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.sell.toLowerCase());
  const buy = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.buy.toLowerCase());
  if (!sell || !buy) return "Select both supported Base tokens.";
  if (!findExecutorRoute(registry, sell.address as `0x${string}`, buy.address as `0x${string}`)) return "Select a pair with a registered Base route.";
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

export interface ChatReviewQuote { key: string; minOut: string; error?: string }

export function chatReviewAuthorizationError(args: {
  form: AutonomyAuthorizeFormState;
  config: AutonomyConfig | null;
  tokens: AutonomyTokenOption[];
  quote: ChatReviewQuote | null;
  authenticated: boolean;
  walletChainId: number | undefined;
}): string | null {
  const { form, config, tokens, quote, authenticated, walletChainId } = args;
  if (!config?.enabled) return "Autonomous goals are unavailable. Retry loading settings; no goal was created.";
  if (config.emergencyDisabled) return "Autonomous goals are disabled by the operator.";
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
  const buy = CHAT_REVIEW_TOKENS.find((t) => t.address.toLowerCase() === form.buy.toLowerCase())!;
  if (!quote || quote.key !== chatQuoteKey(form) || !parseBaseUnits(quote.minOut, buy.decimals)) {
    return quote?.key === chatQuoteKey(form) && quote.error ? quote.error : "A valid live quote for this pair, amount and slippage is required before authorization.";
  }
  return null;
}
