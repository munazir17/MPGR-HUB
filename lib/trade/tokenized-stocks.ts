// lib/trade/tokenized-stocks.ts
//
// Official Coinbase Tokenized Stocks on Base (B20).
//
// Source of truth (do not invent additional tickers or addresses):
//   https://docs.base.org/specifications/b20/tokenized-stocks-on-base
//   https://www.coinbase.com/tokenize
//
// Product facts from those docs:
//   - Issued as B20 tokens on Base (ERC-20 compatible extension).
//   - Identified by contract address, not ticker.
//   - 1 B20 token is NOT permanently 1 share — apply on-chain multiplier.
//   - Holding and secondary-market trading is permissionless.
//   - Mint/redeem of the underlying share is Authorized Participant only.
//     There is no public Coinbase retail mint/redeem API, so this app
//     never fakes a "buy share from issuer" call.
//   - Secondary buy/sell, when liquidity exists, is an ordinary Base
//     ERC-20/B20 swap through the CDP Trade API — same path as any token.
//   - Chainlink equity feeds (8 decimals) × on-chain multiplier = token
//     reference price. DEX price is a different number and is NOT the
//     oracle source.

import type { Address } from "viem";

import type { TokenizedStockCatalogEntry } from "./trade-types";

/** Coinbase on-chain oracle registry (multiplier + pause flag). */
export const B20_ORACLE_REGISTRY =
  "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as Address;

/**
 * Official 13 Coinbase tokenized stocks + Chainlink feeds, copied
 * verbatim from Base docs. Do not add tickers that are not on that page.
 */
export const COINBASE_B20_TOKENIZED_STOCKS: readonly TokenizedStockCatalogEntry[] = [
  {
    ticker: "AAPLc",
    symbol: "AAPLc",
    name: "Apple Tokenized Stock (Coinbase)",
    underlyingTicker: "AAPL",
    address: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "AMZNc",
    symbol: "AMZNc",
    name: "Amazon Tokenized Stock (Coinbase)",
    underlyingTicker: "AMZN",
    address: "0xb200000000000000000000d9192b6B456483C2E8",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "COINc",
    symbol: "COINc",
    name: "Coinbase Tokenized Stock (Coinbase)",
    underlyingTicker: "COIN",
    address: "0xb200000000000000000000c85a31389D71F3ecfb",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "CRCLc",
    symbol: "CRCLc",
    name: "Circle Tokenized Stock (Coinbase)",
    underlyingTicker: "CRCL",
    address: "0xB20000000000000000000019f6E7C675b73C2e4D",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "GOOGLc",
    symbol: "GOOGLc",
    name: "Alphabet Tokenized Stock (Coinbase)",
    underlyingTicker: "GOOGL",
    address: "0xb2000000000000000000002D0BA3164cc74f58B7",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "INTCc",
    symbol: "INTCc",
    name: "Intel Tokenized Stock (Coinbase)",
    underlyingTicker: "INTC",
    address: "0xB2000000000000000000004AFF16039bA04bdFBc",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "METAc",
    symbol: "METAc",
    name: "Meta Tokenized Stock (Coinbase)",
    underlyingTicker: "META",
    address: "0xb2000000000000000000008bC8786B856E61707C",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "MSFTc",
    symbol: "MSFTc",
    name: "Microsoft Tokenized Stock (Coinbase)",
    underlyingTicker: "MSFT",
    address: "0xb200000000000000000000Ab99cFa739E253872B",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "MSTRc",
    symbol: "MSTRc",
    name: "MicroStrategy Tokenized Stock (Coinbase)",
    underlyingTicker: "MSTR",
    address: "0xb2000000000000000000004884b426556b92883d",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "NVDAc",
    symbol: "NVDAc",
    name: "NVIDIA Tokenized Stock (Coinbase)",
    underlyingTicker: "NVDA",
    address: "0xb20000000000000000000078ee7ce2fE4908108C",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "SNDKc",
    symbol: "SNDKc",
    name: "Sandisk Tokenized Stock (Coinbase)",
    underlyingTicker: "SNDK",
    address: "0xb200000000000000000000397293Cb8cda9a10c5",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "SPCXc",
    symbol: "SPCXc",
    name: "SpaceX Tokenized Stock (Coinbase)",
    underlyingTicker: "SPCX",
    address: "0xb2000000000000000000007b9fcbd005511aCBd5",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
  {
    ticker: "TSLAc",
    symbol: "TSLAc",
    name: "Tesla Tokenized Stock (Coinbase)",
    underlyingTicker: "TSLA",
    address: "0xb2000000000000000000001e800a7f5189430cD0",
    chainId: 8453,
    network: "base",
    standard: "B20",
    issuer: "Coinbase",
    chainlinkFeed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    secondaryMarket: "permissionless",
    primaryMintRedeem: "authorized-participant-only",
  },
];

export const TOKENIZED_STOCK_CATALOG_NOTES = [
  "These are Coinbase Tokenized Stocks on Base (B20), not brokerage shares.",
  "Each token is a beneficial claim on a real share held in regulated custody. It is not a traditional stock certificate.",
  "Apply the on-chain multiplier: 1 token is not permanently equal to 1 share (dividends/splits).",
  "Holding and DEX trading is permissionless. Mint/redeem of the underlying is Authorized Participant only — this app has no issuer mint API.",
  "Buy/sell here, when offered, is a Base DEX swap via the Coinbase CDP Trade API if that API reports liquidity. No liquidity = research only.",
  "Chainlink feeds report traditional-market equity prices (24/5) and freeze during corporate actions. Weekend values are last close.",
  "Coinbase for Agents / Advanced Trade equities (AAPL-USD) are a different custodial product and are not wired here.",
] as const;

export function findTokenizedStock(input: string): TokenizedStockCatalogEntry | null {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  return (
    COINBASE_B20_TOKENIZED_STOCKS.find((stock) => {
      return (
        stock.ticker.toLowerCase() === needle ||
        stock.symbol.toLowerCase() === needle ||
        stock.underlyingTicker.toLowerCase() === needle ||
        stock.address.toLowerCase() === needle
      );
    }) ?? null
  );
}
