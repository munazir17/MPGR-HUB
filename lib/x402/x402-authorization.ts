// lib/x402/x402-authorization.ts
//
// P3 — builds the EIP-712 typed data for an EIP-3009
// `transferWithAuthorization` call, from an already-built
// X402PaymentProposal alone. Pure and synchronous — no signing, no
// wallet call, no network request. Mirrors agent-action-simulation.ts's
// resolveExpectedCall(): it independently (re-)derives exactly what
// will be signed from typed, already-validated fields — `payTo`,
// `asset`, `maxAmountRequired`, `eip712Domain` — never from anything an
// LLM or resource server description supplied outside those fields.
//
// Only the "exact" EVM scheme is implemented (see x402-config.ts) — the
// x402 spec's EIP-3009 authorization shape is fixed by the ERC-3009
// standard itself (from/to/value/validAfter/validBefore/nonce), not
// invented here.

import type { Address, Hex } from "viem";

import type { X402PaymentProposal } from "./x402-proposal";

/** From the ERC-3009 standard's own `transferWithAuthorization` EIP-712 type — not app-specific. */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface X402AuthorizationMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface X402TypedDataForSigning {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: X402AuthorizationMessage;
}

/**
 * A fresh, cryptographically random 32-byte nonce — required per
 * EIP-3009 to prevent authorization replay.
 *
 * Generated once per signing attempt; never reused across a retry
 * (see x402-execution.ts's idempotency note).
 */
export function generateAuthorizationNonce(): Hex {
  const bytes = new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
}

export interface BuildAuthorizationOptions {
  payerAddress: Address;
  chainId: number;

  /** Defaults to "now" (0 leeway) — the authorization is valid immediately. */
  validAfter?: bigint;

  /**
   * How long the authorization stays valid for, in seconds.
   * Defaults to the requirement's own maxTimeoutSeconds,
   * falling back to 300s (5 minutes) if the requirement didn't specify one.
   */
  validForSeconds?: number;

  nonce?: Hex;
}

/**
 * Builds the exact EIP-712 typed data the connected wallet will be
 * asked to sign — a pure function of the proposal plus the payer's own
 * address.
 *
 * Every field of the resulting `message` traces back to
 * `proposal.requirement` (payTo, maxAmountRequired) or
 * `proposal.eip712Domain` — nothing here is taken from
 * `proposal.description` or any other freeform text.
 */
export function buildAuthorizationTypedData(
  proposal: X402PaymentProposal,
  options: BuildAuthorizationOptions,
): X402TypedDataForSigning {
  // A proposal reaching this function is expected to have already been
  // validated by the P3 parse/proposal pipeline. The signing domain is
  // therefore mandatory at this point. Fail closed rather than allowing
  // an undefined EIP-712 domain to reach a wallet.
  const eip712Domain = proposal.eip712Domain;

  if (!eip712Domain) {
    throw new Error(
      "Cannot build x402 authorization: the payment proposal has no EIP-712 domain.",
    );
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  const validAfter = options.validAfter ?? 0n;

  const validForSeconds =
    options.validForSeconds ??
    proposal.requirement.maxTimeoutSeconds ??
    300;

  const validBefore =
    nowSeconds + BigInt(Math.max(1, Math.floor(validForSeconds)));

  const nonce = options.nonce ?? generateAuthorizationNonce();

  return {
    domain: {
      name: eip712Domain.domain.name,
      version: eip712Domain.domain.version,
      chainId: options.chainId,
      verifyingContract: proposal.requirement.asset as Address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: options.payerAddress,
      to: proposal.requirement.payTo as Address,
      value: BigInt(proposal.requirement.maxAmountRequired),
      validAfter,
      validBefore,
      nonce,
    },
  };
}
