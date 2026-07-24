"use client";

import { AnimatePresence, motion } from "framer-motion";

export function LevelUpModal({ level, onClose }: { level: number | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {level !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 15 }}
            className="rounded-2xl bg-gradient-premium p-8 text-center shadow-glow-gold"
          >
            <p className="text-sm font-medium text-white/80">Level Up!</p>
            <p className="mt-1 text-4xl font-bold text-white">Level {level}</p>
            <button
              onClick={onClose}
              className="mt-5 rounded-xl bg-white/20 px-5 py-2 text-sm font-semibold text-white"
            >
              Nice!
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
