"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, X } from "lucide-react";

import { formatAddress } from "@/lib/format";
import { formatX402NetworkDisplay } from "@/lib/x402/x402-config";
import type { X402ConfirmationState } from "@/lib/x402/x402-confirmation";
import type { X402ExecutionState } from "@/lib/x402/x402-execution";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { X402Error, X402SettlementResponse } from "@/lib/x402/x402-types";

// P3 — Confirmation UI for an x402 payment proposal. Presentational
// only, mirroring AgentActionConfirmationModal.tsx's own posture: every
// fact shown here comes straight off the already-validated
// X402PaymentProposal (built by x402-proposal.ts from a parsed,
// trusted requirement) — never re-derived or guessed in this component.
//
// "Confirm & Pay" is only a human-confirmation boundary. It never signs
// or submits anything itself — see hooks/useX402Execution.ts for the
// one legitimate call site of executeX402Payment().

interface AgentX402PaymentModalProps {
  open: boolean;
  onClose: () => void;
  proposal: X402PaymentProposal | null;
  confirmationState: X402ConfirmationState;
  confirmationError: X402Error | null;
  executionState: X402ExecutionState;
  executionError: X402Error | null;
  settlement: X402SettlementResponse | null;
  /** Human-confirmation boundary only. */
  onConfirmAndPay?: () => void;
}

function isBusy(confirmationState: X402ConfirmationState, executionState: X402ExecutionState): boolean {
  return (
    confirmationState === "VALIDATING" ||
    executionState === "AWAITING_SIGNATURE" ||
    executionState === "SIGNED" ||
    executionState === "SUBMITTING"
  );
}

function busyLabel(confirmationState: X402ConfirmationState, executionState: X402ExecutionState): string | null {
  if (confirmationState === "VALIDATING") return "Validating payment requirement...";
  if (executionState === "AWAITING_SIGNATURE") return "Waiting for your wallet to sign...";
  if (executionState === "SIGNED" || executionState === "SUBMITTING") return "Submitting payment...";
  return null;
}

export function AgentX402PaymentModal({
  open,
  onClose,
  proposal,
  confirmationState,
  confirmationError,
  executionState,
  executionError,
  settlement,
  onConfirmAndPay,
}: AgentX402PaymentModalProps) {
  if (!proposal) return null;

  const busy = isBusy(confirmationState, executionState);
  const failed = confirmationState === "VALIDATION_FAILED" || executionState === "ERROR";
  const settled = executionState === "SETTLED";
  const canConfirm = confirmationState === "READY_FOR_CONFIRMATION" && executionState === "IDLE";
  const error = executionError ?? confirmationError;

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
                <ShieldCheck className="h-5 w-5 text-good" />
                <h2 className="text-sm font-semibold text-white">Confirm payment</h2>
              </div>
              <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-sm text-zinc-300">{proposal.description}</p>

            <dl className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Amount</dt>
                <dd className="text-white">{proposal.displayAmount ?? proposal.requirement.maxAmountRequired}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Recipient</dt>
                <dd className="text-white">{formatAddress(proposal.requirement.payTo)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Network</dt>
                <dd className="text-white">{formatX402NetworkDisplay(proposal.requirement.network)}</dd>
              </div>
            </dl>

            {proposal.warnings.length > 0 && (
              <ul className="mb-4 space-y-1 text-xs text-amber-400">
                {proposal.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {busy && (
              <div className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                {busyLabel(confirmationState, executionState)}
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
                <span>Payment settled{settlement?.transaction ? ` — ${formatAddress(settlement.transaction)}` : "."}</span>
              </div>
            )}

            {!settled && (
              <button
                onClick={onConfirmAndPay}
                disabled={!canConfirm}
                className="btn-primary w-full text-sm"
              >
                Confirm & Pay
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
