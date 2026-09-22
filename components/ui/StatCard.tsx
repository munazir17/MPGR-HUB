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

// Stat TILE: 12px uppercase caption, 24px tabular number, 48px icon
// circle. Quiet — the number carries the weight.
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
    <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[12px] font-medium uppercase tracking-[0.14em] text-muted">
          {label}
        </span>
        <div
          className={
            isGold
              ? "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-gold/[0.18] bg-gold/[0.08]"
              : "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-primary/[0.18] bg-primary/[0.08]"
          }
        >
          <Icon className={isGold ? "h-[18px] w-[18px] text-gold" : "h-[18px] w-[18px] text-primary"} aria-hidden="true" />
        </div>
      </div>
      <motion.p
        key={value}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={
          isGold
            ? "mt-3 text-[24px] font-semibold tracking-tight text-gradient-gold tabular-nums"
            : "mt-3 text-[24px] font-semibold tracking-tight text-white tabular-nums"
        }
      >
        {value}
      </motion.p>
    </GlassCard>
  );
}
