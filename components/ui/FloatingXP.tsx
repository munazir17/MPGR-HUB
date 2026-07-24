"use client";

import { AnimatePresence, motion } from "framer-motion";

export function FloatingXP({ amount, onComplete }: { amount: number | null; onComplete: () => void }) {
  return (
    <AnimatePresence onExitComplete={onComplete}>
      {amount !== null && (
        <motion.div
          key={amount + Date.now()}
          initial={{ opacity: 0, y: 0, scale: 0.8 }}
          animate={{ opacity: 1, y: -40, scale: 1 }}
          exit={{ opacity: 0, y: -70 }}
          transition={{ duration: 1.4, ease: "easeOut" }}
          onAnimationComplete={(def) => {
            if (def === "animate") setTimeout(onComplete, 700);
          }}
          className="pointer-events-none fixed left-1/2 top-24 z-[60] -translate-x-1/2 rounded-full bg-gradient-premium px-4 py-1.5 text-sm font-semibold text-white shadow-glow-gold"
        >
          +{amount} XP
        </motion.div>
      )}
    </AnimatePresence>
  );
}
