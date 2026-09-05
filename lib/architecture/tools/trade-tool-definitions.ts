// lib/architecture/tools/trade-tool-definitions.ts
//
// P4 — agent-facing trade / tokenized-stock tools.
//
//   trade_get_price              (read)
//   trade_prepare_swap           (prepare) — never signs
//   tokenized_stock_research     (read)
//
// There is NO execute-mode trade tool. Signing stays behind the Confirm
// UI (hooks/useTradeQuote), same boundary as x402.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { previewTokenizedStockOrder } from "@/lib/trade/tokenized-stock-order";

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

const priceSchema: AgentToolSchema = {
  type: "object",
  properties: {
    fromToken: {
      type: "string",
      description: "Sell token: ETH, WETH, USDC, MPGR, a Coinbase B20 ticker like COINc / AAPLc, or a 0x address on Base. For a $-denominated buy, use USDC.",
    },
    toToken: {
      type: "string",
      description: "Buy token: same format as fromToken.",
    },
    amount: {
      type: "string",
      description: "Human sell amount in fromToken units, e.g. \"10\" for 10 USDC / $10. Prefer this over atomic fromAmount. Do not convert to wei.",
    },
    fromAmount: {
      type: "string",
      description: "Optional atomic-unit integer (e.g. 1000000 for 1 USDC). Use `amount` instead when the user said a dollar/token quantity like $10.",
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
  required: ["fromToken", "toToken", "fromAmount", "taker"],
};

function withTaker(
  body: Record<string, unknown>,
  contextWallet?: string,
): Record<string, unknown> {
  if (isAddressLike(body.taker)) return body;
  if (isAddressLike(contextWallet)) return { ...body, taker: contextWallet };
  return body;
}

function toQuoteBody(input: Record<string, unknown>, walletAddress?: string): {
  ok: true;
  body: {
    fromToken: string;
    toToken: string;
    fromAmount: string;
    taker: string;
    slippageBps: number;
  };
} | { ok: false; code: "INVALID_INPUT" | "WALLET_NOT_CONNECTED" | "DATA_UNAVAILABLE" | "PROVIDER_ERROR"; message: string } {
  const parsed = parseTradeSwapRequest(withTaker(input, walletAddress), { requireTaker: true });
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.error.code === "WALLET_REQUIRED" ? "WALLET_NOT_CONNECTED" : toolFailureCode(parsed.error.code),
      message: parsed.error.message,
    };
  }
  return {
    ok: true,
    body: {
      fromToken: parsed.value.from.address,
      toToken: parsed.value.to.address,
      fromAmount: parsed.value.fromAmount,
      taker: parsed.value.taker,
      slippageBps: parsed.value.slippageBps,
    },
  };
}

export const tradeGetPriceTool: AgentTool = {
  id: "trade_get_price",
  name: "Base Swap Price",
  description:
    "Gets a live Base Mainnet swap price from the Coinbase CDP Trade API (getSwapPrice). Reports expected output, minimum output after slippage, fees, and whether liquidity exists. Does not sign, does not swap, does not invent a route. For a $N buy use fromToken=USDC, amount=\"N\". Omit taker — the connected wallet is filled automatically.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: priceSchema,

  async execute(input, context) {
    const normalized = toQuoteBody((input ?? {}) as Record<string, unknown>, context.walletAddress);
    if (!normalized.ok) {
      return toolError("trade_get_price", {
        code: normalized.code,
        message: normalized.message,
      });
    }
    try {
      const { ok, payload } = await postJson("/api/trade/price", normalized.body);
      if (!ok || !payload) {
        return toolError("trade_get_price", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : "Could not fetch a Coinbase CDP swap price.",
          retryable: true,
        });
      }
      return toolSuccess("trade_get_price", payload, { source: "cdp-trade-api", chainId: 8453 });
    } catch {
      return toolError("trade_get_price", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the swap price endpoint.",
        retryable: true,
      });
    }
  },
};

export const tradePrepareSwapTool: AgentTool = {
  id: "trade_prepare_swap",
  name: "Base Swap Proposal",
  description:
    "Creates a structured Base swap proposal (amount, tokens, slippage, fees, risk, Permit2/approval steps) from a Coinbase CDP Trade API quote. Call this when the user asks to buy, sell, swap, or get a quote — including \"$10 of COINc\". Use fromToken=USDC and amount=\"10\" for dollar buys. Returns a proposal for explicit user confirmation. Never signs and never broadcasts. Omit taker.",
  category: "defi",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: true,
  requiresConfirmation: true,
  inputSchema: priceSchema,

  async execute(input, context) {
    const normalized = toQuoteBody((input ?? {}) as Record<string, unknown>, context.walletAddress);
    if (!normalized.ok) {
      return toolError("trade_prepare_swap", {
        code: normalized.code,
        message: normalized.message,
      });
    }
    try {
      const { ok, payload } = await postJson("/api/trade/quote", normalized.body);
      if (!ok || !payload) {
        return toolError("trade_prepare_swap", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : "Could not prepare a Coinbase CDP swap quote.",
        });
      }
      const proposal = payload.proposal;
      if (!proposal || typeof proposal !== "object") {
        return toolError("trade_prepare_swap", {
          code: "DATA_UNAVAILABLE",
          message: "The quote endpoint did not return a proposal.",
        });
      }
      return toolSuccess("trade_prepare_swap", { proposal }, { source: "cdp-trade-api", chainId: 8453 });
    } catch {
      return toolError("trade_prepare_swap", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the swap quote endpoint.",
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
        "Optional Coinbase tokenized-stock ticker (AAPLc, TSLAc, NVDAc, …) or underlying (AAPL). Omit to list the official 13-asset Base catalog.",
    },
    taker: {
      type: "string",
      description: "Optional connected wallet. When set, CDP liquidity against USDC is probed.",
    },
  },
};

export const tokenizedStockResearchTool: AgentTool = {
  id: "tokenized_stock_research",
  name: "Tokenized Stock Research",
  description:
    "Researches Coinbase Tokenized Stocks on Base (B20): official catalog, contract, Chainlink equity oracle, on-chain multiplier, and whether Coinbase CDP reports DEX liquidity. Buy/sell is a Base swap only when CDP reports liquidity — there is no issuer mint API. Does not sign.",
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
      let path = "/api/trade/stocks";
      if (symbol) {
        path = "/api/trade/stocks?symbol=" + encodeURIComponent(symbol);
        if (taker) {
          path = path + "&taker=" + encodeURIComponent(taker);
        }
      }
      const { ok, payload } = await getJson(path);
      if (!ok || !payload) {
        return toolError("tokenized_stock_research", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : "Could not load Coinbase tokenized-stock research.",
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
      description: "Coinbase B20 tokenized-stock ticker, e.g. AAPLc, COINc, TSLAc.",
    },
    side: {
      type: "string",
      description: "\"BUY\" or \"SELL\". Defaults to BUY.",
    },
    amount: {
      type: "string",
      description: "Human USDC amount, e.g. \"10\" for $10. Do not convert to atomic units.",
    },
  },
  required: ["symbol", "amount"],
};

export const tokenizedStockPrepareOrderTool: AgentTool = {
  id: "tokenized_stock_prepare_order",
  name: "Tokenized Stock Order Preview",
  description:
    "Prepares a dry-run preview of a Coinbase B20 tokenized-stock order (AAPLc, COINc, TSLAc, ...) via Coinbase Advanced Trade — the officially supported equities path (docs.cdp.coinbase.com/coinbase-for-agents/overview), not an on-chain DEX swap. Call this when the user asks to buy or sell a tokenized stock, e.g. \"buy $10 of AAPLc\". Returns order total, commission, and estimated fill. Never creates a real order.",
  category: "market",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: false,
  requiresConfirmation: true,
  inputSchema: stockOrderSchema,

  async execute(input) {
    const body = (input ?? {}) as { symbol?: unknown; side?: unknown; amount?: unknown };
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const side = body.side === "SELL" ? "SELL" : "BUY";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";

    if (!symbol || !amount) {
      return toolError("tokenized_stock_prepare_order", {
        code: "INVALID_INPUT",
        message: "symbol and amount are required.",
      });
    }

    const result = await previewTokenizedStockOrder(symbol, side, amount);
    if (!result.ok) {
      return toolError("tokenized_stock_prepare_order", {
        code: toolFailureCode(result.error.code),
        message: result.error.message,
      });
    }

    return toolSuccess(
      "tokenized_stock_prepare_order",
      {
        preview: {
          ticker: result.value.catalog.ticker,
          productId: result.value.productId,
          side: result.value.side,
          quoteAmount: result.value.quoteAmount,
          orderTotal: result.value.preview.orderTotal,
          commissionTotal: result.value.preview.commissionTotal,
          estimatedBaseSize: result.value.preview.baseSize,
          averageFilledPrice: result.value.preview.averageFilledPrice,
          warning: result.value.preview.warning,
          executed: false,
        },
      },
      { source: "coinbase-advanced-trade" },
    );
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
