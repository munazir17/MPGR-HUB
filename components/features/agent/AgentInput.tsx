"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { Send } from "lucide-react";
import { AgentCommandPalette } from "./AgentCommandPalette";
import type { useCommandPalette } from "@/hooks/useCommandPalette";
import type { SlashCommand } from "@/lib/agent-commands/types";

interface AgentInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  // Phase 3A.6 — optional so this component still works standalone
  // (matches AgentChatBubble's onFeedback/onRegenerate optionality
  // precedent from 3A.4) when no palette is wired behind it.
  commandPalette?: ReturnType<typeof useCommandPalette>;
  onSelectCommand?: (command: SlashCommand) => void;
}

const MIN_HEIGHT_PX = 44;
const MAX_HEIGHT_PX = 112;

// Phase 3A.4 Batch 2 update — auto-growing height + IME composition guard.
// Contract unchanged for every existing caller.
//
// Phase 3A.6 — detects a leading "/" to open the command palette above
// the input. Palette navigation (up/down/enter/esc) intercepts the
// textarea's keydown only while the palette is open; normal typing and
// the existing Enter-to-send / Shift+Enter-newline behavior are
// otherwise untouched.
export function AgentInput({ onSend, disabled, commandPalette, onSelectCommand }: AgentInputProps) {
  const [value, setValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT_PX), MAX_HEIGHT_PX)}px`;
  }, [value]);

  const handleChange = (next: string) => {
    setValue(next);
    if (!commandPalette) return;
    if (next.startsWith("/")) {
      commandPalette.setQuery(next.slice(1));
      if (!commandPalette.isOpen) commandPalette.open(next.slice(1));
    } else if (commandPalette.isOpen) {
      commandPalette.close();
    }
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    commandPalette?.close();
  };

  const handleSelectCommand = (command: SlashCommand) => {
    setValue("");
    commandPalette?.close();
    onSelectCommand?.(command);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandPalette?.isOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        commandPalette.moveHighlight(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        commandPalette.moveHighlight(-1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        commandPalette.close();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !isComposing) {
        event.preventDefault();
        if (commandPalette.highlighted) handleSelectCommand(commandPalette.highlighted);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !isComposing) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col">
      {commandPalette && (
        <AgentCommandPalette
          isOpen={commandPalette.isOpen}
          results={commandPalette.results}
          highlightedIndex={commandPalette.highlightedIndex}
          onSelect={handleSelectCommand}
        />
      )}
      <div className="flex items-end gap-2 border-t border-white/[0.08] bg-white/[0.02] p-2.5 sm:p-3 md:p-4">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          disabled={disabled}
          rows={1}
          placeholder="Ask MPGR Agent anything... (try /help)"
          aria-label="Message MPGR Agent"
          className="max-h-28 min-h-[44px] flex-1 resize-none overflow-y-auto rounded-xl border border-white/10 bg-background/50 px-3.5 py-2.5 text-sm text-white placeholder:text-muted focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
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
    </div>
  );
}
