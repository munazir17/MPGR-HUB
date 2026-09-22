"use client";

import { motion } from "framer-motion";

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
  variant?: "blue" | "gold";
}

// Bonding-meter language: a 4px track on #182234, a gold (or blue)
// fill with 10px endcaps and a faint moving sheen. No outer glow —
// the fill carries the accent.
export function ProgressBar({ progress, label, variant = "gold" }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex justify-between text-xs text-muted">
          <span>{label}</span>
          <span className="font-mono tabular-nums text-white/70">{clamped}%</span>
        </div>
      )}
      <div
        className="relative h-1 w-full overflow-hidden rounded-[10px] bg-[#182234]"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${clamped}%` }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          className={
            variant === "gold"
              ? "relative h-full rounded-[10px] bg-gradient-to-r from-gold-2 to-gold"
              : "relative h-full rounded-[10px] bg-gradient-to-r from-primary-2 to-primary"
          }
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-[10px] bg-gradient-shine bg-[length:200%_100%] animate-shine"
          />
        </motion.div>
      </div>
    </div>
  );
}
