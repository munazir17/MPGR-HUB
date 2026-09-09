import "server-only";

// lib/trade/trade-research.ts
//
// Assembles a tokenized-stock catalog or single-asset research report.
// Liquidity is an Aerodrome Slipstream USDC quote — never faked, and
// never sent through CDP/0x (those APIs reject B20).

import { isAddress } from "viem";

import { BASE_USDC } from "./trade-config";
import { getRoutedSwapPrice } from "./trade-swap-router";
import {
  B20_ORACLE_REGISTRY,
  COINBASE_B20_TOKENIZED_STOCKS,
  TOKENIZED_STOCK_CATALOG_NOTES,
  findTokenizedStock,
} from "./tokenized-stocks";
import { readTokenizedStockOnchain } from "./tokenized-stocks-onchain";
import { tokenizedStockResearchRisk } from "./trade-risk";
import type { TokenizedStockReport, TokenizedStockResearch, TradeError, TradeProvider } from "./trade-types";

export type TradeResearchResult =
  | { ok: true; report: TokenizedStockReport }
  | { ok: false; error: TradeError };

const RESEARCH_PROBE_USDC = "1000000"; // 1 USDC atomic

export function buildTokenizedStockCatalog(): TokenizedStockReport {
  return {
    kind: "catalog",
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    registry: B20_ORACLE_REGISTRY,
    assets: [...COINBASE_B20_TOKENIZED_STOCKS],
    notes: TOKENIZED_STOCK_CATALOG_NOTES,
  };
}

export async function researchTokenizedStock(
  query: string,
  taker?: string,
): Promise<TradeResearchResult> {
  const catalog = findTokenizedStock(query);
  if (!catalog) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: `"${query}" is not one of the 13 Coinbase Tokenized Stocks documented on Base. This app will not invent an issuer, contract, or ticker.`,
      },
    };
  }

  const onchain = await readTokenizedStockOnchain(catalog);

  let liquidityAvailable: boolean | null = null;
  let liquidityReason: string;
  let liquidityChecked = false;
  let providerUsed: TradeProvider | null = null;

  const probeTaker =
    taker && isAddress(taker) ? taker : "0x000000000000000000000000000000000000dEaD";
  liquidityChecked = true;
  const price = await getRoutedSwapPrice({
    fromToken: BASE_USDC,
    toToken: catalog.address,
    fromAmount: RESEARCH_PROBE_USDC,
    taker: probeTaker,
  });
  if (!price.ok) {
    liquidityAvailable = null;
    liquidityReason = price.error.message;
  } else {
    liquidityAvailable = price.value.liquidityAvailable;
    providerUsed = price.provider;
    liquidityReason = price.value.liquidityAvailable
      ? "Aerodrome Slipstream reported liquidity for USDC → this token on Base. A swap can be prepared for explicit confirmation."
      : "Aerodrome Slipstream reported no USDC pool liquidity for this token on Base. Buy/sell stays research-only.";
  }

  // A paused B20 token cannot execute a real transfer on-chain even
  // if a DEX quote/route exists — this must override liquidity-based
  // availability, not just be reported alongside it.
  const isPaused = onchain.paused === true;
  const executionAvailable = liquidityAvailable === true && !isPaused;

  const executionMethod: TokenizedStockResearch["execution"]["method"] = !executionAvailable
    ? "none"
    : providerUsed === "aerodrome-slipstream"
      ? "aerodrome-slipstream"
      : providerUsed === "0x-swap-api"
        ? "0x-swap-api"
        : "cdp-trade-api-swap";

  const report: TokenizedStockResearch = {
    catalog,
    onchain,
    liquidity: {
      checked: liquidityChecked,
      quoteAsset: "USDC",
      liquidityAvailable,
      reason: liquidityReason,
    },
    execution: {
      available: executionAvailable,
      method: executionMethod,
      reason: isPaused
        ? `${catalog.ticker} transfers are currently paused on-chain — execution is disabled regardless of DEX liquidity.`
        : executionAvailable
          ? "Secondary-market swap on Base via Aerodrome Slipstream (user wallet signs). Not an issuer mint and not Coinbase Advanced Trade."
          : "No verified programmatic issuer mint/redeem API exists for retail. Without Aerodrome USDC pool liquidity, execution is disabled.",
    },
    risk: tokenizedStockResearchRisk(catalog),
    sources: [
      "https://docs.base.org/specifications/b20/tokenized-stocks-on-base",
      "https://www.coinbase.com/tokenize",
      "https://docs.aerodrome.finance/",
    ],
  };

  return { ok: true, report: { kind: "research", report } };
}
