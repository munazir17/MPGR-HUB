// lib/agent-intelligence.ts
//
// Behavior-preserving facade re-exporting decomposed domain modules:
// - types: AgentIntent, AGENT_INTENTS, AgentIntelligenceResult
// - prompt-parsers: NLP pattern helpers, trade/transfer/x402 parsers
// - intent-detector: priority-driven intent detection, memory context follow-ups
// - reply-generators: deterministic grounded responses, account summaries, greeting/recall notes

import type { AgentContext } from "@/lib/agent-context";
import {
  getAgentActions,
  getAgentHighlights,
  getFollowUpPrompts,
} from "@/lib/agent-actions";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

export type {
  AgentIntent,
  AgentIntelligenceResult,
} from "./agent-intelligence/types";
export {
  AGENT_INTENTS,
} from "./agent-intelligence/types";

export {
  isTradePrompt,
  isTradeQuotePrompt,
  extractCryptoSwapPair,
  extractCryptoSwapAmount,
  isCryptoSwapQuotePrompt,
  extractTradeSymbol,
  isTradeSellPrompt,
  isTradeExecutionPrompt,
  extractTradeHumanAmount,
  extractTokenizedStockOrderAmount,
  isX402PaymentPrompt,
  isTransferPrompt,
  extractTransferRequest,
  extractX402ResourceUrl,
} from "./agent-intelligence/prompt-parsers";

export {
  extractBaseSwapIntent,
  extractUnresolvedSwapOrder,
} from "./agent-intelligence/swap-intent";

export {
  parseWalletBalanceRequest,
  isWalletBalancePrompt,
} from "./agent-intelligence/wallet-balance-intent";
export type {
  WalletBalanceRequest,
  WalletBalanceScope,
} from "./agent-intelligence/wallet-balance-intent";

import { extractBaseSwapIntent as extractBaseSwapIntentForSide } from "./agent-intelligence/swap-intent";
import { isSellValueTargetPhrasing } from "./agent-intelligence/swap-intent";
import { isTradeSellPrompt as isSellPhrased } from "./agent-intelligence/prompt-parsers";

/**
 * Which side of a Coinbase B20 order the user is actually on.
 *
 * Two phrasing families have to stay apart:
 *
 *   "Sell my 4 USDC worth of MSTRc"  → SELL MSTRc, ~4 USDC out. The SELL
 *     verb governs and the dollar figure is the sale's value target.
 *     (Read as a BUY this prepared the exact opposite order — 4 USDC in,
 *     MSTRc out — which is what this fixes.)
 *   "Buy 5 USDC of MSTRc"            → BUY MSTRc, 5 USDC in.
 *   "Sell 5 MSTRc"                   → SELL 5 MSTRc for USDC.
 *
 * When the extended parser resolves a pair that names the B20 ticker and
 * no value-target phrasing is present, that pair decides the side; only
 * prompts with no resolvable pair fall back to the wording.
 */
export function resolveTokenizedStockOrderSide(
  rawPrompt: string,
  ticker: string | null,
): "BUY" | "SELL" {
  if (ticker && isSellValueTargetPhrasing(rawPrompt, ticker)) return "SELL";
  if (ticker) {
    const intent = extractBaseSwapIntentForSide(rawPrompt);
    if (intent) {
      if (intent.buy.symbol === ticker) return "BUY";
      if (intent.sell.symbol === ticker) return "SELL";
    }
  }
  return isSellPhrased(rawPrompt) ? "SELL" : "BUY";
}
export type {
  BaseSwapIntent,
  BaseSwapIntentSide,
} from "./agent-intelligence/swap-intent";

export {
  detectIntent,
} from "./agent-intelligence/intent-detector";

import type { AgentIntent, AgentIntelligenceResult } from "./agent-intelligence/types";
import {
  normalizePrompt,
  looksLikeTradePrompt,
  looksLikeX402PaymentPrompt,
  isCryptoSwapQuotePrompt,
  extractTradeSymbol,
} from "./agent-intelligence/prompt-parsers";
import {
  detectIntent,
} from "./agent-intelligence/intent-detector";
import {
  NOT_CONNECTED_REPLY,
  TRADE_HELP_REPLY,
  X402_PAYMENT_HELP_REPLY,
  INTENT_HANDLERS,
  buildGreetingReply,
  buildRecallNote,
} from "./agent-intelligence/reply-generators";

export function generateIntelligentReply(
  prompt: string,
  context: AgentContext,
  previousIntent: AgentIntent | null,
  memoryContext?: ConversationMemoryContext
): AgentIntelligenceResult {
  const { intent, greeting } = detectIntent(prompt, previousIntent, memoryContext);

  if (!context.isConnected && intent !== "research_query" && intent !== "market_overview" && intent !== "general_help") {
    return { intent: "general_help", reply: NOT_CONNECTED_REPLY, actions: [], highlights: [], followUps: [] };
  }

  if (looksLikeX402PaymentPrompt(normalizePrompt(prompt))) {
    return {
      intent: "general_help",
      reply: X402_PAYMENT_HELP_REPLY,
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (isCryptoSwapQuotePrompt(prompt)) {
    return {
      intent: "general_help",
      reply:
        "I can fetch a live Base swap quote for ETH/WETH/USDC/MPGR via the existing trade price path. Nothing is signed until you confirm a prepared swap.",
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (looksLikeTradePrompt(normalizePrompt(prompt)) && extractTradeSymbol(prompt)) {
    return {
      intent: "general_help",
      reply: TRADE_HELP_REPLY,
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (greeting) {
    const reply = buildGreetingReply(memoryContext);
    return { intent, reply, actions: [], highlights: [], followUps: getFollowUpPrompts(intent) };
  }

  const baseReply = INTENT_HANDLERS[intent](context);
  const recallNote = buildRecallNote(intent, memoryContext);
  const reply = recallNote ? baseReply + " " + recallNote : baseReply;

  return {
    intent,
    reply,
    actions: getAgentActions(intent, context),
    highlights: getAgentHighlights(intent, context),
    followUps: getFollowUpPrompts(intent),
  };
}
