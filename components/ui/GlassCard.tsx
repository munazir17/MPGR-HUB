"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
  className?: string;
}

// The ONE card surface for the whole app: hairline border, faint top-lit
// sheen over the surface color, a 1px light edge along the top and a
// soft drop shadow. Depth without glassmorphism.
export function GlassCard({
  children,
  className,
  ...props
}: GlassCardProps) {
  return (
    <motion.div
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className={clsx(
        "group relative overflow-hidden rounded-2xl border border-white/[0.06]",
        "bg-surface bg-gradient-surface shadow-soft",
        className
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent"
      />
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </motion.div>
  );
}
