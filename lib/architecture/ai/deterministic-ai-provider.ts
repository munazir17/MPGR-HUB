import {
  extractTradeHumanAmount,
  extractTradeSymbol,
  extractX402ResourceUrl,
  generateIntelligentReply,
  isTradePrompt,
  isTradeQuotePrompt,
  isTradeSellPrompt,
  isX402PaymentPrompt,
} from "@/lib/agent-intelligence";
import { getFollowUpPrompts } from "@/lib/agent-actions";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runRegisteredTool } from "./agent-tool-calling";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";
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
    if (isX402PaymentPrompt(request.prompt)) {
      return prepareOrExplainX402(request);
    }

    if (isTradePrompt(request.prompt)) {
      return prepareOrExplainTrade(request);
    }

    return generateIntelligentReply(
      request.prompt,
      request.agentContext,
      request.previousIntent,
      request.memoryContext
    );
  }
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

async function prepareOrExplainTrade(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const symbol = extractTradeSymbol(request.prompt);
  const wantsQuote = isTradeQuotePrompt(request.prompt);

  if (wantsQuote) {
    if (!symbol) {
      return helpResponse(
        "I cannot safely resolve that tokenized stock from the official Coinbase B20 catalog on Base. Name a catalog ticker such as AAPLc, COINc, or TSLAc. Nothing was signed or submitted.",
      );
    }

    const amount = extractTradeHumanAmount(request.prompt);
    if (!amount) {
      return helpResponse(
        "A dollar or token amount is required before I can prepare a Base swap quote (for example $10). I will not guess fromAmount. Nothing was signed or submitted.",
      );
    }

    const selling = isTradeSellPrompt(request.prompt);
    const hydrated = hydrateTradeSwapArguments(
      {
        fromToken: selling ? symbol : "USDC",
        toToken: selling ? "USDC" : symbol,
        amount: amount,
      },
      request.address,
    );

    if (typeof hydrated.fromAmount !== "string" || !hydrated.fromAmount) {
      return helpResponse(
        "I could not convert that amount into a Base swap fromAmount using the token's catalog decimals. Nothing was signed or submitted.",
      );
    }

    const result = await runRegisteredTool(
      "trade_prepare_swap",
      hydrated,
      request,
    );

    if (result.success) {
      const proposal = (result.data as { proposal?: TradeProposal } | undefined)?.proposal;
      if (proposal) {
        return {
          intent: "general_help",
          reply:
            "A Base swap proposal is ready for you to review. Nothing is signed or submitted until you explicitly confirm.",
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
        : "Coinbase CDP could not prepare a swap quote for this pair.";

    return helpResponse(
      "I tried to prepare a Base swap quote and it did not complete. " +
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
    reply,
    actions: [],
    highlights: [],
    followUps: getFollowUpPrompts("general_help"),
  };
}
