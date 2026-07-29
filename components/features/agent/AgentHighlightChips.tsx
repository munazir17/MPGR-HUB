"use client";

import { motion } from "framer-motion";
import { AGENT_ICON_MAP } from "./agent-icon-map";
import type { AgentHighlight } from "@/lib/agent-actions";

interface AgentHighlightChipsProps {
  highlights: AgentHighlight[];
}

// Compact key-stat callouts rendered above an assistant reply's action
// cards — a quick visual anchor ("Level 12", "3-Day Streak") before the
// person reads the full sentence. Styled as small pills, matching
// AgentStatusBadge's soft-tint/ring pill language rather than introducing
// a new chip style.
export function AgentHighlightChips({ highlights }: AgentHighlightChipsProps) {
  if (highlights.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {highlights.map((highlight, i) => {
        const Icon = AGENT_ICON_MAP[highlight.icon];
        return (
          <motion.span
            key={highlight.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.05, duration: 0.2 }}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary-glow ring-1 ring-primary/20"
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {highlight.label}
          </motion.span>
        );
      })}
    </div>
  );
}
