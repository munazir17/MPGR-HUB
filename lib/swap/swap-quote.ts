import { type Address } from "viem";
import { requestManualSwapQuote, type ManualSwapInput } from "@/lib/trade/manual-swap";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { swapFeePolicyError } from "./swap-policy";
export async function requestSwapQuote(input: ManualSwapInput, account: Address, signal?: AbortSignal, tokens?: readonly TradeTokenRef[]) {
  const request = { ...input, requireMPGRFee: true };
  const proposal = await requestManualSwapQuote(request, account, signal, tokens);
  const invalid = swapFeePolicyError(proposal);
  if (invalid) throw new Error(invalid);
  return proposal;
}
