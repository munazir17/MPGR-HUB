"use client";

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
  stepLabel: string | null;
  feeHash?: `0x${string}` | null;
  feeError?: TradeError | null;
  onConfirmAndSwap?: () => void;
}

/**
 * Fee rows from the quote itself (CDP gas + protocol fee, or the 0x gas
 * fee). Amounts arrive as atomic-unit strings; they are rendered with the
 * fee token's real decimals when that token is in the app's catalog, and
 * otherwise shown with the atomic value labelled as such — never
 * re-scaled by a guessed decimals value.
 */
function feeRows(fees: TradeProposal["fees"]): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, fee: { amount: string; token: string } | undefined | null) => {
    if (!fee || !fee.amount) return;
    const known = findKnownTradeToken(fee.token);
    const amount = known
      ? `${formatAtomicAmount(fee.amount, known.decimals)} ${known.symbol}`
      : `${fee.amount} ${fee.token || "atomic units"}`;
    rows.push({ label, value: amount });
  };
  push("Protocol fee", fees.protocolFee);
  push("Est. gas fee", fees.gasFee);
  return rows;
}

function formatPriceImpact(bps: number | null | undefined): string | null {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return null;
  const sign = bps > 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}%`;
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

export function AgentTradeConfirmationModal({
  open,
  onClose,
  proposal,
  confirmationState,
  confirmationError,
  executionState,
  executionError,
  approvalHash,
  swapHash,
  stepLabel,
  feeHash,
  feeError,
  onConfirmAndSwap,
}: AgentTradeConfirmationModalProps) {
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
  const fees = feeRows(proposal.fees);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="w-full max-w-[440px] rounded-t-3xl border border-white/[0.08] bg-surface bg-gradient-surface p-6 shadow-glow-lg sm:rounded-3xl sm:p-8"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5 text-good" />
                <h2 className="text-sm font-semibold text-white">
                  {proposal.kind === "tokenized-stock-swap" ? "Confirm tokenized-stock swap" : "Confirm swap"}
                </h2>
              </div>
              <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-sm text-zinc-300">{proposal.description}</p>

            <dl className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You sell</dt>
                <dd className="text-white">{proposal.displayFromAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You receive (est.)</dt>
                <dd className="text-white">{proposal.displayToAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Minimum out</dt>
                <dd className="text-white">{proposal.displayMinToAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Network</dt>
                <dd className="text-white">Base</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Slippage</dt>
                <dd className="text-white">{proposal.slippageBps / 100}%</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Route</dt>
                <dd className="text-white">{proposal.providerLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Price impact</dt>
                <dd
                  className={
                    impact === null
                      ? "text-zinc-500"
                      : (proposal.priceImpactBps ?? 0) < 0
                        ? "text-amber-300"
                        : "text-good"
                  }
                >
                  {impact ?? "not reported"}
                </dd>
              </div>
              {fees.map((fee) => (
                <div key={fee.label} className="flex justify-between gap-3">
                  <dt className="text-zinc-500">{fee.label}</dt>
                  <dd className="text-white">{fee.value}</dd>
                </div>
              ))}
              {proposal.agentFee?.status === "applied" && proposal.agentFee.displayAmount && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">MPGR agent fee (0.25%)</dt>
                  <dd className="text-white">{proposal.agentFee.displayAmount} (separate tx)</dd>
                </div>
              )}
              {fees.length === 0 && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Fees</dt>
                  <dd className="text-zinc-500">
                    none reported by the route — your wallet shows network cost before you sign
                  </dd>
                </div>
              )}
              {proposal.needsPermit2Approval && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Steps</dt>
                  <dd className="text-white">
                    {proposal.permit2
                      ? "Sign Permit2, then swap"
                      : proposal.provider === "aerodrome-slipstream"
                        ? "Approve Aerodrome SwapRouter, then swap"
                      : proposal.provider === "0x-swap-api"
                        ? "Approve AllowanceHolder, then swap"
                        : "Approve token spending, then swap"}
                  </dd>
                </div>
              )}
            </dl>

            {proposal.risk.length > 0 && (
              <ul className="mb-4 max-h-32 space-y-1 overflow-y-auto text-[11px] text-amber-300">
                {proposal.risk
                  .filter((fact) => fact.severity !== "info")
                  .map((fact) => (
                    <li key={fact.id}>
                      {fact.title}: {fact.detail}
                    </li>
                  ))}
              </ul>
            )}

            {busy && (
              <div className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                {stepLabel ?? "Working…"}
              </div>
            )}

            {failed && error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm text-bad">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error.message}</span>
              </div>
            )}

            {settled && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-good/30 bg-good/10 p-3 text-sm text-good">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Swap settled
                  {swapHash ? ` — ${formatAddress(swapHash)}` : "."}
                  {approvalHash ? ` Approval ${formatAddress(approvalHash)}.` : ""}
                  {feeHash ? ` Agent fee ${formatAddress(feeHash)}.` : ""}
                </span>
              </div>
            )}

            {settled && feeError && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{feeError.message}</span>
              </div>
            )}

            {!settled && (
              <button
                onClick={onConfirmAndSwap}
                disabled={!canConfirm}
                className="btn-primary w-full text-sm"
              >
                {proposal.executionAvailable ? "Confirm & Swap" : "Execution unavailable"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
