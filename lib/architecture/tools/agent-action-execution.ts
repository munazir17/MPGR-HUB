// lib/architecture/tools/agent-action-execution.ts
//
// P1 — First Real Base Action Execution.
//
// This file sits strictly above P0.5 (agent-action-confirmation.ts,
// LOCKED). It is the ONLY layer in the agent stack allowed to call a
// real wallet-signing/broadcast API. It does not decode calldata, does
// not re-derive destination/ABI/function/args, and does not duplicate
// P0.4's resolveExpectedCall(). It takes the exact bytes P0.3 built and
// P0.4 already verified/simulated —
//
//   action.to / action.data / action.value / action.chainId
//
// — and passes them straight into wagmi's sendTransaction, unchanged.
// See the header comments on AgentActionContractBase in
// agent-action-contract.ts ("to" / "data" resolution) for why those
// fields are already safe to execute verbatim.
//
// EXECUTION MUST NOT HAPPEN AUTOMATICALLY. executeAgentAction() below is
// only ever invoked by an explicit call from a "Confirm" click — nothing
// in this module, or in the hook that wraps it, calls it from a
// useEffect, a mount, a simulation callback, a state transition, or a
// promise continuation. See useAgentActionExecution.ts for the one
// legitimate call site.
//
// STATE MACHINE — exactly these states, no others (there is no separate
// "EXECUTING" state; AWAITING_WALLET/PENDING are the two states this
// module occupies while a transaction is in flight):
//
//   IDLE -> READY_FOR_CONFIRMATION -> AWAITING_WALLET -> PENDING -> SUCCESS
//                                                                \-> ERROR
//
// AWAITING_WALLET = wallet signature/request stage (sendTransaction has
// been called and we're waiting on the wallet to sign/reject).
// PENDING = a transaction hash exists and we're waiting on the receipt.
// A transaction hash alone is never SUCCESS — only
// receipt.status === "success" is.
//
// GATES — checked in this exact order, before any wallet API is called:
//   1. a connected wallet account exists
//   2. the confirmation state passed in is READY_FOR_CONFIRMATION
//   3. the current account matches the account confirmation ran against
//   4. the current chain matches the chain confirmation ran against
//   5. the current chain is Base Mainnet
//   6. action.chainId is Base Mainnet
// If any gate fails, sendTransaction/writeContract/signing is never
// called — a typed, user-safe error is returned instead.

import { isAddress, type Address, type Hash } from "viem";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";

import { config } from "@/lib/wagmi";
import type { AgentActionContract } from "./agent-action-contract";
import type { AgentActionConfirmationState } from "./agent-action-confirmation";
import { TOOL_CHAIN_ID } from "./tool-helpers";

// --- State -------------------------------------------------------------

export const AGENT_ACTION_EXECUTION_STATES = [
  "IDLE",
  "READY_FOR_CONFIRMATION",
  "AWAITING_WALLET",
  "PENDING",
  "SUCCESS",
  "ERROR",
] as const;

export type AgentActionExecutionState =
  (typeof AGENT_ACTION_EXECUTION_STATES)[number];

// --- Errors --------------------------------------------------------------

export const AGENT_ACTION_EXECUTION_ERROR_CODES = [
  "WALLET_REQUIRED",
  "WRONG_CHAIN",
  "NOT_READY",
  "ACCOUNT_CHANGED",
  "CHAIN_CHANGED",
  "WALLET_REJECTED",
  "SEND_FAILED",
  "RECEIPT_FAILED",
  "TRANSACTION_REVERTED",
  "EXECUTION_IN_PROGRESS",
] as const;

export type AgentActionExecutionErrorCode =
  (typeof AGENT_ACTION_EXECUTION_ERROR_CODES)[number];

export interface AgentActionExecutionError {
  code: AgentActionExecutionErrorCode;
  /** User-safe — never a raw provider/RPC exception message. */
  message: string;
}

export interface AgentActionExecutionSnapshot {
  state: AgentActionExecutionState;
  hash: Hash | null;
  error: AgentActionExecutionError | null;
}

export function idleExecutionSnapshot(): AgentActionExecutionSnapshot {
  return { state: "IDLE", hash: null, error: null };
}

function errorSnapshot(
  code: AgentActionExecutionErrorCode,
  message: string,
  hash: Hash | null = null
): AgentActionExecutionSnapshot {
  return { state: "ERROR", hash, error: { code, message } };
}

// --- Gate input ------------------------------------------------------------

export interface ExecuteAgentActionInput {
  action: AgentActionContract;
  /** The state P0.5's confirmation state machine reached for this action. Must be READY_FOR_CONFIRMATION. */
  confirmationState: AgentActionConfirmationState;
  /** The account P0.5 verified/simulated this action against. */
  confirmedAccount: Address;
  /** The chain that was active when P0.5 reached READY_FOR_CONFIRMATION. */
  confirmedChainId: number;
  /** The live connected account at the moment execute() is called — never fabricated. */
  currentAccount: Address | null | undefined;
  /** The live connected chain at the moment execute() is called. */
  currentChainId: number | null | undefined;
}

type GateResult =
  | { ok: true }
  | { ok: false; error: AgentActionExecutionError };

function checkGates(input: ExecuteAgentActionInput): GateResult {
  const {
    action,
    confirmationState,
    confirmedAccount,
    confirmedChainId,
    currentAccount,
    currentChainId,
  } = input;

  if (!currentAccount || !isAddress(currentAccount)) {
    return {
      ok: false,
      error: {
        code: "WALLET_REQUIRED",
        message: "Connect your wallet to execute this action.",
      },
    };
  }

  if (confirmationState !== "READY_FOR_CONFIRMATION") {
    return {
      ok: false,
      error: {
        code: "NOT_READY",
        message:
          "This action has not been verified and simulated yet — nothing was executed.",
      },
    };
  }

  if (currentAccount.toLowerCase() !== confirmedAccount.toLowerCase()) {
    return {
      ok: false,
      error: {
        code: "ACCOUNT_CHANGED",
        message:
          "The connected account changed since this action was confirmed. Please re-verify and re-simulate before executing.",
      },
    };
  }

  if (currentChainId !== confirmedChainId) {
    return {
      ok: false,
      error: {
        code: "CHAIN_CHANGED",
        message:
          "The connected network changed since this action was confirmed. Please re-verify and re-simulate before executing.",
      },
    };
  }

  if (currentChainId !== TOOL_CHAIN_ID) {
    return {
      ok: false,
      error: {
        code: "WRONG_CHAIN",
        message: `Switch to Base Mainnet (chainId ${TOOL_CHAIN_ID}) to execute this action.`,
      },
    };
  }

  if (action.chainId !== TOOL_CHAIN_ID) {
    return {
      ok: false,
      error: {
        code: "WRONG_CHAIN",
        message: `This action is not scoped to Base Mainnet (chainId ${TOOL_CHAIN_ID}) and cannot be executed.`,
      },
    };
  }

  return { ok: true };
}

// --- Error classification ---------------------------------------------------
//
// Never surfaces raw provider/RPC text to the UI — only classifies into
// one of the typed codes above and returns a fixed, safe message.
function classifySendError(err: unknown): AgentActionExecutionError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("request rejected")
  ) {
    return {
      code: "WALLET_REJECTED",
      message: "Transaction was cancelled in your wallet.",
    };
  }

  return {
    code: "SEND_FAILED",
    message:
      "Your wallet was unable to send this transaction. Nothing was broadcast.",
  };
}

// --- Duplicate execution protection ----------------------------------------
//
// Module-level, keyed by the action's own deterministic id (see
// buildDeterministicId in agent-action-contract.ts). Two Confirm clicks
// for the same action — from the same hook instance or two independent
// callers — must never both reach sendTransaction. This is enforced here
// (not only in the React hook) so the guarantee holds regardless of
// caller and is directly unit-testable without rendering a component.
const actionsInFlight = new Set<string>();

// --- Driver --------------------------------------------------------------

/**
 * Executes an already-verified, already-simulated, already-confirmed
 * AgentActionContract by sending EXACTLY its (to, data, value, chainId)
 * fields — never a re-derived or re-encoded transaction.
 *
 * Calls onTransition once per state change (including the final one),
 * mirroring runAgentActionConfirmation's shape, so a caller (typically
 * useAgentActionExecution) can mirror every intermediate step into UI
 * state. Resolves with the same final snapshot it last passed to
 * onTransition.
 *
 * This function is the only place in the entire agent-action-* stack
 * allowed to call sendTransaction / waitForTransactionReceipt.
 */
export async function executeAgentAction(
  input: ExecuteAgentActionInput,
  onTransition: (snapshot: AgentActionExecutionSnapshot) => void
): Promise<AgentActionExecutionSnapshot> {
  if (actionsInFlight.has(input.action.id)) {
    const snapshot = errorSnapshot(
      "EXECUTION_IN_PROGRESS",
      "This action is already being executed — please wait for it to finish."
    );
    onTransition(snapshot);
    return snapshot;
  }

  const gate = checkGates(input);

  if (!gate.ok) {
    const snapshot: AgentActionExecutionSnapshot = {
      state: "ERROR",
      hash: null,
      error: gate.error,
    };
    onTransition(snapshot);
    return snapshot;
  }

  const { action, currentAccount } = input;

  actionsInFlight.add(action.id);
  try {
    onTransition({ state: "AWAITING_WALLET", hash: null, error: null });

    let hash: Hash;
    try {
      // EXACT PAYLOAD RULE: these four fields come from the verified
      // action only — never from action.description, UI text, decoded
      // display formatting, or any independently reconstructed params.
      hash = await sendTransaction(config, {
        account: currentAccount as Address,
        to: action.to,
        data: action.data,
        value: action.value,
        chainId: action.chainId,
      });
    } catch (err) {
      const classified = classifySendError(err);
      const snapshot = errorSnapshot(classified.code, classified.message);
      onTransition(snapshot);
      return snapshot;
    }

    onTransition({ state: "PENDING", hash, error: null });

    let receipt: { status: "success" | "reverted" | string };
    try {
      receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: action.chainId,
      });
    } catch {
      const snapshot = errorSnapshot(
        "RECEIPT_FAILED",
        "Your transaction was submitted, but we could not confirm its final status. Check a Base explorer for the latest status.",
        hash
      );
      onTransition(snapshot);
      return snapshot;
    }

    if (receipt.status !== "success") {
      const snapshot = errorSnapshot(
        "TRANSACTION_REVERTED",
        "This transaction was submitted but reverted on-chain.",
        hash
      );
      onTransition(snapshot);
      return snapshot;
    }

    const successSnapshot: AgentActionExecutionSnapshot = {
      state: "SUCCESS",
      hash,
      error: null,
    };
    onTransition(successSnapshot);
    return successSnapshot;
  } finally {
    actionsInFlight.delete(action.id);
  }
}
