"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import type { Address } from "viem";

import type { AgentActionContract } from "@/lib/architecture/tools/agent-action-contract";
import type { AgentActionConfirmationState } from "@/lib/architecture/tools/agent-action-confirmation";
import {
  executeAgentAction,
  idleExecutionSnapshot,
  type AgentActionExecutionError,
  type AgentActionExecutionState,
} from "@/lib/architecture/tools/agent-action-execution";

// P1 — thin React wrapper around the pure state machine in
// lib/architecture/tools/agent-action-execution.ts. This hook holds no
// transaction-building logic of its own — it only:
//   - supplies the connected wallet's own live account/chain (never
//     fabricated, never cached across renders)
//   - mirrors each state-machine transition into React state
//   - guards against a stale/duplicate in-flight run clobbering, or
//     racing, the current one
//
// It never calls execute() itself. The only call site is whatever the
// caller wires to a human "Confirm" click (see AgentActionConfirmationModal's
// onConfirm) — nothing here runs from a mount, an effect, or a promise
// continuation.

export interface UseAgentActionExecutionResult {
  state: AgentActionExecutionState;
  hash: `0x${string}` | null;
  error: AgentActionExecutionError | null;
  /**
   * Attempts to execute `action`, given the confirmation state/account/chain
   * P0.5 reached for it. Call this ONLY from an explicit user "Confirm"
   * click — this function does not itself impose that restriction, so the
   * caller (a click handler, never a mount/effect) is the enforcement
   * point.
   *
   * A call while a previous execution is still in flight (AWAITING_WALLET
   * or PENDING) is ignored and never submits a second transaction.
   */
  execute: (
    action: AgentActionContract,
    confirmation: {
      state: AgentActionConfirmationState;
      account: Address;
      chainId: number;
    }
  ) => void;
  /** Returns to IDLE and invalidates any in-flight run. */
  reset: () => void;
}

export function useAgentActionExecution(): UseAgentActionExecutionResult {
  const { address } = useAccount();
  const chainId = useChainId();

  const [snapshot, setSnapshot] = useState(idleExecutionSnapshot());

  // Incremented on every execute()/reset() call. A transition callback
  // from an older run only applies if it's still the current run — this
  // is what keeps two Confirm clicks from ever producing two submitted
  // transactions or a flickering/conflicting final state.
  const runIdRef = useRef(0);
  const isActiveRef = useRef(false);

  const execute = useCallback(
    (
      action: AgentActionContract,
      confirmation: {
        state: AgentActionConfirmationState;
        account: Address;
        chainId: number;
      }
    ) => {
      // Duplicate-execution protection: a second Confirm click while an
      // earlier run is still awaiting a signature or a receipt is a
      // no-op, not a second sendTransaction call.
      if (isActiveRef.current) {
        return;
      }

      const runId = (runIdRef.current += 1);
      isActiveRef.current = true;

      void executeAgentAction(
        {
          action,
          confirmationState: confirmation.state,
          confirmedAccount: confirmation.account,
          confirmedChainId: confirmation.chainId,
          currentAccount: address,
          currentChainId: chainId,
        },
        (next) => {
          if (runIdRef.current !== runId) return;
          setSnapshot(next);
          if (next.state === "SUCCESS" || next.state === "ERROR") {
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
    setSnapshot(idleExecutionSnapshot());
  }, []);

  return {
    state: snapshot.state,
    hash: snapshot.hash,
    error: snapshot.error,
    execute,
    reset,
  };
}
