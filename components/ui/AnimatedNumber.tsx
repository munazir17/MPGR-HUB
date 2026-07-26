"use client";

import { useEffect, useRef } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  className?: string;
  prefix?: string;
  suffix?: string;
}

export function AnimatedNumber({
  value,
  decimals = 0,
  className,
  prefix = "",
  suffix = "",
}: AnimatedNumberProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const motionValue = useMotionValue(safeValue);
  const spring = useSpring(motionValue, { stiffness: 120, damping: 20, mass: 0.9 });
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    motionValue.set(safeValue);
  }, [safeValue, motionValue]);

  useEffect(() => {
    const unsubscribe = spring.on("change", (latest) => {
      if (spanRef.current) {
        spanRef.current.textContent = `${prefix}${latest.toFixed(decimals)}${suffix}`;
      }
    });
    return unsubscribe;
  }, [spring, decimals, prefix, suffix]);

  return (
    <motion.span ref={spanRef} className={className}>
      {`${prefix}${safeValue.toFixed(decimals)}${suffix}`}
    </motion.span>
  );
}
