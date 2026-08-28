// lib/x402/x402-proposal.ts
//
// P3 — builds a structured X402PaymentProposal from an already-validated
// ParsedX402Requirement (see x402-parse.ts). This is the P0.3-equivalent
// layer for x402: it takes trusted, typed input and produces a
// deterministic, UI-ready proposal — it does NOT sign anything, does
// NOT call fetch, and does NOT touch a wallet. `requiresConfirmation` is
// always true and `phase` always starts at "idle", exactly like
// AgentActionContract's own invariants in agent-action-contract.ts.
//
// Unlike AgentActionContract, there is no `to`/`data`/`value` calldata
// here — x402's "exact" EVM scheme is a signed EIP-3009 authorization
// (an off-chain EIP-712 signature), not a transaction this app sends
// itself. See x402-authorization.ts for where that signature payload is
// actually constructed, and x402-execution.ts for the only module
// allowed to request a wallet signature for it.

import type { ParsedX402Requirement } from "./x402-parse";
import { resolveKnownAssetDecimals } from "./x402-config";
import type { X402Error, X402PaymentRequirements } from "./x402-types";

export const X402_PROPOSAL_PHASES = ["idle", "validating", "awaiting_signature", "submitting", "settled", "error"] as const;
export type X402ProposalPhase = (typeof X402_PROPOSAL_PHASES)[number];

export interface X402PaymentProposal {
  /** Deterministic — see buildDeterministicId(). */
  id: string;
  requirement: X402PaymentRequirements;
  eip712Domain: ParsedX402Requirement["eip712Domain"];
  /** Human-readable amount, e.g. "1.50 USDC" — for display only; every actual signed/compared value uses `requirement.maxAmountRequired` (atomic units) instead. Null if this app doesn't know the asset's decimals and the requirement didn't supply them. */
  displayAmount: string | null;
  /** Plain-English summary of what's being paid for — safe to render directly. */
  description: string;
  /** Plain-English list of what happens after the user confirms — surfaced directly in the confirmation UI per the P3 spec's "Proposal UX" requirements. */
  postConfirmationSteps: readonly string[];
  warnings: readonly string[];
  requiresConfirmation: true;
  phase: X402ProposalPhase;
  createdAt: string;
}

export type X402ProposalResult = { ok: true; proposal: X402PaymentProposal } | { ok: false; error: X402Error };

function formatDisplayAmount(requirement: X402PaymentRequirements): string | null {
  const decimals = resolveKnownAssetDecimals(requirement.asset);
  if (decimals === null) return null;

  const raw = BigInt(requirement.maxAmountRequired);
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  const fracStr = frac === 0n ? "" : `.\( {frac.toString().padStart(decimals, "0").replace(/0+ \)/, "")}`;
  // "USDC" label kept generic ("token") for any future known asset —
  // only USDC is registered today (see x402-config.ts).
  const symbol = requirement.asset.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? "USDC" : "token";
  return `\( {whole} \){fracStr} ${symbol}`;
}

/**
 * Builds a proposal for exactly one already-validated requirement — the
 * caller (a tool, a UI) picks WHICH of a resource's `accepts[]` options
 * to propose; this function never chooses among several itself.
 */
export function buildX402PaymentProposal(resourceUrl: string, parsed: ParsedX402Requirement): X402ProposalResult {
  const { requirement, eip712Domain } = parsed;

  if (requirement.resource !== resourceUrl) {
    // The requirement must describe the same resource the caller is
    // actually trying to pay for — never propose payment for a
    // different URL than the one the requirement names.
    return {
      ok: false,
      error: {
        code: "REQUIREMENT_CHANGED",
        message: "This payment requirement's resource does not match the URL being requested.",
      },
    };
  }

  const displayAmount = formatDisplayAmount(requirement);
  const warnings: string[] = [
    "This is a real payment. Funds will leave your connected wallet once you sign and this is submitted.",
  ];
  if (requirement.maxTimeoutSeconds) {
    warnings.push(`The signed authorization must be submitted within ${requirement.maxTimeoutSeconds} seconds or it will expire.`);
  }
  if (eip712Domain.source === "known-asset-registry") {
    warnings.push("The paid asset's signing domain came from this app's own configuration, not the resource server.");
  }

  const proposal: X402PaymentProposal = {
    id: buildDeterministicId(requirement),
    requirement,
    eip712Domain,
    displayAmount,
    description: requirement.description
      ? `Pay \( {displayAmount ?? requirement.maxAmountRequired} \){requirement.description ? ` — ${requirement.description}` : ""} to access ${requirement.resource}`
      : `Pay ${displayAmount ?? requirement.maxAmountRequired} to access ${requirement.resource}`,
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

  return { ok: true, proposal };
}

function buildDeterministicId(requirement: X402PaymentRequirements): string {
  const raw = `x402:\( {requirement.resource}: \){requirement.asset.toLowerCase()}:\( {requirement.payTo.toLowerCase()}: \){requirement.maxAmountRequired}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `x402_${(hash >>> 0).toString(16)}`;
}
