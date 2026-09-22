"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

export type GlassCardVariant = "tile" | "frame";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
  className?: string;
  /**
   * Card species:
   *   tile  (default) — stats/staking/games/rewards surfaces: 14px
   *                     radius, hairline, top-lit fill, soft shadow
   *   frame           — transparent fill, hairline + "+" corner ticks
   *                     (the Gifted-style frame; HomeInfo cards)
   * The STAGE species is not a card — it is built in AgentExperience.
   */
  variant?: GlassCardVariant;
}

// The app's card system. Depth without glassmorphism; hover lift is
// pointer-fine only (see .card-lift in globals.css).
export function GlassCard({
  children,
  className,
  variant = "tile",
  ...props
}: GlassCardProps) {
  if (variant === "frame") {
    return (
      <motion.div
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
        className={clsx(
          "card-lift group relative rounded-[14px] border border-white/[0.08] bg-transparent",
          className
        )}
        {...props}
      >
        {/* "+" corner ticks — the frame species' signature. */}
        <span aria-hidden="true" className="corner-tick corner-tick-tl" />
        <span aria-hidden="true" className="corner-tick corner-tick-tr" />
        <span aria-hidden="true" className="corner-tick corner-tick-bl" />
        <span aria-hidden="true" className="corner-tick corner-tick-br" />
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </motion.div>
    );
  }

  return (
    <motion.div
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className={clsx(
        "card-lift group relative overflow-hidden rounded-[14px] border border-white/[0.07]",
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
