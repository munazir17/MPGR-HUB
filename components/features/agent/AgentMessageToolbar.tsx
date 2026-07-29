"use client";

import { useEffect, useState } from "react";
import { Check, Copy, RotateCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { clsx } from "clsx";
import type { AgentFeedback } from "@/lib/agent-engine";

interface AgentMessageToolbarProps {
  content: string;
  feedback?: AgentFeedback;
  onFeedback?: (feedback: AgentFeedback) => void;
  showRegenerate?: boolean;
  onRegenerate?: () => void;
  disabled?: boolean;
}

// Phase 3A.4 Batch 2 — per-message action row for assistant replies:
// copy, 👍/👎, and (only for the true last message) regenerate.
//
// Strictly presentation-only, matching the pattern every other
// components/features/agent/* file already follows (AgentActionCard,
// AgentHighlightChips, etc. are all props-in/JSX-out): every button here
// just calls the callback prop it was given. `onFeedback` /
// `onRegenerate` are expected to be hooks/useAgentChat.ts's `sendFeedback`
// / `regenerateLastMessage` — this component has no idea agent-engine.ts
// or storage.ts exist, and never will, which is what keeps it swappable
// if the memory/backend layer changes in Phase 3B.
//
// `showRegenerate` is a prop, not computed here — "is this the last
// assistant message" is exactly the kind of list-position logic that
// belongs in the caller (AgentChatWindow), not duplicated per-toolbar.
//
// Copy uses the same navigator.clipboard + local-state-timeout pattern
// already established in components/features/burn/BurnSuccessModal.tsx
// and app/profile/page.tsx — no new clipboard utility introduced.
export function AgentMessageToolbar({
  content,
  feedback,
  onFeedback,
  showRegenerate,
  onRegenerate,
  disabled,
}: AgentMessageToolbarProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions/unsupported browser) — no-op,
      // same as BurnSuccessModal's share fallback.
    }
  };

  const buttonClass =
    "flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex items-center gap-1 pl-1">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy message"}
        className={buttonClass}
      >
        {copied ? (
          <Check className="h-3 w-3 text-primary-glow" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )}
      </button>

      {onFeedback && (
        <>
          <button
            type="button"
            onClick={() => onFeedback("up")}
            disabled={disabled}
            aria-label="Good response"
            aria-pressed={feedback === "up"}
            className={clsx(buttonClass, feedback === "up" && "text-primary-glow hover:text-primary-glow")}
          >
            <ThumbsUp className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onFeedback("down")}
            disabled={disabled}
            aria-label="Bad response"
            aria-pressed={feedback === "down"}
            className={clsx(buttonClass, feedback === "down" && "text-red-400 hover:text-red-400")}
          >
            <ThumbsDown className="h-3 w-3" aria-hidden="true" />
          </button>
        </>
      )}

      {showRegenerate && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={disabled}
          aria-label="Regenerate response"
          className={buttonClass}
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
