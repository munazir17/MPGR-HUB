// lib/x402/x402-config.ts
//
// P3 — compile-time-constant x402 configuration.
//
// Security boundary:
// - Only Base Mainnet is supported.
// - Only the "exact" x402 scheme is supported.
// - Payment amount, recipient and resource are NEVER invented here.
// - Known asset EIP-712 domains are keyed canonically by lowercase address.
// - Resource-supplied `extra.name` / `extra.version` takes precedence.
// - Unknown assets without a supplied EIP-712 domain are rejected.
//
// This file does NOT:
// - fetch anything
// - sign anything
// - submit payments
// - invent facilitator URLs
// - invent recipients
// - invent payment amounts

import { base } from "wagmi/chains";
import { TOOL_CHAIN_ID } from "@/lib/architecture/tools/tool-helpers";

// =============================================================================
// Supported network
// =============================================================================

/**
 * CAIP-2 identifier for the one chain this app is willing to pay on.
 *
 * MPGR HUB is Base-Mainnet-only for these tools, and TOOL_CHAIN_ID already
 * represents Base Mainnet (8453). We deliberately reuse it rather than
 * introducing another independent chain constant.
 */
export const X402_SUPPORTED_NETWORK =
  `eip155:${TOOL_CHAIN_ID}` as const;

/**
 * Wire-format aliases that mean Base Mainnet and nothing else.
 *
 * Coinbase x402 resources commonly advertise `network: "base"` or
 * `"base-mainnet"` instead of CAIP-2 `"eip155:8453"`. Those aliases
 * are equivalent to the supported mainnet identifier.
 *
 * Base Sepolia (`base-sepolia`, `eip155:84532`) is intentionally
 * absent. Production execution stays mainnet-only.
 */
const X402_BASE_MAINNET_ALIASES = new Set([
  "base",
  "base-mainnet",
  "eip155:8453",
  X402_SUPPORTED_NETWORK,
]);

/**
 * Normalize an untrusted x402 `network` field onto the app's CAIP-2
 * Base Mainnet identifier when it is a known mainnet alias.
 *
 * Unknown / testnet identifiers are returned unchanged so the parser
 * can reject them. Non-strings become `""`.
 */
export function normalizeX402Network(network: unknown): string {
  if (typeof network !== "string") return "";
  const trimmed = network.trim();
  if (
    X402_BASE_MAINNET_ALIASES.has(trimmed) ||
    X402_BASE_MAINNET_ALIASES.has(trimmed.toLowerCase())
  ) {
    return X402_SUPPORTED_NETWORK;
  }
  return trimmed;
}

// =============================================================================
// Supported schemes
// =============================================================================

/**
 * P3 implements the x402 "exact" scheme only.
 *
 * "exact" corresponds to the EIP-3009-style TransferWithAuthorization
 * payment flow implemented elsewhere in the x402 subsystem.
 */
export const X402_SUPPORTED_SCHEMES = ["exact"] as const;

export type X402SupportedScheme =
  (typeof X402_SUPPORTED_SCHEMES)[number];

// =============================================================================
// EIP-712 asset domain configuration
// =============================================================================

export interface Eip712AssetDomain {
  name: string;
  version: string;
}

/**
 * Known EIP-712 domains for assets this application explicitly recognizes.
 *
 * IMPORTANT:
 * All keys MUST be lowercase because resolveEip712Domain() normalizes
 * the supplied asset address with .toLowerCase() before lookup.
 *
 * Base Mainnet USDC:
 *
 *   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *
 * Canonical lowercase representation:
 *
 *   0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 *
 * The previous version contained an uppercase "A" in the final portion
 * of this registry key. Because lookups are lowercase-normalized, that
 * prevented the known USDC domain from being found and caused otherwise
 * valid x402 requirements to be filtered out.
 */
export const KNOWN_X402_ASSET_DOMAINS: Record<
  string,
  Eip712AssetDomain
> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    name: "USDC",
    version: "2",
  },
};

/**
 * Known decimals for human-readable proposal formatting only.
 *
 * These values NEVER modify the atomic-unit payment amount used by the
 * authorization/signing layer.
 */
export const KNOWN_X402_ASSET_DECIMALS: Record<
  string,
  number
> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
};

// =============================================================================
// Domain resolution
// =============================================================================

export interface Eip712DomainResolution {
  domain: Eip712AssetDomain;

  /**
   * Indicates whether the domain came from:
   *
   * - the resource server's own x402 `extra` field, or
   * - MPGR HUB's explicitly known-asset registry.
   */
  source:
    | "requirement.extra"
    | "known-asset-registry";
}

/**
 * Resolve the EIP-712 domain required to sign a payment.
 *
 * Priority:
 *
 * 1. Resource requirement's explicit `extra.name` + `extra.version`
 * 2. MPGR HUB's known-asset registry
 * 3. null — never guess
 *
 * The resource-supplied values are accepted only when BOTH name and
 * version are non-empty strings.
 */
export function resolveEip712Domain(
  assetAddress: string,
  extra: Record<string, unknown> | undefined,
): Eip712DomainResolution | null {
  const extraName = extra?.name;
  const extraVersion = extra?.version;

  if (
    typeof extraName === "string" &&
    extraName.length > 0 &&
    typeof extraVersion === "string" &&
    extraVersion.length > 0
  ) {
    return {
      domain: {
        name: extraName,
        version: extraVersion,
      },
      source: "requirement.extra",
    };
  }

  const known =
    KNOWN_X402_ASSET_DOMAINS[
      assetAddress.toLowerCase()
    ];

  if (known) {
    return {
      domain: known,
      source: "known-asset-registry",
    };
  }

  return null;
}

/**
 * Resolve decimals for a known asset.
 *
 * This is display-only information.
 * Unknown assets return null rather than guessing.
 */
export function resolveKnownAssetDecimals(
  assetAddress: string,
): number | null {
  return (
    KNOWN_X402_ASSET_DECIMALS[
      assetAddress.toLowerCase()
    ] ?? null
  );
}

// =============================================================================
// Chain ID
// =============================================================================

/**
 * Raw numeric Base Mainnet chain ID.
 *
 * Re-exported for callers that need the numeric chain ID alongside
 * the CAIP-2 x402 network identifier.
 */
export const X402_CHAIN_ID = base.id;
