"use client";

// components/features/campaigns/CampaignLeaderboard.tsx
//
// Campaign-scoped leaderboard rows. Deliberately SEPARATE from
// components/ui/LeaderboardRow.tsx (global XP/Season Points) — campaign
// points are attributed to one campaign only and are never displayed as
// global XP. Same visual language: tile rows, mono tabular figures,
// medal chips for the top 3, "you" highlight for the session wallet.

import { motion } from "framer-motion";
import { clsx } from "clsx";
import { AddressAvatar } from "@/components/AddressAvatar";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import type { CampaignLeaderboardEntry } from "@/lib/campaigns/campaign-types";

interface CampaignLeaderboardProps {
  entries: CampaignLeaderboardEntry[];
  currentWallet?: string | null;
  pointsLabel?: string;
}

export function CampaignLeaderboard({ entries, currentWallet, pointsLabel = "pts" }: CampaignLeaderboardProps) {
  const normalizedCurrent = currentWallet?.toLowerCase() ?? null;

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const isCurrentUser = !!normalizedCurrent && entry.wallet === normalizedCurrent;
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
            key={entry.wallet}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25 }}
            className={clsx(
              "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border p-3.5 transition-colors duration-200",
              isCurrentUser
                ? "border-primary/40 bg-primary/10 shadow-glow"
                : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]",
            )}
          >
            <span
              className={clsx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold tabular-nums",
                medalBg,
              )}
            >
              {entry.rank}
            </span>
            <AddressAvatar address={entry.wallet} size={32} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate font-mono text-sm font-medium text-white">
                {entry.displayName ?? formatAddress(entry.wallet)}
                {isCurrentUser && <span className="font-sans text-primary">(you)</span>}
              </p>
              <p className="truncate font-mono text-[11px] tabular-nums text-muted">
                {formatAddress(entry.wallet)}
                {entry.eligibility === "ineligible" ? " · ineligible" : ""}
              </p>
            </div>
            <div className="w-full text-right sm:w-auto">
              <p className="font-mono text-sm font-semibold tabular-nums text-white">
                {formatCompactNumber(entry.points)} {pointsLabel}
              </p>
              <p className="font-mono text-[11px] font-medium tabular-nums text-gradient-gold">
                {entry.rewardStatus === "distributed"
                  ? "reward distributed"
                  : entry.rewardStatus === "ineligible"
                    ? "no reward"
                    : "reward pending"}
              </p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
