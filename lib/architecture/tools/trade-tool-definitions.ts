// lib/architecture/tools/trade-tool-definitions.ts
//
// Agent-facing trade / tokenized-stock tools.
//
//   trade_get_price                 (read)
//   trade_prepare_swap              (prepare) — any Base token + B20
//   tokenized_stock_research        (read)
//   tokenized_stock_prepare_order   (prepare) — B20 on-chain swap
//
// IMPORTANT — why these call HTTP routes instead of lib/trade/* directly:
// lib/trade/trade-swap-router.ts, trade-research.ts, tokenized-stock-swap.ts,
// trade-cdp-client.ts, and trade-0x-client.ts are all marked `server-only`.
// This file is imported (via agent-tool-runtime-instance.ts →
// agent-tool-calling.ts → deterministic-ai-provider.ts →
// ai-provider-registry.ts) from app/agent/page.tsx, which is a
// `"use client"` component. Any `server-only` import reachable from a
// client component's static import graph fails the Next.js build
// (this exact class of error already broke a deploy once before —
// see the tokenized-stock-order.ts incident). Importing the trade/*
// functions directly here WILL reproduce that failure even though the
// code only ever runs server-side at request time — Next's check is
// static, not runtime. Routing through fetch() keeps every
// `server-only` module behind a genuine Route Handler boundary, where
// it belongs, while this file itself stays import-clean.
//
// There is NO execute-mode trade tool. Signing stays behind the
// Confirm UI (hooks/useTradeQuote), same boundary as x402.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";

const CANONICAL_APP_ORIGIN = "https://mpgrhub.xyz";

function tradeEndpoint(path: string): string {
  return CANONICAL_APP_ORIGIN + path;
}

function toolFailureCode(code: unknown): "INVALID_INPUT" | "WALLET_NOT_CONNECTED" | "DATA_UNAVAILABLE" | "PROVIDER_ERROR" {
  if (code === "INVALID_INPUT" || code === "UNSUPPORTED_ASSET") return "INVALID_INPUT";
  if (code === "WALLET_REQUIRED" || code === "WALLET_NOT_CONNECTED") return "WALLET_NOT_CONNECTED";
  if (code === "CREDENTIALS_MISSING" || code === "LIQUIDITY_UNAVAILABLE" || code === "EXECUTION_UNAVAILABLE") {
    return "DATA_UNAVAILABLE";
  }
  return "PROVIDER_ERROR";
}

function isAddressLike(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const response = await fetch(tradeEndpoint(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

async function getJson(path: string): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const response = await fetch(tradeEndpoint(path), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

function withTaker(
  body: Record<string, unknown>,
  contextWallet?: string,
): Record<string, unknown> {
  if (isAddressLike(body.taker)) return body;
  if (isAddressLike(contextWallet)) return { ...body, taker: contextWallet };
  return body;
}

const priceSchema: AgentToolSchema = {
  type: "object",
  properties: {
    fromToken: {
      type: "string",
      description:
        "Sell token on Base: ETH, WETH, USDC, MPGR, a Coinbase B20 ticker (AAPLc, SPCXc, COINc, …), or any 0x contract address on Base. For a $-denominated buy, use USDC.",
    },
    toToken: {
      type: "string",
      description: "Buy token on Base. Same format as fromToken.",
    },
    amount: {
      type: "string",
      description:
        "Human sell amount in fromToken units, e.g. \"10\" for 10 USDC / $10. Prefer this over atomic fromAmount. Do not convert to wei.",
    },
    fromAmount: {
      type: "string",
      description:
        "Optional atomic-unit integer (e.g. 1000000 for 1 USDC). Use `amount` when the user said a dollar/token quantity like $10.",
    },
    taker: {
      type: "string",
      description: "Optional. Connected wallet is filled automatically — omit this.",
    },
    slippageBps: {
      type: "number",
      description: "Max slippage in basis points. Default 100 (1%). Allowed 1–500.",
    },
  },
  required: ["fromToken", "toToken"],
};

export const tradeGetPriceTool: AgentTool = {
  id: "trade_get_price",
  name: "Base Swap Price",
  description:
    "Gets a live Base Mainnet swap price. Regular tokens use Coinbase CDP Trade API, then 0x. Coinbase B20 tokenized stocks (AAPLc, TSLAc, …) use Aerodrome Slipstream USDC pools — not CDP/0x. For a $N B20 buy use fromToken=USDC, toToken=AAPLc, amount=\"N\". Does not sign. Omit taker. Never use this for ETH/USDC price research via tokenized_stock_research.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: priceSchema,

  async execute(input, context) {
    const body = withTaker((input ?? {}) as Record<string, unknown>, context.walletAddress);
    try {
      const { ok, payload } = await postJson("/api/trade/price", body);
      if (!ok || !payload) {
        return toolError("trade_get_price", {
          code: toolFailureCode(payload?.code),
          message: typeof payload?.error === "string" ? payload.error : "Could not fetch a Base swap price.",
          retryable: true,
        });
      }
      return toolSuccess(
        "trade_get_price",
        { price: payload.price, provider: payload.provider, network: "base" },
        { source: typeof payload.provider === "string" ? payload.provider : "cdp-trade-api", chainId: 8453 },
      );
    } catch {
      return toolError("trade_get_price", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the Base swap price endpoint.",
        retryable: true,
      });
    }
  },
};

export const tradePrepareSwapTool: AgentTool = {
  id: "trade_prepare_swap",
  name: "Base Swap Proposal",
  description:
    "Creates a structured Base swap proposal for explicit user confirmation. Works for ETH/WETH/USDC/MPGR and any Base ERC-20 0x address via CDP/0x. Coinbase B20 tokenized stocks (AAPLc, SPCXc, TSLAc, …) route through Aerodrome Slipstream USDC pools. For \"$10 of AAPLc\" use fromToken=USDC, toToken=AAPLc, amount=\"10\". Never signs. Omit taker. Do not call this for a plain ETH price question — use trade_get_price.",
  category: "defi",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: true,
  requiresConfirmation: true,
  inputSchema: priceSchema,

  async execute(input, context) {
    const body = withTaker((input ?? {}) as Record<string, unknown>, context.walletAddress);
    try {
      const { ok, payload } = await postJson("/api/trade/quote", body);
      if (!ok || !payload) {
        return toolError("trade_prepare_swap", {
          code: toolFailureCode(payload?.code),
          message: typeof payload?.error === "string" ? payload.error : "Could not prepare a Base swap quote.",
        });
      }
      const proposal = payload.proposal as { provider?: string } | undefined;
      return toolSuccess(
        "trade_prepare_swap",
        { proposal: payload.proposal },
        { source: proposal?.provider ?? "cdp-trade-api", chainId: 8453 },
      );
    } catch {
      return toolError("trade_prepare_swap", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the Base swap quote endpoint.",
        retryable: true,
      });
    }
  },
};

const stockSchema: AgentToolSchema = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description:
        "Optional Coinbase B20 ticker only (AAPLc, TSLAc, NVDAc, SPCXc, COINc, …) or underlying (AAPL). Omit to list the official 13-asset Base catalog. Do NOT pass ETH, USDC, WETH, or MPGR.",
    },
    taker: {
      type: "string",
      description: "Optional connected wallet. When set, DEX liquidity against USDC is probed.",
    },
  },
};

export const tokenizedStockResearchTool: AgentTool = {
  id: "tokenized_stock_research",
  name: "Tokenized Stock Research",
  description:
    "Researches Coinbase Tokenized Stocks on Base (B20): official 13-asset catalog, contract, Chainlink equity oracle, on-chain multiplier, and whether Aerodrome Slipstream has USDC pool liquidity. Use ONLY for B20 names (AAPLc, SPCXc, COINc, tokenized stocks). Never call this for ETH, USDC, WETH, or MPGR prices.",
  category: "research",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: stockSchema,

  async execute(input, context) {
    const body = (input ?? {}) as { symbol?: unknown; taker?: unknown };
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const taker =
      typeof body.taker === "string" && isAddressLike(body.taker)
        ? body.taker.trim()
        : context.walletAddress ?? "";

    try {
      const query = new URLSearchParams();
      if (symbol) query.set("symbol", symbol);
      if (taker) query.set("taker", taker);
      const path = "/api/trade/stocks" + (query.toString() ? `?${query.toString()}` : "");
      const { ok, payload } = await getJson(path);
      if (!ok || !payload) {
        return toolError("tokenized_stock_research", {
          code: toolFailureCode(payload?.code),
          message: typeof payload?.error === "string" ? payload.error : "Could not load Coinbase tokenized-stock research.",
        });
      }
      return toolSuccess(
        "tokenized_stock_research",
        { report: payload },
        { source: "base-b20+chainlink", chainId: 8453 },
      );
    } catch {
      return toolError("tokenized_stock_research", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the tokenized-stock research endpoint.",
        retryable: true,
      });
    }
  },
};

const stockOrderSchema: AgentToolSchema = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description: "Coinbase B20 ticker only, e.g. AAPLc, COINc, TSLAc, SPCXc. Not ETH or USDC.",
    },
    side: {
      type: "string",
      description: "\"BUY\" or \"SELL\". Defaults to BUY.",
    },
    amount: {
      type: "string",
      description: "Human USD amount, e.g. \"10\" for $10. Do not convert to atomic units.",
    },
  },
  required: ["symbol", "amount"],
};

export const tokenizedStockPrepareOrderTool: AgentTool = {
  id: "tokenized_stock_prepare_order",
  name: "Tokenized Stock Swap Preview",
  description:
    "Prepares an on-chain Base swap proposal to buy or sell a Coinbase B20 tokenized stock (AAPLc, SPCXc, …) using the connected wallet. BUY $10 of AAPLc = sell 10 USDC for AAPLc on Aerodrome Slipstream. This is a Base DEX swap, not Coinbase Advanced Trade (AAPL-USD). Returns a proposal for explicit confirmation. Never signs.",
  category: "market",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: true,
  requiresConfirmation: true,
  inputSchema: stockOrderSchema,

  async execute(input, context) {
    const body = (input ?? {}) as { symbol?: unknown; side?: unknown; amount?: unknown };
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const side = body.side === "SELL" ? "SELL" : "BUY";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    const taker = context.walletAddress?.trim() ?? "";

    if (!symbol || !amount) {
      return toolError("tokenized_stock_prepare_order", {
        code: "INVALID_INPUT",
        message: "symbol and amount are required.",
      });
    }
    if (!isAddressLike(taker)) {
      return toolError("tokenized_stock_prepare_order", {
        code: "WALLET_NOT_CONNECTED",
        message: "Connect a Base wallet to prepare this tokenized-stock swap.",
      });
    }

    try {
      const { ok, payload } = await postJson("/api/trade/stocks/quote", { symbol, side, amount, taker });
      if (!ok || !payload) {
        return toolError("tokenized_stock_prepare_order", {
          code: toolFailureCode(payload?.code),
          message: typeof payload?.error === "string" ? payload.error : "Could not prepare a tokenized-stock Base swap.",
        });
      }
      const proposal = payload.proposal as { provider?: string } | undefined;
      return toolSuccess(
        "tokenized_stock_prepare_order",
        { proposal: payload.proposal },
        { source: proposal?.provider ?? "cdp-trade-api", chainId: 8453 },
      );
    } catch {
      return toolError("tokenized_stock_prepare_order", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the tokenized-stock swap endpoint.",
        retryable: true,
      });
    }
  },
};

const registry = getAgentToolRegistry();
for (const tool of [
  tradeGetPriceTool,
  tradePrepareSwapTool,
  tokenizedStockResearchTool,
  tokenizedStockPrepareOrderTool,
]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
