"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";

import type { AgentActionContract } from "@/lib/architecture/tools/agent-action-contract";
import {
  idleConfirmationSnapshot,
  runAgentActionConfirmation,
  type AgentActionConfirmationError,
  type AgentActionConfirmationState,
} from "@/lib/architecture/tools/agent-action-confirmation";
import type { DecodedAgentAction } from "@/lib/architecture/tools/agent-action-simulation";

// P0.5 — thin React wrapper around the pure state machine in
// lib/architecture/tools/agent-action-confirmation.ts. This hook holds
// no verification/simulation logic of its own — it only:
//   - supplies the connected wallet's own account (never fabricated)
//   - mirrors each state-machine transition into React state
//   - guards against a stale in-flight run clobbering a newer one
//
// It never imports anything execution/broadcast-related; the run()
// this hook exposes ends at READY_FOR_CONFIRMATION, same as the state
// machine it wraps.

export interface UseAgentActionConfirmationResult {
  state: AgentActionConfirmationState;
  decoded: DecodedAgentAction | null;
  error: AgentActionConfirmationError | null;
  /** True only when state === "READY_FOR_CONFIRMATION". The one boundary this hook exposes for a "Confirm" button to gate on. */
  canConfirm: boolean;
  /** Starts (or restarts) verification+simulation for the given action. */
  run: (action: AgentActionContract) => void;
  /** Returns to IDLE and invalidates any in-flight run. */
  reset: () => void;
}

export function useAgentActionConfirmation(): UseAgentActionConfirmationResult {
  const { address } = useAccount();

  const [snapshot, setSnapshot] = useState(idleConfirmationSnapshot());

  // Incremented on every run()/reset() call. A transition callback from
  // an older run only applies if it's still the current run — this is
  // what keeps a duplicate/second run() from producing a flickering or
  // conflicting final state from the first, now-stale run.
  const runIdRef = useRef(0);

  const run = useCallback(
    (action: AgentActionContract) => {
      const runId = (runIdRef.current += 1);

      void runAgentActionConfirmation(action, address, (next) => {
        if (runIdRef.current === runId) {
          setSnapshot(next);
        }
      });
    },
    [address]
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setSnapshot(idleConfirmationSnapshot());
  }, []);

  return {
    state: snapshot.state,
    decoded: snapshot.decoded,
    error: snapshot.error,
    canConfirm: snapshot.state === "READY_FOR_CONFIRMATION",
    run,
    reset,
  };
}

