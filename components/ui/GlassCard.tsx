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
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className={clsx(
        "group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-xl",
        "shadow-glow shadow-inner-top transition-[box-shadow,border-color] duration-300",
        "hover:border-white/[0.16] hover:shadow-glow-lg",
        className
      )}
      {...props}
    >
      {/* Glass highlight */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/[0.05] via-transparent to-transparent"
      />

      {/* Content */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </motion.div>
  );
}
