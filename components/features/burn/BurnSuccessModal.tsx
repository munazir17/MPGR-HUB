"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Flame, Share2, X } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatAddress } from "@/lib/format";

interface BurnSuccessModalProps {
  open: boolean;
  amount: number;
  address: string;
  onClose: () => void;
}

// Mock transaction id, presented honestly as a mock id (not a fake
// BaseScan link) until the real burn contract's receipt is available.
// Phase 2B swap point: replace with the real tx hash from the contract
// write's receipt.
function makeMockTxId() {
  return `0x${Math.random().toString(16).slice(2).padEnd(12, "0")}...${Date.now().toString(16).slice(-6)}`;
}

export function BurnSuccessModal({ open, amount, address, onClose }: BurnSuccessModalProps) {
  const [copied, setCopied] = useState(false);
  const txId = useMemo(() => makeMockTxId(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    const timer = setTimeout(onClose, 3200);
    return () => clearTimeout(timer);
  }, [open, onClose]);

  const handleShare = async () => {
    const text = `I just burned ${amount.toLocaleString()} MPGR on MPGR HUB 🔥`;
    try {
      if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // User cancelled the share sheet or clipboard was unavailable — no-op.
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:px-4"
        >
          <motion.div
            initial={{ y: 40, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm overflow-hidden rounded-t-2xl border border-gold/20 bg-surface p-6 text-center shadow-glow-gold sm:rounded-2xl"
            style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-gold opacity-25 blur-3xl animate-glow-pulse"
            />

            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <motion.div
              initial={{ scale: 0.4, rotate: -10 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 14, delay: 0.1 }}
              className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-gold shadow-glow-gold"
            >
              <Flame className="h-8 w-8 text-background" aria-hidden="true" />
            </motion.div>

            <p className="relative mt-4 text-sm font-semibold text-white">MPGR Burned</p>
            <p className="relative mt-1 text-3xl font-bold text-gradient-gold">
              <AnimatedNumber value={amount} decimals={0} suffix=" MPGR" />
            </p>
            <p className="relative mt-1 text-xs text-muted">removed from circulation forever</p>

            <div className="relative mt-5 space-y-1.5 rounded-xl bg-background/50 p-3 text-left text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">From</span>
                <span className="font-medium text-white">{formatAddress(address)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Transaction</span>
                <span className="font-medium text-white">{txId}</span>
              </div>
            </div>

            <button
              onClick={handleShare}
              aria-label="Share this burn"
              className="relative mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-sm font-semibold text-white transition-colors hover:bg-white/[0.06]"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-gold" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                  Share
                </>
              )}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
