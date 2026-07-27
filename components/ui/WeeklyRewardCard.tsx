"use client";

import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { AnimatedNumber } from "./AnimatedNumber";
import type { WeeklyClaimPoint } from "@/lib/rewards-engine";

interface WeeklyRewardCardProps {
  series: WeeklyClaimPoint[];
  total: number;
  previousTotal: number;
  loading?: boolean;
}

export function WeeklyRewardCard({ series, total, previousTotal, loading }: WeeklyRewardCardProps) {
  if (loading) {
    return (
      <GlassCard className="p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-8 w-28" />
        <div className="mt-6 flex items-end gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </GlassCard>
    );
  }

  const max = Math.max(1, ...series.map((d) => d.amount));
  const delta = total - previousTotal;
  const pct = previousTotal > 0 ? Math.round((delta / previousTotal) * 100) : total > 0 ? 100 : 0;
  const TrendIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const trendColor = delta > 0 ? "text-gold" : delta < 0 ? "text-muted" : "text-muted";
  const trendLabel =
    previousTotal > 0 || total > 0 ? `${delta > 0 ? "+" : ""}${pct}% vs last week` : "No claims yet";

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Claimed This Week</p>
        <span className={`flex items-center gap-1 text-[11px] font-semibold ${trendColor}`}>
          <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {trendLabel}
        </span>
      </div>

      <p className="mt-2 text-2xl font-bold tracking-tight text-gradient-gold sm:text-3xl">
        <AnimatedNumber value={total} suffix=" MPGR" />
      </p>

      <div className="mt-6 flex items-end justify-between gap-1.5 sm:gap-2.5">
        {series.map((d, i) => {
          const heightPct = Math.max(8, Math.round((d.amount / max) * 100));
          return (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-16 w-full items-end">
                <motion.div
                  initial={{ height: "4%" }}
                  animate={{ height: `${heightPct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut", delay: i * 0.04 }}
                  className={`w-full rounded-md ${
                    d.amount > 0 ? "bg-gradient-gold shadow-glow-gold" : "bg-surface"
                  }`}
                />
              </div>
              <span className="text-[9px] font-medium text-muted">{d.label.slice(0, 2)}</span>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
