// Manual entry uses the existing session-bound quote route and its routing,
// decimals, fees and slippage validation. No client quote/calldata construction.
import { TRADE_QUOTE_MAX_AGE_MS } from "./trade-config";
import { parseHumanTokenAmount } from "./trade-format";
import { revalidateTradeProposal } from "./trade-confirmation";
import { KNOWN_TRADE_TOKENS } from "./trade-tokens";
import { findBasePairByAddress, isNotYetLiveB20 } from "@/lib/markets/base-pairs";
import type { Address } from "viem";
import type { TradeProposal } from "./trade-types";

export const MANUAL_SWAP_TOKENS = [...new Map(KNOWN_TRADE_TOKENS.filter(t => !isNotYetLiveB20(t.symbol) && findBasePairByAddress(t.address)?.live !== false).map(t => [t.address.toLowerCase(), t])).values()];
export interface ManualSwapInput { fromToken: string; toToken: string; amount: string; slippageBps: number }
export function manualSwapInputError(input: ManualSwapInput): string | null {
  const from = MANUAL_SWAP_TOKENS.find(t => t.address === input.fromToken);
  const to = MANUAL_SWAP_TOKENS.find(t => t.address === input.toToken);
  if (!from || !to || from === to) return "Select two different supported tokens.";
  // B20 decimals are verified on the server; never convert an amount using
  // catalog display defaults. Non-B20 precision can be checked locally.
  if (!/^\d+(?:\.\d+)?$/.test(input.amount) || !/[1-9]/.test(input.amount) ||
      (from.kind !== "b20-tokenized-stock" && parseHumanTokenAmount(input.amount, from.decimals) === null)) return "Enter a positive amount within the sell token's precision.";
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500) return "Slippage must be 1–500 bps.";
  return null;
}
export function manualQuoteFresh(proposal: TradeProposal, now = Date.now()): boolean {
  const quotedAt = Date.parse(proposal.quotedAt), expiresAt = Date.parse(proposal.expiresAt);
  return Number.isFinite(quotedAt) && Number.isFinite(expiresAt) && quotedAt <= now + 5_000 && now - quotedAt <= TRADE_QUOTE_MAX_AGE_MS && expiresAt > now;
}
export class ManualSwapQuoteError extends Error {
  constructor(public status: number, public code: string, message: string) { super(`Quote HTTP ${status} (${code}): ${message}`); }
}
export async function requestManualSwapQuote(input: ManualSwapInput, account: Address, signal?: AbortSignal): Promise<TradeProposal> {
  const invalid = manualSwapInputError(input);
  if (invalid) throw new Error(invalid);
  const response = await fetch("/api/trade/quote", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(input) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.proposal) {
    const code = typeof payload?.code === "string" ? payload.code : "INVALID_RESPONSE";
    throw new ManualSwapQuoteError(response.status, code, typeof payload?.error === "string" ? payload.error : "No executable quote returned.");
  }
  const proposal: TradeProposal = payload.proposal;
  if (!proposal.from || !proposal.to || !Array.isArray(proposal.postConfirmationSteps) || !proposal.fees || !Array.isArray(proposal.risk)) throw new ManualSwapQuoteError(response.status, "INVALID_RESPONSE", "Malformed swap proposal.");
  const validation = revalidateTradeProposal(proposal, account);
  if (validation.state !== "VALIDATED") throw new Error(validation.error?.message ?? "Invalid swap quote.");
  if (proposal.from.address.toLowerCase() !== input.fromToken.toLowerCase() || proposal.to.address.toLowerCase() !== input.toToken.toLowerCase() ||
      parseHumanTokenAmount(input.amount, proposal.from.decimals)?.toString() !== proposal.fromAmount || proposal.slippageBps !== input.slippageBps || !manualQuoteFresh(proposal)) {
    throw new Error("Quote does not match the requested tokens, amount, slippage or expiry. Refresh the quote.");
  }
  return proposal;
}
