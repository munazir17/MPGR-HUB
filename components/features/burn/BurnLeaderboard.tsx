"use client";

import { motion } from "framer-motion";
import { Trophy, Users } from "lucide-react";
import { AddressAvatar } from "@/components/AddressAvatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import { clsx } from "clsx";
import type { BurnLeaderboardEntry } from "@/lib/burn-types";

interface BurnLeaderboardProps {
  entries: BurnLeaderboardEntry[];
}

// Visually mirrors components/ui/LeaderboardRow.tsx (medal badges, avatar,
// current-user highlight) but built for burn fields (totalBurned,
// contributionPercent) instead of XP fields, since LeaderboardRow's props
// are typed specifically to XP/season data. Same honesty rule as
// app/leaderboard/page.tsx: only ever shows real wallets that have
// actually burned — never a fabricated multi-wallet ranking.
export function BurnLeaderboard({ entries }: BurnLeaderboardProps) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No burns yet"
        description="Be the first to burn MPGR — global rankings will grow here as more wallets join, once the leaderboard backend launches."
      />
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const isTop3 = entry.rank <= 3;
        const medalBg =
          entry.rank === 1
            ? "bg-gradient-to-br from-gold-glow to-gold text-black shadow-glow-gold"
            : entry.rank === 2
              ? "bg-gradient-to-br from-gray-200 to-gray-400 text-black"
              : entry.rank === 3
                ? "bg-gradient-to-br from-orange-300 to-orange-500 text-black"
                : "bg-white/5 text-muted";

        return (
          <motion.div
            key={entry.address}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            whileHover={{ x: 2 }}
            className={clsx(
              "flex items-center gap-3 rounded-xl border p-3.5 transition-colors duration-200",
              entry.isCurrentUser
                ? "border-gold/40 bg-gold/[0.06] shadow-glow-gold"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
            )}
          >
            <span
              className={clsx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                medalBg
              )}
            >
              {isTop3 ? <Trophy className="h-3.5 w-3.5" aria-hidden="true" /> : entry.rank}
            </span>
            <AddressAvatar address={entry.address} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {formatAddress(entry.address)}{" "}
                {entry.isCurrentUser && <span className="text-gold">(you)</span>}
              </p>
              <p className="text-[11px] text-muted">{entry.contributionPercent}% of total supply</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-gold">
                {formatCompactNumber(entry.totalBurned)} MPGR
              </p>
              <p className="text-[11px] text-muted">burned</p>
            </div>
          </motion.div>
        );
      })}
      <p className="mt-4 text-center text-xs text-muted">
        Global cross-wallet rankings arrive once the leaderboard backend launches.
      </p>
    </div>
  );
}
