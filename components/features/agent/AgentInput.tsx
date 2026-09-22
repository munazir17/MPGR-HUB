"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Send, Square } from "lucide-react";
import { AgentCommandPalette } from "./AgentCommandPalette";
import type { useCommandPalette } from "@/hooks/useCommandPalette";
import type { SlashCommand } from "@/lib/agent-commands/types";

interface AgentInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** Fully locked (e.g. wallet not connected): textarea + button disabled, no stop button. */
  locked?: boolean;
  /** Composer placeholder — "Ask anything..." on the canonical agent chat. */
  placeholder?: string;
  onStop?: () => void;
  // Phase 3A.6 — optional so this component still works standalone
  // (matches AgentChatBubble's onFeedback/onRegenerate optionality
  // precedent from 3A.4) when no palette is wired behind it.
  commandPalette?: ReturnType<typeof useCommandPalette>;
  onSelectCommand?: (command: SlashCommand) => void;
  /**
   * Optional content rendered INSIDE the composer, above the textarea
   * row — the canonical home of the suggested prompt chips. Keeping the
   * chips inside the same composer as the "Ask anything..." input is
   * what makes the whole area read as ONE chat interface.
   */
  suggestionsSlot?: ReactNode;
  /**
   * Embedded mode: the composer renders inside the unified chat
   * surface card, so it drops its own border/fill instead of drawing a
   * card inside a card.
   */
  embedded?: boolean;
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
export function AgentInput({
  onSend,
  disabled,
  locked,
  placeholder = "Ask anything...",
  onStop,
  commandPalette,
  onSelectCommand,
  suggestionsSlot,
  embedded,
}: AgentInputProps) {
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
    if (!trimmed || disabled || locked) return;
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
      if (!locked) handleSend();
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
      <div
        className={
          embedded
            ? "p-0"
            : "rounded-2xl border border-white/[0.08] bg-surface p-2 sm:p-2.5"
        }
        data-testid="agent-composer"
      >
        {suggestionsSlot ? (
          <div
            className={
              embedded
                ? "mb-2 pb-2"
                : "mb-2 border-b border-white/[0.06] pb-2"
            }
            data-testid="agent-composer-suggestions"
          >
            {suggestionsSlot}
          </div>
        ) : null}
        <div
          className={
            embedded
              ? "flex items-end gap-2 rounded-xl border border-white/[0.06] bg-surface px-2 py-1.5 sm:px-2.5"
              : "flex items-end gap-2"
          }
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            disabled={disabled || locked}
            rows={1}
            placeholder={placeholder}
            aria-label="Message MPGR Agent"
            className="max-h-28 min-h-[44px] flex-1 resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-3.5 py-2.5 text-sm text-white placeholder:text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <motion.button
            type="button"
            onClick={disabled && !locked && onStop ? onStop : handleSend}
            disabled={locked || (disabled ? !onStop : !value.trim())}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            aria-label={disabled && !locked ? "Stop generating" : "Send message"}
            title={disabled && !locked ? "Stop generating" : "Send message"}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-background shadow-glow transition-opacity duration-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {disabled && !locked ? (
              <Square className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
