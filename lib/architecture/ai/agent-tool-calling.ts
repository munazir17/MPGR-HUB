// lib/architecture/ai/agent-tool-calling.ts

import type {
  AIProviderRequest,
  AIProviderResponse,
} from "./ai-provider";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";
import type { TransferProposal } from "@/lib/trade/transfer-types";
import {
  extractTokenizedStockOrderAmount,
  extractTradeSymbol,
  isTradeExecutionPrompt,
  isTradePrompt,
  isTradeQuotePrompt,
  isTradeSellPrompt,
  resolveTokenizedStockOrderSide,
} from "@/lib/agent-intelligence";

import { extractBaseSwapIntent } from "@/lib/agent-intelligence";

// Re-exports from decomposed modules preserving 100% public API compatibility
export {
  MAX_TOOL_CALL_ROUNDS,
  normalizeX402ToolArguments,
  normalizeTradeToolArguments,
  hasNegativeTradeAmount,
} from "./tool-call-normalization";

export {
  parseModelDirective,
} from "./tool-call-parser";
export type {
  ToolCallDirective,
  FinalAnswerDirective,
  ModelDirective,
} from "./tool-call-parser";

export {
  getReadOnlyToolCatalog,
  getReadAndPrepareToolCatalog,
  selectAdvertisedToolsForPrompt,
  buildGatedCapabilityInstructions,
  buildToolCatalogPromptBlock,
  buildCompactToolCatalogPromptBlock,
} from "./tool-catalog-selector";

export {
  runRegisteredReadTool,
  runRegisteredTool,
  synthesizeFinalReplyFromToolResult,
} from "./tool-execution-service";

import {
  MAX_TOOL_CALL_ROUNDS,
  hasNegativeTradeAmount,
} from "./tool-call-normalization";
import {
  parseModelDirective,
} from "./tool-call-parser";
import { answerWalletBalance } from "./wallet-balance-answer";
import {
  buildCompactToolCatalogPromptBlock,
  buildToolCatalogPromptBlock,
  isTradeActionPrompt,
  selectAdvertisedToolsForPrompt,
} from "./tool-catalog-selector";
import {
  buildLoopResponse,
  captureTradeProposal,
  captureTokenizedStockReport,
  captureTransferProposal,
  captureX402Proposal,
  formatInsufficientBalanceReply,
  formatTransferPrepareFailureReply,
  runRegisteredTool,
  safeStringify,
  synthesizeFinalReplyFromToolResult,
} from "./tool-execution-service";

export type SendCompletion = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

const FORCED_B20_PREPARE_REPLY =
  "A tokenized-stock swap proposal is ready for you to review. Nothing is signed or submitted until you explicitly confirm.";

/**
 * An explicit B20 buy/sell order that cannot be quoted YET because the
 * user did not state a size. The reply must ask for the size — a
 * research-only answer to an execution order is the bug this guards
 * against (the card would meanwhile advertise a live execution route).
 */
function pendingTokenizedStockOrderSides(prompt: string): { symbol: string; side: "BUY" | "SELL" } | null {
  if (!isTradePrompt(prompt) || !isTradeExecutionPrompt(prompt)) return null;
  const symbol = extractTradeSymbol(prompt);
  if (!symbol) return null;
  if (extractTokenizedStockOrderAmount(prompt, symbol)) return null;
  return { symbol, side: resolveTokenizedStockOrderSide(prompt, symbol) };
}

function formatPendingOrderReply(prompt: string): string {
  const pending = pendingTokenizedStockOrderSides(prompt);
  if (!pending) return "";
  const funding =
    extractBaseSwapIntent(prompt)?.sell.symbol ?? "USDC";
  return (
    "How much " +
    (pending.side === "SELL" ? pending.symbol : funding) +
    " do you want to " +
    (pending.side === "SELL" ? "sell" : "spend on " + pending.symbol) +
    "? Give me an amount — dollars (for example $10) or a share count (for example 0.05) — and I will prepare the tokenized-stock swap with the live quote — minOut, route, price impact and fees — for you to review. Nothing is signed until you confirm in your wallet."
  );
}

/**
 * If the network model answered a B20 buy/sell in prose (or JSON without
 * a tool call), still run the prepare-only tool so AgentTradeProposalCard
 * can render. Never signs. Never calls execute tools. Failures are
 * swallowed so a successful NVIDIA/Gemini reply is not turned into a 502.
 */
async function maybePrepareTokenizedStockOrder(
  request: AIProviderRequest,
  captured: TradeProposal | undefined,
): Promise<TradeProposal | undefined> {
  if (captured) return captured;
  if (!isTradePrompt(request.prompt)) return undefined;
  if (
    !isTradeQuotePrompt(request.prompt) &&
    !isTradeActionPrompt(request.prompt) &&
    !isTradeExecutionPrompt(request.prompt)
  ) {
    return undefined;
  }

  const symbol = extractTradeSymbol(request.prompt);
  if (!symbol) return undefined;
  // Unit-aware: a bare number next to the ticker is a share count
  // ("Sell 5 AAPLc"); "$5 of my AAPLc" stays a dollar budget.
  const orderAmount = extractTokenizedStockOrderAmount(request.prompt, symbol);
  if (!orderAmount) return undefined;

  const result = await runRegisteredTool(
    "tokenized_stock_prepare_order",
    {
      symbol,
      amount: orderAmount.amount,
      side: resolveTokenizedStockOrderSide(request.prompt, symbol),
      amountUnit: orderAmount.unit,
    },
    request,
  );

  return captureTradeProposal(
    "tokenized_stock_prepare_order",
    result,
    undefined,
  );
}

/**
 * Runs one provider turn with bounded client-side tool calling.
 *
 * P3 x402 behavior:
 *   1. Model requests x402_prepare_payment.
 *   2. Runtime executes the prepare tool.
 *   3. Structured X402PaymentProposal is extracted directly from tool data.
 *   4. Only a short non-sensitive confirmation message is sent back to the
 *      model.
 *   5. Final AIProviderResponse carries x402Proposal separately.
 *
 * The model never constructs the proposal.
 *
 * If the model requests another tool on the final allowed turn, the
 * loop still executes that last read/prepare tool (never execute-mode)
 * and returns a grounded final answer. It does not throw into
 * FallbackAIProvider after a valid tool result.
 */
export async function runToolCallingLoop(
  request: AIProviderRequest,
  baseSystemPrompt: string,
  sendCompletion: SendCompletion,
  options: { compactToolCatalog?: boolean; toolCatalog?: readonly AnyAgentTool[] } = {},
): Promise<AIProviderResponse> {
  // Strict wallet-balance questions are answered deterministically from live
  // on-chain reads BEFORE the model is called, so a single-token balance
  // ("What is my MSTRc balance?") can never come back as a portfolio summary
  // or a guessed number. Everything else keeps the normal tool loop.
  const balanceAnswer = await answerWalletBalance(request);
  if (balanceAnswer) return balanceAnswer;

  const toolCatalog = options.toolCatalog ?? selectAdvertisedToolsForPrompt(request.prompt);
  const catalogBlock = options.compactToolCatalog
    ? buildCompactToolCatalogPromptBlock(toolCatalog)
    : buildToolCatalogPromptBlock(toolCatalog);

  const systemPrompt = catalogBlock
    ? baseSystemPrompt + "\n\n" + catalogBlock
    : baseSystemPrompt;

  let transcript = "";

  let capturedX402Proposal:
    | X402PaymentProposal
    | undefined;
  let capturedTradeProposal: TradeProposal | undefined;
  let capturedStockReport: TokenizedStockReport | undefined;
  let capturedTransferProposal: TransferProposal | undefined;

  for (
    let round = 1;
    round <= MAX_TOOL_CALL_ROUNDS;
    round++
  ) {
    const isFinalRound =
      round === MAX_TOOL_CALL_ROUNDS;

    const roundSystemPrompt = isFinalRound
      ? systemPrompt +
        "\n\nThis is your final turn for this request. You MUST respond with the final answer JSON now. Do not request another tool."
      : systemPrompt;

    const userPrompt = transcript
      ? request.prompt + "\n\n" + transcript
      : request.prompt;

    // SECURITY: reject negative trade amounts from the ORIGINAL user
    // prompt before the model can normalize them into a positive tool
    // argument. This is intentionally before sendCompletion().
    if (hasNegativeTradeAmount(request.prompt)) {
      return buildLoopResponse(
        request,
        request.previousIntent ?? "general_help",
        "I cannot prepare that because the amount must be a positive value. Nothing was signed or submitted.",
        undefined,
        undefined,
        undefined,
        undefined,
      );
    }

    const content = await sendCompletion(
      roundSystemPrompt,
      userPrompt,
    );

    const directive = parseModelDirective(
      content,
      request.previousIntent,
    );

    if (directive.kind === "final") {
      const tradeProposal = await maybePrepareTokenizedStockOrder(
        request,
        capturedTradeProposal,
      );

      // An execution order with no size cannot be quoted, so the reply is
      // the amount question — deterministically, and without the research
      // card, instead of whatever the model wrote about the asset.
      const pendingOrderReply = formatPendingOrderReply(request.prompt);
      if (pendingOrderReply && !tradeProposal && !capturedTradeProposal) {
        return buildLoopResponse(
          request,
          request.previousIntent ?? "general_help",
          pendingOrderReply,
          capturedX402Proposal,
          undefined,
          undefined,
          capturedTransferProposal,
        );
      }

      const reply =
        tradeProposal && !capturedTradeProposal
          ? FORCED_B20_PREPARE_REPLY
          : directive.reply;

      return buildLoopResponse(
        request,
        directive.intent,
        reply,
        capturedX402Proposal,
        tradeProposal,
        capturedStockReport,
        capturedTransferProposal,
      );
    }

    const toolResult = await runRegisteredTool(
      directive.toolId,
      directive.arguments,
      request,
    );

    capturedX402Proposal =
      captureX402Proposal(
        directive.toolId,
        toolResult,
        capturedX402Proposal,
      );
    capturedTradeProposal = captureTradeProposal(
      directive.toolId,
      toolResult,
      capturedTradeProposal,
    );
    capturedStockReport = captureTokenizedStockReport(
      directive.toolId,
      toolResult,
      capturedStockReport,
    );
    capturedTransferProposal = captureTransferProposal(
      directive.toolId,
      toolResult,
      capturedTransferProposal,
    );

    // FIX (Part 1): a failed transfer_prepare_send must never be
    // handed back to the model for a free-form next turn — that is
    // exactly how a grounded server error ("Invalid recipient
    // address...") gets silently swapped out for generic
    // "I can help with: Portfolio Summary, XP & Level Progress..."
    // assistant text. Return the real tool error deterministically,
    // right here, before another sendCompletion() call can happen.
    if (
      directive.toolId === "transfer_prepare_send" &&
      !toolResult.success
    ) {
      return buildLoopResponse(
        request,
        request.previousIntent ?? "general_help",
        formatTransferPrepareFailureReply(toolResult),
        capturedX402Proposal,
        capturedTradeProposal,
        capturedStockReport,
        capturedTransferProposal,
      );
    }

    // Same determinism guarantee for the "prepared fine, but the live
    // balance check came back short" case (Part 3): the proposal
    // still renders (capturedTransferProposal above), but the chat
    // reply is grounded in sufficientBalance rather than left to the
    // model's next free-form turn.
    if (
      directive.toolId === "transfer_prepare_send" &&
      toolResult.success &&
      capturedTransferProposal &&
      capturedTransferProposal.sufficientBalance === false
    ) {
      return buildLoopResponse(
        request,
        request.previousIntent ?? "general_help",
        formatInsufficientBalanceReply(capturedTransferProposal),
        capturedX402Proposal,
        capturedTradeProposal,
        capturedStockReport,
        capturedTransferProposal,
      );
    }

    if (isFinalRound) {
      const intent =
        request.previousIntent ?? "general_help";

      return buildLoopResponse(
        request,
        intent,
        synthesizeFinalReplyFromToolResult(
          directive.toolId,
          toolResult,
          capturedX402Proposal,
          capturedTradeProposal,
          capturedTransferProposal,
        ),
        capturedX402Proposal,
        capturedTradeProposal,
        capturedStockReport,
        capturedTransferProposal,
      );
    }

    const isX402Prepare =
      directive.toolId === "x402_prepare_payment";
    const isTradePrepare =
      directive.toolId === "trade_prepare_swap" ||
      directive.toolId === "tokenized_stock_prepare_order" ||
      // Base Stocks Agent alias: same quote route, same review-only
      // proposal — it must get the short structured-proposal
      // instruction instead of a free-form next turn.
      directive.toolId === "prepare_swap";
    const isTransferPrepare =
      directive.toolId === "transfer_prepare_send";

    if (isX402Prepare) {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A payment proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short; do NOT restate the amount, asset, recipient, or other payment fields — the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else if (isTradePrepare) {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A swap proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short. Do NOT restate amounts, token addresses, calldata, or recipient fields; the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else if (isTransferPrepare) {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A transfer proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short. Do NOT restate the amount, token, or recipient address/Basename; the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        safeStringify({
          success: toolResult.success,
          data: toolResult.data ?? null,
          error: toolResult.error ?? null,
          source:
            toolResult.metadata.source ?? null,
        }),
        'Use this tool result, if relevant, to answer the user\'s original question. Respond ONLY with the final JSON {"intent":"...","reply":"..."}.',
      ].join("\n");
    }
  }

  throw new Error(
    "Tool-calling loop ended without a final answer.",
  );
}
