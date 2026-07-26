"use client";

import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionHeader } from "@/components/ui/SectionHeader";

export default function AgentPage() {
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <SectionHeader
            title="MPGR Agent"
            subtitle="Your AI assistant for MPGR HUB"
          />

          <GlassCard className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold">
              <Bot className="h-7 w-7 text-white" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-white">MPGR Agent is coming soon</p>
            <p className="max-w-sm text-xs leading-relaxed text-muted">
              Soon you&apos;ll be able to chat with the MPGR Agent to check your stats, manage
              staking, and get personalized tips for earning XP and rewards.
            </p>
          </GlassCard>
        </motion.div>
      </main>
    </>
  );
}
