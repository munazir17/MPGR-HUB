"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  awardXP,
  claimAchievement,
  getUserRecord,
  performDailyCheckIn,
  type UserXPRecord,
  type GameAchievementStats,
} from "@/lib/xp-engine";

interface XPEvent {
  amount: number;
  id: number;
}

// Bug fix — global leaderboard.
//
// lib/xp-engine.ts stays exactly as it was (a local, per-browser XP
// cache — untouched). The only addition here is a fire-and-forget sync
// of {wallet, xp, history} to the server-side leaderboard store (see
// lib/leaderboard-store.ts) whenever the local record changes, so every
// OTHER wallet's leaderboard page can see this wallet's standing too —
// not just this browser.
//
// Root-cause fix — Season Points data integrity. This used to compute
// `seasonPoints` locally (via getSeasonPoints) and send that finished
// number to the server, which then stored it as-is. Season Points is
// now a server-authoritative calculation (see the header comment in
// app/api/leaderboard/route.ts): the client sends its raw `history`
// instead, and the server derives Season Points itself using the exact
// same canonical lib/season-points.ts logic getSeasonPoints() uses for
// this wallet's own local display. A client can no longer influence
// its Season Points by sending a bigger number directly.
async function syncServerXP(action: "WALLET_CONNECTED" | "DAILY_CHECK_IN") {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const res = await fetch("/api/xp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }), keepalive: true });
      if (res.ok || res.status === 400) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function useXP() {
  const { address, isConnected } = useAccount();
  const [record, setRecord] = useState<UserXPRecord | null>(null);
  const [lastEvent, setLastEvent] = useState<XPEvent | null>(null);
  const [leveledUp, setLeveledUp] = useState<number | null>(null);

  useEffect(() => {
    if (!isConnected || !address) {
      setRecord(null);
      return;
    }
    const result = awardXP(address, "WALLET_CONNECTED");
    setRecord(result.record);
    void syncServerXP("WALLET_CONNECTED");
    if (result.xpGained > 0) {
      setLastEvent({ amount: result.xpGained, id: Date.now() });
    }
    if (result.leveledUp) setLeveledUp(result.newLevel);
  }, [address, isConnected]);

  const checkIn = useCallback(() => {
    if (!address) return null;
    const result = performDailyCheckIn(address);
    setRecord(result.record);
    void syncServerXP("DAILY_CHECK_IN");
    if (result.xpGained > 0) setLastEvent({ amount: result.xpGained, id: Date.now() });
    if (result.leveledUp) setLeveledUp(result.newLevel);
    return result;
  }, [address]);

  const claim = useCallback(
    (achievementId: string, gameStats?: GameAchievementStats) => {
      if (!address) return;
      const updated = claimAchievement(address, achievementId, gameStats);
      setRecord(updated);
    },
    [address]
  );

  const dismissLevelUp = useCallback(() => setLeveledUp(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  const refresh = useCallback(() => {
    if (!address) return;
    setRecord(getUserRecord(address));
  }, [address]);

  return { record, checkIn, claim, refresh, isConnected, lastEvent, leveledUp, dismissLevelUp, dismissEvent };
}
