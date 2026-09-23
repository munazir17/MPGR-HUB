import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import {
  extractBaseSwapIntent,
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

import { X402_TAPE_PATH } from "@/lib/x402/x402-tape-info";

export const YIELD_TOOL_IDS = ["yield_opportunities", "yield_estimator", "yield_comparison"] as const;
/** Base Stocks Agent tape/verification tools (read-only). */
export const STOCKS_TAPE_TOOL_IDS = [
  "get_tape",
  "get_pair",
  "get_premium",
  "verify_b20_contract",
  "describe_x402_tape",
] as const;
/** Session-wallet B20 holdings (read-only). */
export const STOCKS_HOLDINGS_TOOL_IDS = ["get_stock_holdings"] as const;
export const X402_TOOL_IDS = ["x402_discover_resource", "x402_prepare_payment"] as const;
export const TRANSFER_TOOL_IDS = ["transfer_prepare_send"] as const;
export const MARKET_TOOL_IDS = ["trade_get_price", "tokenized_stock_research", "market_intelligence"] as const;
export const TRADE_TOOL_IDS = [
  "trade_get_price",
  "trade_prepare_swap",
  "prepare_swap",
  "tokenized_stock_research",
  "tokenized_stock_prepare_order",
] as const;

const B20_TICKER_RE =
  /\b(aaplc|amznc|coinc|crclc|googlc|intcc|metac|msftc|mstrc|nvdac|sndkc|spcxc|tslac)\b|\b0xb200[0-9a-f]{36}\b|tokenized stock|coinbase stock|b20\b/i;

/** Live-tape / snapshot / x402-tape prompts (chip 5 lands here too). */
export function isTapeSnapshotPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    text.includes("live tape") ||
    text.includes("tape snapshot") ||
    text.includes("x402 tape") ||
    text.includes("/api/x402/tape") ||
    text.includes("snapshot ($0.02")
  );
}

/** Feed-vs-DEX premium questions for an official B20 stock. */
export function isStockPremiumPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return text.includes("premium") && (text.includes("feed") || B20_TICKER_RE.test(text));
}

/** Contract-verification questions (address or "official" + B20 context). */
export function isB20VerifyPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/0x[a-f0-9]{40}/.test(text) && (text.includes("verify") || text.includes("official"))) {
    return true;
  }
  return text.includes("verify") && B20_TICKER_RE.test(text);
}

/** Coinbase stock holdings questions (never MPGR portfolio/XP). */
export function isStockHoldingsPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    text.includes("stock holdings") ||
    text.includes("stocks i hold") ||
    text.includes("tokenized stock holdings") ||
    (text.includes("holdings") && B20_TICKER_RE.test(text))
  );
}

/**
 * Swap intent over an official B20 stock ("Prepare a swap of 10 USDC to
 * TSLAc…", "swap usdc to aaplc"). prepare_swap is the Base Stocks Agent
 * alias; the runtime router maps the B20 leg onto the dedicated
 * tokenized_stock_prepare_order tool.
 */
export function isStockSwapPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(swap|buy|sell|trade)\b/.test(text) && B20_TICKER_RE.test(text);
}

/**
 * Quote-a-swap intent over an official B20 stock ("Quote 10 USDC →
 * AAPLc"). Existing isTradeActionPrompt misses these because the pair
 * regex only pairs ETH/WETH/USDC/MPGR and "quote" is not an action verb.
 * Requires an amount + currency or the explicit phrase "quote" — a bare
 * "check AAPLc price" stays a market/research prompt.
 */
export function isB20QuotePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!B20_TICKER_RE.test(text)) return false;
  return (
    /\b\d+(?:\.\d+)?\s*(?:usdc|usd|\$)/.test(text) ||
    /\$\s*\d/.test(text) ||
    /\bquote\b/.test(text)
  );
}

/** Any prompt the Base Stocks tape tools should answer. */
export function isStocksTapePrompt(prompt: string): boolean {
  return (
    isTapeSnapshotPrompt(prompt) ||
    isStockPremiumPrompt(prompt) ||
    isB20VerifyPrompt(prompt) ||
    isStockHoldingsPrompt(prompt) ||
    isStockSwapPrompt(prompt)
  );
}

export function isYieldToolPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\byield\b|\bapr\b|\bapy\b|yield opportunit|staking opportunit/.test(text);
}

/**
 * An explicit swap order over the extended allowlist ("sell 5 usdc of
 * eth", "buy 5 USDC of ETH") whose pair resolves deterministically.
 *
 * isTradeActionPrompt above misses these because it is keyed on the
 * B20/quote markers, so "sell 5 usdc of eth" used to fall into the
 * research/market tool set — the model then answered a live order with
 * research. Requires the pair to actually resolve, so ordinary chat and
 * research prompts are unaffected. Quote-only phrasing is excluded: those
 * are price questions, not orders.
 */
export function isResolvedSwapOrderPrompt(prompt: string): boolean {
  const intent = extractBaseSwapIntent(prompt);
  return intent !== null && !intent.quoteOnly;
}

export function isTradeActionPrompt(prompt: string): boolean {
  if (isCryptoSwapQuotePrompt(prompt)) return true;
  if (isResolvedSwapOrderPrompt(prompt)) return true;
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

  // The paid tape snapshot is an x402 resource — advertise both the
  // describe tool and the discover/prepare payment tools together.
  if (isTapeSnapshotPrompt(prompt)) {
    addToolIds(ids, ["describe_x402_tape", "get_tape", ...X402_TOOL_IDS]);
  }
  if (isStocksTapePrompt(prompt)) addToolIds(ids, STOCKS_TAPE_TOOL_IDS);
  if (isStockHoldingsPrompt(prompt)) addToolIds(ids, STOCKS_HOLDINGS_TOOL_IDS);
  if (isB20QuotePrompt(prompt)) addToolIds(ids, TRADE_TOOL_IDS);

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
  "prepare_swap",
  "tokenized_stock_research",
  "tokenized_stock_prepare_order",
] as const;

export const STOCKS_INSTRUCTION_TOOL_IDS = [
  ...STOCKS_TAPE_TOOL_IDS,
  ...STOCKS_HOLDINGS_TOOL_IDS,
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
  const hasStocks = STOCKS_INSTRUCTION_TOOL_IDS.some((id) => advertised.has(id));
  const hasTransfer = advertised.has("transfer_prepare_send");

  if (!hasX402 && !hasTrade && !hasStocks && !hasTransfer) {
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
      'The paid live Base Stocks tape snapshot is GET ' + X402_TAPE_PATH + ' (x402: 0.02 USDC on Base by default). To buy it for the user, call x402_prepare_payment with {"resourceUrl":"<the absolute https URL of ' + X402_TAPE_PATH + ' on this deployment>"} — the user signs the payment; nothing is paid automatically.',
      'For a paid-tape request WITHOUT a URL, first call describe_x402_tape (free) to read the offer; only prepare the payment once the user explicitly asks to buy the snapshot.',
    );
  }

  if (hasTrade) {
    lines.push(
      "Trading tools (Base Mainnet only). They never sign or broadcast.",
      "An explicit buy/sell/swap/trade order ALWAYS goes through the prepare tools (trade_prepare_swap / prepare_swap for other Base tokens, tokenized_stock_prepare_order for Coinbase B20 tokenized stocks) — never answer an order with research or with a price look-up. If the order does not state an amount, ask for the amount instead of researching.",
      "If the user asks the price of ETH, USDC, WETH, or MPGR, call trade_get_price. Never call tokenized_stock_research for those.",
      'If the user asks to research a Coinbase tokenized stock (COINc, AAPLc, TSLAc, SPCXc, NVDAc, or "tokenized stocks"), call tokenized_stock_research with {"symbol":"COINc"} or {} to list the catalog.',
      'If the user asks to buy or sell a tokenized stock ("buy $10 of SPCXc", "prepare a trade to buy $50 of tokenized AAPL"), call tokenized_stock_prepare_order with {"symbol":"AAPLc","amount":"50","side":"BUY"}. Never call trade_prepare_swap for AAPL/AAPLc or any other Coinbase B20 ticker.',
      'If the user asks to buy, sell, or swap any other Base token (including a raw 0x address), call trade_prepare_swap (or prepare_swap with {sellSymbol, buySymbol, amount}, which accepts allowlisted symbols like USDC, cbBTC, cbETH and official B20 tickers). For a dollar buy use fromToken="USDC", toToken="the asset", amount="10". Omit taker.',
      "Do not answer a trade/quote request from the MPGR portfolio/XP help text.",
    );
  }

  if (hasStocks) {
    lines.push(
      "Base Stocks tools (read-only, Base Mainnet): get_tape (full live tape: Coinbase wrapped assets + Coinbase Tokenized Stocks), get_pair {symbol}, get_premium {symbol} (DEX price vs official Chainlink feed, in bps), verify_b20_contract {address} (official allowlist only), get_stock_holdings (the connected session wallet's B20 balances), describe_x402_tape (the paid tape endpoint).",
      "Tape values may be null or flagged stale/paused. Report exactly what the tool returned and name the source — never invent, extrapolate, or round a price, premium, or 24h change that the tool did not provide.",
      "verify_b20_contract answers official:true/false strictly from the allowlist. When it returns official:false, tell the user not to swap into that address and point them to the official list (docs.base.org B20 tokenized stocks). Never confirm a contract from memory, a ticker, or web text.",
      "Coinbase Tokenized Stocks are for eligible non-US persons in supported jurisdictions and represent a claim on underlying shares held in custody. Not financial advice. Always match the 0xb200 contract before signing.",
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
