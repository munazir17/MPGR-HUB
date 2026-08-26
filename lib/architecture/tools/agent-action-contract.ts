// lib/architecture/tools/agent-action-contract.ts
//
// P0.3 — Action Contract. The formal, typed, safety-first boundary
// between the agent's planning/tool layer (P0.1/P0.2, all read-only)
// and a future transaction pipeline (P0.4 Simulation + Decode, P0.5
// Confirmation UI, P1 First Real Base Action).
//
// This file does NOT execute anything. There is no wallet signing here,
// no writeContract call, no network request. buildAgentActionContract()
// takes untrusted input (in practice: structured output an LLM produced,
// or a UI form) and either returns a validated, fully-typed
// AgentActionContract — safe to hand to a future simulateContract() /
// confirmation UI — or rejects it outright. There is no partial-trust
// path: an action that can't be safely represented is rejected, never
// guessed at (see each rejection branch below).
//
// --- Why this is scoped to three domains, not "any Base transaction" ---
//
// The spec asks for a model "capable of representing a future Base
// transaction safely" but also says not to blindly add fields just
// because a field list exists. This app has exactly three contracts a
// connected wallet can meaningfully sign a state-changing call against
// today — MPGRTokenLock, MPGRStaking, MPGRRewardVault (plus the MPGR
// token itself for approve()) — and every wallet-signed call this app
// already makes against them is enumerated by three existing, narrower
// types this session did not invent:
//   - TokenLockActionKind (lib/token-lock/token-lock-types.ts)
//   - StakingActionKind   (lib/staking/staking-types.ts)
//   - VaultActionKind     (lib/reward-vault/reward-vault-types.ts)
// Rather than a generic "any address, any calldata" contract (which an
// LLM could fill with an arbitrary spender/recipient), this Action
// Contract is closed over exactly those three domains and exactly the
// action kinds each one's own client module already implements. `to` is
// never taken from the input at all — it is resolved by this file from
// MPGR_TOKEN_LOCK_CONFIG / MPGR_STAKING_CONFIG / MPGR_REWARD_VAULT_CONFIG
// / MPGR_TOKEN_CONFIG, the same compile-time-constant addresses
// tool-definitions.ts's KNOWN_MPGR_CONTRACTS already trusts. An LLM (or
// any other caller) can select WHICH known action to prepare; it can
// never choose an arbitrary destination address. Admin-only functions on
// these contracts (setAPR, pause, recoverERC20, depositRewards, …) are
// not reachable through this file at all — they were never part of
// TokenLockActionKind/StakingActionKind/VaultActionKind to begin with.
//
// --- Where P0.4/P0.5 pick this up ---
//
// `data` below is real, deterministically encoded calldata (via viem's
// encodeFunctionData against this app's own already-verified ABIs) —
// not a placeholder string — so a future P0.4 can pass
// { to, data, value } straight into wagmi's simulateContract/
// prepareTransactionRequest without re-deriving anything. `phase` and
// `verified` are the placeholders P0.4/P0.5 update as the action moves
// through simulate -> confirm -> sign -> execute -> verify; nothing in
// this file ever sets `phase` to anything but "idle" or `verified` to
// anything but `false` — those are read-only observations, not knobs,
// from inside this module.

import { encodeFunctionData, type Address, type Hex } from "viem";

import { erc20Abi } from "@/lib/erc20-abi";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

import { TOKEN_LOCK_ABI } from "@/lib/token-lock/token-lock-abi";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import type { TokenLockActionKind } from "@/lib/token-lock/token-lock-types";

import { STAKING_ABI } from "@/lib/staking/staking-abi";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import type { StakingActionKind } from "@/lib/staking/staking-types";

import { REWARD_VAULT_ABI } from "@/lib/reward-vault/reward-vault-abi";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";
import type { VaultActionKind } from "@/lib/reward-vault/reward-vault-types";

import type { AgentToolRisk } from "./agent-tool";
import { TOOL_CHAIN_ID } from "./tool-helpers";

// --- Domain ------------------------------------------------------------
//
// Exactly the three live-contract modules this app has today. Adding a
// fourth (e.g. a future DEX) is a one-line addition here plus one new
// params branch below — nothing else in this file's control flow
// switches on the domain list's *length*, only on specific values.
export const AGENT_ACTION_DOMAINS = ["tokenLock", "staking", "rewardVault"] as const;
export type AgentActionDomain = (typeof AGENT_ACTION_DOMAINS)[number];

// --- Phase ---------------------------------------------------------------
//
// Deliberately the exact same vocabulary as TokenLockActionPhase /
// StakingActionPhase / VaultActionPhase (all: idle -> simulating ->
// pending -> confirming -> success -> error) rather than a fourth,
// slightly-different phase enum. P0.3 only ever constructs "idle" — the
// remaining transitions are P0.4 (simulating), P0.5 (confirming), and P1
// (pending/success/error) territory.
export const AGENT_ACTION_PHASES = ["idle", "simulating", "pending", "confirming", "success", "error"] as const;
export type AgentActionPhase = (typeof AGENT_ACTION_PHASES)[number];

// --- Per-domain params (discriminated on actionType) ----------------------
//
// One params shape per actionType, keyed by this domain's own existing
// ActionKind type — not a new invented vocabulary. Every numeric amount
// is `bigint` (raw base units), matching how every client module in this
// codebase (tokenLockClient, stakingService, rewardVaultService) already
// represents amounts — never a floating-point "human" number this close
// to a transaction boundary.

export interface ApproveParams {
  actionType: "approve";
  /** Raw MPGR amount (18 decimals) to approve. Exact-amount only — this contract never builds an unlimited/MaxUint256 approval. */
  amount: bigint;
}
export interface TokenLockCreateLockParams {
  actionType: "createLock";
  amount: bigint;
  /** Unix seconds. */
  unlockTime: bigint;
}
export interface TokenLockWithdrawParams {
  actionType: "withdraw";
  lockId: bigint;
}
export interface TokenLockEarlyUnlockParams {
  actionType: "earlyUnlock";
  lockId: bigint;
}
export type TokenLockActionParams =
  | ApproveParams
  | TokenLockCreateLockParams
  | TokenLockWithdrawParams
  | TokenLockEarlyUnlockParams;

export interface StakingStakeParams {
  actionType: "stake";
  amount: bigint;
}
export interface StakingUnstakeParams {
  actionType: "unstake";
  amount: bigint;
}
export interface StakingClaimParams {
  actionType: "claim";
}
export interface StakingExitParams {
  actionType: "exit";
}
export type StakingActionParams = ApproveParams | StakingStakeParams | StakingUnstakeParams | StakingClaimParams | StakingExitParams;

export interface VaultClaimParams {
  actionType: "claim";
  rewardId: bigint;
}
export interface VaultClaimMultipleParams {
  actionType: "claimMultiple";
  rewardIds: bigint[];
}
export type RewardVaultActionParams = VaultClaimParams | VaultClaimMultipleParams;

// --- The contract itself ---------------------------------------------------

interface AgentActionContractBase {
  /** Deterministic — see buildDeterministicId(). Same (domain, actionType, params) always yields the same id, so a caller/UI can dedupe or re-derive it without re-hashing by hand. */
  id: string;
  chainId: number;
  /** Resolved by this module from compile-time config — never taken from input. See header comment. */
  to: Address;
  /** Always 0n — no action this contract can build is payable. Not accepted from input at all (see header comment on `to`). */
  value: bigint;
  /** Real calldata, deterministically encoded via viem's encodeFunctionData against this app's existing ABIs — ready for a future simulateContract/prepareTransactionRequest call. */
  data: Hex;
  /** Plain-English, no jargon — safe to render directly in a future confirmation UI. */
  description: string;
  /** Optional caller-supplied purpose, e.g. "user asked to lock for 90 days". Free text, never interpolated into `data`/`to`/`value`. */
  reason?: string;
  riskLevel: AgentToolRisk;
  /** Always true in P0.3 — there is no field or mode that can make this false. Real confirmation UI/logic is P0.5's job, not this file's. */
  requiresConfirmation: true;
  phase: AgentActionPhase;
  /** Set once P1 executes and verifies the resulting transaction. Never true coming out of this module. */
  verified: boolean;
  createdAt: string;
}

export type AgentActionContract =
  | (AgentActionContractBase & { domain: "tokenLock"; actionType: TokenLockActionKind; params: TokenLockActionParams })
  | (AgentActionContractBase & { domain: "staking"; actionType: StakingActionKind; params: StakingActionParams })
  | (AgentActionContractBase & { domain: "rewardVault"; actionType: VaultActionKind; params: RewardVaultActionParams });

// --- Input (untrusted) -----------------------------------------------------
//
// What a caller (an LLM's structured tool-call output, a future UI form)
// actually supplies. Every field is `unknown` on purpose — this is the
// boundary where "natural-language model output must not be treated as
// executable calldata" is enforced; nothing here is assumed to already
// be the right shape/type.
export interface AgentActionContractInput {
  domain: unknown;
  actionType: unknown;
  chainId?: unknown;
  params: unknown;
  reason?: unknown;
}

// --- Errors ------------------------------------------------------------

export const AGENT_ACTION_CONTRACT_ERROR_CODES = [
  "INVALID_DOMAIN",
  "INVALID_ACTION_TYPE",
  "INVALID_CHAIN",
  "INVALID_ADDRESS",
  "INVALID_PARAMS",
  "MISSING_REQUIRED_FIELD",
] as const;
export type AgentActionContractErrorCode = (typeof AGENT_ACTION_CONTRACT_ERROR_CODES)[number];

export interface AgentActionContractError {
  code: AgentActionContractErrorCode;
  /** User-safe — never a raw exception message. Same guarantee as AgentToolError.message (agent-tool-result.ts). */
  message: string;
}

export type AgentActionContractResult =
  | { ok: true; action: AgentActionContract }
  | { ok: false; error: AgentActionContractError };

// --- Builder -----------------------------------------------------------

export function buildAgentActionContract(input: AgentActionContractInput): AgentActionContractResult {
  if (input.chainId !== undefined && input.chainId !== null) {
    if (typeof input.chainId !== "number" || input.chainId !== TOOL_CHAIN_ID) {
      return err("INVALID_CHAIN", `Only chainId ${TOOL_CHAIN_ID} (Base Mainnet) is supported; received ${String(input.chainId)}.`);
    }
  }

  if (input.reason !== undefined && typeof input.reason !== "string") {
    return err("INVALID_PARAMS", "reason, if provided, must be a string.");
  }
  const reason = typeof input.reason === "string" ? input.reason : undefined;

  if (!(AGENT_ACTION_DOMAINS as readonly unknown[]).includes(input.domain)) {
    return err("INVALID_DOMAIN", `domain must be one of: ${AGENT_ACTION_DOMAINS.join(", ")}.`);
  }
  const domain = input.domain as AgentActionDomain;

  const rawParams = isPlainObject(input.params) ? input.params : null;
  if (!rawParams) {
    return err("MISSING_REQUIRED_FIELD", "params must be an object.");
  }

  switch (domain) {
    case "tokenLock":
      return buildTokenLockAction(input.actionType, rawParams, reason);
    case "staking":
      return buildStakingAction(input.actionType, rawParams, reason);
    case "rewardVault":
      return buildRewardVaultAction(input.actionType, rawParams, reason);
  }
}

// --- Domain builders ---------------------------------------------------

function buildTokenLockAction(
  actionTypeInput: unknown,
  rawParams: Record<string, unknown>,
  reason: string | undefined
): AgentActionContractResult {
  const validTypes: readonly TokenLockActionKind[] = ["approve", "createLock", "withdraw", "earlyUnlock"];
  if (!validTypes.includes(actionTypeInput as TokenLockActionKind)) {
    return err("INVALID_ACTION_TYPE", `actionType for domain "tokenLock" must be one of: ${validTypes.join(", ")}.`);
  }
  const actionType = actionTypeInput as TokenLockActionKind;

  if (actionType === "approve") {
    const amount = parsePositiveBigInt(rawParams.amount, "amount");
    if (!amount) return err("INVALID_PARAMS", "approve requires a positive integer amount.");
    const data = safeEncode(() =>
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MPGR_TOKEN_LOCK_CONFIG.address, amount.value] })
    );
    if (!data) return err("INVALID_PARAMS", "Failed to encode approve() calldata from the given amount.");
    return ok({
      domain: "tokenLock",
      actionType,
      params: { actionType, amount: amount.value },
      to: MPGR_TOKEN_CONFIG.address,
      data,
      description: `Approve ${formatUnitsShort(amount.value)} MPGR for the Token Lock contract to spend`,
      riskLevel: "medium",
      reason,
    });
  }

  if (actionType === "createLock") {
    const amount = parsePositiveBigInt(rawParams.amount, "amount");
    if (!amount) return err("INVALID_PARAMS", "createLock requires a positive integer amount.");
    const unlockTime = parsePositiveBigInt(rawParams.unlockTime, "unlockTime");
    if (!unlockTime) return err("INVALID_PARAMS", "createLock requires a positive integer unlockTime (unix seconds).");
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    if (unlockTime.value <= nowSeconds) {
      return err("INVALID_PARAMS", "unlockTime must be in the future.");
    }
    const data = safeEncode(() =>
      encodeFunctionData({ abi: TOKEN_LOCK_ABI, functionName: "createLock", args: [amount.value, unlockTime.value] })
    );
    if (!data) return err("INVALID_PARAMS", "Failed to encode createLock() calldata from the given params.");
    return ok({
      domain: "tokenLock",
      actionType,
      params: { actionType, amount: amount.value, unlockTime: unlockTime.value },
      to: MPGR_TOKEN_LOCK_CONFIG.address,
      data,
      description: `Lock ${formatUnitsShort(amount.value)} MPGR until ${new Date(Number(unlockTime.value) * 1000).toISOString()}`,
      riskLevel: "medium",
      reason,
    });
  }

  // withdraw / earlyUnlock — both take only { lockId }.
  const lockId = parsePositiveBigInt(rawParams.lockId, "lockId");
  if (!lockId) return err("INVALID_PARAMS", `${actionType} requires a non-negative integer lockId.`);
  const fn = actionType === "withdraw" ? "withdraw" : "earlyUnlock";
  const data = safeEncode(() => encodeFunctionData({ abi: TOKEN_LOCK_ABI, functionName: fn, args: [lockId.value] }));
  if (!data) return err("INVALID_PARAMS", `Failed to encode ${fn}() calldata from the given lockId.`);
  return ok({
    domain: "tokenLock",
    actionType,
    params: { actionType, lockId: lockId.value } as TokenLockWithdrawParams | TokenLockEarlyUnlockParams,
    to: MPGR_TOKEN_LOCK_CONFIG.address,
    data,
    description:
      actionType === "withdraw"
        ? `Withdraw MPGR lock #${lockId.value.toString()} (already unlocked)`
        : `Early-unlock MPGR lock #${lockId.value.toString()} (10% on-chain penalty applies)`,
    riskLevel: actionType === "earlyUnlock" ? "high" : "medium",
    reason,
  });
}

function buildStakingAction(
  actionTypeInput: unknown,
  rawParams: Record<string, unknown>,
  reason: string | undefined
): AgentActionContractResult {
  const validTypes: readonly StakingActionKind[] = ["approve", "stake", "unstake", "claim", "exit"];
  if (!validTypes.includes(actionTypeInput as StakingActionKind)) {
    return err("INVALID_ACTION_TYPE", `actionType for domain "staking" must be one of: ${validTypes.join(", ")}.`);
  }
  const actionType = actionTypeInput as StakingActionKind;

  if (actionType === "approve") {
    const amount = parsePositiveBigInt(rawParams.amount, "amount");
    if (!amount) return err("INVALID_PARAMS", "approve requires a positive integer amount.");
    const data = safeEncode(() =>
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MPGR_STAKING_CONFIG.address, amount.value] })
    );
    if (!data) return err("INVALID_PARAMS", "Failed to encode approve() calldata from the given amount.");
    return ok({
      domain: "staking",
      actionType,
      params: { actionType, amount: amount.value },
      to: MPGR_TOKEN_CONFIG.address,
      data,
      description: `Approve ${formatUnitsShort(amount.value)} MPGR for the Staking contract to spend`,
      riskLevel: "medium",
      reason,
    });
  }

  if (actionType === "stake" || actionType === "unstake") {
    const amount = parsePositiveBigInt(rawParams.amount, "amount");
    if (!amount) return err("INVALID_PARAMS", `${actionType} requires a positive integer amount.`);
    const data = safeEncode(() => encodeFunctionData({ abi: STAKING_ABI, functionName: actionType, args: [amount.value] }));
    if (!data) return err("INVALID_PARAMS", `Failed to encode ${actionType}() calldata from the given amount.`);
    return ok({
      domain: "staking",
      actionType,
      params: { actionType, amount: amount.value } as StakingStakeParams | StakingUnstakeParams,
      to: MPGR_STAKING_CONFIG.address,
      data,
      description: `${actionType === "stake" ? "Stake" : "Unstake"} ${formatUnitsShort(amount.value)} MPGR`,
      riskLevel: "medium",
      reason,
    });
  }

  // claim / exit — no params. STAKING_ABI's write function for "claim" is
  // named claimRewards() on-chain (see lib/staking/staking-client.ts) —
  // the actionType label and the ABI function name intentionally differ
  // here; this mapping is the one place that difference is bridged.
  const fn = actionType === "claim" ? "claimRewards" : "exit";
  const data = safeEncode(() => encodeFunctionData({ abi: STAKING_ABI, functionName: fn, args: [] }));
  if (!data) return err("INVALID_PARAMS", `Failed to encode ${fn}() calldata.`);
  return ok({
    domain: "staking",
    actionType,
    params: { actionType } as StakingClaimParams | StakingExitParams,
    to: MPGR_STAKING_CONFIG.address,
    data,
    description: actionType === "claim" ? "Claim earned staking rewards" : "Exit staking (unstake full balance and claim rewards)",
    riskLevel: "medium",
    reason,
  });
}

function buildRewardVaultAction(
  actionTypeInput: unknown,
  rawParams: Record<string, unknown>,
  reason: string | undefined
): AgentActionContractResult {
  const validTypes: readonly VaultActionKind[] = ["claim", "claimMultiple"];
  if (!validTypes.includes(actionTypeInput as VaultActionKind)) {
    return err("INVALID_ACTION_TYPE", `actionType for domain "rewardVault" must be one of: ${validTypes.join(", ")}.`);
  }
  const actionType = actionTypeInput as VaultActionKind;

  if (actionType === "claim") {
    const rewardId = parsePositiveBigInt(rawParams.rewardId, "rewardId");
    if (!rewardId) return err("INVALID_PARAMS", "claim requires a non-negative integer rewardId.");
    const data = safeEncode(() =>
      encodeFunctionData({ abi: REWARD_VAULT_ABI, functionName: "claim", args: [rewardId.value] })
    );
    if (!data) return err("INVALID_PARAMS", "Failed to encode claim() calldata from the given rewardId.");
    return ok({
      domain: "rewardVault",
      actionType,
      params: { actionType, rewardId: rewardId.value },
      to: MPGR_REWARD_VAULT_CONFIG.address,
      data,
      description: `Claim reward #${rewardId.value.toString()} from the Reward Vault`,
      riskLevel: "medium",
      reason,
    });
  }

  // claimMultiple
  if (!Array.isArray(rawParams.rewardIds) || rawParams.rewardIds.length === 0) {
    return err("INVALID_PARAMS", "claimMultiple requires a non-empty array rewardIds.");
  }
  const rewardIds: bigint[] = [];
  for (const raw of rawParams.rewardIds) {
    const parsed = parsePositiveBigInt(raw, "rewardIds[]");
    if (!parsed) return err("INVALID_PARAMS", "claimMultiple's rewardIds must all be non-negative integers.");
    rewardIds.push(parsed.value);
  }
  const data = safeEncode(() =>
    encodeFunctionData({ abi: REWARD_VAULT_ABI, functionName: "claimMultiple", args: [rewardIds] })
  );
  if (!data) return err("INVALID_PARAMS", "Failed to encode claimMultiple() calldata from the given rewardIds.");
  return ok({
    domain: "rewardVault",
    actionType,
    params: { actionType, rewardIds },
    to: MPGR_REWARD_VAULT_CONFIG.address,
    data,
    description: `Claim ${rewardIds.length} rewards from the Reward Vault`,
    riskLevel: "medium",
    reason,
  });
}

// --- Shared construction helper ------------------------------------------
//
// Every branch above ends here so `value`, `chainId`, `requiresConfirmation`,
// `phase`, `verified`, `createdAt`, and `id` are set exactly once, the same
// way, everywhere — no branch can forget one or set it differently.
interface OkPartial {
  domain: AgentActionDomain;
  actionType: TokenLockActionKind | StakingActionKind | VaultActionKind;
  params: TokenLockActionParams | StakingActionParams | RewardVaultActionParams;
  to: Address;
  data: Hex;
  description: string;
  riskLevel: AgentToolRisk;
  reason?: string;
}

function ok(partial: OkPartial): AgentActionContractResult {
  const createdAt = new Date().toISOString();
  const action = {
    id: buildDeterministicId(partial.domain, partial.actionType, partial.to, partial.data),
    chainId: TOOL_CHAIN_ID,
    to: partial.to,
    value: 0n,
    data: partial.data,
    description: partial.description,
    reason: partial.reason,
    riskLevel: partial.riskLevel,
    requiresConfirmation: true as const,
    phase: "idle" as const,
    verified: false,
    createdAt,
    domain: partial.domain,
    actionType: partial.actionType,
    params: partial.params,
  } as AgentActionContract;
  return { ok: true, action };
}

function err(code: AgentActionContractErrorCode, message: string): AgentActionContractResult {
  return { ok: false, error: { code, message } };
}

// --- Small, dependency-free validation helpers -----------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Accepts a decimal string or a safe-integer number; rejects negatives,
// non-integers, empty strings, and anything else. Never throws.
function parsePositiveBigInt(value: unknown, _field: string): { value: bigint } | null {
  try {
    if (typeof value === "bigint") {
      return value >= 0n ? { value } : null;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) return null;
      return { value: BigInt(value) };
    }
    if (typeof value === "string" && /^[0-9]+$/.test(value)) {
      return { value: BigInt(value) };
    }
    return null;
  } catch {
    return null;
  }
}

// Wraps encodeFunctionData so a mismatched-args throw becomes `null`
// (-> INVALID_PARAMS) instead of an uncaught exception escaping this
// module — mirrors tool-helpers.ts's readOrProviderError pattern for the
// same "never let an internal exception surface" reason.
function safeEncode(fn: () => Hex): Hex | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// Coarse, non-cryptographic, deterministic identifier — good enough for
// P0.4 to dedupe/reference a proposed action, not a security boundary
// (see the `id` field's own doc comment). FNV-1a keeps this dependency
// -free and isomorphic (browser + server), matching this codebase's
// existing feature-detected `crypto.randomUUID()` fallback pattern in
// agent-tool-runtime.ts/agent-tool-context.ts, rather than pulling in
// Node's `crypto` module (which isn't available client-side).
function buildDeterministicId(domain: string, actionType: string, to: Address, data: Hex): string {
  const raw = `${domain}:${actionType}:${to.toLowerCase()}:${data}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `action_${domain}_${actionType}_${(hash >>> 0).toString(16)}`;
}

function formatUnitsShort(raw: bigint): string {
  // 18-decimal formatting without pulling in viem's formatUnits just for
  // display text in an error/description string — every amount this
  // module handles is MPGR (18 decimals), same as MPGR_TOKEN_CONFIG.decimals.
  const denom = 10n ** 18n;
  const whole = raw / denom;
  const frac = raw % denom;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "").slice(0, 4);
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}


