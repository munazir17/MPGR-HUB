"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  awardXP,
  claimAchievement,
  getUserRecord,
  performDailyCheckIn,
  type UserXPRecord,
} from "@/lib/xp-engine";

interface XPEvent {
  amount: number;
  id: number;
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
    if (result.xpGained > 0) {
      setLastEvent({ amount: result.xpGained, id: Date.now() });
    }
    if (result.leveledUp) setLeveledUp(result.newLevel);
  }, [address, isConnected]);

  const checkIn = useCallback(() => {
    if (!address) return null;
    const result = performDailyCheckIn(address);
    setRecord(result.record);
    if (result.xpGained > 0) setLastEvent({ amount: result.xpGained, id: Date.now() });
    if (result.leveledUp) setLeveledUp(result.newLevel);
    return result;
  }, [address]);

  const claim = useCallback(
    (achievementId: string) => {
      if (!address) return;
      setRecord(claimAchievement(address, achievementId));
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
