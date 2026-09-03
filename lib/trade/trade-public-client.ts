// lib/trade/trade-public-client.ts
//
// Server-safe viem public client for Base reads (B20 / Chainlink).
// Does not use wagmi connectors — those are wallet/browser concerns.

import { createPublicClient, http } from "viem";
import { base } from "wagmi/chains";

function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim() || "https://mainnet.base.org";
}

export function getTradePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl()),
  });
}
