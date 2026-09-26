import { formatTradeReview, formatTradePrice, publicAgentContent } from "@/lib/trade/trade-chat";
import { hasNegativeTradeAmount } from "./tool-call-normalization";
import {
  extractBaseSwapIntent,
  extractUnresolvedSwapOrder,
  isTradeExecutionPrompt,
  resolveTokenizedStockOrderSide,
  extractCryptoSwapAmount,
  extractCryptoSwapPair,
  extractTradeHumanAmount,
  extractTokenizedStockOrderAmount,
  extractTradeSymbol,
  extractTransferRequest,
  extractX402ResourceUrl,
  generateIntelligentReply,
  isCryptoSwapQuotePrompt,
  isTradePrompt,
  isTradeQuotePrompt,
  isTradeSellPrompt,
  isTransferPrompt,
  isX402PaymentPrompt,
  type BaseSwapIntent,
} from "@/lib/agent-intelligence";
import { getFollowUpPrompts } from "@/lib/agent-actions";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runRegisteredTool } from "./agent-tool-calling";
import { answerWalletBalance } from "./wallet-balance-answer";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";
import type { TransferProposal } from "@/lib/trade/transfer-types";
import { hydrateTradeSwapArguments } from "@/lib/trade/trade-request";

// Phase 3C Part 1 — wraps generateIntelligentReply as the always-available
// local provider. FallbackAIProvider uses this class when Gemini throws.
//
// x402 addendum — payment prompts still never sign or submit. When the
// Gemini tool loop fails mid-flight, this provider runs the existing
// read/prepare tools itself so a review-only proposal can still surface.
//
// P4 trade addendum — same pattern for tokenized-stock research and
// Base swap quotes. Never signs. Never broadcasts.

export class DeterministicAIProvider implements AIProvider {
  readonly name = "deterministic";
  readonly requiresNetwork = false;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    if (hasNegativeTradeAmount(request.prompt)) return helpResponse("The swap amount must be positive. Nothing was signed or submitted.");
    // Strict wallet-balance questions ("What is my MSTRc balance?", "How much
    // MPGR do I have?", "What's in my wallet?", "How much is my wallet
    // worth?") are answered from live reads — and ONLY what was asked. This
    // runs before every trade/portfolio branch so a token balance can never
    // be answered with a whole-portfolio dump.
    const balanceAnswer = await answerWalletBalance(request);
    if (balanceAnswer) return balanceAnswer;

    if (isTransferPrompt(request.prompt)) {
      return prepareOrExplainTransfer(request);
    }

    // Catalog-backed B20 names (AAPL → AAPLc, etc.) win over the
    // generic ETH/USDC/MPGR swap classifier so a tokenized-stock
    // prepare cannot fall into trade_prepare_swap.
    if (isTradePrompt(request.prompt) && extractTradeSymbol(request.prompt)) {
      return prepareOrExplainTrade(request);
    }

    const directSwap = extractBaseSwapIntent(request.prompt);
    if (directSwap && !directSwap.quoteOnly && isTradeExecutionPrompt(request.prompt)) {
      return prepareOrExplainBaseSwap(request, directSwap);
    }

    if (isCryptoSwapQuotePrompt(request.prompt)) {
      return quoteOrPrepareCryptoSwap(request);
    }

    // Extended catalog swaps — cbBTC/cbETH/cbDOGE/cbXRP/cbLTC/cbADA,
    // official B20 tickers the earlier branches did not claim, and raw
    // 0x addresses the user pasted instead of a symbol. Same quote/
    // prepare routes as the API path; never signs.
    const baseSwap = extractBaseSwapIntent(request.prompt);
    if (baseSwap) {
      return prepareOrExplainBaseSwap(request, baseSwap);
    }

    if (isTradePrompt(request.prompt)) {
      return prepareOrExplainTrade(request);
    }

    if (isX402PaymentPrompt(request.prompt)) {
      return prepareOrExplainX402(request);
    }

    // A SIZED order naming an asset this app does not support ("buy 10
    // USDC of FAKECOIN") gets an explicit refusal. It never reaches a
    // prepare tool, and the user is pointed at the supported set plus the
    // 0x-address route instead of being handed generic help.
    const unresolvedOrder = extractUnresolvedSwapOrder(request.prompt);
    if (unresolvedOrder) {
      if (!unresolvedOrder.amount) return helpResponse("How much of the sell token do you want to swap? Include the token name or exact Base contract.");
      const result = await runRegisteredTool("trade_prepare_swap", {
        fromToken: unresolvedOrder.sell, toToken: unresolvedOrder.buy, amount: unresolvedOrder.amount,
      }, request);
      const proposal = result.success ? (result.data as { proposal?: TradeProposal } | undefined)?.proposal : undefined;
      if (proposal) return { ...helpResponse(formatTradeReview(proposal)), tradeProposal: proposal };
      return helpResponse(publicAgentContent(result.error?.message ?? "Could not resolve and prepare this swap. Please try again."));
    }

    return generateIntelligentReply(
      request.prompt,
      request.agentContext,
      request.previousIntent,
      request.memoryContext
    );
  }
}

async function prepareOrExplainTransfer(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const parsed = extractTransferRequest(request.prompt);
  if (!parsed) {
    return helpResponse(
      "I can prepare a Base send for your review, but I need token, amount, and recipient. Example: \"Send 0.000001 ETH to jesse.base.eth\" or use the 0x address directly. Nothing will be signed until you confirm.",
    );
  }

  const result = await runRegisteredTool(
    "transfer_prepare_send",
    parsed,
    request,
  );

  if (result.success) {
    const proposal = (result.data as { proposal?: TransferProposal } | undefined)?.proposal;
    if (proposal) {
      return {
        intent: "general_help",
        reply:
          "I prepared a Base transfer proposal for your review. Nothing is signed or submitted until you explicitly confirm.",
        actions: [],
        highlights: [],
        followUps: getFollowUpPrompts("general_help"),
        transferProposal: proposal,
      };
    }
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "The Base transfer could not be prepared.";

  return helpResponse(detail);
}

async function prepareOrExplainX402(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const resourceUrl = extractX402ResourceUrl(request.prompt);
  if (!resourceUrl) {
    return helpResponse(
      "This looks like an x402 paid-resource request, but I could not find a valid https resource URL to inspect. Paste the full https:// URL — nothing will be signed or submitted.",
    );
  }

  const result = await runRegisteredTool(
    "x402_prepare_payment",
    { resourceUrl },
    request,
  );

  if (result.success) {
    const proposal = (result.data as { proposal?: X402PaymentProposal } | undefined)
      ?.proposal;
    if (proposal) {
      return {
        intent: "general_help",
        reply:
          "I prepared an x402 payment proposal for your review. Nothing is signed or submitted until you explicitly confirm.",
        actions: [],
        highlights: [],
        followUps: getFollowUpPrompts("general_help"),
        x402Proposal: proposal,
      };
    }
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "The resource could not be prepared as a supported x402 payment.";

  return helpResponse(
    "I found the resource URL but could not prepare a payment proposal. " +
      detail +
      " Nothing was signed or submitted.",
  );
}

async function quoteOrPrepareCryptoSwap(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const pair = extractCryptoSwapPair(request.prompt);
  if (!pair) {
    return helpResponse(
      "I can quote ETH, WETH, USDC, or MPGR on Base. Name the pair (for example ETH to USDC). I will not invent a price.",
    );
  }

  const amount = extractTradeHumanAmount(request.prompt) ?? extractCryptoSwapAmount(request.prompt);
  const wantsPrepare = /\bprepare\b|\bswap proposal\b/.test(request.prompt.toLowerCase());

  if (wantsPrepare && amount) {
    const hydrated = hydrateTradeSwapArguments(
      { fromToken: pair.fromToken, toToken: pair.toToken, amount },
      request.address,
    );
    const result = await runRegisteredTool("trade_prepare_swap", hydrated, request);
    if (result.success) {
      const proposal = (result.data as { proposal?: TradeProposal } | undefined)?.proposal;
      if (proposal) {
        return {
          intent: "general_help",
          reply:
            formatTradeReview(proposal),
          actions: [],
          highlights: [],
          followUps: getFollowUpPrompts("general_help"),
          tradeProposal: proposal,
        };
      }
    }
    const detail =
      typeof result.error?.message === "string" && result.error.message.trim()
        ? result.error.message.trim()
        : "No live Base swap quote is available for that pair right now.";
    return helpResponse(detail + " Nothing was signed or submitted.");
  }

  const result = await runRegisteredTool(
    "trade_get_price",
    amount
      ? { fromToken: pair.fromToken, toToken: pair.toToken, amount }
      : { fromToken: pair.fromToken, toToken: pair.toToken },
    request,
  );

  if (result.success) {
    return {
      intent: "general_help",
      reply:
        formatTradePrice(result.data as Parameters<typeof formatTradePrice>[0]),
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "Live Base quote tools are not available right now.";
  return helpResponse(
    "I could not fetch a live " +
      pair.fromToken +
      " → " +
      pair.toToken +
      " quote. " +
      detail +
      " I will not invent a price. Nothing was signed or submitted.",
  );
}

/**
 * Reference-price-only reply for a quote/price question over the
 * extended catalog (no proposal, no signature).
 */
async function quoteBaseSwapSide(
  request: AIProviderRequest,
  intent: BaseSwapIntent,
): Promise<AIProviderResponse> {
  const result = await runRegisteredTool(
    "trade_get_price",
    {
      fromToken: intent.sell.symbol ?? intent.sell.address,
      toToken: intent.buy.symbol ?? intent.buy.address,
      ...(intent.amount ? { amount: intent.amount } : {}),
    },
    request,
  );

  if (result.success) {
    return {
      intent: "general_help",
      reply:
        formatTradePrice(result.data as Parameters<typeof formatTradePrice>[0]),
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "Live Base quote tools are not available right now.";
  return helpResponse(
    "I could not fetch a live " +
      intent.sell.input +
      " → " +
      intent.buy.input +
      " quote. " +
      detail +
      " I will not invent a price. Nothing was signed or submitted.",
  );
}

/**
 * Natural "swap X to Y" over the existing supported token universe.
 *
 *   - no amount yet       → ask for it (no API call, no guessed unit)
 *   - quote/price wording → trade_get_price (reference only)
 *   - otherwise           → prepare_swap, which routes B20 legs through
 *                           the Aerodrome path and everything else
 *                           through the existing CDP → 0x quote route
 *
 * Never signs. The proposal it returns is review-only, exactly like the
 * other prepare tools.
 */
async function prepareOrExplainBaseSwap(
  request: AIProviderRequest,
  intent: BaseSwapIntent,
): Promise<AIProviderResponse> {
  if (intent.quoteOnly) {
    return quoteBaseSwapSide(request, intent);
  }

  if (!intent.amount) {
    return helpResponse(
      "How much " +
        intent.sell.input +
        " do you want to swap to " +
        intent.buy.input +
        "? Tell me the amount and I will prepare a Base swap proposal with the live quote (minimum received, route and fees) for you to review. Nothing is signed until you confirm in your wallet.",
    );
  }

  const result = await runRegisteredTool(
    "prepare_swap",
    {
      amount: intent.amount,
      ...(intent.sell.symbol
        ? { sellSymbol: intent.sell.symbol }
        : { sellAddress: intent.sell.address }),
      ...(intent.buy.symbol
        ? { buySymbol: intent.buy.symbol }
        : { buyAddress: intent.buy.address }),
    },
    request,
  );

  if (result.success) {
    const proposal = (result.data as { proposal?: TradeProposal } | undefined)?.proposal;
    if (proposal) {
      return {
        intent: "general_help",
        reply:
          formatTradeReview(proposal),
        actions: [],
        highlights: [],
        followUps: getFollowUpPrompts("general_help"),
        tradeProposal: proposal,
      };
    }
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "No live Base swap quote is available for that pair right now.";
  return helpResponse(detail + " Nothing was signed or submitted.");
}

async function prepareOrExplainTrade(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const symbol = extractTradeSymbol(request.prompt);
  const wantsQuote = isTradeQuotePrompt(request.prompt);
  // An explicit execution order ("sell my USDC worth of MSTRc",
  // "sell 5 MSTRc", "buy $10 of AAPLc") is NOT a research question. It
  // has to reach the prepare path — and when the size is missing it must
  // ASK for the size, never answer with a research-only reply while the
  // card claims an execution route is ready. Research phrasing without an
  // execution verb ("check AAPLc price", "NVDAc premium vs feed",
  // "should I buy AAPLc?") keeps the research path untouched.
  const wantsExecution = isTradeExecutionPrompt(request.prompt);

  if (wantsQuote || wantsExecution) {
    if (!symbol) {
      return helpResponse(
        "I cannot safely resolve that tokenized stock from the official Coinbase B20 catalog on Base. Name a catalog ticker such as AAPLc, COINc, or TSLAc. Nothing was signed or submitted.",
      );
    }

    // Side first: "sell my 4 USDC worth of MSTRc" SELLS MSTRc with a
    // ~4 USDC value target, "buy 5 USDC of MSTRc" spends 5 USDC on
    // MSTRc, and "sell 5 MSTRc" sells 5 shares. Deciding this from the
    // value-target phrasing and the resolved pair (falling back to the
    // wording) keeps the prepared order pointed the way the user asked.
    const catalogSwap = extractBaseSwapIntent(request.prompt);
    const side = resolveTokenizedStockOrderSide(request.prompt, symbol);
    const fundingSymbol =
      catalogSwap && catalogSwap.buy.symbol === symbol ? catalogSwap.sell.symbol : null;

    // Unit matters for B20 orders: "Sell 5 AAPLc" is 5 shares, while
    // "Sell $5 of my AAPLc" is a dollar budget. Reading both as dollars
    // is what made "Sell 5 AAPLc" prepare a wrong-sized (or unpricable)
    // order.
    const orderAmount = extractTokenizedStockOrderAmount(request.prompt, symbol);
    const amount = orderAmount?.amount ?? null;
    const amountUnit = orderAmount?.unit ?? "usd";
    if (!amount) {
      const question =
        side === "SELL"
          ? "How much " +
            symbol +
            " do you want to sell? Give me an amount — dollars (for example $10) or a share count (for example 0.05) — and I will prepare the tokenized-stock swap with the live quote — minOut, route, price impact and fees — for you to review. Nothing is signed until you confirm in your wallet."
          : "How much " +
            (fundingSymbol ?? "USDC") +
            " do you want to spend on " +
            symbol +
            "? Give me an amount — dollars (for example $10) or a share count (for example 0.05) — and I will prepare the tokenized-stock swap with the live quote — minOut, route, price impact and fees — for you to review. Nothing is signed until you confirm in your wallet.";
      return helpResponse(
        wantsExecution
          ? question
          : "A dollar or token amount is required before I can prepare a tokenized-stock swap (for example $10). I will not guess fromAmount. Nothing was signed or submitted.",
      );
    }

    const result = await runRegisteredTool(
      "tokenized_stock_prepare_order",
      {
        symbol,
        amount,
        side,
        amountUnit,
      },
      request,
    );

    if (result.success) {
      const proposal = (result.data as { proposal?: TradeProposal } | undefined)?.proposal;
      if (proposal) {
        return {
          intent: "general_help",
          reply:
            formatTradeReview(proposal),
          actions: [],
          highlights: [],
          followUps: getFollowUpPrompts("general_help"),
          tradeProposal: proposal,
        };
      }
    }

    const detail =
      typeof result.error?.message === "string" && result.error.message.trim()
        ? result.error.message.trim()
        : "No tokenized-stock swap could be prepared for this catalog asset.";

    return helpResponse(
      "I tried to prepare a Coinbase B20 tokenized-stock swap and it did not complete. " +
        detail +
        " Nothing was signed or submitted.",
    );
  }

  const result = await runRegisteredTool(
    "tokenized_stock_research",
    symbol ? { symbol: symbol } : {},
    request,
  );

  if (result.success) {
    const report = (result.data as { report?: TokenizedStockReport } | undefined)?.report;
    if (report) {
      return {
        intent: "general_help",
        reply:
          "Here is Coinbase tokenized-stock research on Base. This is research only — I will not sign or execute anything.",
        actions: [],
        highlights: [],
        followUps: getFollowUpPrompts("general_help"),
        tokenizedStockReport: report,
      };
    }
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "Tokenized-stock research is unavailable right now.";

  return helpResponse(
    "I could not complete that Coinbase tokenized-stock lookup. " +
      detail +
      " Nothing was signed or submitted.",
  );
}

function helpResponse(reply: string): AIProviderResponse {
  return {
    intent: "general_help",
    reply: publicAgentContent(reply),
    actions: [],
    highlights: [],
    followUps: getFollowUpPrompts("general_help"),
  };
}
