import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import {
  isCryptoSwapQuotePrompt,
  isTradePrompt,
  isTradeQuotePrompt,
  isTransferPrompt,
  isX402PaymentPrompt,
} from "@/lib/agent-intelligence";

/**
 * Existing P2 read-only catalog.
 *
 * Kept unchanged so existing callers/tests retain the original
 * read-only behavior.
 */
export function getReadOnlyToolCatalog(): readonly AnyAgentTool[] {
  return getAgentToolRegistry()
    .list()
    .filter((tool: AnyAgentTool) => tool.mode === "read");
}

/**
 * P3 catalog.
 *
 * Includes read tools and prepare tools.
 *
 * Prepare is intentionally different from execute:
 *   read    -> may inspect data
 *   prepare -> may construct a proposal
 *   execute -> never exposed to this model loop
 */
export function getReadAndPrepareToolCatalog(): readonly AnyAgentTool[] {
  return getAgentToolRegistry()
    .list()
    .filter(
      (tool: AnyAgentTool) =>
        tool.mode === "read" ||
        tool.mode === "prepare",
    );
}

export const YIELD_TOOL_IDS = ["yield_opportunities", "yield_estimator", "yield_comparison"] as const;
export const X402_TOOL_IDS = ["x402_discover_resource", "x402_prepare_payment"] as const;
export const TRANSFER_TOOL_IDS = ["transfer_prepare_send"] as const;
export const MARKET_TOOL_IDS = ["trade_get_price", "tokenized_stock_research", "market_intelligence"] as const;
export const TRADE_TOOL_IDS = [
  "trade_get_price",
  "trade_prepare_swap",
  "tokenized_stock_research",
  "tokenized_stock_prepare_order",
] as const;

export function isYieldToolPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\byield\b|\bapr\b|\bapy\b|yield opportunit|staking opportunit/.test(text);
}

export function isTradeActionPrompt(prompt: string): boolean {
  if (isCryptoSwapQuotePrompt(prompt)) return true;
  const text = prompt.toLowerCase();
  const hasAction =
    /\b(buy|sell|swap|prepare|order)\b/.test(text) ||
    text.includes("buy $") ||
    text.includes("trade quote") ||
    text.includes("swap quote");
  if (!hasAction) return false;
  return isTradePrompt(prompt) || isTradeQuotePrompt(prompt);
}

export function isMarketOrStockResearchPrompt(prompt: string): boolean {
  if (isTradeActionPrompt(prompt)) return false;
  if (isTradePrompt(prompt)) return true;
  const text = prompt.toLowerCase();
  return /\bprice\b|\bmarket\b|\bquote\b|\bbtc\b|\beth\b|what'?s moving|whats moving|tokenized/.test(
    text,
  );
}

export function addToolIds(target: Set<string>, ids: readonly string[]): void {
  for (const id of ids) target.add(id);
}

/**
 * Advertises only the read/prepare tools the current user prompt needs.
 * Execute/sign tools are never included. Simple chat gets an empty catalog.
 */
export function selectAdvertisedToolsForPrompt(prompt: string): readonly AnyAgentTool[] {
  const ids = new Set<string>();

  if (isTransferPrompt(prompt)) addToolIds(ids, TRANSFER_TOOL_IDS);
  if (isX402PaymentPrompt(prompt)) addToolIds(ids, X402_TOOL_IDS);
  if (isYieldToolPrompt(prompt)) addToolIds(ids, YIELD_TOOL_IDS);

  if (isTradeActionPrompt(prompt)) {
    addToolIds(ids, TRADE_TOOL_IDS);
  } else if (isMarketOrStockResearchPrompt(prompt)) {
    addToolIds(ids, MARKET_TOOL_IDS);
  }

  return getReadAndPrepareToolCatalog().filter(
    (tool: AnyAgentTool) =>
      ids.has(tool.id) &&
      tool.mode !== "execute" &&
      !tool.id.toLowerCase().includes("execute"),
  );
}

export const TRADE_INSTRUCTION_TOOL_IDS = [
  "trade_get_price",
  "trade_prepare_swap",
  "tokenized_stock_research",
  "tokenized_stock_prepare_order",
] as const;

/**
 * Extra system-prompt essays for tools that are actually advertised on
 * this turn. Simple chat ("hi") gets none of the trading/x402 manuals —
 * those tokens were the bulk of the ~3k promptTokens on a 20-char user
 * message. Buy/AAPLc/x402 turns still receive the full safety text.
 */
export function buildGatedCapabilityInstructions(prompt: string): string[] {
  const advertised = new Set(
    selectAdvertisedToolsForPrompt(prompt).map((tool) => tool.id),
  );
  const hasX402 =
    advertised.has("x402_discover_resource") ||
    advertised.has("x402_prepare_payment");
  const hasTrade = TRADE_INSTRUCTION_TOOL_IDS.some((id) => advertised.has(id));
  const hasTransfer = advertised.has("transfer_prepare_send");

  if (!hasX402 && !hasTrade && !hasTransfer) {
    return [];
  }

  const lines: string[] = [];

  if (hasX402 || hasTrade) {
    lines.push(
      "You have native tools available for looking up live facts" +
        (hasX402
          ? ", discovering or preparing an x402-gated resource"
          : "") +
        (hasTrade
          ? ", researching Coinbase Tokenized Stocks on Base, and preparing a Base swap quote"
          : "") +
        ". Prefer calling an appropriate provided tool when the user's request genuinely requires it.",
    );
  }

  if (hasX402) {
    lines.push(
      'If the user\'s message already contains an https URL and they ask you to inspect, discover, access, or determine whether it is an x402-gated resource, call x402_discover_resource with arguments {"resourceUrl":"<that URL>"} instead of asking the user to provide the URL again. The argument name is resourceUrl — never url.',
      'If an x402 resource has been discovered and the user explicitly wants to access/pay for it, use x402_prepare_payment with arguments {"resourceUrl":"<that URL>"} when appropriate. Preparing an x402 payment only creates a proposal for the user to review; it never signs or submits a payment.',
    );
  }

  if (hasTrade) {
    lines.push(
      "Trading tools (Base Mainnet only). They never sign or broadcast.",
      "If the user asks the price of ETH, USDC, WETH, or MPGR, call trade_get_price. Never call tokenized_stock_research for those.",
      'If the user asks to research a Coinbase tokenized stock (COINc, AAPLc, TSLAc, SPCXc, NVDAc, or "tokenized stocks"), call tokenized_stock_research with {"symbol":"COINc"} or {} to list the catalog.',
      'If the user asks to buy or sell a tokenized stock ("buy $10 of SPCXc", "prepare a trade to buy $50 of tokenized AAPL"), call tokenized_stock_prepare_order with {"symbol":"AAPLc","amount":"50","side":"BUY"}. Never call trade_prepare_swap for AAPL/AAPLc or any other Coinbase B20 ticker.',
      'If the user asks to buy, sell, or swap any other Base token (including a raw 0x address), call trade_prepare_swap. For a dollar buy use fromToken="USDC", toToken="the asset", amount="10". Omit taker.',
      "Do not answer a trade/quote request from the MPGR portfolio/XP help text.",
    );
  }

  if (hasTransfer) {
    lines.push(
      "To send/transfer ETH or any Base token, call transfer_prepare_send with {token, amount, recipient}. recipient is a 0x address or a Basename the user actually gave you — never invent one. If they have not given a recipient, ask instead of calling this tool.",
    );
  }

  return lines;
}

export function buildToolCatalogPromptBlock(
  tools: readonly AnyAgentTool[],
): string {
  if (tools.length === 0) {
    return "";
  }

  const lines = tools.map(
    (tool) =>
      '- "' + tool.id + '": ' + tool.description + " Arguments JSON schema: " + JSON.stringify(
        tool.inputSchema,
      ),
  );

  return [
    "You have tools for looking up live on-chain/app facts you do not already know, for preparing an x402 payment proposal, for researching Coinbase Tokenized Stocks on Base, and for preparing a Base swap quote.",
    "Read tools may retrieve information.",
    "Prepare tools may construct a proposal only. They never sign, pay, submit, or execute anything.",
    "Execute tools are not available to you.",
    "Never invent tool result data.",
    "Available tools:",
    ...lines,
    'To call a tool, respond with ONLY this JSON and nothing else: {"toolCall":{"toolId":"<id>","arguments":{...matching that tool\'s schema...}}}',
    'Once you have enough information, respond with ONLY this JSON: {"intent":"<intent>","reply":"<answer>"}',
    "Call at most one tool per turn.",
    "Never invent a toolId.",
    'For x402_discover_resource and x402_prepare_payment the URL argument name is resourceUrl — never url.',
    "Never invent payment amount, asset, recipient, or any other payment field. If x402_prepare_payment succeeds, the app itself will display the structured proposal.",
    'For buy/sell/swap/quote of any Base token (ETH, USDC, MPGR, a 0x address) call trade_prepare_swap. Dollar buys: fromToken="USDC", amount="10" (human units). Omit taker.',
    "For Coinbase B20 tokenized stocks (AAPL, AAPLc, SPCXc, COINc, TSLAc, …) ALWAYS call tokenized_stock_prepare_order with {symbol, amount} to buy/sell, or tokenized_stock_research to look up catalog/oracle data. Never call trade_prepare_swap for a B20 ticker.",
    "Never call tokenized_stock_research for ETH, USDC, WETH, or MPGR. Use trade_get_price for those prices.",
    'To send/transfer ETH or any Base token to someone, call transfer_prepare_send with {token, amount, recipient}. recipient is a 0x address or a Basename (name.base.eth) the user actually gave you — never invent, guess, or reuse an address from earlier in the conversation for a different request. If the user has not given a recipient, ask for one instead of calling this tool.',
  ].join("\n");
}

export function buildCompactToolCatalogPromptBlock(
  tools: readonly AnyAgentTool[],
): string {
  if (tools.length === 0) {
    return "";
  }

  return [
    "Native function tools are available. Use them when they are the correct way to answer the user's request.",
    "Available tool IDs:",
    ...tools.map((tool) => `- "${tool.id}"`),
    "Use the native function/tool interface and follow the declared argument schema exactly.",
  ].join("\n");
}
