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

export function StatCard({ label, value, icon: Icon, accent = "blue", loading }: StatCardProps) {
  if (loading) {
    return (
      <GlassCard className="p-5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-3 h-8 w-24" />
      </GlassCard>
    );
  }

  const isGold = accent === "gold";

  return (
    <motion.div whileHover={{ scale: 1.02 }} transition={{ type: "spring", stiffness: 300, damping: 20 }}>
      <GlassCard className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
          <div
            className={
              isGold
                ? "flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/20 to-gold/10 ring-1 ring-gold/20"
                : "flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/20"
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
              ? "mt-3 text-2xl font-bold tracking-tight text-gradient-gold sm:text-3xl"
              : "mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl"
          }
        >
          {value}
        </motion.p>
      </GlassCard>
    </motion.div>
  );
}
