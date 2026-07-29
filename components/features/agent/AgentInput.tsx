"use client";

import { useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { Send } from "lucide-react";

interface AgentInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function AgentInput({ onSend, disabled }: AgentInputProps) {
  const [value, setValue] = useState("");

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-white/[0.08] bg-white/[0.02] p-3 sm:p-4">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder="Ask MPGR Agent anything..."
        className="max-h-28 min-h-[44px] flex-1 resize-none rounded-xl border border-white/10 bg-background/50 px-3.5 py-2.5 text-sm text-white placeholder:text-muted focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <motion.button
        type="button"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        whileHover={{ scale: disabled || !value.trim() ? 1 : 1.05 }}
        whileTap={{ scale: disabled || !value.trim() ? 1 : 0.95 }}
        aria-label="Send message"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-premium text-white shadow-glow-gold transition-opacity duration-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </motion.button>
    </div>
  );
}
