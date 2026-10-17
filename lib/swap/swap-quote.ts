import { type Address } from "viem";
import { requestManualSwapQuote, type ManualSwapInput } from "@/lib/trade/manual-swap";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { swapQuoteFresh } from "./swap-lifecycle";
import { swapFeePolicyError } from "./swap-policy";
export async function requestSwapQuote(input: ManualSwapInput, account: Address, signal?: AbortSignal, tokens?: readonly TradeTokenRef[], options?: { fresh?: boolean }) {
  const request = { ...input, requireMPGRFee: true, ...(options?.fresh ? { refreshQuote: true } : {}) };
  const proposal = await requestManualSwapQuote(request, account, signal, tokens);
  const invalid = swapFeePolicyError(proposal);
  if (invalid) throw new Error(invalid);
  if (!swapQuoteFresh(proposal)) throw new Error("The route expired. Request a new quote.");
  return proposal;
}
