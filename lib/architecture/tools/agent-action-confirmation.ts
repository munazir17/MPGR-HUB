// lib/architecture/tools/agent-action-confirmation.ts
//
// P0.5 — Confirmation boundary state machine.
//
// This file sits strictly on top of P0.4 (agent-action-simulation.ts,
// LOCKED). It owns exactly one thing: moving an already-built
// AgentActionContract through an explicit, typed state model —
//
//   IDLE -> WALLET_REQUIRED
//   IDLE -> VERIFYING -> VERIFIED -> SIMULATING -> SIMULATED -> READY_FOR_CONFIRMATION
//                      \-> VERIFICATION_FAILED
//                                       SIMULATING -> SIMULATION_FAILED
//
// — and stops at READY_FOR_CONFIRMATION. It never calls
// writeContract/sendTransaction/signTransaction/walletClient.* itself, and
// it never imports anything that could. The human-confirmation boundary
// (the "Confirm" button) lives one layer up, in the React hook/component;
// this module doesn't even expose a way to skip past it.
//
// CRITICAL: this module does NOT decode calldata, does NOT re-derive
// destination/ABI/function/args, and does NOT duplicate any verification
// logic. It calls verifyAgentAction()/simulateAgentAction() from P0.4 and
// only ever displays/propagates what those functions returned. There is
// no second decoder here.

import { isAddress, type Address } from "viem";

import type { AgentActionContract } from "./agent-action-contract";
import {
  simulateAgentAction,
  verifyAgentAction,
  type AgentActionSimulationErrorCode,
  type AgentActionVerificationErrorCode,
  type DecodedAgentAction,
} from "./agent-action-simulation";

// --- State -------------------------------------------------------------

export const AGENT_ACTION_CONFIRMATION_STATES = [
  "IDLE",
  "WALLET_REQUIRED",
  "VERIFYING",
  "VERIFIED",
  "SIMULATING",
  "SIMULATED",
  "READY_FOR_CONFIRMATION",
  "VERIFICATION_FAILED",
  "SIMULATION_FAILED",
] as const;

export type AgentActionConfirmationState =
  (typeof AGENT_ACTION_CONFIRMATION_STATES)[number];

// A local, additive error code for the one failure mode P0.4 doesn't
// itself describe (P0.4's ACCOUNT_REQUIRED covers "no account was passed
// into simulateAgentAction"; this module's WALLET_REQUIRED covers "we
// never even attempted verification/simulation because no wallet is
// connected at all" — it's caught here, before P0.4 is called, and is
// deliberately never fabricated: see runAgentActionConfirmation below).
export type AgentActionConfirmationErrorCode =
  | "WALLET_REQUIRED"
  | AgentActionVerificationErrorCode
  | AgentActionSimulationErrorCode;

export interface AgentActionConfirmationError {
  code: AgentActionConfirmationErrorCode;
  /** User-safe — same guarantee as P0.4's error messages. Never a raw provider/RPC exception. */
  message: string;
}

export interface AgentActionConfirmationSnapshot {
  state: AgentActionConfirmationState;
  /** Only ever P0.4's own DecodedAgentAction — never independently constructed here. */
  decoded: DecodedAgentAction | null;
  error: AgentActionConfirmationError | null;
}

export function idleConfirmationSnapshot(): AgentActionConfirmationSnapshot {
  return { state: "IDLE", decoded: null, error: null };
}

function walletRequiredSnapshot(): AgentActionConfirmationSnapshot {
  return {
    state: "WALLET_REQUIRED",
    decoded: null,
    error: {
      code: "WALLET_REQUIRED",
      message: "Connect your wallet to verify and simulate this action.",
    },
  };
}

// --- Driver --------------------------------------------------------------

/**
 * Drives an AgentActionContract through the P0.5 state machine, calling
 * onTransition once per state change (including the final one) so a
 * caller — typically the useAgentActionConfirmation hook — can mirror
 * every intermediate step into UI state. Resolves with the same final
 * snapshot it last passed to onTransition.
 *
 * This function makes exactly the same calls P0.4 already exposes:
 *   verifyAgentAction(action)
 *   simulateAgentAction(action, { account })
 * and never calls anything execution/broadcast related.
 */
export async function runAgentActionConfirmation(
  action: AgentActionContract,
  account: Address | null | undefined,
  onTransition: (snapshot: AgentActionConfirmationSnapshot) => void
): Promise<AgentActionConfirmationSnapshot> {
  if (!account || !isAddress(account)) {
    const snapshot = walletRequiredSnapshot();
    onTransition(snapshot);
    return snapshot;
  }

  onTransition({ state: "VERIFYING", decoded: null, error: null });

  const verification = verifyAgentAction(action);

  if (!verification.ok) {
    const snapshot: AgentActionConfirmationSnapshot = {
      state: "VERIFICATION_FAILED",
      decoded: null,
      error: verification.error,
    };
    onTransition(snapshot);
    return snapshot;
  }

  onTransition({
    state: "VERIFIED",
    decoded: verification.decoded,
    error: null,
  });

  onTransition({
    state: "SIMULATING",
    decoded: verification.decoded,
    error: null,
  });

  const simulation = await simulateAgentAction(action, { account });

  if (
    !simulation.ok ||
    simulation.simulated !== true ||
    simulation.safeToProceed !== true
  ) {
    const snapshot: AgentActionConfirmationSnapshot = {
      state: "SIMULATION_FAILED",
      decoded: simulation.decoded ?? verification.decoded,
      error: !simulation.ok
        ? simulation.error
        : {
            code: "SIMULATION_FAILED",
            message:
              "Simulating this action did not confirm it is safe to proceed.",
          },
    };
    onTransition(snapshot);
    return snapshot;
  }

  onTransition({
    state: "SIMULATED",
    decoded: simulation.decoded,
    error: null,
  });

  const readySnapshot: AgentActionConfirmationSnapshot = {
    state: "READY_FOR_CONFIRMATION",
    decoded: simulation.decoded,
    error: null,
  };
  onTransition(readySnapshot);
  return readySnapshot;
}

