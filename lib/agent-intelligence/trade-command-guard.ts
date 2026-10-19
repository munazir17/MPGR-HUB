// Deterministic input refusals before conditional parsing or any AI/tool path.
// This is NOT an authorization gate: the existing quote/confirm/executor gates
// still independently validate every proposal and wallet transaction.
import { conditionalTradeInputError } from "@/lib/autonomy/chat-draft";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
export function tradeCommandInputError(prompt: string): string | null {
  if (!/\b(?:buy|sell|swap|trade|exchange|convert|route|limit[- ]orders?)\b/i.test(prompt)) return null;
  if (/\blimit[- ]orders?\b/i.test(prompt)) return "Executable limit orders are not integrated. No order was signed or submitted. A conditional Agent goal is not a protocol limit order.";
  for (const match of prompt.matchAll(/\b(?:on(?:\s+chain)?|chain(?:\s+id)?\s*[:=]?)\s+([a-z0-9-]+(?:\s+(?:mainnet|sepolia))?)\b/gi)) {
    if (!/^(?:base(?: mainnet)?|8453)$/i.test(match[1])) return "Trading supports Base Mainnet (chain 8453) only. Specify a Base token contract and amount; nothing was prepared on another chain.";
  }
  const conditionalError = conditionalTradeInputError(prompt);
  if (conditionalError) return conditionalError;
  const joinedAssets = [...prompt.matchAll(/(?:\band\b|&)\s+(0x[a-f0-9]{40}|[a-z][a-z0-9]{1,15})\b/gi)];
  if (joinedAssets.some(match => /^0x/i.test(match[1]) || findKnownTradeToken(match[1]))) return "Specify one buy asset and one sell asset for this swap. Nothing was prepared from multiple asset choices.";
  if (/\b(?:or|either)\b|\b(?:and(?:\s+then)?|then)\s+(?:buy|sell|swap|convert|exchange)\b/i.test(prompt)) return "Specify one swap at a time with the exact sell asset, buy asset and sell amount. Nothing was prepared from an ambiguous or multi-order request.";
  // A token quantity is not a USDC budget. B20 has its own existing explicit
  // share/dollar parser; don't change that path's semantics.
  const quantity = /^\s*buy\s+\d+(?:\.\d+)?\s+(?:of\s+)?([a-z][a-z0-9]{1,15})(?:\s+on\s+base(?:\s+mainnet)?)?[.!?]?\s*$/i.exec(prompt);
  if (quantity && quantity[1].toUpperCase() !== "USDC" && findKnownTradeToken(quantity[1])?.kind !== "b20-tokenized-stock") return 'Specify the spend amount and asset, for example "Buy $10 of ETH on Base" or "Swap 20 USDC to WETH". A token quantity cannot be treated as a USDC budget.';
  return null;
}
