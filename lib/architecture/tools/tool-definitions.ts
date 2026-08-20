// lib/architecture/tools/tool-definitions.ts
//
// P0.1 — the five planned tool definitions from the roadmap, registered
// but NOT implemented. Every one of them returns TOOL_NOT_IMPLEMENTED
// immediately — none of them fetches, computes, or fabricates any real
// wallet/token/market data. Implementing the real data-fetching logic
// for these belongs to P0.2, per the spec ("They may initially return
// TOOL_NOT_IMPLEMENTED if implementation would belong to P0.2... DO NOT
// fabricate results").
//
// requiresWallet assumptions (spec was explicit only for wallet_analyzer
// — the other four are my own judgment call, flagged here rather than
// silently assumed):
//   - wallet_analyzer: requiresWallet = true (explicit in the spec)
//   - portfolio_analyzer: requiresWallet = true — a "portfolio" is
//     inherently wallet-scoped, consistent with how
//     lib/agent-context.ts's AgentPortfolioContext is already only ever
//     populated for a connected wallet
//   - token_analyzer / base_research / market_intelligence:
//     requiresWallet = false — token lookups, general Base research, and
//     market data don't inherently need a connected wallet
//
// Importing this module registers every tool below into
// getAgentToolRegistry()'s current instance as a side effect — see
// agent-tool-runtime-instance.ts, the one place that imports it.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError } from "./agent-tool-result";

function notImplemented(toolId: string, toolName: string) {
  return async () =>
    toolError(toolId, {
      code: "TOOL_NOT_IMPLEMENTED" as const,
      message: `"${toolName}" is defined but not yet implemented — real data fetching belongs to P0.2.`,
      retryable: false,
    });
}

const walletAddressSchema: AgentToolSchema = {
  type: "object",
  properties: {
    walletAddress: { type: "string", description: "The 0x-prefixed wallet address to analyze." },
  },
  required: ["walletAddress"],
};

const tokenSymbolSchema: AgentToolSchema = {
  type: "object",
  properties: {
    tokenSymbolOrAddress: { type: "string", description: "A token symbol (e.g. \"MPGR\") or contract address." },
  },
  required: ["tokenSymbolOrAddress"],
};

const researchQuerySchema: AgentToolSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "A free-text research question about Base or its ecosystem." },
  },
  required: ["query"],
};

const marketScopeSchema: AgentToolSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      description: "What market data to look at.",
      enum: ["overview", "trending", "gainers", "losers"],
    },
  },
  required: ["scope"],
};

export const walletAnalyzerTool: AgentTool = {
  id: "wallet_analyzer",
  name: "Wallet Analyzer",
  description: "Analyzes a wallet's onchain holdings and activity on Base.",
  category: "wallet",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: walletAddressSchema,
  execute: notImplemented("wallet_analyzer", "Wallet Analyzer"),
};

export const tokenAnalyzerTool: AgentTool = {
  id: "token_analyzer",
  name: "Token Analyzer",
  description: "Looks up a token's current price, supply, and other onchain metadata.",
  category: "token",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: tokenSymbolSchema,
  execute: notImplemented("token_analyzer", "Token Analyzer"),
};

export const portfolioAnalyzerTool: AgentTool = {
  id: "portfolio_analyzer",
  name: "Portfolio Analyzer",
  description: "Analyzes a wallet's full portfolio composition and performance.",
  category: "portfolio",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: walletAddressSchema,
  execute: notImplemented("portfolio_analyzer", "Portfolio Analyzer"),
};

export const baseResearchTool: AgentTool = {
  id: "base_research",
  name: "Base Research",
  description: "Researches protocols, tokens, and trends on the Base ecosystem.",
  category: "research",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: researchQuerySchema,
  execute: notImplemented("base_research", "Base Research"),
};

export const marketIntelligenceTool: AgentTool = {
  id: "market_intelligence",
  name: "Market Intelligence",
  description: "Surfaces current market-wide data such as trending tokens or top movers.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: marketScopeSchema,
  execute: notImplemented("market_intelligence", "Market Intelligence"),
};

const registry = getAgentToolRegistry();
for (const tool of [
  walletAnalyzerTool,
  tokenAnalyzerTool,
  portfolioAnalyzerTool,
  baseResearchTool,
  marketIntelligenceTool,
]) {
  if (!registry.has(tool.id)) registry.register(tool);
}
