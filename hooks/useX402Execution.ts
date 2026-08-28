"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";

import type { X402ConfirmationState } from "@/lib/x402/x402-confirmation";
import {
  executeX402Payment,
  idleX402ExecutionSnapshot,
  type X402ExecutionState,
} from "@/lib/x402/x402-execution";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { X402Error, X402SettlementResponse } from "@/lib/x402/x402-types";

// P3 — thin React wrapper around the pure state machine in
// lib/x402/x402-execution.ts, mirroring useAgentActionExecution.ts
// exactly: holds no signing/submission logic of its own, supplies the
// connected wallet's own live account/chain (never fabricated), and
// guards against a stale/duplicate in-flight run.
//
// It never calls executeX402Payment() itself — the only legitimate call
// site is an explicit "Confirm & Pay" click handler, never a mount, an
// effect, or a promise continuation.

export interface UseX402ExecutionResult {
  state: X402ExecutionState;
  settlement: X402SettlementResponse | null;
  error: X402Error | null;
  /**
   * Attempts to pay for `proposal`, given the confirmation state
   * useX402Confirmation reached for it. Call this ONLY from an explicit
   * user "Confirm & Pay" click.
   *
   * A call while a previous execution is still in flight is ignored and
   * never signs/submits a second payment.
   */
  execute: (proposal: X402PaymentProposal, confirmationState: X402ConfirmationState) => void;
  reset: () => void;
}

export function useX402Execution(): UseX402ExecutionResult {
  const { address } = useAccount();
  const chainId = useChainId();

  const [snapshot, setSnapshot] = useState(idleX402ExecutionSnapshot());
  const runIdRef = useRef(0);
  const isActiveRef = useRef(false);

  const execute = useCallback(
    (proposal: X402PaymentProposal, confirmationState: X402ConfirmationState) => {
      if (isActiveRef.current) {
        return;
      }

      const runId = (runIdRef.current += 1);
      isActiveRef.current = true;

      void executeX402Payment(
        {
          proposal,
          confirmationState,
          currentAccount: address,
          currentChainId: chainId,
        },
        (next) => {
          if (runIdRef.current !== runId) return;
          setSnapshot(next);
          if (next.state === "SETTLED" || next.state === "ERROR") {
            isActiveRef.current = false;
          }
        }
      );
    },
    [address, chainId]
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    isActiveRef.current = false;
    setSnapshot(idleX402ExecutionSnapshot());
  }, []);

  return {
    state: snapshot.state,
    settlement: snapshot.settlement,
    error: snapshot.error,
    execute,
    reset,
  };
}
