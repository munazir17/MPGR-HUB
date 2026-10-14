// Offline API-shaped fixtures only; never imported by production components.
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { CHAT_REVIEW_TOKENS } from "../chat-autonomy-review";
import { parseBaseUnits } from "@/lib/autonomy/policy-engine";
import type { AutonomyAuthorizeFormState } from "../autonomy-authorize-form";
import type { TradeTokenRef } from "@/lib/trade/trade-types";

export function reviewQuoteFixture(form: AutonomyAuthorizeFormState) {
  const token = (address: string): TradeTokenRef => {
    const t = CHAT_REVIEW_TOKENS.find((t) => t.address === address)!;
    return { ...t, address: t.address as `0x${string}`, name: t.symbol, kind: "erc20", verified: true };
  };
  const result = buildTradeProposal({
    from: token(form.sell), to: token(form.buy), taker: "0x1111111111111111111111111111111111111111", slippageBps: form.slippageBps,
    quote: { liquidityAvailable: true, fromToken: form.sell, toToken: form.buy, fromAmount: parseBaseUnits(form.sellAmount, token(form.sell).decimals)!,
      toAmount: "290000", minToAmount: "280000", transaction: { to: "0x2222222222222222222222222222222222222222", data: "0x1234", value: "0" }, permit2: null },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.proposal;
}
