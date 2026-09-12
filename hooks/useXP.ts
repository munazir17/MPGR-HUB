"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  awardXP,
  cacheServerXPTotals,
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

interface ServerStanding {
  xp: number;
  seasonPoints: number;
  rank: number | null;
  referrals?: number;
}

async function fetchServerStanding(): Promise<ServerStanding | null> {
  try {
    const res = await fetch("/api/xp", { method: "GET", cache: "no-store", credentials: "include" });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<ServerStanding> & { source?: string };
    if (typeof body.xp !== "number" || !Number.isFinite(body.xp)) return null;
    return {
      xp: body.xp,
      seasonPoints: typeof body.seasonPoints === "number" ? body.seasonPoints : 0,
      rank: typeof body.rank === "number" ? body.rank : null,
      referrals: typeof body.referrals === "number" ? body.referrals : undefined,
    };
  } catch {
    return null;
  }
}

async function postServerXP(action: "WALLET_CONNECTED" | "DAILY_CHECK_IN"): Promise<ServerStanding | null> {
  try {
    const res = await fetch("/api/xp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      keepalive: true,
    });
    if (!res.ok) return fetchServerStanding();
    const body = (await res.json()) as {
      totalXp?: number;
      seasonPoints?: number;
      rank?: number | null;
    };
    if (typeof body.totalXp === "number" && Number.isFinite(body.totalXp)) {
      return {
        xp: body.totalXp,
        seasonPoints: typeof body.seasonPoints === "number" ? body.seasonPoints : 0,
        rank: typeof body.rank === "number" ? body.rank : null,
      };
    }
    return fetchServerStanding();
  } catch {
    return null;
  }
}

function applyStanding(address: string, standing: ServerStanding | null): UserXPRecord {
  if (!standing) return getUserRecord(address);
  return cacheServerXPTotals(address, standing.xp, standing.referrals, standing.seasonPoints);
}

export function useXP() {
  const { address, isConnected } = useAccount();
  const [record, setRecord] = useState<UserXPRecord | null>(null);
  const [lastEvent, setLastEvent] = useState<XPEvent | null>(null);
  const [leveledUp, setLeveledUp] = useState<number | null>(null);
  const [source, setSource] = useState<"server-ledger" | "local-cache">("local-cache");

  useEffect(() => {
    if (!isConnected || !address) {
      setRecord(null);
      setSource("local-cache");
      return;
    }
    setRecord(getUserRecord(address));
    const onXpUpdated = () => {
      setRecord(getUserRecord(address));
      void fetchServerStanding().then((standing) => {
        setRecord(applyStanding(address, standing));
        if (standing) setSource("server-ledger");
      });
    };
    window.addEventListener("mpgr-xp-updated", onXpUpdated);
    let cancelled = false;
    void (async () => {
      const standing = await postServerXP("WALLET_CONNECTED");
      if (cancelled) return;
      const local = awardXP(address, "WALLET_CONNECTED");
      const merged = applyStanding(address, standing);
      setRecord(merged);
      setSource(standing ? "server-ledger" : "local-cache");
      if (standing) {
        const gained = Math.max(0, standing.xp - (local.record.xp - local.xpGained));
        if (gained > 0) setLastEvent({ amount: gained, id: Date.now() });
      } else if (local.xpGained > 0) {
        setLastEvent({ amount: local.xpGained, id: Date.now() });
      }
      if (local.leveledUp) setLeveledUp(local.newLevel);
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("mpgr-xp-updated", onXpUpdated);
    };
  }, [address, isConnected]);

  const checkIn = useCallback(() => {
    if (!address) return null;
    const result = performDailyCheckIn(address);
    setRecord(result.record);
    void (async () => {
      const standing = await postServerXP("DAILY_CHECK_IN");
      setRecord(applyStanding(address, standing));
      setSource(standing ? "server-ledger" : "local-cache");
    })();
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
    [address],
  );

  const dismissLevelUp = useCallback(() => setLeveledUp(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  const refresh = useCallback(() => {
    if (!address) return;
    setRecord(getUserRecord(address));
    void (async () => {
      const standing = await fetchServerStanding();
      setRecord(applyStanding(address, standing));
      setSource(standing ? "server-ledger" : "local-cache");
    })();
  }, [address]);

  return {
    record,
    checkIn,
    claim,
    refresh,
    isConnected,
    lastEvent,
    leveledUp,
    dismissLevelUp,
    dismissEvent,
    source,
  };
}
