"use client";

import type { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";

// Calm, centered empty state: one soft surface, a quiet icon chip and a
// single clear action. No pulsing glows or floating ornaments.
export function EmptyState({
  icon: Icon,
  title,
  description,
  ctaLabel,
  onCta,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-surface bg-gradient-surface px-6 py-14 text-center shadow-soft"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent"
      />
      <div className="relative mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/[0.18] bg-primary/[0.08]">
        <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
      </div>
      <p className="relative text-[15px] font-semibold tracking-[-0.01em] text-white">{title}</p>
      <p className="relative mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">{description}</p>
      {ctaLabel && onCta && (
        <button type="button" onClick={onCta} className="btn-primary relative mt-6 px-5 py-2.5 text-xs">
          {ctaLabel}
        </button>
      )}
    </motion.div>
  );
}
