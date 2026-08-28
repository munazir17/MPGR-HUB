// lib/x402/x402-types.ts
//
// P3 — x402 Agentic Commerce.
//
// Wire-format types for the x402 payment protocol (HTTP 402), scoped to
// exactly what this app supports: the "exact" scheme on the "eip155"
// (EVM) namespace, targeting Base Mainnet only (see x402-config.ts).
//
// These field names/shapes are copied directly from the published x402
// specification (coinbase/x402 — specs/x402-specification-v2.md,
// specs/schemes/exact/scheme_exact_evm.md), not invented. Nothing here
// is executable — this file is pure data shape, exactly like
// agent-action-contract.ts's own type-only sections.

// --- Payment Requirements (from a 402 response body) ------------------

/**
 * One entry of a 402 response's `accepts` array. `network` is a CAIP-2
 * chain identifier (e.g. "eip155:8453" for Base Mainnet) per the x402
 * v2 wire format. `asset` is the ERC-20 token contract address the
 * payment must be denominated in. `extra` carries scheme-specific data
 * — for the EVM "exact" scheme this is where a resource server may
 * supply the asset's own EIP-712 domain (name/version), which this app
 * always prefers over any locally-configured default (see
 * x402-config.ts's resolveEip712Domain()).
 */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  extra?: Record<string, unknown>;
}

/** The full JSON body of a 402 Payment Required response. */
export interface X402PaymentRequiredBody {
  x402Version: number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

// --- Exact/EVM payment payload (what the client sends back) -----------

/** EIP-3009 `transferWithAuthorization` parameters, wire-encoded as decimal/hex strings (never bigint — this crosses an HTTP/JSON boundary). */
export interface X402ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402ExactEvmPayload {
  signature: string;
  authorization: X402ExactEvmAuthorization;
}

/** The full X-PAYMENT header payload (base64-JSON-encoded on the wire). */
export interface X402PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: X402ExactEvmPayload;
}

// --- Settlement / X-PAYMENT-RESPONSE -----------------------------------

/** Decoded X-PAYMENT-RESPONSE header — the facilitator/resource server's report of what happened on-chain. */
export interface X402SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

// --- Shared error code vocabulary --------------------------------------
//
// One closed set spans parsing -> proposal -> confirmation -> execution
// -> verification, mirroring agent-action-contract.ts /
// agent-action-simulation.ts's own per-layer (but shared-vocabulary)
// error codes. A caller (a tool, a hook) narrows to the subset its own
// layer can actually produce.
export const X402_ERROR_CODES = [
  // Discovery / parsing
  "NOT_PAYMENT_REQUIRED",
  "MALFORMED_RESPONSE",
  "NO_ACCEPTABLE_REQUIREMENT",
  "UNSUPPORTED_SCHEME",
  "UNSUPPORTED_NETWORK",
  "UNSUPPORTED_ASSET",
  "INVALID_AMOUNT",
  "INVALID_PAY_TO",
  "RESOURCE_FETCH_FAILED",
  // Proposal / confirmation
  "REQUIREMENT_CHANGED",
  "WALLET_REQUIRED",
  "NOT_READY",
  // Signing / submission / verification
  "WALLET_REJECTED",
  "SIGNING_FAILED",
  "SUBMISSION_FAILED",
  "PAYMENT_REJECTED",
  "PAYMENT_FAILED",
  "VERIFICATION_FAILED",
  "EXECUTION_IN_PROGRESS",
] as const;
export type X402ErrorCode = (typeof X402_ERROR_CODES)[number];

export interface X402Error {
  code: X402ErrorCode;
  /** User-safe — never a raw fetch/provider exception message. Same guarantee as AgentToolError.message. */
  message: string;
}
