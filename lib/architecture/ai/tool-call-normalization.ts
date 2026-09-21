import {
  AGENT_INTENTS,
  type AgentIntent,
} from "@/lib/agent-intelligence";
import { hydrateTradeSwapArguments } from "@/lib/trade/trade-request";

export const MAX_TOOL_CALL_ROUNDS = 3;

export const X402_RESOURCE_URL_TOOL_IDS = new Set([
  "x402_discover_resource",
  "x402_prepare_payment",
]);

export function isValidIntent(value: unknown): value is AgentIntent {
  return (
    typeof value === "string" &&
    (AGENT_INTENTS as readonly string[]).includes(value)
  );
}

export function pickResourceUrl(
  args: Record<string, unknown>,
): string | null {
  if (
    typeof args.resourceUrl === "string" &&
    args.resourceUrl.trim()
  ) {
    return args.resourceUrl.trim();
  }

  if (
    typeof args.url === "string" &&
    args.url.trim()
  ) {
    return args.url.trim();
  }

  if (
    typeof args.resource === "string" &&
    args.resource.trim()
  ) {
    return args.resource.trim();
  }

  return null;
}

/**
 * x402_discover_resource / x402_prepare_payment require `resourceUrl`.
 *
 * Models (and a few older tests) sometimes emit `url` or `resource`.
 * Those aliases are rewritten here so the real tool schema is satisfied
 * without advertising `url` on the declaration.
 */
export function normalizeX402ToolArguments(
  toolId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!X402_RESOURCE_URL_TOOL_IDS.has(toolId)) {
    return args;
  }

  const resourceUrl = pickResourceUrl(args);

  if (resourceUrl === null) {
    return args;
  }

  const next: Record<string, unknown> = {
    ...args,
    resourceUrl,
  };

  delete next.url;
  delete next.resource;

  return next;
}

export const TRADE_TAKER_TOOL_IDS = new Set([
  "trade_get_price",
  "trade_prepare_swap",
  "tokenized_stock_research",
]);

/**
 * CDP quotes are bound to `taker`. If the model omitted it, fill from
 * the connected wallet — never invent a different address.
 */
export function normalizeTradeToolArguments(
  toolId: string,
  args: Record<string, unknown>,
  walletAddress?: string,
): Record<string, unknown> {
  if (!TRADE_TAKER_TOOL_IDS.has(toolId)) return args;
  if (toolId === "tokenized_stock_research") {
    if (typeof args.taker === "string" && args.taker.trim().length > 0) return args;
    if (typeof walletAddress === "string" && walletAddress.trim().length > 0) {
      return { ...args, taker: walletAddress.trim() };
    }
    return args;
  }
  return hydrateTradeSwapArguments(args, walletAddress);
}

export function hasNegativeTradeAmount(prompt: string): boolean {
  if (typeof prompt !== "string" || !prompt.trim()) return false;

  const lower = prompt.toLowerCase();

  // Only activate for an actual trade- or transfer-like request. Send/
  // transfer verbs are included here too — "send -10 USDC to 0x..." is
  // the same signed-amount trick against transfer_prepare_send that
  // this check already exists to catch for trade_prepare_swap.
  const hasTradeVerb =
    /\b(buy|sell|swap|trade|purchase|send|transfer)\b/.test(lower);

  if (!hasTradeVerb) return false;

  // Catch common signed-dollar/number forms before the LLM can
  // normalize "-$2" / "$-2" / "-2" into a positive value.
  return (
    /-\s*\$\s*\d+(?:\.\d+)?/.test(lower) ||
    /\$\s*-\s*\d+(?:\.\d+)?/.test(lower) ||
    /(?:^|\s)-\s*\d+(?:\.\d+)?(?:\s|$)/.test(lower)
  );
}
