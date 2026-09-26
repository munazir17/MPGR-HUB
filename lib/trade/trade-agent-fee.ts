// lib/trade/trade-agent-fee.ts
//
// MPGR Agent swap fee: 0.25% (25 bps) on the SELL leg.
//
// Design (safest compatible approach — see docs/TRADE.md "MPGR Agent fee"):
//   - The fee is computed ONLY from the proposal's `fromAmount`
//     (sell-token atomic units): floor(fromAmount * 25 / 10_000).
//     No decimals math is needed for the amount itself, so tokens with
//     different decimals (USDC 6, ETH/WETH 18, B20 8, …) are exact by
//     construction. Decimals are used for DISPLAY only.
//   - The fee is collected as a SEPARATE wallet-signed transfer AFTER
//     the swap settles (ERC-20 `transfer` to the fee wallet, or a native
//     value transfer when selling ETH). It never touches the swap quote,
//     calldata, approvals, slippage, routing, or min-out.
//   - Fail-open for the swap, fail-closed for the fee: when the fee
//     wallet is unconfigured/invalid, the fee amount is dust (0), or the
//     fee transfer itself fails, the swap proceeds/stands exactly as it
//     does today. The fee is informational and non-blocking by design —
//     there is no custodial signing flow and nothing is ever forced.
//   - The SERVER is the source of truth for the fee. Execution only sends
//     the fee that was DISPLAYED on the proposal, after STRUCTURAL
//     re-validation that needs no client-side env (resolveExecutionAgentFee
//     recomputes the exact amount from the proposal's fromAmount and
//     validates the recipient address). A legacy proposal without a fee,
//     or a tampered/invalid fee, means no fee transfer.
//   - Incident 2026-09-24: a production swap settled with no fee because
//     the production deployment was BUILT before the fee-recipient env var
//     was added — NEXT_PUBLIC_* values are inlined at build time
//     (verified in the shipped client bundle), and Vercel does not backfill
//     env into running deployments. The running build therefore quoted
//     `skipped` and settled no fee. Fix: the client no longer depends on
//     its own build-time env to settle a server-quoted fee, the server
//     also honors a server-only MPGR_AGENT_FEE_RECIPIENT, a missing
//     recipient emits a one-time warning (server log / console) instead of
//     failing silently, and the docs state the redeploy requirement. The
//     swap flow itself (routing, quote, calldata, approvals, slippage,
//     execution) is unchanged.
//
// Import-safe: used by both server routes (proposal building) and the
// client (execution + confirmation modal). No `server-only`, no fetches,
// no signing.

import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex } from "viem";

import { erc20Abi } from "@/lib/erc20-abi";
import { isNativeEthSentinel } from "./trade-config";
import { formatAtomicAmount } from "./trade-format";
import type { TradeAgentFee, TradeProposal } from "./trade-types";

/** 25 basis points = 0.25%. Compile-time constant, never env-configured. */
export const MPGR_AGENT_FEE_BPS = 25;
/** Basis-point denominator. */
export const MPGR_AGENT_FEE_DENOMINATOR = 10_000n;
export const MPGR_AGENT_FEE_PERCENT_LABEL = "0.25%";
/**
 * Server-only env var carrying the fee-recipient wallet (preferred on the
 * server: quote-time is the source of truth for the fee). A recipient
 * address is not a secret; no private key is ever read here.
 */
export const MPGR_AGENT_FEE_RECIPIENT_SERVER_ENV = "MPGR_AGENT_FEE_RECIPIENT";
/**
 * Public fallback carrying the fee-recipient wallet. NEXT_PUBLIC_* values
 * are inlined at BUILD time — after adding or rotating this variable the
 * deployment MUST be rebuilt, otherwise the running build keeps the old
 * (or missing) value. Signing always stays with the connected wallet.
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
    "[mpgr-agent-fee] fee-recipient wallet is not configured — swaps proceed with no fee. " +
      "Set MPGR_AGENT_FEE_RECIPIENT (server) or NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT and redeploy.",
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
 * Validated fee-recipient wallet, or a safe skip reason.
 * Server-only MPGR_AGENT_FEE_RECIPIENT wins when set; the public
 * NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT is the fallback (the only one a
 * browser bundle can see). A missing recipient warns once per process
 * (server log / console) so a silently uncollected fee is diagnosable.
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
      reason: "MPGR agent-fee wallet is not configured — no fee is charged.",
    };
  }
  if (!isAddress(raw) || raw.toLowerCase() === zeroAddress.toLowerCase()) {
    return {
      ok: false,
      reason: "MPGR agent-fee wallet address is invalid — no fee is charged.",
    };
  }
  return { ok: true, recipient: raw as Address };
}

function skipped(reason: string): TradeAgentFee {
  return {
    status: "skipped",
    bps: null,
    recipient: null,
    amountAtomic: "0",
    displayAmount: null,
    reason,
  };
}

/**
 * Fee for a TradeProposal, built at quote time from the quoted
 * `fromAmount`. Pure: quote amounts, calldata, and slippage are inputs,
 * never modified.
 */
export function buildProposalAgentFee(input: {
  fromAmount: string;
  from: Pick<TradeProposal["from"], "symbol" | "decimals">;
  taker: string;
  executionAvailable: boolean;
}): TradeAgentFee {
  if (!input.executionAvailable) {
    return skipped("No executable swap — no fee is charged.");
  }
  const recipient = getAgentFeeRecipient();
  if (!recipient.ok) return skipped(recipient.reason);
  if (input.taker.trim().toLowerCase() === recipient.recipient.toLowerCase()) {
    return skipped("MPGR agent-fee wallet matches the taker — no fee is charged.");
  }
  const fromAmount = parsePositiveAtomic(input.fromAmount);
  if (fromAmount === null) {
    return skipped("Swap amount is not a valid positive amount — no fee is charged.");
  }
  const fee = calculateAgentFeeAmount(input.fromAmount);
  if (fee === null) {
    return skipped("Swap amount is not a valid positive amount — no fee is charged.");
  }
  if (fee <= 0n) {
    return skipped("Fee rounds to zero at this size — no fee is charged.");
  }
  // Mathematically impossible at 25 bps (fee < fromAmount for every
  // positive input), but fail closed rather than trust the arithmetic.
  if (fee >= fromAmount) {
    return skipped("Fee is not smaller than the swap amount — no fee is charged.");
  }
  return {
    status: "applied",
    bps: MPGR_AGENT_FEE_BPS,
    recipient: recipient.recipient,
    amountAtomic: fee.toString(),
    displayAmount: `${formatAtomicAmount(fee.toString(), input.from.decimals, input.from.decimals)} ${input.from.symbol}`,
    reason: null,
  };
}

export type ExecutionAgentFee =
  | { send: true; recipient: Address; amount: bigint }
  | { send: false; reason: string };

/**
 * Pre-execution validation. Only the fee that was DISPLAYED on the
 * proposal is ever sent, and only after STRUCTURAL re-validation that
 * deliberately needs no client-side env: the server is the source of
 * truth for the fee, and the client already trusts server-provided swap
 * calldata for 100% of the funds, so requiring the client's own
 * build-time env to match for the 0.25% fee would be both incoherent and
 * fragile (stale tabs, CDN-cached bundles, and deploy skew would silently
 * suppress a quoted fee — the 2026-09-24 incident).
 *
 * Checks: proposal is executable, fee was displayed as applied, recipient
 * is a valid non-zero address different from the taker, and the displayed
 * amount EXACTLY equals floor(fromAmount * 25 / 10_000) recomputed from
 * the proposal (any tampered amount fails this equality). Anything else —
 * legacy proposal without a fee, invalid recipient, amount mismatch —
 * means no fee transfer. The swap itself is unaffected either way.
 */
export function resolveExecutionAgentFee(proposal: TradeProposal): ExecutionAgentFee {
  const displayed = proposal.agentFee;
  if (!displayed || displayed.status !== "applied") {
    return { send: false, reason: displayed?.reason ?? "No agent fee on this proposal." };
  }
  if (!proposal.executionAvailable) {
    return { send: false, reason: "No executable swap — no fee is charged." };
  }
  const recipient = displayed.recipient;
  if (
    typeof recipient !== "string" ||
    !isAddress(recipient) ||
    recipient.toLowerCase() === zeroAddress.toLowerCase()
  ) {
    return { send: false, reason: "Quoted agent-fee wallet address is invalid — no fee is charged." };
  }
  if (proposal.taker.trim().toLowerCase() === recipient.toLowerCase()) {
    return { send: false, reason: "MPGR agent-fee wallet matches the taker — no fee is charged." };
  }
  const fromAmount = parsePositiveAtomic(proposal.fromAmount);
  const expected = calculateAgentFeeAmount(proposal.fromAmount);
  let amount: bigint;
  try {
    amount = BigInt(displayed.amountAtomic);
  } catch {
    return { send: false, reason: "Quoted agent fee amount is invalid — no fee is charged." };
  }
  if (fromAmount === null || expected === null || expected <= 0n || amount <= 0n || amount >= fromAmount) {
    return { send: false, reason: "Quoted agent fee amount is invalid — no fee is charged." };
  }
  if (amount !== expected) {
    return { send: false, reason: "Quoted agent fee does not match the swap amount — no fee is charged." };
  }
  return { send: true, recipient: recipient as Address, amount };
}

export type AgentFeeTransfer =
  | { kind: "erc20"; to: Address; data: Hex; value: bigint }
  | { kind: "native"; to: Address; value: bigint };

/**
 * Unsigned fee-transfer parameters for the user's wallet to sign AFTER
 * the swap settles. ERC-20 sell → `transfer(recipient, fee)` on the sell
 * token (no approval needed — a direct transfer from the signer). Native
 * ETH sell → a plain value transfer. Never signs or broadcasts.
 */
export function buildAgentFeeTransfer(input: {
  fromAddress: Address;
  recipient: Address;
  amount: bigint;
}): AgentFeeTransfer {
  if (isNativeEthSentinel(input.fromAddress)) {
    return { kind: "native", to: input.recipient, value: input.amount };
  }
  return {
    kind: "erc20",
    to: input.fromAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [input.recipient, input.amount],
    }),
    value: 0n,
  };
}
