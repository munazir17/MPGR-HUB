"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  awardXP,
  getUserRecord,
  performDailyCheckIn,
  type UserXPRecord,
} from "@/lib/xp-engine";

export function useXP() {
  const { address, isConnected } = useAccount();
  const [record, setRecord] = useState<UserXPRecord | null>(null);

  useEffect(() => {
    if (!isConnected || !address) {
      setRecord(null);
      return;
    }
    // Award the one-time "Wallet Connected" XP, then load the current record.
    const updated = awardXP(address, "WALLET_CONNECTED");
    setRecord(updated);
  }, [address, isConnected]);

  const checkIn = useCallback(() => {
    if (!address) return null;
    const result = performDailyCheckIn(address);
    setRecord(result.record);
    return result;
  }, [address]);

  const refresh = useCallback(() => {
    if (!address) return;
    setRecord(getUserRecord(address));
  }, [address]);

  return { record, checkIn, refresh, isConnected };
}
