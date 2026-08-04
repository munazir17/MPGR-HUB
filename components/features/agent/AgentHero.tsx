"use client";

import { motion } from "framer-motion";
import { Bot, Sparkles } from "lucide-react";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";

interface AgentHeroProps {
  statuses: AgentStatusId[];
}

// The flagship moment of MPGR HUB — visually louder than the rest of the
// app (bigger glow, layered orbs, animated ring) while reusing the exact
// same design tokens (bg-gradient-premium, shadow-glow-gold-lg,
// animate-glow-pulse) so it still reads as part of the same product.
//
// Mobile UX polish (below md/768px only): padding, icon, title, badges,
// and spacing are all aggressively scaled down so the whole Agent page —
// hero + conversation + input — fits on one phone screen without
// scrolling. Every md: value below matches the original desktop design
// exactly — nothing changes at md and up.
export function AgentHero({ statuses }: AgentHeroProps) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-xl shadow-glow-lg md:p-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-gradient-premium opacity-25 blur-3xl animate-glow-pulse"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-28 -right-20 h-72 w-72 rounded-full bg-gradient-gold opacity-15 blur-3xl animate-float"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-mesh opacity-60"
      />

      <div className="relative flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="relative"
        >
          <div
            aria-hidden="true"
            className="absolute -inset-1 rounded-full bg-gradient-premium opacity-60 blur-xl animate-glow-pulse md:-inset-3"
          />
          <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold-lg ring-2 ring-white/10 md:h-24 md:w-24">
            <Bot className="h-4 w-4 text-white md:h-11 md:w-11" aria-hidden="true" />
          </div>
          <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gold shadow-glow-gold ring-2 ring-background md:h-7 md:w-7">
            <Sparkles className="h-2 w-2 text-background md:h-3.5 md:w-3.5" aria-hidden="true" />
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="mt-1 text-sm font-bold tracking-tight text-white md:mt-5 md:text-4xl"
        >
          MPGR <span className="text-gradient-premium">Agent</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, duration: 0.4 }}
          className="mt-0.5 line-clamp-2 max-w-md text-[11px] leading-snug text-muted md:mt-2 md:line-clamp-none md:text-base md:leading-relaxed"
        >
          Your AI companion for MPGR HUB — ask about XP, staking, Holder Tier, Premium, and your
          portfolio, all in one place.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.26, duration: 0.4 }}
          className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 md:mt-5 md:gap-2"
        >
          {statuses.map((status) => (
            <AgentStatusBadge key={status} status={status} />
          ))}
        </motion.div>
      </div>
    </div>
  );
}
