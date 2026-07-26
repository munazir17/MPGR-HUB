"use client";

import { motion } from "framer-motion";

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
}

export function ProgressBar({ progress, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex justify-between text-xs text-muted">
          <span>{label}</span>
          <span>{clamped}%</span>
        </div>
      )}
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-surface ring-1 ring-inset ring-white/5">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${clamped}%` }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          className="relative h-full rounded-full bg-gradient-premium shadow-glow-gold"
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
