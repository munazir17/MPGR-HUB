// lib/trade/trade-public-client.ts
//
// Server-safe viem public client for Base reads (B20 / Chainlink /
// Aerodrome Slipstream). Does not use wagmi connectors — those are
// wallet/browser concerns.
//
// mainnet.base.org rate-limits; fall back to a public endpoint so
// B20 quotes do not 429 in production.

import { createPublicClient, fallback, http } from "viem";
import { base } from "wagmi/chains";

function rpcUrls(): string[] {
  const urls = [
    process.env.BASE_RPC_URL?.trim(),
    process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim(),
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ].filter((url): url is string => !!url && url.length > 0);
  return [...new Set(urls)];
}

export function getTradePublicClient() {
  return createPublicClient({
    chain: base,
    transport: fallback(rpcUrls().map((url) => http(url, { timeout: 12_000 }))),
  });
}
