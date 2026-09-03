import "server-only";

// lib/trade/trade-research.ts
//
// Assembles a tokenized-stock catalog or single-asset research report.
// Liquidity is an optional CDP getSwapPrice against USDC — never faked.

import { BASE_USDC } from "./trade-config";
import { getCdpSwapPrice, hasTradeApiCredentials } from "./trade-cdp-client";
import {
  B20_ORACLE_REGISTRY,
  COINBASE_B20_TOKENIZED_STOCKS,
  TOKENIZED_STOCK_CATALOG_NOTES,
  findTokenizedStock,
} from "./tokenized-stocks";
import { readTokenizedStockOnchain } from "./tokenized-stocks-onchain";
import { tokenizedStockResearchRisk } from "./trade-risk";
import type { TokenizedStockReport, TokenizedStockResearch, TradeError } from "./trade-types";

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

  if (!hasTradeApiCredentials()) {
    liquidityReason =
      "CDP Trade API credentials are not configured, so DEX liquidity was not probed. On-chain oracle data is still shown.";
  } else if (!taker) {
    liquidityReason =
      "Connect a wallet to probe Coinbase CDP for secondary-market (DEX) liquidity against USDC.";
  } else {
    liquidityChecked = true;
    const price = await getCdpSwapPrice({
      fromToken: BASE_USDC,
      toToken: catalog.address,
      fromAmount: RESEARCH_PROBE_USDC,
      taker,
    });
    if (!price.ok) {
      liquidityAvailable = null;
      liquidityReason = price.error.message;
    } else {
      liquidityAvailable = price.value.liquidityAvailable;
      liquidityReason = price.value.liquidityAvailable
        ? "Coinbase CDP Trade API reported liquidity for USDC → this token on Base. A swap can be prepared for explicit confirmation."
        : "Coinbase CDP Trade API reported no liquidity for USDC → this token. Buy/sell stays research-only.";
    }
  }

  const executionAvailable = liquidityAvailable === true;

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
      method: executionAvailable ? "cdp-trade-api-swap" : "none",
      reason: executionAvailable
        ? "Secondary-market swap via Coinbase CDP Trade API (user wallet signs). Not an issuer mint."
        : "No verified programmatic issuer mint/redeem API exists for retail. Without CDP liquidity, execution is disabled.",
    },
    risk: tokenizedStockResearchRisk(catalog),
    sources: [
      "https://docs.base.org/specifications/b20/tokenized-stocks-on-base",
      "https://www.coinbase.com/tokenize",
      "https://docs.cdp.coinbase.com/trade-api/quickstart",
    ],
  };

  return { ok: true, report: { kind: "research", report } };
}
