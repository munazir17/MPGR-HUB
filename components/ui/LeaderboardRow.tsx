"use client";

import { motion } from "framer-motion";
import { AddressAvatar } from "@/components/AddressAvatar";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import { clsx } from "clsx";

interface LeaderboardRowProps {
  rank: number;
  address: string;
  xp: number;
  seasonPoints: number;
  referrals: number;
  isCurrentUser?: boolean;
}

export function LeaderboardRow({ rank, address, xp, seasonPoints, referrals, isCurrentUser }: LeaderboardRowProps) {
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
      whileHover={{ x: 2 }}
      className={clsx(
        "flex items-center gap-3 rounded-xl border p-3.5 transition-colors duration-200",
        isCurrentUser
          ? "border-primary/40 bg-primary/[0.06] shadow-glow"
          : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
      )}
    >
      <span
        className={clsx(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
          isTop3 ? medalBg : medalBg
        )}
      >
        {rank}
      </span>
      <AddressAvatar address={address} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {formatAddress(address)} {isCurrentUser && <span className="text-primary">(you)</span>}
        </p>
        <p className="text-[11px] text-muted">{referrals} referrals</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold text-white">{formatCompactNumber(xp)} XP</p>
        <p className="text-[11px] font-medium text-gradient-gold">{formatCompactNumber(seasonPoints)} season</p>
      </div>
    </motion.div>
  );
}
