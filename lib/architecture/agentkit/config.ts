import "server-only";

// lib/architecture/agentkit/config.ts
//
// Coinbase AgentKit is the MPGR onchain/action layer on Base.
// This file is the single place that names the network, RPC, and
// server-only CDP env keys. It never reads a private key into a
// client bundle and never invents payment fields.

import { base } from "wagmi/chains";

import { TOOL_CHAIN_ID } from "@/lib/architecture/tools/tool-helpers";

export const AGENTKIT_NETWORK_ID = "base-mainnet" as const;
export const AGENTKIT_CHAIN_ID = TOOL_CHAIN_ID;
export const AGENTKIT_PROTOCOL_FAMILY = "evm" as const;

export const AGENTKIT_NETWORK = {
  protocolFamily: AGENTKIT_PROTOCOL_FAMILY,
  networkId: AGENTKIT_NETWORK_ID,
  chainId: String(AGENTKIT_CHAIN_ID),
} as const;

export const AGENTKIT_VIEM_CHAIN = base;

export const PREPARE_ONLY_ERROR =
  "AgentKit is configured prepare-only on Base. Signing, payment, and transaction submission stay behind the MPGR Confirm UX and the user's connected wallet.";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export function getAgentKitRpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim() || "https://mainnet.base.org"
  );
}

/**
 * CDP credentials stay server-side. They are optional: MPGR uses a
 * prepare-only wallet provider, so AgentKit does not need a CDP-hosted
 * signer. If present they must never be returned to the browser.
 */
export function readServerCdpCredentials(): {
  cdpApiKeyId: string | undefined;
  cdpApiKeySecret: string | undefined;
  cdpWalletSecret: string | undefined;
} {
  return {
    cdpApiKeyId: process.env.CDP_API_KEY_ID?.trim() || undefined,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET?.trim() || undefined,
    cdpWalletSecret: process.env.CDP_WALLET_SECRET?.trim() || undefined,
  };
}

export function hasServerCdpCredentials(): boolean {
  const creds = readServerCdpCredentials();
  return Boolean(
    creds.cdpApiKeyId && creds.cdpApiKeySecret && creds.cdpWalletSecret,
  );
}
