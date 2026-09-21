// app/api/market/stock-holdings/route.ts
//
// GET /api/market/stock-holdings — the SESSION wallet's Coinbase
// Tokenized Stock (B20) balances on Base, plus its native USDC balance
// (the quote asset every B20 pool trades against).
//
// Security:
//   - the wallet ALWAYS comes from the authenticated SIWE session —
//     never from a query param or request body (AGENTS.md rule 3)
//   - balances are raw bigint strings; decimals are read on-chain per
//     token because B20 decimals are issuer-configurable and guessing
//     them is a real-funds unit error (same policy as the swap path)
//   - a token whose decimals read fails is returned with
//     `decimals: null, human: null` instead of a formatted guess

import { NextResponse } from "next/server";
import { formatUnits, isAddress } from "viem";

import { erc20Abi } from "@/lib/erc20-abi";
import { COINBASE_B20_TOKENIZED_STOCKS } from "@/lib/trade/tokenized-stocks";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { BASE_USDC } from "@/lib/trade/trade-config";
import { checkRateLimit } from "@/lib/trade/trade-rate-limit";
import { requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { authenticateRequest } from "@/lib/auth/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export interface StockHoldingEntry {
  symbol: string;
  name: string;
  address: string;
  /** Raw token balance in atomic units (decimal string). */
  balanceRaw: string;
  /** On-chain decimals, or null when the read failed. */
  decimals: number | null;
  /** formatUnits(balanceRaw, decimals), or null — never a guessed unit. */
  human: string | null;
  nonzero: boolean;
}

async function readBalanceAndDecimals(
  wallet: string,
  token: string,
): Promise<{ balanceRaw: bigint | null; decimals: number | null }> {
  const client = getTradePublicClient();
  const [balance, decimals] = await Promise.all([
    client
      .readContract({
        address: token as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet as `0x${string}`],
      })
      .catch(() => null),
    client
      .readContract({
        address: token as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      })
      .catch(() => null),
  ]);
  return {
    balanceRaw: typeof balance === "bigint" ? balance : null,
    decimals: typeof decimals === "number" ? decimals : null,
  };
}

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) =>
    withRequestId(NextResponse.json(body, init), requestId);

  const session = await authenticateRequest(request);
  if (!session || !isAddress(session.wallet)) {
    return json(
      { error: "Authentication required", code: "AUTH_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rate = await checkRateLimit(
    `${session.wallet.toLowerCase()}:market-stock-holdings`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const tokens = [
    ...COINBASE_B20_TOKENIZED_STOCKS.map((stock) => ({
      symbol: stock.ticker,
      name: stock.name,
      address: stock.address as string,
    })),
    { symbol: "USDC", name: "USD Coin", address: BASE_USDC as string },
  ];

  try {
    const reads = await Promise.all(
      tokens.map(async (token) => {
        const { balanceRaw, decimals } = await readBalanceAndDecimals(session.wallet, token.address);
        const human =
          balanceRaw !== null && decimals !== null ? formatUnits(balanceRaw, decimals) : null;
        const entry: StockHoldingEntry = {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          balanceRaw: balanceRaw !== null ? balanceRaw.toString() : "0",
          decimals,
          human,
          nonzero: balanceRaw !== null && balanceRaw > 0n,
        };
        return entry;
      }),
    );

    return json(
      {
        wallet: session.wallet,
        chainId: 8453,
        asOf: new Date().toISOString(),
        // Official B20 holdings only; USDC is reported separately so the
        // "stocks" list is never mixed with the quote asset.
        holdings: reads.filter((entry) => entry.symbol !== "USDC" && entry.nonzero),
        all: reads,
        usdc: reads.find((entry) => entry.symbol === "USDC") ?? null,
        source: "Base RPC balanceOf (session wallet)",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json(
      { error: "Holdings lookup is temporarily unavailable.", code: "DATA_UNAVAILABLE" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
