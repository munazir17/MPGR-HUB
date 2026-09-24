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
//   - Execution only sends the fee that was DISPLAYED on the proposal
//     and re-validated against current config (resolveExecutionAgentFee).
//     A legacy proposal without a fee, or config drift after quoting,
//     means no fee transfer.
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
 * Public env var carrying the fee-recipient wallet. Public (not
 * server-only) because the CLIENT builds the fee transfer the user's
 * wallet signs — a recipient address is not a secret. No private key is
 * ever read here; signing stays with the connected wallet.
 */
export const MPGR_AGENT_FEE_RECIPIENT_ENV = "NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT";

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

/** Validated fee-recipient wallet, or a safe skip reason. */
export function getAgentFeeRecipient(): AgentFeeRecipientResult {
  const raw = (process.env[MPGR_AGENT_FEE_RECIPIENT_ENV] ?? "").trim();
  if (!raw) {
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
    displayAmount: `${formatAtomicAmount(fee.toString(), input.from.decimals)} ${input.from.symbol}`,
    reason: null,
  };
}

export type ExecutionAgentFee =
  | { send: true; recipient: Address; amount: bigint }
  | { send: false; reason: string };

/**
 * Pre-execution validation. Only the fee that was DISPLAYED on the
 * proposal is ever sent, and only after re-validating it against the
 * current configuration. Anything else (legacy proposal without a fee,
 * config drift after quoting, tampered amount/recipient) means no fee
 * transfer — the swap itself is unaffected.
 */
export function resolveExecutionAgentFee(proposal: TradeProposal): ExecutionAgentFee {
  const displayed = proposal.agentFee;
  if (!displayed || displayed.status !== "applied") {
    return { send: false, reason: displayed?.reason ?? "No agent fee on this proposal." };
  }
  const expected = buildProposalAgentFee({
    fromAmount: proposal.fromAmount,
    from: proposal.from,
    taker: proposal.taker,
    executionAvailable: proposal.executionAvailable,
  });
  if (expected.status !== "applied" || !expected.recipient) {
    return {
      send: false,
      reason: expected.reason ?? "Agent fee is no longer collectible.",
    };
  }
  if (
    expected.recipient.toLowerCase() !== displayed.recipient?.toLowerCase() ||
    expected.amountAtomic !== displayed.amountAtomic
  ) {
    return {
      send: false,
      reason: "Quoted agent fee no longer matches current configuration — no fee is charged.",
    };
  }
  let amount: bigint;
  try {
    amount = BigInt(displayed.amountAtomic);
  } catch {
    return { send: false, reason: "Quoted agent fee amount is invalid — no fee is charged." };
  }
  if (amount <= 0n) {
    return { send: false, reason: "Quoted agent fee amount is invalid — no fee is charged." };
  }
  return { send: true, recipient: expected.recipient, amount };
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
