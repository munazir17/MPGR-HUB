"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
  className?: string;
}

export function GlassCard({
  children,
  className,
  ...props
}: GlassCardProps) {
  return (
    <motion.div
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className={clsx(
        "group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-surface",
        "shadow-soft",
        className
      )}
      {...props}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </motion.div>
  );
}
