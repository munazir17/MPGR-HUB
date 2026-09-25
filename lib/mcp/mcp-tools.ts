import "server-only";

// lib/mcp/mcp-tools.ts
//
// MCP tool registry: name, human title, description, JSON Schema input, MCP
// annotations and handler. Every tool is read-only with respect to user funds:
// it returns data or UNSIGNED transactions / typed data. None signs.

import {
  finalizeTrade,
  getCapabilities,
  getQuote,
  getTradeStatus,
  listTokens,
  prepareTrade,
  verifyTrade,
  type McpDeps,
  type ToolOutcome,
} from "./mcp-trade-service";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: boolean; openWorldHint: boolean };
  handler: (deps: McpDeps, args: unknown) => ToolOutcome | Promise<ToolOutcome>;
}

const CHAIN_ID = {
  type: "integer",
  enum: [84532, 8453],
  default: 84532,
  description: "84532 = Base Sepolia (MPGR Executor). 8453 = Base mainnet (0x native fee; disabled unless enabled by the operator).",
};
const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const TX_HASH = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const AUTH = {
  type: "string",
  enum: ["APPROVAL", "EIP2612", "PERMIT2"],
  description: "APPROVAL = exact approve tx then swap. EIP2612 = sign permit, one swap tx. PERMIT2 = sign Permit2 transfer, one swap tx.",
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "mpgr_get_capabilities",
    title: "Discover MPGR trading capabilities",
    description:
      "Returns supported chains, the deployed MPGR Executor, fee policy (25 bps of the sell token, collected in the same tx), authorization modes, providers and the required trade flow. Call first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (deps) => getCapabilities(deps),
  },
  {
    name: "mpgr_list_tokens",
    title: "List tradable tokens",
    description: "Lists the executor's allowlisted tokens and pairs on a chain. Use \"ETH\" for native ETH.",
    inputSchema: { type: "object", properties: { chainId: CHAIN_ID }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (deps, args) => listTokens(deps, args),
  },
  {
    name: "mpgr_get_quote",
    title: "Quote a swap (exact fee included)",
    description:
      "Quotes selling an exact amount. Returns expected/min output, the exact MPGR fee (floor(sellAmount*feeBps/10000) of the sell token), route, and a signed quoteId valid for 120s. Does not sign or send anything.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: CHAIN_ID,
        taker: { ...ADDRESS, description: "The user's wallet address (will sign and receive the output)." },
        sellToken: { type: "string", description: "Token address, allowlisted symbol, or \"ETH\"." },
        buyToken: { type: "string", description: "Token address, allowlisted symbol, or \"ETH\"." },
        sellAmount: { type: "string", pattern: "^[0-9]+$", description: "Gross sell amount in base units (fee is taken from this)." },
        sellAmountHuman: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$", description: "Alternative to sellAmount, e.g. \"12.5\"." },
        slippageBps: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["taker", "sellToken", "buyToken"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (deps, args) => getQuote(deps, args),
  },
  {
    name: "mpgr_prepare_trade",
    title: "Prepare unsigned trade steps",
    description:
      "Turns a quoteId into the exact steps for the USER'S WALLET: an optional exact-amount approval tx, EIP-712 typed data to sign (EIP2612/PERMIT2), and/or the unsigned swap transaction to the MPGR Executor. The AI must never sign; present these to the user.",
    inputSchema: {
      type: "object",
      properties: { quoteId: { type: "string" }, authorization: AUTH },
      required: ["quoteId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (deps, args) => prepareTrade(deps, args),
  },
  {
    name: "mpgr_finalize_trade",
    title: "Attach the user's permit signature",
    description:
      "For EIP2612/PERMIT2: verifies the user's signature matches this exact intent and returns the unsigned one-transaction swap (permit + fee + swap). The signature is produced by the user's wallet, never by the AI.",
    inputSchema: {
      type: "object",
      properties: {
        quoteId: { type: "string" },
        authorization: { type: "string", enum: ["EIP2612", "PERMIT2"] },
        signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
        permitNonce: { type: "string", pattern: "^[0-9]+$" },
      },
      required: ["quoteId", "authorization", "signature", "permitNonce"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: (deps, args) => finalizeTrade(deps, args),
  },
  {
    name: "mpgr_get_trade_status",
    title: "Transaction status",
    description: "Returns confirmed / reverted / pending for a transaction hash.",
    inputSchema: {
      type: "object",
      properties: { chainId: CHAIN_ID, txHash: TX_HASH },
      required: ["txHash"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: (deps, args) => getTradeStatus(deps, args),
  },
  {
    name: "mpgr_verify_trade",
    title: "Verify an executed trade",
    description:
      "Verifies from the on-chain receipt that the trade matched the quote: executor event, taker, tokens, gross amount, EXACT fee to the fee recipient, and output >= minBuyAmount.",
    inputSchema: {
      type: "object",
      properties: { quoteId: { type: "string" }, txHash: TX_HASH },
      required: ["quoteId", "txHash"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: (deps, args) => verifyTrade(deps, args),
  },
];

export function findMcpTool(name: unknown): McpToolDefinition | null {
  return typeof name === "string" ? (MCP_TOOLS.find((t) => t.name === name) ?? null) : null;
}
