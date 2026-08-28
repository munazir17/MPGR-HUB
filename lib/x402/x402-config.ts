// lib/x402/x402-config.ts
//
// P3 — compile-time-constant x402 configuration. Exactly the same
// "never take a trust-relevant value from untrusted input" posture as
// tool-helpers.ts's TOOL_CHAIN_ID and agent-action-contract.ts's
// resolved `to` addresses: the network this app will pay on, and the
// EIP-712 domain fallback for known assets, are fixed here — never
// inferred from a resource server's freeform text.
//
// This file does NOT invent a facilitator URL, a token address, or a
// payment amount. It only fixes WHICH chain this app is willing to pay
// on (Base Mainnet — the app's own existing, single configured chain,
// see lib/wagmi.ts's `chains: [base]`) and provides a small, explicitly
// sourced fallback for one well-known asset's EIP-712 domain, which a
// resource server's own `extra` field always overrides (see
// resolveEip712Domain below) — the facilitator/recipient/amount
// themselves always come from the 402 response, never from here.

import { base } from "wagmi/chains";
import { TOOL_CHAIN_ID } from "@/lib/architecture/tools/tool-helpers";

/** CAIP-2 identifier for the one chain this app pays x402 requirements on. Reuses TOOL_CHAIN_ID (Base Mainnet, 8453) — not a second chain constant. */
export const X402_SUPPORTED_NETWORK = `eip155:${TOOL_CHAIN_ID}` as const;

/** Only the "exact" scheme (EIP-3009 TransferWithAuthorization) is implemented in P3 — see the header comment in x402-authorization.ts for why. */
export const X402_SUPPORTED_SCHEMES = ["exact"] as const;
export type X402SupportedScheme = (typeof X402_SUPPORTED_SCHEMES)[number];

export interface Eip712AssetDomain {
  name: string;
  version: string;
}

/**
 * A small, explicitly-sourced fallback registry of EIP-712 domains for
 * assets this app already knows about, keyed by lowercased Base Mainnet
 * contract address. Used ONLY when a payment requirement's own `extra`
 * field (the spec-defined place for a resource server to supply this)
 * is absent — extra always wins when present (see
 * resolveEip712Domain). Every entry's address is the same
 * project-verified Base Mainnet USDC address this codebase already
 * treats as canonical Circle-issued USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
 * base.blockscout.com / BaseScan / Circle's own contract-address docs);
 * name/version are USDC's own published EIP-3009/EIP-2612 domain
 * values on Base. No other asset is pre-registered — an unrecognized
 * asset with no `extra` domain is rejected (UNSUPPORTED_ASSET) rather
 * than guessed at.
 */
export const KNOWN_X402_ASSET_DOMAINS: Record<string, Eip712AssetDomain> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USDC", version: "2" },
};

/** Base Mainnet USDC's own decimals — used only for human-readable proposal formatting, never for calldata/authorization values (those stay in the requirement's own atomic-unit string). */
export const KNOWN_X402_ASSET_DECIMALS: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
};

export interface Eip712DomainResolution {
  domain: Eip712AssetDomain;
  /** Where the domain came from — surfaced in the proposal so a reviewer can see whether it was resource-supplied or app-configured. */
  source: "requirement.extra" | "known-asset-registry";
}

/**
 * Resolves the EIP-712 domain (name/version) to sign a given asset's
 * TransferWithAuthorization against. Prefers the requirement's own
 * `extra.name`/`extra.version` (the protocol's own mechanism for a
 * resource server to declare this) and falls back to
 * KNOWN_X402_ASSET_DOMAINS only when neither is present. Returns null —
 * never a guess — if neither source has it.
 */
export function resolveEip712Domain(
  assetAddress: string,
  extra: Record<string, unknown> | undefined
): Eip712DomainResolution | null {
  const extraName = extra?.name;
  const extraVersion = extra?.version;
  if (typeof extraName === "string" && extraName.length > 0 && typeof extraVersion === "string" && extraVersion.length > 0) {
    return { domain: { name: extraName, version: extraVersion }, source: "requirement.extra" };
  }

  const known = KNOWN_X402_ASSET_DOMAINS[assetAddress.toLowerCase()];
  if (known) {
    return { domain: known, source: "known-asset-registry" };
  }

  return null;
}

/** Only used for human-readable formatting in a proposal — see the header comment on KNOWN_X402_ASSET_DECIMALS. Returns null (never a guess) for an asset this app doesn't already know the decimals of. */
export function resolveKnownAssetDecimals(assetAddress: string): number | null {
  return KNOWN_X402_ASSET_DECIMALS[assetAddress.toLowerCase()] ?? null;
}

// Re-exported for callers that want the raw chain id alongside the CAIP-2 form.
export const X402_CHAIN_ID = base.id;
