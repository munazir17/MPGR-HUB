"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
   * Embedded mode: the composer renders inside the stage dock, drawing
   * its own opaque #070C16 surface + hairline (it sits on the stage's
   * surface, not inside another card).
   */
  embedded?: boolean;
}

const MIN_HEIGHT_PX = 56;
const MAX_HEIGHT_PX = 120;

// The stage DOCK composer. Contract unchanged for every existing caller
// — same send / stop / lock / IME / palette behavior; only the physical
// form changed:
//
//   · opaque #070C16 surface, 16px radius, hairline, focus ring primary/40
//   · textarea grows 56 → 120px
//   · send = a 44×44 SQUARE-ISH (16px radius) extruded blue button —
//     a physical key, not a round glow pill
//   · /commands palette behavior untouched
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

  const stopping = disabled && !locked && Boolean(onStop);

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
            : "rounded-2xl border border-white/[0.08] bg-elevated p-2 sm:p-2.5"
        }
        data-testid="agent-composer"
      >
        {suggestionsSlot ? (
          <div
            className={embedded ? "mb-2 pb-2" : "mb-2 border-b border-white/[0.06] pb-2"}
            data-testid="agent-composer-suggestions"
          >
            {suggestionsSlot}
          </div>
        ) : null}
        <div
          className={
            embedded
              ? "flex items-end gap-2 rounded-[16px] border border-white/[0.08] bg-elevated px-2 py-2 transition-[border-color,box-shadow] duration-200 focus-within:border-primary/40 focus-within:shadow-[0_0_0_3px_rgba(77,163,255,0.14)] sm:px-2.5"
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
            className="max-h-[120px] min-h-[52px] flex-1 resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-3 py-1.5 text-sm text-white placeholder:text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 md:min-h-[56px]"
          />
          {/* 44×44 physical key — extruded blue lip that collapses on press. */}
          <button
            type="button"
            onClick={disabled && !locked && onStop ? onStop : handleSend}
            disabled={locked || (disabled ? !onStop : !value.trim())}
            aria-label={stopping ? "Stop generating" : "Send message"}
            title={stopping ? "Stop generating" : "Send message"}
            className="btn-primary-send group flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] text-white transition-[transform,box-shadow,filter] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              border: "1px solid rgba(140,199,255,0.38)",
              background: "linear-gradient(180deg, #6AB2FF 0%, #4DA3FF 44%, #2472EB 100%)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 0 rgba(9,32,74,0.4), 0 3px 0 #1E63DB, 0 8px 14px rgba(30,99,219,0.22)",
            }}
          >
            {stopping ? (
              <Square className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
