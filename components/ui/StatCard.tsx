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

  return (
    <motion.div whileHover={{ scale: 1.02 }} transition={{ type: "spring", stiffness: 300, damping: 20 }}>
      <GlassCard className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">{label}</span>
          <div
            className={
              accent === "gold"
                ? "flex h-8 w-8 items-center justify-center rounded-full bg-gold/10"
                : "flex h-8 w-8 items-center justify-center rounded-full bg-primary/10"
            }
          >
            <Icon className={accent === "gold" ? "h-4 w-4 text-gold" : "h-4 w-4 text-primary"} aria-hidden="true" />
          </div>
        </div>
        <motion.p
          key={value}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mt-3 text-3xl font-bold tracking-tight text-white"
        >
          {value}
        </motion.p>
      </GlassCard>
    </motion.div>
  );
}
