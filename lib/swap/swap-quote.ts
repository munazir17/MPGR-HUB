import { type Address } from "viem";
import { MANUAL_SWAP_TOKENS, ManualSwapQuoteError, manualQuoteFresh, type ManualSwapInput } from "@/lib/trade/manual-swap";
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { parseHumanTokenAmount } from "@/lib/trade/trade-format";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { swapQuoteFresh } from "./swap-lifecycle";
import { swapQuotePolicyError } from "./swap-policy";
import { swapInputError } from "./swap-capability";
class SwapQuoteError extends ManualSwapQuoteError {
  constructor(status: number, code: string, message: string) { super(status, code, message); this.name = "SwapQuoteError"; this.message = message; }
}
export async function requestSwapQuote(input: ManualSwapInput, account: Address, signal?: AbortSignal, tokens: readonly TradeTokenRef[] = MANUAL_SWAP_TOKENS, options?: { fresh?: boolean }) {
  const inputError = swapInputError(input, tokens); if (inputError) throw new Error(inputError);
  const response = await fetch("/api/swap/quote", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...input, requireMPGRFee: true, ...(options?.fresh ? { refreshQuote: true } : {}) }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.proposal) throw new SwapQuoteError(response.status, payload?.reason ?? payload?.code ?? "INVALID_RESPONSE", typeof payload?.error === "string" ? payload.error : "No executable quote returned. Please retry.");
  const p: TradeProposal = payload.proposal;
  if (!p.from || !p.to || !Array.isArray(p.postConfirmationSteps) || !p.fees || !Array.isArray(p.risk)) throw new Error("Malformed swap proposal. Request a fresh quote.");
  const validation = revalidateTradeProposal(p, account);
  if (validation.state !== "VALIDATED") throw new Error(validation.error?.message ?? "Invalid swap quote.");
  if (p.from.address.toLowerCase() !== input.fromToken.toLowerCase() || p.to.address.toLowerCase() !== input.toToken.toLowerCase() ||
      parseHumanTokenAmount(input.amount, p.from.decimals)?.toString() !== p.fromAmount || p.slippageBps !== input.slippageBps || !manualQuoteFresh(p)) throw new Error("Quote does not match the requested tokens, amount, slippage or expiry. Refresh the quote.");
  const invalid = swapQuotePolicyError(p); if (invalid) throw new Error(invalid);
  if (!swapQuoteFresh(p)) throw new Error("The route expired. Request a new quote.");
  return p;
}
