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
        <Skeleton className="mt-3 h-7 w-24" />
      </GlassCard>
    );
  }

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        <Icon className={accent === "gold" ? "h-4 w-4 text-gold" : "h-4 w-4 text-primary"} />
      </div>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-2 text-2xl font-semibold text-white"
      >
        {value}
      </motion.p>
    </GlassCard>
  );
}
