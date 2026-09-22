"use client";

import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";

interface StatCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  accent?: "blue" | "gold";
  loading?: boolean;
}

// Premium stat tile: quiet uppercase label, large tabular value, a
// restrained icon chip. Hover only lifts the border — no scale pop.
export function StatCard({ label, value, icon: Icon, accent = "blue", loading }: StatCardProps) {
  if (loading) {
    return (
      <GlassCard className="p-5">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="mt-3.5 h-8 w-24" />
      </GlassCard>
    );
  }

  const isGold = accent === "gold";

  return (
    <GlassCard className="p-5 transition-colors duration-300 hover:border-white/[0.12]">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
          {label}
        </span>
        <div
          className={
            isGold
              ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gold/[0.18] bg-gold/[0.08]"
              : "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/[0.18] bg-primary/[0.08]"
          }
        >
          <Icon className={isGold ? "h-4 w-4 text-gold" : "h-4 w-4 text-primary"} aria-hidden="true" />
        </div>
      </div>
      <motion.p
        key={value}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={
          isGold
            ? "mt-3 text-2xl font-semibold tracking-tight text-gradient-gold tabular-nums sm:text-3xl"
            : "mt-3 text-2xl font-semibold tracking-tight text-white tabular-nums sm:text-3xl"
        }
      >
        {value}
      </motion.p>
    </GlassCard>
  );
}
