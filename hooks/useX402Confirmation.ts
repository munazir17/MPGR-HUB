"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";

import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import {
  idleX402ConfirmationSnapshot,
  runX402Confirmation,
  type X402ConfirmationState,
} from "@/lib/x402/x402-confirmation";
import type { X402Error } from "@/lib/x402/x402-types";

// P3 — thin React wrapper around the pure state machine in
// lib/x402/x402-confirmation.ts, mirroring useAgentActionConfirmation.ts
// exactly: holds no validation logic of its own, supplies the connected
// wallet's own account (never fabricated), and guards against a stale
// in-flight run clobbering a newer one. Never imports anything
// signing/submission-related — see useX402Execution.ts for that.

export interface UseX402ConfirmationResult {
  state: X402ConfirmationState;
  error: X402Error | null;
  /** True only when state === "READY_FOR_CONFIRMATION" — the one boundary a "Confirm & Pay" button should gate on. */
  canConfirm: boolean;
  run: (proposal: X402PaymentProposal) => void;
  reset: () => void;
}

export function useX402Confirmation(): UseX402ConfirmationResult {
  const { address } = useAccount();

  const [snapshot, setSnapshot] = useState(idleX402ConfirmationSnapshot());
  const runIdRef = useRef(0);

  const run = useCallback(
    (proposal: X402PaymentProposal) => {
      const runId = (runIdRef.current += 1);

      void runX402Confirmation(proposal, address, (next) => {
        if (runIdRef.current === runId) {
          setSnapshot(next);
        }
      });
    },
    [address]
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setSnapshot(idleX402ConfirmationSnapshot());
  }, []);

  return {
    state: snapshot.state,
    error: snapshot.error,
    canConfirm: snapshot.state === "READY_FOR_CONFIRMATION",
    run,
    reset,
  };
}
