import { formatAtomicAmount } from "./trade-format";
import type { TradeProposal, TradeTokenRef, CdpSwapPrice } from "./trade-types";

export const NO_BASE_ROUTE = "Token contract found, but no executable Base liquidity route is currently available.";

/** Public error boundary. Never pass arbitrary provider messages to chat. */
export function publicTradeError(error: { code?: unknown; message?: unknown } | null | undefined): string {
  switch (error?.code) {
    case "INVALID_ADDRESS": return "Invalid token address. Use 0x followed by exactly 40 hexadecimal characters.";
    case "TOKEN_NOT_CONTRACT": return "This address has no deployed contract on Base. Provide a token contract, not a wallet address.";
    case "TOKEN_NOT_ERC20": return "Contract found on Base, but it does not expose the required ERC-20 token interface.";
    case "TOKEN_METADATA_UNAVAILABLE": return "Token contract found, but its metadata could not be read reliably. Nothing was prepared.";
    case "TOKEN_NOT_FOUND": return "No matching Base token was found in the discovery catalog. Provide the exact contract address to check it directly.";
    case "TOKEN_AMBIGUOUS": {
      // Full addresses are appropriate ONLY for this explicit selection question.
      const addresses = typeof error.message === "string" ? error.message.match(/0x[a-fA-F0-9]{40}\b/g) : null;
      return `Multiple Base contracts match. Repeat the swap with the exact contract you intend${addresses?.length ? `: ${[...new Set(addresses)].slice(0, 8).join(", ")}` : ""}.`;
    }
    case "LIQUIDITY_UNAVAILABLE": case "EXECUTION_UNAVAILABLE": return NO_BASE_ROUTE;
    case "WALLET_REJECTED": return "Your wallet rejected the transaction.";
    case "SEND_FAILED": return error.message === "The swap transaction failed on Base."
      ? "Transaction failed on-chain." : "Transaction failed. Check any submitted transaction before trying again.";
    case "APPROVAL_FAILED": return "Token approval failed. Check your wallet before trying again.";
    case "WALLET_REQUIRED": case "WALLET_NOT_CONNECTED": return "Connect and sign in with your wallet on Base to continue.";
    case "INSUFFICIENT_BALANCE": return "Not enough balance for this swap. Add funds or lower the amount.";
    case "QUOTE_CHANGED": return "The quote changed. Review a fresh quote before confirming.";
    case "QUOTE_EXPIRED": return "This quote expired. Request a fresh quote.";
    case "UNSUPPORTED_NETWORK": return "Switch your wallet to Base to continue.";
    case "INVALID_INPUT": return "Check the tokens and amount, then request a fresh quote.";
    case "CREDENTIALS_MISSING": return "Swaps are temporarily unavailable. Please try again later.";
    default: return "Could not fetch or prepare this swap right now. Please try again.";
  }
}

const amount = (value: string, token: TradeTokenRef) => `${formatAtomicAmount(value, token.decimals, token.decimals)} ${token.symbol}`;

export function formatTradeReview(proposal: TradeProposal): string {
  if (proposal.executionAvailable === false) return NO_BASE_ROUTE;
  // Defensive against incomplete persisted/older proposal payloads. The modal
  // remains gated by the existing validator; never invent missing amounts.
  if (!proposal.from || !proposal.to) return "Review the swap details before confirming. Nothing is signed or submitted until you explicitly confirm in your wallet.";
  const fee = proposal.agentFee;
  return [
    `Swap ${amount(proposal.fromAmount, proposal.from)} → ~${amount(proposal.toAmount, proposal.to)}`,
    `Minimum received: ${amount(proposal.minToAmount, proposal.to)}`,
    "Network: Base",
    `Slippage: ${proposal.slippageBps / 100}%`,
    ...(fee?.status === "applied" ? [`MPGR fee${fee.bps !== null ? ` (${fee.bps / 100}%)` : ""}: ${amount(fee.amountAtomic, proposal.from)} (taken from the swap amount in the same transaction)`] : []),
    "Your wallet signs and sends the transaction. MPGR never controls your funds.",
    "Confirm swap?",
  ].join("\n");
}

export function formatTradePrice(data: { price?: CdpSwapPrice; from?: TradeTokenRef; to?: TradeTokenRef } | undefined): string {
  if (data?.price?.liquidityAvailable === false) return NO_BASE_ROUTE;
  if (!data?.from || !data.to || !data.price?.fromAmount || !data.price.toAmount) return "The quote could not be displayed reliably. Request a fresh quote with the tokens and amount.";
  return `Quote: ${amount(data.price.fromAmount, data.from)} → ~${amount(data.price.toAmount, data.to)}\nNetwork: Base\nQuote only. Nothing was signed or submitted.`;
}

export function formatTradeSuccess(proposal: TradeProposal, hash: `0x${string}`): string {
  // The reviewed quote is an estimate, not a decoded receipt amount. Never claim
  // its output is the actual received amount without receipt/event evidence.
  return `Swap confirmed.\n\n${amount(proposal.fromAmount, proposal.from)} → ~${amount(proposal.toAmount, proposal.to)} (quoted output)\n\nTransaction: https://basescan.org/tx/${hash}`;
}

/** Also applied at rendering so old persisted tool dumps cannot leak back out. */
export function publicAgentContent(text: string): string {
  // Legacy persisted success messages contained approval internals and duplicated
  // raw hashes. Preserve their quoted amounts and explorer link, not that dump.
  if (text.startsWith("✅ Swap successful")) {
    const link = text.match(/https:\/\/basescan\.org\/tx\/0x[a-fA-F0-9]{64}\b/)?.[0];
    const quoted = text.split("\n").find(line => line.includes(" → "));
    if (link) text = `Swap confirmed.\n\n${quoted ? `${quoted} (quoted output)\n\n` : ""}Transaction: ${link}`;
  }
  if (/\{\s*["']?[\w-]+["']?\s*:|\[\s*\{|```(?:json)?\s*[{[]|\b(?:Bearer\s+\S+|api[ _-]?key\s*[=:]|private[ _-]?key\s*[=:]|authorization\s*[=:])|\bsk-(?:proj-)?[a-zA-Z0-9_-]{8,}|https?:\/\/[^\s/@]+:[^\s/@]+@|[?&](?:key|token|secret)=/i.test(text)) {
    return "I couldn’t display that result safely. Please request a fresh quote or try your question again.";
  }
  return text;
}
