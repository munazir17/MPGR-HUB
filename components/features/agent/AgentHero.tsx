"use client";

import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { AgentStatusId } from "@/lib/agent-config";

interface AgentHeroProps {
  statuses: AgentStatusId[];
}

export function AgentHero({ statuses }: AgentHeroProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3 md:p-8">
      <div className="relative flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="relative flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] md:h-16 md:w-16"
        >
          <Bot className="h-4 w-4 text-white md:h-7 md:w-7" aria-hidden="true" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.35 }}
          className="mt-1 text-sm font-semibold tracking-tight text-white md:mt-4 md:text-3xl"
        >
          MPGR Agent
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14, duration: 0.35 }}
          className="mt-0.5 line-clamp-2 max-w-md text-[11px] leading-snug text-muted md:mt-2 md:line-clamp-none md:text-base md:leading-relaxed"
        >
          A Base-native AI agent — it researches, reasons, and can safely prepare onchain actions
          for your explicit confirmation. Nothing signs or sends without you.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.35 }}
          className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 md:mt-4 md:gap-2"
        >
          {statuses.map((status) => (
            <AgentStatusBadge key={status} status={status} />
          ))}
        </motion.div>
      </div>
    </div>
  );
}
