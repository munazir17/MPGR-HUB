// lib/architecture/tools/agent-action-simulation.ts
//
// P0.4 — Simulation + Calldata Decode.
//
// This file sits strictly between P0.3 (agent-action-contract.ts, LOCKED)
// and P0.5 (Confirmation UI). It takes an already-built AgentActionContract
// and independently re-derives, from scratch, what the chain would actually
// see — then checks that against what's on the contract. It never trusts
// `action.description` (that's just UI text) and it never trusts that
// `action.data`/`action.to`/`action.value` still say what `action.params`
// says they should — it recomputes the expected destination/ABI/function/
// args from (domain, actionType, params) alone, using the exact same
// compile-time configs and ABIs P0.3 uses, and requires an exact match.
//
// UNDERSTAND -> DECODE -> VERIFY -> SIMULATE -> READY FOR CONFIRMATION.
// This file stops there. It never calls writeContract, sendTransaction,
// signTransaction, or anything else that signs or broadcasts. Simulation
// below is a single read-only `simulateContract` call (an eth_call), the
// same primitive every existing client in this repo already calls before
// its own writeContract — this file just never takes the write step.

import { decodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { simulateContract } from "wagmi/actions";

import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

import { TOKEN_LOCK_ABI } from "@/lib/token-lock/token-lock-abi";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";

import { STAKING_ABI } from "@/lib/staking/staking-abi";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";

import { REWARD_VAULT_ABI } from "@/lib/reward-vault/reward-vault-abi";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";

import {
  AGENT_ACTION_DOMAINS,
  type AgentActionContract,
  type AgentActionDomain,
  type TokenLockActionParams,
  type StakingActionParams,
  type RewardVaultActionParams,
} from "./agent-action-contract";
import { TOOL_CHAIN_ID } from "./tool-helpers";

// The single source of truth for the chain supported by the agent stack.
export const SIMULATION_CHAIN_ID = TOOL_CHAIN_ID;

// --- Decoded shape ----------------------------------------------------------

export interface DecodedAgentAction {
  domain: AgentActionDomain;
  actionType: string;
  /** The real on-chain function name — e.g. staking's "claim" decodes to "claimRewards". */
  functionName: string;
  args: readonly unknown[];
  to: Address;
  value: bigint;
  chainId: number;
}

// --- Errors -----------------------------------------------------------------

export const AGENT_ACTION_VERIFICATION_ERROR_CODES = [
  "INVALID_ACTION",
  "INVALID_CHAIN",
  "INVALID_DESTINATION",
  "INVALID_VALUE",
  "INVALID_CALLDATA",
  "UNSUPPORTED_FUNCTION",
  "PARAMETER_MISMATCH",
] as const;

export type AgentActionVerificationErrorCode =
  (typeof AGENT_ACTION_VERIFICATION_ERROR_CODES)[number];

export type AgentActionSimulationErrorCode =
  | AgentActionVerificationErrorCode
  | "ACCOUNT_REQUIRED"
  | "SIMULATION_FAILED";

export interface AgentActionVerificationError {
  code: AgentActionVerificationErrorCode;
  message: string;
}

export interface AgentActionSimulationError {
  code: AgentActionSimulationErrorCode;
  message: string;
}

export type AgentActionVerificationResult =
  | { ok: true; decoded: DecodedAgentAction }
  | { ok: false; error: AgentActionVerificationError };

export type AgentActionSimulationResult =
  | {
      ok: true;
      decoded: DecodedAgentAction;
      simulated: true;
      safeToProceed: true;
    }
  | {
      ok: false;
      decoded?: DecodedAgentAction;
      error: AgentActionSimulationError;
    };

// --- Expected-call resolution -----------------------------------------------
//
// ExpectedCall is deliberately a discriminated union.
//
// This preserves the ABI <-> functionName relationship required by wagmi's
// simulateContract generics. It prevents a broad function-name union from
// becoming detached from the ABI that actually owns that function.

interface Erc20ExpectedCall {
  kind: "erc20";
  to: Address;
  abi: typeof erc20Abi;
  functionName: "approve";
  args: readonly unknown[];
}

interface TokenLockExpectedCall {
  kind: "tokenLock";
  to: Address;
  abi: typeof TOKEN_LOCK_ABI;
  functionName: "createLock" | "withdraw" | "earlyUnlock";
  args: readonly unknown[];
}

interface StakingExpectedCall {
  kind: "staking";
  to: Address;
  abi: typeof STAKING_ABI;
  functionName: "stake" | "unstake" | "claimRewards" | "exit";
  args: readonly unknown[];
}

interface RewardVaultExpectedCall {
  kind: "rewardVault";
  to: Address;
  abi: typeof REWARD_VAULT_ABI;
  functionName: "claim" | "claimMultiple";
  args: readonly unknown[];
}

type ExpectedCall =
  | Erc20ExpectedCall
  | TokenLockExpectedCall
  | StakingExpectedCall
  | RewardVaultExpectedCall;

type ExpectedCallResult =
  | { ok: true; expected: ExpectedCall }
  | { ok: false; error: AgentActionVerificationError };

function invalidAction(message: string): ExpectedCallResult {
  return {
    ok: false,
    error: {
      code: "INVALID_ACTION",
      message,
    },
  };
}

function resolveExpectedCall(
  action: AgentActionContract
): ExpectedCallResult {
  // Verify that the envelope's actionType and the params discriminant agree.
  const paramsActionType = (
    action.params as { actionType?: unknown } | null
  )?.actionType;

  if (paramsActionType !== action.actionType) {
    return {
      ok: false,
      error: {
        code: "PARAMETER_MISMATCH",
        message: `action.actionType ("${String(
          action.actionType
        )}") does not match action.params.actionType ("${String(
          paramsActionType
        )}").`,
      },
    };
  }

  switch (action.domain) {
    case "tokenLock": {
      const params = action.params as TokenLockActionParams;

      switch (params.actionType) {
        case "approve":
          return {
            ok: true,
            expected: {
              kind: "erc20",
              to: MPGR_TOKEN_CONFIG.address,
              abi: erc20Abi,
              functionName: "approve",
              args: [MPGR_TOKEN_LOCK_CONFIG.address, params.amount],
            },
          };

        case "createLock":
          return {
            ok: true,
            expected: {
              kind: "tokenLock",
              to: MPGR_TOKEN_LOCK_CONFIG.address,
              abi: TOKEN_LOCK_ABI,
              functionName: "createLock",
              args: [params.amount, params.unlockTime],
            },
          };

        case "withdraw":
          return {
            ok: true,
            expected: {
              kind: "tokenLock",
              to: MPGR_TOKEN_LOCK_CONFIG.address,
              abi: TOKEN_LOCK_ABI,
              functionName: "withdraw",
              args: [params.lockId],
            },
          };

        case "earlyUnlock":
          return {
            ok: true,
            expected: {
              kind: "tokenLock",
              to: MPGR_TOKEN_LOCK_CONFIG.address,
              abi: TOKEN_LOCK_ABI,
              functionName: "earlyUnlock",
              args: [params.lockId],
            },
          };

        default:
          return invalidAction(
            `Unknown tokenLock actionType "${String(action.actionType)}".`
          );
      }
    }

    case "staking": {
      const params = action.params as StakingActionParams;

      switch (params.actionType) {
        case "approve":
          return {
            ok: true,
            expected: {
              kind: "erc20",
              to: MPGR_TOKEN_CONFIG.address,
              abi: erc20Abi,
              functionName: "approve",
              args: [MPGR_STAKING_CONFIG.address, params.amount],
            },
          };

        case "stake":
        case "unstake":
          return {
            ok: true,
            expected: {
              kind: "staking",
              to: MPGR_STAKING_CONFIG.address,
              abi: STAKING_ABI,
              functionName: params.actionType,
              args: [params.amount],
            },
          };

        case "claim":
          return {
            ok: true,
            expected: {
              kind: "staking",
              to: MPGR_STAKING_CONFIG.address,
              abi: STAKING_ABI,
              functionName: "claimRewards",
              args: [],
            },
          };

        case "exit":
          return {
            ok: true,
            expected: {
              kind: "staking",
              to: MPGR_STAKING_CONFIG.address,
              abi: STAKING_ABI,
              functionName: "exit",
              args: [],
            },
          };

        default:
          return invalidAction(
            `Unknown staking actionType "${String(action.actionType)}".`
          );
      }
    }

    case "rewardVault": {
      const params = action.params as RewardVaultActionParams;

      switch (params.actionType) {
        case "claim":
          return {
            ok: true,
            expected: {
              kind: "rewardVault",
              to: MPGR_REWARD_VAULT_CONFIG.address,
              abi: REWARD_VAULT_ABI,
              functionName: "claim",
              args: [params.rewardId],
            },
          };

        case "claimMultiple":
          return {
            ok: true,
            expected: {
              kind: "rewardVault",
              to: MPGR_REWARD_VAULT_CONFIG.address,
              abi: REWARD_VAULT_ABI,
              functionName: "claimMultiple",
              args: [params.rewardIds],
            },
          };

        default:
          return invalidAction(
            `Unknown rewardVault actionType "${String(action.actionType)}".`
          );
      }
    }

    default:
      return invalidAction("Unknown action domain.");
  }
}

// --- Argument comparison ----------------------------------------------------

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return (
        BigInt(a as bigint | number | string) ===
        BigInt(b as bigint | number | string)
      );
    } catch {
      return false;
    }
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((value, index) => valuesEqual(value, b[index]))
    );
  }

  if (
    typeof a === "string" &&
    typeof b === "string" &&
    a.startsWith("0x") &&
    b.startsWith("0x")
  ) {
    return a.toLowerCase() === b.toLowerCase();
  }

  return a === b;
}

function argsMatch(
  decodedArgs: readonly unknown[],
  expectedArgs: readonly unknown[]
): boolean {
  if (decodedArgs.length !== expectedArgs.length) {
    return false;
  }

  return decodedArgs.every((value, index) =>
    valuesEqual(value, expectedArgs[index])
  );
}

// --- Verification -----------------------------------------------------------

function failVerification(
  code: AgentActionVerificationErrorCode,
  message: string
): AgentActionVerificationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

/**
 * Independently decodes and verifies an AgentActionContract.
 *
 * Pure and synchronous — makes no network call.
 *
 * Recomputes destination/ABI/function/args from:
 *   domain + actionType + params
 *
 * and requires:
 *   action.to + action.value + action.data
 *
 * to agree with that independent recomputation.
 */
export function verifyAgentAction(
  action: AgentActionContract
): AgentActionVerificationResult {
  if (
    !(AGENT_ACTION_DOMAINS as readonly string[]).includes(action.domain)
  ) {
    return failVerification(
      "INVALID_ACTION",
      "Unknown action domain."
    );
  }

  if (action.chainId !== SIMULATION_CHAIN_ID) {
    return failVerification(
      "INVALID_CHAIN",
      `Only chainId ${SIMULATION_CHAIN_ID} (Base Mainnet) is supported.`
    );
  }

  const expectedResult = resolveExpectedCall(action);

  if (!expectedResult.ok) {
    return expectedResult;
  }

  const { expected } = expectedResult;

  if (
    typeof action.to !== "string" ||
    !isAddress(action.to)
  ) {
    return failVerification(
      "INVALID_DESTINATION",
      "The action's destination address is missing or not a valid address."
    );
  }

  if (
    action.to.toLowerCase() !==
    expected.to.toLowerCase()
  ) {
    return failVerification(
      "INVALID_DESTINATION",
      "The action's destination address does not match the expected contract for this domain/actionType."
    );
  }

  if (action.value !== 0n) {
    return failVerification(
      "INVALID_VALUE",
      "No known MPGR action sends native value; a non-zero value is not supported."
    );
  }

  let decodedFunctionName: string;
  let decodedArgs: readonly unknown[];

  try {
    const result = decodeFunctionData({
      abi: expected.abi,
      data: action.data as Hex,
    });

    decodedFunctionName = result.functionName;
    decodedArgs = (result.args ?? []) as readonly unknown[];
  } catch {
    return failVerification(
      "INVALID_CALLDATA",
      "The action's calldata could not be decoded against the expected contract ABI."
    );
  }

  if (decodedFunctionName !== expected.functionName) {
    return failVerification(
      "UNSUPPORTED_FUNCTION",
      `The action's calldata calls "${decodedFunctionName}", but "${expected.functionName}" was expected for this action.`
    );
  }

  if (!argsMatch(decodedArgs, expected.args)) {
    return failVerification(
      "PARAMETER_MISMATCH",
      "The action's calldata arguments do not match its own typed parameters."
    );
  }

  return {
    ok: true,
    decoded: {
      domain: action.domain,
      actionType: action.actionType,
      functionName: decodedFunctionName,
      args: decodedArgs,
      to: action.to,
      value: action.value,
      chainId: action.chainId,
    },
  };
}

// --- Simulation -------------------------------------------------------------

/**
 * Runs the already-resolved expected call against Base using wagmi's
 * read-only simulateContract primitive.
 *
 * IMPORTANT:
 * - No writeContract.
 * - No sendTransaction.
 * - No signTransaction.
 * - No wallet signing.
 * - No broadcast.
 *
 * SIMULATION_CHAIN_ID is deliberately used instead of a generic `number`
 * parameter because wagmi's chain-aware config resolves the supported chain
 * as the literal Base Mainnet chain ID (8453).
 *
 * The `kind` discriminant preserves ABI/functionName correlation.
 */
async function runExpectedCallSimulation(
  expected: ExpectedCall,
  address: Address,
  account: Address
): Promise<void> {
  switch (expected.kind) {
    case "erc20":
      await simulateContract(config, {
        address,
        abi: expected.abi,
        functionName: expected.functionName,
        args: expected.args as never,
        chainId: SIMULATION_CHAIN_ID,
        account,
      });
      return;

    case "tokenLock":
      await simulateContract(config, {
        address,
        abi: expected.abi,
        functionName: expected.functionName,
        args: expected.args as never,
        chainId: SIMULATION_CHAIN_ID,
        account,
      });
      return;

    case "staking":
      await simulateContract(config, {
        address,
        abi: expected.abi,
        functionName: expected.functionName,
        args: expected.args as never,
        chainId: SIMULATION_CHAIN_ID,
        account,
      });
      return;

    case "rewardVault":
      await simulateContract(config, {
        address,
        abi: expected.abi,
        functionName: expected.functionName,
        args: expected.args as never,
        chainId: SIMULATION_CHAIN_ID,
        account,
      });
      return;
  }
}

export interface SimulateAgentActionOptions {
  /** The address to simulate as (msg.sender). Required — never defaulted or fabricated. */
  account?: string;
}

/**
 * Verifies the action and, only if verification passes, performs exactly
 * one read-only simulateContract call.
 *
 * If account is missing or malformed, simulation is not attempted.
 */
export async function simulateAgentAction(
  action: AgentActionContract,
  options: SimulateAgentActionOptions = {}
): Promise<AgentActionSimulationResult> {
  const verification = verifyAgentAction(action);

  if (!verification.ok) {
    return verification;
  }

  if (
    !options.account ||
    !isAddress(options.account)
  ) {
    return {
      ok: false,
      decoded: verification.decoded,
      error: {
        code: "ACCOUNT_REQUIRED",
        message:
          "Simulating this action requires the connecting wallet's own address; none was provided.",
      },
    };
  }

  const expectedResult = resolveExpectedCall(action);

  // Defensive re-resolution. Verification already proved this succeeds,
  // but this keeps the simulation layer from assuming that fact.
  if (!expectedResult.ok) {
    return {
      ok: false,
      error: expectedResult.error,
    };
  }

  const { expected } = expectedResult;

  try {
    await runExpectedCallSimulation(
      expected,
      action.to,
      options.account as Address
    );
  } catch {
    // Never expose raw provider/RPC exception text.
    return {
      ok: false,
      decoded: verification.decoded,
      error: {
        code: "SIMULATION_FAILED",
        message:
          "Simulating this action against Base failed — it would not succeed on-chain in its current form.",
      },
    };
  }

  return {
    ok: true,
    decoded: verification.decoded,
    simulated: true,
    safeToProceed: true,
  };
}
