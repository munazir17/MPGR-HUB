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

// The single source of truth for "which chain this whole agent stack
// supports" — same constant P0.3's agent-action-contract.ts imports
// from tool-helpers.ts, imported directly here rather than through
// agent-action-contract.ts (which does not re-export it).
export const SIMULATION_CHAIN_ID = TOOL_CHAIN_ID;

// --- Decoded shape (what P0.5 actually needs) ------------------------------

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

// --- Errors ------------------------------------------------------------
//
// A deliberately small, closed set — every one of these is reachable from a
// distinct, real mismatch below, and every message is written to be safe to
// show a user as-is (no raw provider/exception text ever flows into these).

export const AGENT_ACTION_VERIFICATION_ERROR_CODES = [
  "INVALID_ACTION",
  "INVALID_CHAIN",
  "INVALID_DESTINATION",
  "INVALID_VALUE",
  "INVALID_CALLDATA",
  "UNSUPPORTED_FUNCTION",
  "PARAMETER_MISMATCH",
] as const;
export type AgentActionVerificationErrorCode = (typeof AGENT_ACTION_VERIFICATION_ERROR_CODES)[number];

export type AgentActionSimulationErrorCode = AgentActionVerificationErrorCode | "ACCOUNT_REQUIRED" | "SIMULATION_FAILED";

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
  | { ok: true; decoded: DecodedAgentAction; simulated: true; safeToProceed: true }
  | { ok: false; decoded?: DecodedAgentAction; error: AgentActionSimulationError };

// --- Expected-call resolution -------------------------------------------
//
// Recomputes, purely from (domain, actionType, params) — never from
// action.to/action.data — exactly what the chain call should look like.
// This is the independent side of the check; `action.to`/`action.data`
// are the side under test.

// The literal union of every function name across the four ABIs this file
// resolves calls against — extracted from the ABIs themselves (all
// declared `as const`), not hand-typed, so it can never drift out of sync
// with them. This is what makes ExpectedCall.functionName assignable to
// wagmi/viem's `simulateContract` `functionName` param, which is typed as
// exactly this kind of ABI-derived literal union rather than plain
// `string`. The runtime function-name mapping itself (resolveExpectedCall
// below) is unchanged — this only widens the *type* enough to describe
// values that already come from those same ABIs.
type AbiFunctionName<TAbi extends readonly { readonly type: string; readonly name?: string }[]> = Extract<
  TAbi[number],
  { readonly type: "function" }
>["name"];

type ExpectedCallFunctionName =
  | AbiFunctionName<typeof erc20Abi>
  | AbiFunctionName<typeof TOKEN_LOCK_ABI>
  | AbiFunctionName<typeof STAKING_ABI>
  | AbiFunctionName<typeof REWARD_VAULT_ABI>;

interface ExpectedCall {
  to: Address;
  abi: typeof erc20Abi | typeof TOKEN_LOCK_ABI | typeof STAKING_ABI | typeof REWARD_VAULT_ABI;
  functionName: ExpectedCallFunctionName;
  args: readonly unknown[];
}

type ExpectedCallResult = { ok: true; expected: ExpectedCall } | { ok: false; error: AgentActionVerificationError };

function invalidAction(message: string): ExpectedCallResult {
  return { ok: false, error: { code: "INVALID_ACTION", message } };
}

function resolveExpectedCall(action: AgentActionContract): ExpectedCallResult {
  // Independently verify the envelope agrees with itself before trusting
  // either half of it: action.actionType (what P0.5/UI would display and
  // key any confirmation logic off of) must be the exact same value as
  // action.params.actionType (what actually drives the expected call
  // below). Without this, a tampered object could carry two different
  // actionTypes — one for display, a different one actually used to
  // resolve the expected contract call — and pass verification while
  // silently describing the wrong action. `action.params` is `unknown`-ish
  // at the type level relative to `action.actionType` here on purpose: this
  // check must not assume the two already agree.
  const paramsActionType = (action.params as { actionType?: unknown } | null)?.actionType;
  if (paramsActionType !== action.actionType) {
    return {
      ok: false,
      error: {
        code: "PARAMETER_MISMATCH",
        message: `action.actionType ("${String(action.actionType)}") does not match action.params.actionType ("${String(paramsActionType)}").`,
      },
    };
  }

  switch (action.domain) {
    case "tokenLock": {
      // Switch on params.actionType itself (the union's own discriminant),
      // not action.actionType — TypeScript's control-flow narrowing only
      // narrows a value based on switching on that same value's own
      // discriminant property. Switching on action.actionType (a sibling,
      // separately-typed field) can't narrow `params`, even though the
      // check above already proved the two are runtime-equal.
      const params = action.params as TokenLockActionParams;
      switch (params.actionType) {
        case "approve":
          return {
            ok: true,
            expected: {
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
              to: MPGR_TOKEN_LOCK_CONFIG.address,
              abi: TOKEN_LOCK_ABI,
              functionName: "createLock",
              args: [params.amount, params.unlockTime],
            },
          };
        case "withdraw":
          return {
            ok: true,
            expected: { to: MPGR_TOKEN_LOCK_CONFIG.address, abi: TOKEN_LOCK_ABI, functionName: "withdraw", args: [params.lockId] },
          };
        case "earlyUnlock":
          return {
            ok: true,
            expected: { to: MPGR_TOKEN_LOCK_CONFIG.address, abi: TOKEN_LOCK_ABI, functionName: "earlyUnlock", args: [params.lockId] },
          };
        default:
          return invalidAction(`Unknown tokenLock actionType "${String(action.actionType)}".`);
      }
    }
    case "staking": {
      // Same fix as tokenLock above: switch on params.actionType (the
      // union's own discriminant) so TS narrows `params` — not on
      // action.actionType.
      const params = action.params as StakingActionParams;
      switch (params.actionType) {
        case "approve":
          return {
            ok: true,
            expected: {
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
            expected: { to: MPGR_STAKING_CONFIG.address, abi: STAKING_ABI, functionName: params.actionType, args: [params.amount] },
          };
        case "claim":
          // actionType "claim" maps to the real on-chain function
          // claimRewards() — the same mapping P0.3's buildStakingAction
          // uses; re-declared independently here rather than imported,
          // since re-deriving it from scratch is the whole point of P0.4.
          return { ok: true, expected: { to: MPGR_STAKING_CONFIG.address, abi: STAKING_ABI, functionName: "claimRewards", args: [] } };
        case "exit":
          return { ok: true, expected: { to: MPGR_STAKING_CONFIG.address, abi: STAKING_ABI, functionName: "exit", args: [] } };
        default:
          return invalidAction(`Unknown staking actionType "${String(action.actionType)}".`);
      }
    }
    case "rewardVault": {
      // Same fix as tokenLock/staking above.
      const params = action.params as RewardVaultActionParams;
      switch (params.actionType) {
        case "claim":
          return {
            ok: true,
            expected: { to: MPGR_REWARD_VAULT_CONFIG.address, abi: REWARD_VAULT_ABI, functionName: "claim", args: [params.rewardId] },
          };
        case "claimMultiple":
          return {
            ok: true,
            expected: {
              to: MPGR_REWARD_VAULT_CONFIG.address,
              abi: REWARD_VAULT_ABI,
              functionName: "claimMultiple",
              args: [params.rewardIds],
            },
          };
        default:
          return invalidAction(`Unknown rewardVault actionType "${String(action.actionType)}".`);
      }
    }
    default:
      // action.domain is a discriminated union (AGENT_ACTION_DOMAINS) and
      // the three cases above are exhaustive, so TS narrows `action` to
      // `never` here — this branch is unreachable at the type level (it
      // only guards a runtime value that bypassed the type system, e.g.
      // an untyped/tampered object cast to AgentActionContract). Don't
      // access any property of `action` here; it has no statically valid
      // properties to read.
      return invalidAction("Unknown action domain.");
  }
}

// --- Argument comparison ---------------------------------------------------
//
// bigint- and address-aware structural equality. Addresses compare
// case-insensitively (checksummed vs lowercase is not a mismatch);
// everything else must match exactly.

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return BigInt(a as bigint | number | string) === BigInt(b as bigint | number | string);
    } catch {
      return false;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (typeof a === "string" && typeof b === "string" && a.startsWith("0x") && b.startsWith("0x")) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function argsMatch(decodedArgs: readonly unknown[], expectedArgs: readonly unknown[]): boolean {
  if (decodedArgs.length !== expectedArgs.length) return false;
  return decodedArgs.every((value, index) => valuesEqual(value, expectedArgs[index]));
}

// --- Verification (decode + compare — no network) --------------------------

function failVerification(code: AgentActionVerificationErrorCode, message: string): AgentActionVerificationResult {
  return { ok: false, error: { code, message } };
}

/**
 * Independently decodes and verifies an AgentActionContract. Pure and
 * synchronous — makes no network call. Recomputes the expected
 * destination/ABI/function/args from (domain, actionType, params) alone and
 * requires action.to / action.value / action.data to agree with that
 * recomputation exactly. Never reads action.description.
 */
export function verifyAgentAction(action: AgentActionContract): AgentActionVerificationResult {
  if (!(AGENT_ACTION_DOMAINS as readonly string[]).includes(action.domain)) {
    return failVerification("INVALID_ACTION", "Unknown action domain.");
  }

  if (action.chainId !== SIMULATION_CHAIN_ID) {
    return failVerification("INVALID_CHAIN", `Only chainId ${SIMULATION_CHAIN_ID} (Base Mainnet) is supported.`);
  }

  const expectedResult = resolveExpectedCall(action);
  if (!expectedResult.ok) return expectedResult;
  const { expected } = expectedResult;

  // A tampered/malformed runtime object could carry a non-string (or
  // non-address) `to` — validate before ever touching it as a string, so
  // this returns a typed failure instead of throwing.
  if (typeof action.to !== "string" || !isAddress(action.to)) {
    return failVerification("INVALID_DESTINATION", "The action's destination address is missing or not a valid address.");
  }

  if (action.to.toLowerCase() !== expected.to.toLowerCase()) {
    return failVerification("INVALID_DESTINATION", "The action's destination address does not match the expected contract for this domain/actionType.");
  }

  if (action.value !== 0n) {
    return failVerification("INVALID_VALUE", "No known MPGR action sends native value; a non-zero value is not supported.");
  }

  let decodedFunctionName: string;
  let decodedArgs: readonly unknown[];
  try {
    const result = decodeFunctionData({ abi: expected.abi, data: action.data as Hex });
    decodedFunctionName = result.functionName;
    decodedArgs = (result.args ?? []) as readonly unknown[];
  } catch {
    return failVerification("INVALID_CALLDATA", "The action's calldata could not be decoded against the expected contract ABI.");
  }

  if (decodedFunctionName !== expected.functionName) {
    return failVerification(
      "UNSUPPORTED_FUNCTION",
      `The action's calldata calls "${decodedFunctionName}", but "${expected.functionName}" was expected for this action.`
    );
  }

  if (!argsMatch(decodedArgs, expected.args)) {
    return failVerification("PARAMETER_MISMATCH", "The action's calldata arguments do not match its own typed parameters.");
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

// --- Simulation (read-only eth_call, network) -------------------------------

export interface SimulateAgentActionOptions {
  /** The address to simulate as (msg.sender). Required — never defaulted or fabricated. */
  account?: string;
}

/**
 * Verifies the action (see verifyAgentAction) and, only if that passes,
 * performs a single read-only simulateContract call — the same primitive
 * every existing *-client.ts in this repo already calls immediately before
 * its own writeContract, just without the write step. Never signs or
 * broadcasts anything. If `options.account` is missing or malformed, returns
 * a typed ACCOUNT_REQUIRED failure without ever calling simulateContract —
 * there is no default/fallback account.
 */
export async function simulateAgentAction(
  action: AgentActionContract,
  options: SimulateAgentActionOptions = {}
): Promise<AgentActionSimulationResult> {
  const verification = verifyAgentAction(action);
  if (!verification.ok) return verification;

  if (!options.account || !isAddress(options.account)) {
    return {
      ok: false,
      decoded: verification.decoded,
      error: {
        code: "ACCOUNT_REQUIRED",
        message: "Simulating this action requires the connecting wallet's own address; none was provided.",
      },
    };
  }

  const expectedResult = resolveExpectedCall(action);
  // Unreachable in practice — verification.ok already proved this resolves —
  // kept only so this function never assumes what verifyAgentAction did.
  if (!expectedResult.ok) return { ok: false, error: expectedResult.error };
  const { expected } = expectedResult;

  try {
    await simulateContract(config, {
      address: action.to,
      abi: expected.abi,
      functionName: expected.functionName,
      args: expected.args as never,
      chainId: action.chainId,
      account: options.account as Address,
    });
  } catch {
    // Raw provider/RPC exception text is never surfaced — same rule
    // agent-tool-result.ts's AgentToolError.message follows.
    return {
      ok: false,
      decoded: verification.decoded,
      error: {
        code: "SIMULATION_FAILED",
        message: "Simulating this action against Base failed — it would not succeed on-chain in its current form.",
      },
    };
  }

  return { ok: true, decoded: verification.decoded, simulated: true, safeToProceed: true };
}

