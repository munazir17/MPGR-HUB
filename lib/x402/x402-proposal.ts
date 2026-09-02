// lib/x402/x402-proposal.ts
//
// P3 — builds a structured X402PaymentProposal from an already-validated
// ParsedX402Requirement.
//
// This layer never signs, never fetches, and never touches a wallet.
// The parser guarantees that a usable EIP-712 domain exists before a
// requirement reaches this function. We preserve that invariant here by
// making the proposal's eip712Domain explicitly non-null.
//
// The proposal is deterministic with respect to the payment requirement.
// createdAt is intentionally informational only and is not used for the
// deterministic proposal id.

import type { ParsedX402Requirement } from "./x402-parse";
import { resolveKnownAssetDecimals } from "./x402-config";
import type {
  X402Error,
  X402PaymentRequirements,
} from "./x402-types";

export const X402_PROPOSAL_PHASES = [
  "idle",
  "validating",
  "awaiting_signature",
  "submitting",
  "settled",
  "error",
] as const;

export type X402ProposalPhase =
  (typeof X402_PROPOSAL_PHASES)[number];

/**
 * x402-parse.ts filters out requirements for which an EIP-712 domain
 * cannot be resolved. Therefore a proposal must always contain a
 * concrete domain.
 */
export type X402Eip712Domain =
  NonNullable<ParsedX402Requirement["eip712Domain"]>;

export interface X402PaymentProposal {
  /** Deterministic — see buildDeterministicId(). */
  id: string;

  /** The exact validated payment requirement. */
  requirement: X402PaymentRequirements;

  /**
   * Non-null because x402-parse.ts rejects requirements without a
   * resolvable EIP-712 domain.
   */
  eip712Domain: X402Eip712Domain;

  /**
   * Human-readable amount, e.g. "1.5 USDC".
   * Display only. Actual authorization values always use the
   * requirement's atomic-unit maxAmountRequired.
   */
  displayAmount: string | null;

  /** Plain-English summary safe to render directly. */
  description: string;

  /**
   * Plain-English list of what happens after confirmation.
   * This is informational UI text only.
   */
  postConfirmationSteps: readonly string[];

  /** Warnings shown to the user before payment. */
  warnings: readonly string[];

  /** x402 payments always require explicit human confirmation. */
  requiresConfirmation: true;

  /** Initial proposal phase is always idle. */
  phase: X402ProposalPhase;

  /** Creation timestamp for UI/audit purposes only. */
  createdAt: string;
}

export type X402ProposalResult =
  | {
      ok: true;
      proposal: X402PaymentProposal;
    }
  | {
      ok: false;
      error: X402Error;
    };

/**
 * Converts an atomic-unit amount into a human-readable amount when the
 * asset's decimals are known locally.
 *
 * This function never changes the amount used for signing.
 */
function formatDisplayAmount(
  requirement: X402PaymentRequirements,
): string | null {
  const decimals = resolveKnownAssetDecimals(requirement.asset);

  if (decimals === null) {
    return null;
  }

  const raw = BigInt(requirement.maxAmountRequired);
  const denom = 10n ** BigInt(decimals);

  const whole = raw / denom;
  const frac = raw % denom;

  const fracStr =
    frac === 0n
      ? ""
      : `.${frac
          .toString()
          .padStart(decimals, "0")
          .replace(/0+$/, "")}`;

  const symbol =
    requirement.asset.toLowerCase() ===
    "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913".toLowerCase()
      ? "USDC"
      : "token";

  return `\( {whole} \){fracStr} ${symbol}`;
}

/**
 * Builds a proposal for exactly one already-validated requirement.
 *
 * The caller chooses which accepted payment option to use.
 * This function never selects between multiple requirements.
 */
export function buildX402PaymentProposal(
  resourceUrl: string,
  parsed: ParsedX402Requirement,
): X402ProposalResult {
  const { requirement } = parsed;

  /*
   * x402-parse.ts intentionally types the resolved domain as nullable
   * because resolution can fail for arbitrary untrusted resources.
   *
   * A ParsedX402Requirement returned by parseX402PaymentRequired() has
   * already passed the `!eip712Domain` rejection gate.
   *
   * We still guard here because this function is exported and may be
   * called independently with a manually constructed ParsedX402Requirement.
   */
  const eip712Domain = parsed.eip712Domain;

  if (!eip712Domain) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message:
          "This payment requirement does not have a usable EIP-712 signing domain.",
      },
    };
  }

  /*
   * Never allow a proposal to describe a different resource from the
   * URL that will actually be paid.
   */
  if (requirement.resource !== resourceUrl) {
    return {
      ok: false,
      error: {
        code: "REQUIREMENT_CHANGED",
        message:
          "This payment requirement's resource does not match the URL being requested.",
      },
    };
  }

  const displayAmount = formatDisplayAmount(requirement);

  const warnings: string[] = [
    "This is a real payment. Funds will leave your connected wallet once you sign and this is submitted.",
  ];

  if (
    requirement.maxTimeoutSeconds !== undefined &&
    requirement.maxTimeoutSeconds > 0
  ) {
    warnings.push(
      `The signed authorization must be submitted within ${requirement.maxTimeoutSeconds} seconds or it will expire.`,
    );
  }

  if (eip712Domain.source === "known-asset-registry") {
    warnings.push(
      "The paid asset's signing domain came from this app's own configuration, not the resource server.",
    );
  }

  const amountText =
    displayAmount ?? requirement.maxAmountRequired;

  const description = requirement.description
    ? `Pay ${amountText} — ${requirement.description} to access ${requirement.resource}`
    : `Pay ${amountText} to access ${requirement.resource}`;

  const proposal: X402PaymentProposal = {
    id: buildDeterministicId(requirement),
    requirement,
    eip712Domain,
    displayAmount,
    description,
    postConfirmationSteps: [
      "Your wallet will ask you to sign a payment authorization (no gas fee, no on-chain transaction from you directly).",
      "The signed authorization is submitted to the resource with your request.",
      "This app verifies the resource's settlement response before showing you the result.",
    ],
    warnings,
    requiresConfirmation: true,
    phase: "idle",
    createdAt: new Date().toISOString(),
  };

  return {
    ok: true,
    proposal,
  };
}

/**
 * Builds a stable FNV-1a-style identifier from trust-relevant payment
 * fields only.
 *
 * Description, timestamps, and other freeform fields are intentionally
 * excluded so an LLM/resource-server text change cannot silently create
 * a different payment identity.
 *
 * This is an identifier, never a capability or secret. The server
 * reconstructs it independently during registration.
 */
export function buildDeterministicProposalId(
  requirement: Pick<
    X402PaymentRequirements,
    "resource" | "asset" | "payTo" | "maxAmountRequired"
  >,
): string {
  const raw =
    `x402:${requirement.resource}:` +
    `${requirement.asset.toLowerCase()}:` +
    `${requirement.payTo.toLowerCase()}:` +
    `${requirement.maxAmountRequired}`;

  let hash = 0x811c9dc5;

  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `x402_${(hash >>> 0).toString(16)}`;
}

function buildDeterministicId(
  requirement: X402PaymentRequirements,
): string {
  return buildDeterministicProposalId(requirement);
}
