"use client";

import { useCallback, useState } from "react";

import { useX402Confirmation } from "./useX402Confirmation";
import { useX402Execution } from "./useX402Execution";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";

// P3 — Adapter between an X402PaymentProposal carried by an
// AgentMessage and AgentX402PaymentModal.
//
// Responsibilities are intentionally narrow:
//
// 1. Track which proposal is currently open.
// 2. Revalidate the proposal when the user explicitly opens it.
// 3. Expose confirmAndPay() as the only UI-level path that invokes
//    the execution hook.
//
// This hook does NOT construct payment fields, sign typed data, submit
// HTTP requests, or perform settlement verification itself. Those
// responsibilities remain in the existing x402 modules/hooks.
//
// IMPORTANT:
// - Opening a proposal performs validation only.
// - No signing happens during openProposal().
// - No payment is automatically executed from an effect/mount.
// - confirmAndPay() must only be wired to an explicit user confirmation
//   action such as the "Confirm & Pay" button.
// - The execution layer remains responsible for its own final safety
//   gates before requesting a wallet signature.

export interface UseX402PaymentResult {
  /** The proposal currently shown in the modal, or null when closed. */
  proposal: X402PaymentProposal | null;

  /** True when a proposal is currently open in the modal. */
  open: boolean;

  confirmationState: ReturnType<typeof useX402Confirmation>["state"];
  confirmationError: ReturnType<typeof useX402Confirmation>["error"];

  executionState: ReturnType<typeof useX402Execution>["state"];
  executionError: ReturnType<typeof useX402Execution>["error"];

  settlement: ReturnType<typeof useX402Execution>["settlement"];

  /**
   * Opens a proposal for review and performs validation only.
   *
   * This function MUST be called from an explicit user interaction
   * such as clicking "Review payment". It never signs or submits.
   */
  openProposal: (proposal: X402PaymentProposal) => void;

  /**
   * Explicit payment confirmation entry point.
   *
   * This is the only function exposed by this adapter that can reach
   * the x402 execution/signing layer. It must be wired only to an
   * explicit "Confirm & Pay" user action.
   */
  confirmAndPay: () => void;

  /** Closes the modal and resets its validation/execution display state. */
  close: () => void;
}

export function useX402Payment(): UseX402PaymentResult {
  const [proposal, setProposal] =
    useState<X402PaymentProposal | null>(null);

  const {
    state: confirmationState,
    error: confirmationError,
    run: runConfirmation,
    reset: resetConfirmation,
  } = useX402Confirmation();

  const {
    state: executionState,
    error: executionError,
    settlement,
    execute,
    reset: resetExecution,
  } = useX402Execution();

  const openProposal = useCallback(
    (nextProposal: X402PaymentProposal) => {
      // Reset any previous execution UI state before displaying the
      // newly selected proposal. This does NOT cancel an execution
      // already in flight; the execution hook owns that lifecycle.
      resetExecution();

      setProposal(nextProposal);

      // Validation only. This does not sign, submit, or touch the
      // wallet. The confirmation hook performs the proposal's
      // revalidation and wallet/readiness checks.
      runConfirmation(nextProposal);
    },
    [resetExecution, runConfirmation],
  );

  const confirmAndPay = useCallback(() => {
    if (!proposal) {
      return;
    }

    // Defense-in-depth gate at the adapter/UI boundary.
    //
    // The execution layer MUST still perform its own independent
    // validation/gating before calling signTypedData. This check
    // prevents the modal from accidentally invoking execute() while
    // the confirmation hook has not reached its ready state.
    if (confirmationState !== "READY_FOR_CONFIRMATION") {
      return;
    }

    execute(proposal, confirmationState);
  }, [proposal, confirmationState, execute]);

  const close = useCallback(() => {
    setProposal(null);
    resetConfirmation();
    resetExecution();
  }, [resetConfirmation, resetExecution]);

  return {
    proposal,
    open: proposal !== null,

    confirmationState,
    confirmationError,

    executionState,
    executionError,
    settlement,

    openProposal,
    confirmAndPay,
    close,
  };
}
