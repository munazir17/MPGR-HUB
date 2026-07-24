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
      className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center"
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-6 w-6 text-primary" />
      </div>
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted">{description}</p>
      {ctaLabel && onCta && (
        <button
          onClick={onCta}
          className="mt-4 rounded-xl bg-gradient-premium px-4 py-2 text-xs font-semibold text-white"
        >
          {ctaLabel}
        </button>
      )}
    </motion.div>
  );
}
