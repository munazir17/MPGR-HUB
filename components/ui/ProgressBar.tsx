"use client";

import { motion } from "framer-motion";

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
}

// Slim, quiet progress track with a blue gradient fill and a faint
// moving sheen. No outer glow — the fill carries the accent.
export function ProgressBar({ progress, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex justify-between text-xs text-muted">
          <span>{label}</span>
          <span className="tabular-nums text-white/70">{clamped}%</span>
        </div>
      )}
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${clamped}%` }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          className="relative h-full rounded-full bg-gradient-to-r from-primary/80 to-primary"
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-gradient-shine bg-[length:200%_100%] animate-shine"
          />
        </motion.div>
      </div>
    </div>
  );
}
