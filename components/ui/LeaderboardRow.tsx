"use client";

import { motion } from "framer-motion";
import { AddressAvatar } from "@/components/AddressAvatar";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import type { PremiumTierId } from "@/lib/premium-config";
import { clsx } from "clsx";

interface LeaderboardRowProps {
  rank: number;
  address: string;
  xp: number;
  seasonPoints: number;
  referrals: number;
  isCurrentUser?: boolean;
  /** Optional — omitted callers render exactly as before (no badge). */
  tier?: PremiumTierId;
}

// One leaderboard row — a TILE with mono tabular figures and hairline
// rows. The connected wallet is highlighted as "you" with a primary/10
// fill. On phones the figures stack under the identity instead of
// squeezing it.
export function LeaderboardRow({
  rank,
  address,
  xp,
  seasonPoints,
  referrals,
  isCurrentUser,
  tier,
}: LeaderboardRowProps) {
  const isTop3 = rank <= 3;
  const medalBg =
    rank === 1
      ? "bg-gradient-to-br from-gold-glow to-gold text-black shadow-glow-gold"
      : rank === 2
      ? "bg-gradient-to-br from-gray-200 to-gray-400 text-black"
      : rank === 3
      ? "bg-gradient-to-br from-orange-300 to-orange-500 text-black"
      : "bg-white/5 text-muted";

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className={clsx(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border p-3.5 transition-colors duration-200",
        isCurrentUser
          ? "border-primary/40 bg-primary/10 shadow-glow"
          : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]"
      )}
    >
      <span
        className={clsx(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold tabular-nums",
          medalBg
        )}
      >
        {rank}
      </span>
      <AddressAvatar address={address} size={32} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-mono text-sm font-medium text-white">
          {formatAddress(address)} {isCurrentUser && <span className="font-sans text-primary">(you)</span>}
          {tier && tier !== "none" && <PremiumBadge tier={tier} size="sm" />}
        </p>
        <p className="font-mono text-[11px] tabular-nums text-muted">{referrals} referrals</p>
      </div>
      <div className="w-full text-right sm:w-auto sm:text-right">
        <p className="font-mono text-sm font-semibold tabular-nums text-white">{formatCompactNumber(xp)} XP</p>
        {/* This is `seasonPoints` (a distinct, server-tracked metric — see
            lib/xp-engine.ts getSeasonPoints), never the season NUMBER and
            never XP. The value is correct; the label stays qualified. */}
        <p className="font-mono text-[11px] font-medium tabular-nums text-gradient-gold">
          {formatCompactNumber(seasonPoints)} season pts
        </p>
      </div>
    </motion.div>
  );
}
