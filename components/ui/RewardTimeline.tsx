"use client";

import { motion } from "framer-motion";
import { GlassCard } from "./GlassCard";
import { REWARD_SOURCE_ICON } from "./reward-visuals";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import {
  inferRewardMeta,
  type RewardClaim,
  type RewardClaimHistoryEntry,
} from "@/lib/rewards-engine";

interface RewardTimelineProps {
  history: RewardClaimHistoryEntry[];
  claims: RewardClaim[];
  limit?: number;
}

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

export function RewardTimeline({ history, claims, limit = 12 }: RewardTimelineProps) {
  const entries = history.slice(0, limit);

  const groups: { key: string; label: string; entries: RewardClaimHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, label: formatRelativeTime(entry.timestamp), entries: [entry] });
    }
  }

  let renderedIndex = 0;

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.key}>
          <p className="mb-2 pl-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {group.label}
          </p>
          <div className="relative space-y-2 pl-4">
            <div
              aria-hidden="true"
              className="absolute bottom-1 left-[7px] top-1 w-px bg-gradient-to-b from-white/15 via-white/10 to-transparent"
            />
            {group.entries.map((entry) => {
              const meta = inferRewardMeta(entry.rewardId, claims);
              const Icon = REWARD_SOURCE_ICON[meta.source];
              const delay = Math.min(renderedIndex, 10) * 0.03;
              renderedIndex += 1;
              return (
                <motion.div
                  key={`${entry.rewardId}-${entry.timestamp}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay }}
                  className="relative"
                >
                  <span
                    aria-hidden="true"
                    className="absolute -left-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-gold shadow-glow-gold ring-4 ring-background"
                  />
                  <GlassCard className="flex items-center gap-3 p-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
                      <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-white">{meta.title}</p>
                      <p className="text-[11px] text-muted">{formatRelativeTime(entry.timestamp)}</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-gold">
                      +{formatCompactNumber(entry.amount)} MPGR
                    </span>
                  </GlassCard>
                </motion.div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
