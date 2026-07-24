"use client";

import { motion } from "framer-motion";
import { GlassCard } from "./GlassCard";
import { formatRelativeTime } from "@/lib/format";
import { XP_ACTIONS, type XPHistoryEntry } from "@/lib/xp-engine";

const ACTION_ICONS: Record<string, string> = {
  WALLET_CONNECTED: "🔗",
  DAILY_CHECK_IN: "🔥",
  PROFILE_COMPLETED: "🧩",
  SHARE_ON_X: "📣",
  QUEST_COMPLETED: "🧠",
  REFERRAL_SUCCESS: "👥",
};

export function ActivityTimeline({ entries, limit = 8 }: { entries: XPHistoryEntry[]; limit?: number }) {
  const items = [...entries].reverse().slice(0, limit);

  return (
    <div className="space-y-2">
      {items.map((entry, i) => (
        <motion.div
          key={`${entry.timestamp}-${i}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.03 }}
        >
          <GlassCard className="flex items-center gap-3 p-3">
            <span className="text-lg" aria-hidden="true">
              {ACTION_ICONS[entry.action] ?? "⭐"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-white">
                {XP_ACTIONS[entry.action]?.label ?? entry.action.replace(/_/g, " ")}
              </p>
              {entry.timestamp && (
                <p className="text-[11px] text-muted">{formatRelativeTime(entry.timestamp)}</p>
              )}
            </div>
            <span className="shrink-0 text-sm font-semibold text-gold">+{entry.xp} XP</span>
          </GlassCard>
        </motion.div>
      ))}
    </div>
  );
}
