"use client";

import { useId } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeftRight, CheckCircle2, Loader2, X } from "lucide-react";

import { formatAddress } from "@/lib/format";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import type { TradeConfirmationState } from "@/lib/trade/trade-confirmation";
import type { TradeExecutionState } from "@/lib/trade/trade-execution";
import type { TradeError, TradeProposal } from "@/lib/trade/trade-types";

interface AgentTradeConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  proposal: TradeProposal | null;
  confirmationState: TradeConfirmationState;
  confirmationError: TradeError | null;
  executionState: TradeExecutionState;
  executionError: TradeError | null;
  approvalHash: `0x${string}` | null;
  swapHash: `0x${string}` | null;
  // Retained for callers/diagnostics; internal execution copy is not presented.
  stepLabel: string | null;
  feeHash?: `0x${string}` | null;
  feeError?: TradeError | null;
  onConfirmAndSwap?: () => void;
}

/** Presentation only: never infer decimals or display a raw fee-token address. */
function feeRows(proposal: TradeProposal): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, fee: { amount: string; token: string } | undefined) => {
    if (!fee?.amount) return;
    const known = findKnownTradeToken(fee.token) ?? [proposal.from, proposal.to].find(
      (token) => token.address.toLowerCase() === fee.token.toLowerCase(),
    );
    rows.push({
      label,
      value: known
        ? `${formatAtomicAmount(fee.amount, known.decimals, known.decimals)} ${known.symbol}`
        : `${fee.amount} base units`,
    });
  };
  push("Swap fee", proposal.fees.protocolFee);
  push("Est. network fee", proposal.fees.gasFee);
  return rows;
}

function formatPriceImpact(bps: number | null | undefined): string | null {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return null;
  return `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
}

function isBusy(confirmationState: TradeConfirmationState, executionState: TradeExecutionState): boolean {
  return (
    confirmationState === "VALIDATING" ||
    executionState === "REQUOTING" ||
    executionState === "APPROVING" ||
    executionState === "AWAITING_PERMIT" ||
    executionState === "AWAITING_WALLET" ||
    executionState === "PENDING"
  );
}

/** Keep error codes/handling intact; do not echo provider/configuration text. */
function userError(error: TradeError | null, submitted: boolean): string {
  switch (error?.code) {
    case "WALLET_REJECTED": return "You declined the wallet request.";
    case "WALLET_REQUIRED": return "Connect the wallet for this swap to continue.";
    case "UNSUPPORTED_NETWORK": return "Switch your wallet to Base to continue.";
    case "INSUFFICIENT_BALANCE": return "Not enough balance for this swap. Add funds or lower the amount.";
    case "QUOTE_EXPIRED": return "This quote has expired. Request a fresh quote.";
    case "QUOTE_CHANGED": return "The price changed. Request a fresh quote before confirming.";
    case "APPROVAL_FAILED": return "Token approval failed. Check your wallet before trying again.";
    case "SIGNING_FAILED": return "Your wallet could not confirm this swap. Please try again.";
    case "SEND_FAILED": return "Swap failed. Check any submitted transaction before trying again.";
    case "PROVIDER_ERROR": return submitted
      ? "Confirmation is unavailable. Check the submitted transaction before trying again."
      : "Swap details are temporarily unavailable. Please try again.";
    case "CREDENTIALS_MISSING":
    case "LIQUIDITY_UNAVAILABLE":
    case "EXECUTION_UNAVAILABLE": return "This swap is currently unavailable. Please try again later.";
    default: return "Unable to complete this swap. Review the details and request a fresh quote.";
  }
}

/** Preserve meaningful safety warnings, without internal titles or addresses. */
function userWarnings(proposal: TradeProposal): string[] {
  return [...new Set(proposal.risk.flatMap((fact) => {
    if (fact.severity === "info") return [];
    switch (fact.id) {
      case "unverified-from": return ["The token you are selling is unverified. Check it before confirming."];
      case "unverified-to": return ["The token you are buying is unverified. Check it before confirming."];
      case "no-liquidity": return ["This swap is currently unavailable."];
      case "insufficient-balance": return ["Not enough balance for this swap. Add funds or lower the amount."];
      case "sim-incomplete": return ["This swap could not be fully checked and may fail."];
      case "high-slippage": return ["High slippage allows a larger price change before your swap completes."];
      // Approval is displayed once from its execution flag. Provider/stock
      // descriptions are not additional confirmation warnings.
      default: return fact.severity === "critical" ? ["Review the trade details carefully before confirming."] : [];
    }
  }))];
}

export function AgentTradeConfirmationModal({
  open, onClose, proposal, confirmationState, confirmationError,
  executionState, executionError, approvalHash, swapHash, feeHash, feeError,
  onConfirmAndSwap,
}: AgentTradeConfirmationModalProps) {
  const titleId = useId();
  if (!proposal) return null;

  const busy = isBusy(confirmationState, executionState);
  const failed = confirmationState === "VALIDATION_FAILED" || executionState === "ERROR";
  const settled = executionState === "SUCCESS";
  const canConfirm =
    confirmationState === "READY_FOR_CONFIRMATION" &&
    executionState === "IDLE" &&
    proposal.executionAvailable;
  const error = executionError ?? confirmationError;
  const impact = formatPriceImpact(proposal.priceImpactBps);
  const fees = feeRows(proposal);
  const warnings = userWarnings(proposal);
  const status = executionState === "PENDING"
    ? "Transaction submitted…"
    : executionState === "REQUOTING" || confirmationState === "VALIDATING"
      ? "Updating swap details…"
      : "Waiting for wallet confirmation…";
  const amount = (value: string, token: TradeProposal["from"]) =>
    `${formatAtomicAmount(value, token.decimals, token.decimals)} ${token.symbol}`;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}
            className="max-h-[90dvh] w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-t-3xl border border-white/[0.08] bg-surface bg-gradient-surface p-6 shadow-glow-lg sm:rounded-3xl sm:p-8"
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5 text-good" aria-hidden="true" />
                <h2 id={titleId} className="text-sm font-semibold text-white">Confirm swap</h2>
              </div>
              <button type="button" onClick={onClose} disabled={busy} className="flex h-11 w-11 shrink-0 items-center justify-center text-zinc-400 hover:text-white disabled:opacity-40" aria-label="Close">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <dl className="mb-4 space-y-3 rounded-xl border border-white/10 bg-white/5 p-4 text-xs">
              <div className="border-b border-white/10 pb-3">
                <dt className="mb-1 text-zinc-400">Swap</dt>
                <dd className="flex flex-wrap items-baseline gap-x-1.5 text-base font-semibold text-white">
                  <span className="min-w-0 break-words">{amount(proposal.fromAmount, proposal.from)}</span>
                  <span className="text-zinc-400">→</span>
                  <span className="min-w-0 break-words">~{amount(proposal.toAmount, proposal.to)}</span>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-400">Minimum received</dt>
                <dd className="min-w-0 break-words text-right text-white">{amount(proposal.minToAmount, proposal.to)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-400">Network</dt>
                <dd className="text-white">Base</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-400">Slippage</dt>
                <dd className="text-white">{proposal.slippageBps / 100}%</dd>
              </div>
              {impact !== null && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-400">Price impact</dt>
                  <dd className={(proposal.priceImpactBps ?? 0) < 0 ? "text-amber-300" : "text-good"}>{impact}</dd>
                </div>
              )}
              {fees.map((fee) => (
                <div key={fee.label} className="flex justify-between gap-3">
                  <dt className="text-zinc-400">{fee.label}</dt>
                  <dd className="min-w-0 break-words text-right text-white">{fee.value}</dd>
                </div>
              ))}
              {proposal.agentFee?.status === "applied" && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-400">MPGR fee{proposal.agentFee.bps !== null ? ` (${proposal.agentFee.bps / 100}%)` : ""}</dt>
                  <dd className="min-w-0 break-words text-right text-white">
                    {amount(proposal.agentFee.amountAtomic, proposal.from)}
                    <span className="mt-0.5 block text-[11px] text-zinc-400">Paid separately after the swap</span>
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-400">Recipient</dt>
                <dd className="font-mono text-white">{formatAddress(proposal.taker).replace("...", "…")}</dd>
              </div>
            </dl>

            {proposal.needsPermit2Approval && !approvalHash && !busy && !failed && !settled && (
              <p className="mb-3 text-xs text-zinc-300">Token approval required</p>
            )}
            {warnings.length > 0 && (
              <ul className="mb-3 space-y-1 text-xs text-amber-300">
                {warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
            <p className="mb-4 text-xs leading-relaxed text-zinc-400">
              Your wallet signs and sends this transaction. MPGR never has access to your private key.
            </p>

            {busy && (
              <div role="status" aria-live="polite" className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />{status}
              </div>
            )}
            {(failed || confirmationState === "WALLET_REQUIRED") && (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm text-bad">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{userError(error, !!swapHash)}</span>
              </div>
            )}
            {settled && (
              <div role="status" className="mb-4 flex items-center gap-2 text-sm text-good">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />Swap confirmed
              </div>
            )}
            {settled && feeError && (
              <div role="alert" className="mb-4 text-xs text-amber-300">
                {feeError.code === "WALLET_REJECTED"
                  ? "Your swap is confirmed, but you declined the separate fee payment."
                  : "Your swap is confirmed, but the separate fee payment could not be confirmed. Check your wallet before retrying it."}
              </div>
            )}
            {(approvalHash || swapHash || feeHash) && (
              <div className="mb-4 flex flex-wrap gap-3 text-xs">
                {([["Approval", approvalHash], ["Swap", swapHash], ["Fee", feeHash]] as const).map(([label, hash]) => hash && (
                  <a key={label} href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="text-primary-glow underline">View {label.toLowerCase()} on BaseScan</a>
                ))}
              </div>
            )}
            {!settled && (
              <button type="button" onClick={onConfirmAndSwap} disabled={!canConfirm} className="btn-primary w-full text-sm">
                {busy ? status : failed || !proposal.executionAvailable ? "Swap unavailable" : "Confirm & Swap"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
