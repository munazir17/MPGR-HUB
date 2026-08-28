// lib/x402/x402-confirmation.ts
//
// P3 — confirmation boundary state machine for an x402 payment
// proposal. Mirrors agent-action-confirmation.ts exactly in spirit:
//
//   IDLE -> WALLET_REQUIRED
//   IDLE -> VALIDATING -> VALIDATED -> READY_FOR_CONFIRMATION
//                       \-> VALIDATION_FAILED
//
// — and stops at READY_FOR_CONFIRMATION. This module never calls
// signTypedData, never touches a wallet, and never submits an HTTP
// request. The human-confirmation boundary (the "Confirm & Pay" button)
// lives one layer up, in the React hook/component — see
// hooks/useX402Payment.ts.
//
// "Validation" here re-checks the proposal's own requirement against
// the same acceptance rules x402-parse.ts already enforced (supported
// scheme/network/asset, positive amount, a real payTo address) — this
// is the x402-equivalent of verifyAgentAction()'s "never trust,
// independently re-derive" posture, applied to a proposal object that
// may have been held in UI state for a while before the user clicks
// Confirm.

import { isAddress, type Address } from "viem";

import { X402_SUPPORTED_NETWORK, X402_SUPPORTED_SCHEMES } from "./x402-config";
import type { X402PaymentProposal } from "./x402-proposal";
import type { X402Error, X402ErrorCode } from "./x402-types";

export const X402_CONFIRMATION_STATES = [
  "IDLE",
  "WALLET_REQUIRED",
  "VALIDATING",
  "VALIDATED",
  "READY_FOR_CONFIRMATION",
  "VALIDATION_FAILED",
] as const;
export type X402ConfirmationState = (typeof X402_CONFIRMATION_STATES)[number];

export interface X402ConfirmationSnapshot {
  state: X402ConfirmationState;
  error: X402Error | null;
}

export function idleX402ConfirmationSnapshot(): X402ConfirmationSnapshot {
  return { state: "IDLE", error: null };
}

function fail(code: X402ErrorCode, message: string): X402ConfirmationSnapshot {
  return { state: "VALIDATION_FAILED", error: { code, message } };
}

/** Re-validates a proposal's requirement in isolation — pure, synchronous, no network. Exported separately so a test can exercise it without the async driver below. */
export function revalidateX402Proposal(proposal: X402PaymentProposal): X402ConfirmationSnapshot {
  const { requirement } = proposal;

  if (!(X402_SUPPORTED_SCHEMES as readonly string[]).includes(requirement.scheme)) {
    return fail("UNSUPPORTED_SCHEME", `Scheme "${requirement.scheme}" is not supported.`);
  }
  if (requirement.network !== X402_SUPPORTED_NETWORK) {
    return fail("UNSUPPORTED_NETWORK", `Network "${requirement.network}" is not supported; only ${X402_SUPPORTED_NETWORK} is.`);
  }
  if (!isAddress(requirement.payTo)) {
    return fail("INVALID_PAY_TO", "This proposal's recipient address is no longer valid.");
  }
  if (!isAddress(requirement.asset)) {
    return fail("UNSUPPORTED_ASSET", "This proposal's asset address is no longer valid.");
  }
  try {
    if (BigInt(requirement.maxAmountRequired) <= 0n) {
      return fail("INVALID_AMOUNT", "This proposal's amount is no longer valid.");
    }
  } catch {
    return fail("INVALID_AMOUNT", "This proposal's amount is no longer valid.");
  }

  return { state: "VALIDATED", error: null };
}

/**
 * Drives a proposal through the confirmation state machine, calling
 * onTransition once per state change (mirroring
 * runAgentActionConfirmation's own onTransition contract). Resolves
 * with the same final snapshot it last passed to onTransition.
 */
export async function runX402Confirmation(
  proposal: X402PaymentProposal,
  account: Address | null | undefined,
  onTransition: (snapshot: X402ConfirmationSnapshot) => void
): Promise<X402ConfirmationSnapshot> {
  if (!account || !isAddress(account)) {
    const snapshot: X402ConfirmationSnapshot = {
      state: "WALLET_REQUIRED",
      error: { code: "WALLET_REQUIRED", message: "Connect your wallet to pay for this resource." },
    };
    onTransition(snapshot);
    return snapshot;
  }

  onTransition({ state: "VALIDATING", error: null });

  const validated = revalidateX402Proposal(proposal);
  onTransition(validated);
  if (validated.state !== "VALIDATED") {
    return validated;
  }

  const readySnapshot: X402ConfirmationSnapshot = { state: "READY_FOR_CONFIRMATION", error: null };
  onTransition(readySnapshot);
  return readySnapshot;
}
