// lib/architecture/tools/stocks-tool-definitions.ts
//
// Base Stocks Agent tools (read + prepare only):
//
//   get_tape                  (read)    — live tape snapshot
//   get_pair                  (read)    — one allowlisted pair in detail
//   verify_b20_contract       (read)    — allowlist-only "official?" oracle
//   get_stock_holdings        (read)    — SESSION wallet B20 balances
//   get_premium               (read)    — DEX vs Chainlink feed premium
//   describe_x402_tape        (read)    — what the paid tape endpoint costs
//   prepare_swap              (prepare) — allowlisted Base swap proposal
//
// Same HTTP-route indirection as trade-tool-definitions.ts: this file is
// in the client import graph (agent page → ai service → registry), so it
// must never import `server-only` modules directly. verify_b20_contract
// and prepare_swap's allowlist checks use lib/markets/base-pairs.ts,
// which is deliberately import-safe (typed config, no fetches).
//
// There is NO execute tool here. prepare_swap reuses the existing,
// session-bound quote routes (/api/trade/stocks/quote for USDC↔B20 via
// the runtime's deterministic router, /api/trade/quote otherwise) and
// returns the same TradeProposal the confirm-and-sign UI already
// renders. The taker is always the authenticated session wallet —
// body.wallet from the model is ignored by the routes themselves.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import { findBasePair, verifyB20Address } from "@/lib/markets/base-pairs";
import type { TapePairDetail, TapeSnapshot } from "@/lib/markets/tape-types";
import { X402_TAPE_PATH } from "@/lib/x402/x402-tape-info";

function toolFailureCode(
  code: unknown,
): "INVALID_INPUT" | "WALLET_NOT_CONNECTED" | "DATA_UNAVAILABLE" | "PROVIDER_ERROR" {
  if (code === "INVALID_INPUT" || code === "UNSUPPORTED_ASSET" || code === "UNKNOWN_SYMBOL") {
    return "INVALID_INPUT";
  }
  if (code === "WALLET_REQUIRED" || code === "WALLET_NOT_CONNECTED" || code === "AUTH_REQUIRED") {
    return "WALLET_NOT_CONNECTED";
  }
  if (
    code === "CREDENTIALS_MISSING" ||
    code === "LIQUIDITY_UNAVAILABLE" ||
    code === "EXECUTION_UNAVAILABLE" ||
    code === "TAPE_UNAVAILABLE" ||
    code === "DATA_UNAVAILABLE"
  ) {
    return "DATA_UNAVAILABLE";
  }
  return "PROVIDER_ERROR";
}

async function getJson(
  path: string,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const response = await fetchWithSession(path, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const response = await fetchWithSession(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

/** Compact the tape for the model transcript — prices, freshness, sources only. */
function compactTape(snapshot: TapeSnapshot) {
  return {
    asOf: snapshot.asOf,
    chainId: snapshot.chainId,
    blockNumber: snapshot.blockNumber,
    wrapped: snapshot.wrapped.map((entry) => ({
      symbol: entry.symbol,
      usd: entry.usd,
      change24h: entry.change24h,
      stale: entry.stale,
      source: entry.source,
    })),
    stocks: snapshot.stocks.map((entry) => ({
      symbol: entry.symbol,
      usdFeed: entry.usdFeed,
      usdDex: entry.usdDex,
      premiumBps: entry.premiumBps,
      change24h: entry.change24h,
      stale: entry.stale,
      feedStale: entry.feedStale,
      paused: entry.paused,
    })),
  };
}

// --- get_tape ---------------------------------------------------------------

export const getTapeTool: AgentTool = {
  id: "get_tape",
  name: "Base Stocks Live Tape",
  description:
    "Reads the live Base Stocks tape: Coinbase wrapped assets (cbBTC, cbETH, USDC, cbDOGE, cbXRP, cbLTC, cbADA) and Coinbase Tokenized Stocks (NVDAc, AAPLc, TSLAc, …) with DEX price, Chainlink feed price, premium bps, real 24h change, staleness and pause flags. Values may be null — report them as unavailable, never invent a number. This is the free endpoint; the paid x402 snapshot lives at " +
    X402_TAPE_PATH +
    ".",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: { type: "object", properties: {} } satisfies AgentToolSchema,

  async execute() {
    try {
      const { ok, payload } = await getJson("/api/market/tape");
      if (!ok || !payload) {
        return toolError("get_tape", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : "Could not load the live Base Stocks tape.",
          retryable: true,
        });
      }
      return toolSuccess("get_tape", { tape: compactTape(payload as unknown as TapeSnapshot) }, {
        source: "server-aggregated tape (Chainlink + DexScreener)",
        chainId: 8453,
      });
    } catch {
      return toolError("get_tape", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the tape endpoint.",
        retryable: true,
      });
    }
  },
};

// --- get_pair ----------------------------------------------------------------

const pairSchema: AgentToolSchema = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description:
        "Allowlisted pair symbol: a Coinbase wrapped asset (cbBTC, cbETH, cbDOGE, cbXRP, cbLTC, cbADA), USDC, or an official B20 stock (NVDAc, AAPLc, GOOGLc, METAc, AMZNc, MSFTc, TSLAc, SPCXc, SNDKc, MSTRc, COINc, CRCLc, INTCc). Underlying tickers (AAPL) resolve to their B20 token.",
    },
  },
  required: ["symbol"],
};

export const getPairTool: AgentTool = {
  id: "get_pair",
  name: "Base Pair Detail",
  description:
    "Reads one allowlisted Base pair in detail: official contract, Chainlink feed price vs DEX price, premium bps, 24h change, freshness, block, sources and the Basescan link. Unknown symbols are rejected — never guess a contract.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: pairSchema,

  async execute(input) {
    const { symbol } = (input ?? {}) as { symbol?: unknown };
    const query = typeof symbol === "string" ? symbol.trim() : "";
    if (!query) {
      return toolError("get_pair", {
        code: "INVALID_INPUT",
        message: "symbol is required.",
      });
    }
    try {
      const { ok, payload } = await getJson(`/api/market/pair?symbol=${encodeURIComponent(query)}`);
      if (!ok || !payload) {
        return toolError("get_pair", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : `Could not load pair data for "${query}".`,
        });
      }
      const detail = payload as unknown as TapePairDetail;
      return toolSuccess(
        "get_pair",
        {
          pair: detail.pair,
          stock: detail.stockEntry
            ? {
                usdFeed: detail.stockEntry.usdFeed,
                usdDex: detail.stockEntry.usdDex,
                premiumBps: detail.stockEntry.premiumBps,
                change24h: detail.stockEntry.change24h,
                stale: detail.stockEntry.stale,
                feedStale: detail.stockEntry.feedStale,
                paused: detail.stockEntry.paused,
                feedUpdatedAt: detail.stockEntry.feedUpdatedAt,
                source: detail.stockEntry.source,
              }
            : null,
          wrapped: detail.wrappedEntry,
          asOf: detail.asOf,
          blockNumber: detail.blockNumber,
        },
        { source: "server-aggregated tape (Chainlink + DexScreener)", chainId: 8453 },
      );
    } catch {
      return toolError("get_pair", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the pair endpoint.",
        retryable: true,
      });
    }
  },
};

// --- verify_b20_contract ------------------------------------------------------

const verifySchema: AgentToolSchema = {
  type: "object",
  properties: {
    address: {
      type: "string",
      description: "A 0x contract address on Base to check against the official Coinbase B20 list.",
    },
  },
  required: ["address"],
};

export const verifyB20ContractTool: AgentTool = {
  id: "verify_b20_contract",
  name: "Verify B20 Contract",
  description:
    "Checks whether a Base contract address is an official Coinbase Tokenized Stock (B20). Answers strictly from the docs-verified allowlist: official:true with symbol/name/feed/registry when it matches, official:false for everything else — including look-alike 0xb200… addresses and clone tickers. Never verifies from memory or the web.",
  category: "research",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: verifySchema,

  async execute(input) {
    const { address } = (input ?? {}) as { address?: unknown };
    const query = typeof address === "string" ? address.trim() : "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(query)) {
      return toolError("verify_b20_contract", {
        code: "INVALID_ADDRESS",
        message: "address must be a 0x-prefixed, 40-hex-character Base contract address.",
      });
    }
    const verification = verifyB20Address(query);
    return toolSuccess("verify_b20_contract", { verification }, {
      source: verification.source ?? "mpgr-allowlist",
      chainId: 8453,
    });
  },
};

// --- get_stock_holdings --------------------------------------------------------

export const getStockHoldingsTool: AgentTool = {
  id: "get_stock_holdings",
  name: "My Coinbase Stock Holdings",
  description:
    "Lists the connected wallet's official Coinbase Tokenized Stock (B20) balances on Base, plus its native USDC balance. Reads the authenticated session wallet server-side — a wallet in the message text is ignored. Requires a connected + signed-in wallet.",
  category: "portfolio",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: { type: "object", properties: {} } satisfies AgentToolSchema,

  async execute() {
    try {
      const { ok, status, payload } = await getJson("/api/market/stock-holdings");
      if (!ok || !payload) {
        const code = toolFailureCode(payload?.code);
        return toolError("get_stock_holdings", {
          code,
          message:
            status === 401
              ? "Connect and sign in with your wallet to see your Coinbase stock holdings."
              : typeof payload?.error === "string"
                ? payload.error
                : "Could not load your stock holdings.",
          retryable: code === "PROVIDER_ERROR" || code === "DATA_UNAVAILABLE",
        });
      }
      return toolSuccess(
        "get_stock_holdings",
        {
          holdings: payload.holdings,
          usdc: payload.usdc,
          asOf: payload.asOf,
        },
        { source: String(payload.source ?? "Base RPC balanceOf"), chainId: 8453 },
      );
    } catch {
      return toolError("get_stock_holdings", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the holdings endpoint.",
        retryable: true,
      });
    }
  },
};

// --- get_premium ----------------------------------------------------------------

const premiumSchema: AgentToolSchema = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description: "Official B20 stock symbol, e.g. NVDAc, AAPLc, TSLAc.",
    },
  },
  required: ["symbol"],
};

export const getPremiumTool: AgentTool = {
  id: "get_premium",
  name: "Stock Premium vs Feed",
  description:
    "Reports a Coinbase Tokenized Stock's DEX price versus its official Chainlink feed price and the premium in basis points, with staleness/pause flags. premiumBps null means a leg is unavailable — say so, never estimate it.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: premiumSchema,

  async execute(input) {
    const { symbol } = (input ?? {}) as { symbol?: unknown };
    const query = typeof symbol === "string" ? symbol.trim() : "";
    const pair = query ? findBasePair(query) : null;
    if (!pair || pair.kind !== "b20-stock") {
      return toolError("get_premium", {
        code: "INVALID_INPUT",
        message: `"${query}" is not an official Coinbase Tokenized Stock (B20) on Base. Premium is only defined for the allowlisted stock tokens.`,
      });
    }
    try {
      const { ok, payload } = await getJson(`/api/market/pair?symbol=${encodeURIComponent(pair.symbol)}`);
      if (!ok || !payload) {
        return toolError("get_premium", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : `Could not load premium data for ${pair.symbol}.`,
          retryable: true,
        });
      }
      const detail = payload as unknown as TapePairDetail;
      const stock = detail.stockEntry;
      return toolSuccess(
        "get_premium",
        {
          symbol: pair.symbol,
          address: pair.address,
          usdFeed: stock?.usdFeed ?? null,
          usdDex: stock?.usdDex ?? null,
          premiumBps: stock?.premiumBps ?? null,
          feedStale: stock?.feedStale ?? true,
          paused: stock?.paused ?? null,
          feedUpdatedAt: stock?.feedUpdatedAt ?? null,
          asOf: detail.asOf,
          interpretation:
            stock?.premiumBps === null || stock?.premiumBps === undefined
              ? "A price leg is unavailable — report the premium as unknown."
              : stock.premiumBps > 0
                ? "DEX trades above the official feed (premium)."
                : stock.premiumBps < 0
                  ? "DEX trades below the official feed (discount)."
                  : "DEX matches the official feed.",
        },
        { source: "Chainlink Coinbase equity feed + DexScreener", chainId: 8453 },
      );
    } catch {
      return toolError("get_premium", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the pair endpoint.",
        retryable: true,
      });
    }
  },
};

// --- describe_x402_tape ----------------------------------------------------------

export const describeX402TapeTool: AgentTool = {
  id: "describe_x402_tape",
  name: "Paid Tape Endpoint (x402)",
  description:
    "Explains the one paid endpoint this app sells: GET " +
    X402_TAPE_PATH +
    " — an x402-gated live tape snapshot for agents. Unpaid calls receive HTTP 402 with payment requirements (USDC on Base, 0.02 by default); a valid EIP-3009 payment returns the tape JSON with paid:true. Does not pay anything.",
  category: "payment",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: { type: "object", properties: {} } satisfies AgentToolSchema,

  async execute(_input, context) {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
    return toolSuccess(
      "describe_x402_tape",
      {
        method: "GET",
        path: X402_TAPE_PATH,
        url: origin ? `${origin}${X402_TAPE_PATH}` : X402_TAPE_PATH,
        product: "MPGR / Base Stocks live tape snapshot",
        payment: {
          protocol: "x402 (HTTP 402 + EIP-3009 TransferWithAuthorization)",
          scheme: "exact",
          network: "Base Mainnet (eip155:8453)",
          asset: "USDC (native on Base, 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)",
          priceUsdc: "0.02 by default (server env X402_TAPE_PRICE_USDC_RAW, atomic 20000)",
        },
        unpaidResponse: "HTTP 402 with accepts[]: { scheme, network, asset, maxAmountRequired, payTo, resource, description }",
        paidResponse:
          "HTTP 200 with the /api/market/tape snapshot plus { paid: true, paymentTx } and an X-PAYMENT-RESPONSE settlement header",
        howToPay:
          "The user's wallet signs the EIP-3009 authorization — in this app, ask to prepare the x402 payment for this resource URL and confirm in the payment modal. The agent never holds funds.",
        ...(context.walletAddress ? {} : { note: "No wallet connected — payment requires the user's signature." }),
      },
      { source: "mpgr-x402-config", chainId: 8453 },
    );
  },
};

// --- prepare_swap ------------------------------------------------------------------

const prepareSwapSchema: AgentToolSchema = {
  type: "object",
  properties: {
    sellSymbol: {
      type: "string",
      description:
        "Allowlisted token to sell: USDC, ETH, WETH, MPGR, a Coinbase wrapped asset (cbBTC, cbETH, cbDOGE, cbXRP, cbLTC, cbADA) or an official B20 stock (AAPLc, NVDAc, …).",
    },
    sellAddress: {
      type: "string",
      description: "Optional 0x address on Base to sell instead of sellSymbol. Allowlisted symbols are preferred.",
    },
    buySymbol: {
      type: "string",
      description: "Allowlisted token to buy. Same format as sellSymbol.",
    },
    buyAddress: {
      type: "string",
      description: "Optional 0x address on Base to buy instead of buySymbol.",
    },
    amount: {
      type: "string",
      description:
        'Human sell amount in sell-token units, e.g. "10" for 10 USDC. Do not convert to atomic units.',
    },
    slippageBps: {
      type: "number",
      description: "Max slippage in basis points. Default 100 (1%). Allowed 1–500.",
    },
  },
  required: ["amount"],
};

/**
 * Resolves one side of the swap to an allowlisted address. Unknown
 * tickers fail closed here — the model can never make this tool quote an
 * arbitrary contract by symbol. Raw 0x addresses pass through to the
 * quote routes, which mark them unverified and add risk warnings (the
 * existing, audited behavior).
 */
function resolveSwapSide(
  symbolValue: unknown,
  addressValue: unknown,
): { address: string; symbol: string } | { error: string } {
  const symbol = typeof symbolValue === "string" ? symbolValue.trim() : "";
  const address = typeof addressValue === "string" ? addressValue.trim() : "";
  if (symbol) {
    const pair = findBasePair(symbol);
    if (pair) return { address: pair.address, symbol: pair.symbol };
    // ETH/WETH/MPGR are not tape pairs but are known trade tokens.
    const upper = symbol.toUpperCase();
    if (upper === "ETH" || upper === "WETH" || upper === "MPGR") {
      return { address: upper, symbol: upper };
    }
    return {
      error: `"${symbol}" is not on the official Base pairs allowlist (Coinbase wrapped assets, native USDC, official B20 stocks) and is not ETH/WETH/MPGR. Refusing to invent a contract.`,
    };
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { address, symbol: address };
  }
  return { error: "Provide sellSymbol/buySymbol (allowlisted) or a 0x address on Base." };
}

export const prepareSwapTool: AgentTool = {
  id: "prepare_swap",
  name: "Prepare Base Swap",
  description:
    "Prepares a structured Base Mainnet swap proposal between allowlisted assets — e.g. USDC → AAPLc (Aerodrome Slipstream) or USDC → cbBTC (CDP/0x). Shows sell amount, buy token, minOut, route, price impact and fees for explicit user confirmation; the connected wallet signs. Never signs, never broadcasts, Base 8453 only. Amount is human units of the sell token.",
  category: "defi",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: true,
  requiresConfirmation: true,
  inputSchema: prepareSwapSchema,

  async execute(input, context) {
    const body = (input ?? {}) as Record<string, unknown>;
    const sell = resolveSwapSide(body.sellSymbol, body.sellAddress);
    const buy = resolveSwapSide(body.buySymbol, body.buyAddress);
    if ("error" in sell) {
      return toolError("prepare_swap", { code: "INVALID_INPUT", message: sell.error });
    }
    if ("error" in buy) {
      return toolError("prepare_swap", { code: "INVALID_INPUT", message: buy.error });
    }
    if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
      return toolError("prepare_swap", {
        code: "INVALID_INPUT",
        message: "Sell and buy tokens must be different.",
      });
    }
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    if (!amount || /^[-+]/.test(amount)) {
      return toolError("prepare_swap", {
        code: "INVALID_INPUT",
        message: "amount must be a positive human quantity of the sell token, e.g. \"10\".",
      });
    }
    if (!context.walletAddress) {
      return toolError("prepare_swap", {
        code: "WALLET_NOT_CONNECTED",
        message: "Connect a Base wallet to prepare a swap.",
      });
    }

    // Deterministic routing (mirrors the runtime's B20 router): a B20
    // leg goes to the dedicated Aerodrome Slipstream prepare route;
    // everything else goes to the general CDP → 0x quote route. The
    // routes bind the taker to the authenticated session wallet and
    // fail closed on missing liquidity.
    const sellStock = findBasePair(sell.address);
    const buyStock = findBasePair(buy.address);
    try {
      if (buyStock?.kind === "b20-stock" && sell.symbol.toUpperCase() === "USDC") {
        const { ok, payload } = await postJson("/api/trade/stocks/quote", {
          symbol: buyStock.symbol,
          side: "BUY",
          amount,
        });
        if (!ok || !payload?.proposal) {
          return toolError("prepare_swap", {
            code: toolFailureCode(payload?.code),
            message:
              typeof payload?.error === "string"
                ? payload.error
                : `Could not prepare the USDC → ${buyStock.symbol} swap.`,
          });
        }
        const stockBuyProposal = payload.proposal as { provider?: string } | undefined;
        return toolSuccess("prepare_swap", { proposal: payload.proposal }, {
          source: stockBuyProposal?.provider ?? "aerodrome-slipstream",
          chainId: 8453,
        });
      }
      if (sellStock?.kind === "b20-stock" && buy.symbol.toUpperCase() === "USDC") {
        const { ok, payload } = await postJson("/api/trade/stocks/quote", {
          symbol: sellStock.symbol,
          side: "SELL",
          amount,
        });
        if (!ok || !payload?.proposal) {
          return toolError("prepare_swap", {
            code: toolFailureCode(payload?.code),
            message:
              typeof payload?.error === "string"
                ? payload.error
                : `Could not prepare the ${sellStock.symbol} → USDC swap.`,
          });
        }
        const stockSellProposal = payload.proposal as { provider?: string } | undefined;
        return toolSuccess("prepare_swap", { proposal: payload.proposal }, {
          source: stockSellProposal?.provider ?? "aerodrome-slipstream",
          chainId: 8453,
        });
      }

      const { ok, payload } = await postJson("/api/trade/quote", {
        fromToken: sell.address,
        toToken: buy.address,
        amount,
        ...(typeof body.slippageBps === "number" ? { slippageBps: body.slippageBps } : {}),
      });
      if (!ok || !payload?.proposal) {
        return toolError("prepare_swap", {
          code: toolFailureCode(payload?.code),
          message:
            typeof payload?.error === "string"
              ? payload.error
              : `Could not prepare the ${sell.symbol} → ${buy.symbol} swap.`,
        });
      }
      const proposal = payload.proposal as { provider?: string } | undefined;
      return toolSuccess("prepare_swap", { proposal: payload.proposal }, {
        source: proposal?.provider ?? "cdp-trade-api",
        chainId: 8453,
      });
    } catch {
      return toolError("prepare_swap", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the swap quote endpoint.",
        retryable: true,
      });
    }
  },
};

// --- registration ------------------------------------------------------------------

const registry = getAgentToolRegistry();
for (const tool of [
  getTapeTool,
  getPairTool,
  verifyB20ContractTool,
  getStockHoldingsTool,
  getPremiumTool,
  describeX402TapeTool,
  prepareSwapTool,
]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
