"use client";

import { motion } from "framer-motion";
import { AlertTriangle, RotateCcw, X } from "lucide-react";

interface AgentErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

// Phase 3A.4 Batch 2 — surfaces hooks/useAgentChat.ts's `error` state.
// Batch 3 addendum: added `exit` so wrapping it in <AnimatePresence>
// (app/agent/page.tsx) animates it out on dismiss/retry instead of
// popping instantly — no other change.
export function AgentErrorBanner({ message, onRetry, onDismiss }: AgentErrorBannerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      role="alert"
      className="flex items-center gap-2.5 border-t border-red-500/20 bg-red-500/10 px-4 py-2.5 sm:px-6"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
      <p className="flex-1 text-xs text-red-200">{message}</p>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-200 transition-colors duration-200 hover:bg-red-500/20"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      )}

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="shrink-0 rounded-lg p-1 text-red-300 transition-colors duration-200 hover:bg-red-500/20 hover:text-red-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </motion.div>
  );
}
