// lib/trade/trade-agent-fee.ts
//
// MPGR Agent swap fee: 0.25% (25 bps) on the SELL leg — collected by the
// MPGR Executor INSIDE the swap transaction.
//
// Design (see docs/TRADE.md "MPGR Agent fee" and docs/EXECUTOR.md):
//   - The fee is computed ONLY from the proposal's `fromAmount`
//     (GROSS sell-token atomic units): floor(fromAmount * 25 / 10_000).
//     No decimals math is needed for the amount itself, so tokens with
//     different decimals (USDC 6, ETH/WETH 18, B20 8, …) are exact by
//     construction. Decimals are used for DISPLAY only.
//   - The fee is taken by the MPGR Executor in the SAME transaction as
//     the swap: the user's wallet sends `grossAmountIn` to the executor,
//     the executor forwards `floor(gross * feeBps / 10_000)` to its own
//     configured `feeRecipient()` and swaps `gross - fee`. One approval
//     (when the allowance is short) plus one swap — never a third
//     transaction. This module intentionally exposes NO transfer builder:
//     there is no supported way to pay this fee out-of-band.
//   - The recipient is the EXECUTOR's configured `feeRecipient()`
//     (mirrored in lib/executor/executor-config.ts, read live at quote
//     time). It is never the connected/taker wallet — the contract
//     reverts with `TakerIsFeeRecipient` if it ever were — and never a
//     frontend-supplied address.
//   - `status: "applied"` therefore only ever describes an executor
//     proposal. Every other route (CDP Trade API, 0x, Aerodrome
//     Slipstream) is quoted `status: "skipped"` with a reason: those
//     routes cannot carry an executor fee, and charging it separately is
//     not supported.
//   - 0x integrator fees: the MCP 0x fallback path configures its fee in
//     the 0x quote itself (`swapFeeToken` = sell token, still inside the
//     swap transaction) and uses getAgentFeeRecipient() below. That path
//     never touches the browser flow.
//
// Import-safe: used by both server routes (proposal building) and the
// client (execution + confirmation modal). No `server-only`, no fetches,
// no signing.

import { isAddress, zeroAddress, type Address } from "viem";

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT } from "@/lib/executor/executor-config";
import { formatAtomicAmount } from "./trade-format";
import type { TradeAgentFee, TradeProposal, TradeTokenRef } from "./trade-types";

/** 25 basis points = 0.25%. Compile-time constant, never env-configured. */
export const MPGR_AGENT_FEE_BPS = 25;
/** Basis-point denominator. */
export const MPGR_AGENT_FEE_DENOMINATOR = 10_000n;
export const MPGR_AGENT_FEE_PERCENT_LABEL = "0.25%";

/**
 * Why a non-executor route carries no fee. Shown in the proposal's
 * `agentFee.reason`; the UI simply omits the fee row for skipped fees.
 */
export const AGENT_FEE_EXECUTOR_ONLY_REASON =
  "The MPGR fee is collected inside the swap transaction by the MPGR Executor, which does not route this pair — no fee is charged.";

/**
 * Server-only env var carrying the 0x fallback fee wallet used by the MCP
 * 0x-native-fee path (never by the browser trade flow, which uses the
 * executor's on-chain `feeRecipient()`). A recipient address is not a
 * secret; no private key is ever read here.
 */
export const MPGR_AGENT_FEE_RECIPIENT_SERVER_ENV = "MPGR_AGENT_FEE_RECIPIENT";
/**
 * Public fallback carrying the 0x fallback fee wallet. NEXT_PUBLIC_* values
 * are inlined at BUILD time — after adding or rotating this variable the
 * deployment MUST be rebuilt. Signing always stays with the connected wallet.
 */
export const MPGR_AGENT_FEE_RECIPIENT_ENV = "NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT";

let warnedMissingRecipient = false;

/** Test hook — resets the one-time missing-recipient warning. */
export function resetAgentFeeConfigWarningForTests(): void {
  warnedMissingRecipient = false;
}

function warnMissingRecipientOnce(): void {
  if (warnedMissingRecipient) return;
  warnedMissingRecipient = true;
  console.warn(
    "[mpgr-agent-fee] 0x fallback fee-recipient wallet is not configured — 0x quotes proceed with no fee. " +
      "Set MPGR_AGENT_FEE_RECIPIENT (server) or NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT and redeploy. " +
      "Executor quotes do not use this variable.",
  );
}

function parsePositiveAtomic(raw: string): bigint | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  try {
    const amount = BigInt(text);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Exact fee: floor(fromAmount * 25 / 10_000).
 * Returns 0n for dust (fromAmount < 400 atomic units) — never negative,
 * never rounded up, always strictly less than fromAmount for any
 * positive input.
 */
export function calculateAgentFeeAmount(fromAmount: string): bigint | null {
  const amount = parsePositiveAtomic(fromAmount);
  if (amount === null) return null;
  return (amount * BigInt(MPGR_AGENT_FEE_BPS)) / MPGR_AGENT_FEE_DENOMINATOR;
}

export type AgentFeeRecipientResult =
  | { ok: true; recipient: Address }
  | { ok: false; reason: string };

/**
 * Validated 0x-fallback fee-recipient wallet, or a safe skip reason.
 * Server-only MPGR_AGENT_FEE_RECIPIENT wins when set; the public
 * NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT is the fallback (the only one a
 * browser bundle can see). A missing recipient warns once per process
 * (server log / console) so a silently uncollected fee is diagnosable.
 *
 * NOTE: this is the 0x integrator-fee wallet for the MCP 0x fallback path
 * only. The browser trade flow charges through the MPGR Executor, whose
 * recipient is read from the executor contract — see executorFeeRecipient().
 */
export function getAgentFeeRecipient(): AgentFeeRecipientResult {
  // First non-empty value wins: an empty/whitespace var behaves as unset
  // rather than shadowing the fallback (an explicit "" must never act as
  // a kill-switch for a configured fallback).
  const serverRaw = (process.env[MPGR_AGENT_FEE_RECIPIENT_SERVER_ENV] ?? "").trim();
  const publicRaw = (process.env[MPGR_AGENT_FEE_RECIPIENT_ENV] ?? "").trim();
  const raw = serverRaw || publicRaw;
  if (!raw) {
    warnMissingRecipientOnce();
    return {
      ok: false,
      reason: "MPGR 0x fallback fee wallet is not configured — no fee is charged.",
    };
  }
  if (!isAddress(raw) || raw.toLowerCase() === zeroAddress.toLowerCase()) {
    return {
      ok: false,
      reason: "MPGR 0x fallback fee wallet address is invalid — no fee is charged.",
    };
  }
  return { ok: true, recipient: raw as Address };
}

/**
 * The executor's configured fee recipient — the ONLY address this app ever
 * pays the MPGR fee to. The recorded deployment value is the fallback; the
 * quote path prefers the live on-chain `feeRecipient()` read.
 */
export function recordedExecutorFeeRecipient(): Address {
  return BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient;
}

/** The MPGR Executor that must carry an applied fee (Base Mainnet). */
export function recordedExecutorAddress(): Address {
  return BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor;
}

export function skippedAgentFee(reason: string): TradeAgentFee {
  return {
    status: "skipped",
    bps: null,
    recipient: null,
    amountAtomic: "0",
    displayAmount: null,
    reason,
    collection: null,
  };
}

export type ExecutorFeeBuild =
  | { ok: true; fee: TradeAgentFee }
  | { ok: false; reason: string };

/**
 * Fee for an executor-routed swap, built from the GROSS sell amount that
 * the executor will pull. Fails closed (returns a reason) whenever the fee
 * could not be taken inside the executor transaction, so a quote can never
 * advertise a fee that the swap does not collect.
 *
 * Rejects: non-positive/invalid gross, taker == fee recipient (the
 * contract reverts `TakerIsFeeRecipient`), zero-address/invalid recipient,
 * a fee that rounds to zero (the contract reverts `FeeRoundsToZero`), and
 * a fee that is not strictly smaller than the gross amount.
 */
export function buildExecutorAgentFee(input: {
  grossAmountIn: string;
  feeBps: number;
  feeRecipient: string | null | undefined;
  from: Pick<TradeTokenRef, "symbol" | "decimals">;
  taker: string;
}): ExecutorFeeBuild {
  const recipient = typeof input.feeRecipient === "string" ? input.feeRecipient.trim() : "";
  if (!recipient || !isAddress(recipient) || recipient.toLowerCase() === zeroAddress.toLowerCase()) {
    return { ok: false, reason: "The executor's fee recipient is not configured — no fee is charged." };
  }
  if (input.taker.trim().toLowerCase() === recipient.toLowerCase()) {
    return { ok: false, reason: "The executor's fee recipient is the trading wallet — no fee is charged." };
  }
  const gross = parsePositiveAtomic(input.grossAmountIn);
  if (gross === null) {
    return { ok: false, reason: "Swap amount is not a valid positive amount — no fee is charged." };
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps <= 0) {
    return { ok: false, reason: "The executor fee is not configured — no fee is charged." };
  }
  const fee = (gross * BigInt(input.feeBps)) / MPGR_AGENT_FEE_DENOMINATOR;
  if (fee <= 0n) {
    return { ok: false, reason: "Fee rounds to zero at this size — no fee is charged." };
  }
  if (fee >= gross) {
    return { ok: false, reason: "Fee is not smaller than the swap amount — no fee is charged." };
  }
  return {
    ok: true,
    fee: {
      status: "applied",
      bps: input.feeBps,
      recipient: recipient as Address,
      amountAtomic: fee.toString(),
      // Sell-token precision for display only — never for the amount itself.
      displayAmount: `${formatAtomicAmount(fee.toString(), input.from.decimals, input.from.decimals)} ${input.from.symbol}`,
      reason: null,
      collection: "mpgr-executor",
    },
  };
}

export type AgentFeeSwapInvariant =
  | { ok: true; fee: { recipient: Address; amount: bigint } }
  | { ok: true; fee: null }
  | { ok: false; reason: string };

/**
 * Pre-broadcast invariant for the swap flow: an APPLIED fee must be
 * collected by the executor inside the transaction that is about to be
 * signed. If a proposal claims a fee but its transaction does not target
 * the MPGR Executor (or the fee cannot be witnessed inside that swap), the
 * execution path stops BEFORE any wallet prompt rather than resolving the
 * fee some other way — there is no other way.
 *
 * Returns `{ ok: true, fee: null }` for fee-less proposals (legacy
 * payloads and non-executor routes): nothing extra is sent, ever.
 */
export function verifyAgentFeeInSwapTransaction(proposal: TradeProposal): AgentFeeSwapInvariant {
  const displayed = proposal.agentFee;
  if (!displayed || displayed.status !== "applied") return { ok: true, fee: null };

  if (displayed.collection !== "mpgr-executor") {
    return { ok: false, reason: "This proposal quoted an MPGR fee outside the MPGR Executor — nothing was signed." };
  }
  const recipient = displayed.recipient;
  if (
    typeof recipient !== "string" ||
    !isAddress(recipient) ||
    recipient.toLowerCase() === zeroAddress.toLowerCase()
  ) {
    return { ok: false, reason: "The quoted MPGR fee recipient is invalid — nothing was signed." };
  }
  if (proposal.taker.trim().toLowerCase() === recipient.toLowerCase()) {
    return { ok: false, reason: "The quoted MPGR fee recipient is the trading wallet — nothing was signed." };
  }
  const executor = recordedExecutorAddress();
  const target = proposal.transaction?.to;
  if (typeof target !== "string" || !isAddress(target) || target.toLowerCase() !== executor.toLowerCase()) {
    return { ok: false, reason: "The quoted MPGR fee is not collected by the MPGR Executor — nothing was signed." };
  }
  const gross = parsePositiveAtomic(proposal.fromAmount);
  const expected = calculateAgentFeeAmount(proposal.fromAmount);
  let amount: bigint;
  try {
    amount = BigInt(displayed.amountAtomic);
  } catch {
    return { ok: false, reason: "The quoted MPGR fee amount is invalid — nothing was signed." };
  }
  if (gross === null || expected === null || expected <= 0n || amount !== expected || amount <= 0n || amount >= gross) {
    return { ok: false, reason: "The quoted MPGR fee does not match the swap amount — nothing was signed." };
  }
  return { ok: true, fee: { recipient: recipient as Address, amount } };
}
