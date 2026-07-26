"use client";

import type { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaLabel?: string;
  onCta?: () => void;
}

export function EmptyState({ icon: Icon, title, description, ctaLabel, onCta }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center backdrop-blur-xl shadow-glow"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-premium opacity-20 blur-3xl animate-glow-pulse"
      />
      <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/25 shadow-glow animate-float mx-auto">
        <Icon className="h-7 w-7 text-primary" />
      </div>
      <p className="relative text-base font-semibold text-white">{title}</p>
      <p className="relative mx-auto mt-2 max-w-xs text-sm text-muted">{description}</p>
      {ctaLabel && onCta && (
        <button
          onClick={onCta}
          className="relative mt-6 rounded-xl bg-gradient-premium px-5 py-2.5 text-xs font-semibold text-white shadow-glow-gold transition-transform duration-200 hover:scale-[1.03] active:scale-95"
        >
          {ctaLabel}
        </button>
      )}
    </motion.div>
  );
}
