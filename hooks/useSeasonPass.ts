"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  getSeasonPassStatus,
  getSeasonPassState,
  getSeasonTrack,
  getSeasonMissions,
  claimFreeReward,
  claimPremiumReward,
  claimSeasonMission,
  type SeasonPassStatus,
  type SeasonPassState,
  type SeasonTrackNode,
} from "@/lib/season-engine";
import { getUserRecord, type Achievement } from "@/lib/xp-engine";

interface SeasonEvent {
  id: number;
  message: string;
}

export function useSeasonPass() {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<SeasonPassStatus | null>(null);
  const [state, setState] = useState<SeasonPassState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<SeasonEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setStatus(getSeasonPassStatus(address));
    setState(getSeasonPassState(address));
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setStatus(null);
      setState(null);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Season level depends on Premium tier (locks unlock over time) and the
  // season countdown — recompute periodically, same pattern as
  // hooks/usePremium.ts / hooks/useTokenLock.ts.
  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const track: SeasonTrackNode[] = status && state ? getSeasonTrack(status, state) : [];
  const missions: Achievement[] =
    address && status && state ? getSeasonMissions(getUserRecord(address), status.seasonPoints, state) : [];

  const claimFree = useCallback(
    (level: number) => {
      if (!address) return;
      setError(null);
      const result = claimFreeReward(address, level);
      if (!result.success) {
        setError(result.error ?? "Unable to claim this reward.");
      } else {
        setState(result.state);
        setLastEvent({ id: Date.now(), message: `Free reward claimed — Level ${level}` });
      }
    },
    [address]
  );

  const claimPremium = useCallback(
    (level: number) => {
      if (!address) return;
      setError(null);
      const result = claimPremiumReward(address, level);
      if (!result.success) {
        setError(result.error ?? "Unable to claim this reward.");
      } else {
        setState(result.state);
        setLastEvent({ id: Date.now(), message: `Premium reward claimed — Level ${level}` });
      }
    },
    [address]
  );

  const claimMission = useCallback(
    (missionId: string) => {
      if (!address) return;
      setState(claimSeasonMission(address, missionId));
    },
    [address]
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    status,
    state,
    track,
    missions,
    isConnected,
    loading: isConnected && !hasLoaded,
    error,
    lastEvent,
    claimFree,
    claimPremium,
    claimMission,
    dismissError,
    dismissEvent,
    refresh,
  };
}
