"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { clsx } from "clsx";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  children: React.ReactNode;
  className?: string;
}

export function GlassCard({ children, className, ...props }: GlassCardProps) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className={clsx(
        "rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl",
        "shadow-glow",
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  );
}
