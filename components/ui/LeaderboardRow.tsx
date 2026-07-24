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
  const medalColor = rank === 1 ? "text-gold" : rank === 2 ? "text-gray-300" : "text-orange-400";

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className={clsx(
        "flex items-center gap-3 rounded-xl border p-3",
        isCurrentUser ? "border-primary/40 bg-primary/5" : "border-white/10 bg-white/[0.02]"
      )}
    >
      <span className={clsx("w-6 text-center text-sm font-semibold", isTop3 ? medalColor : "text-muted")}>
        {rank}
      </span>
      <AddressAvatar address={address} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">
          {formatAddress(address)} {isCurrentUser && <span className="text-primary">(you)</span>}
        </p>
        <p className="text-[11px] text-muted">{referrals} referrals</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold text-white">{formatCompactNumber(xp)} XP</p>
        <p className="text-[11px] text-gold">{formatCompactNumber(seasonPoints)} season</p>
      </div>
    </motion.div>
  );
}
