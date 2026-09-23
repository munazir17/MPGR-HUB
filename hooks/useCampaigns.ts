"use client";

// hooks/useCampaigns.ts
//
// Client fetch for GET /api/campaigns — normalized PublicCampaign rows
// (config + server participant counts + the viewer's standing). Follows
// the same fetch shape as hooks/useLeaderboard.ts (no-store, session
// cookie included for Farcaster/Base Mini App webviews via
// fetchWithSession).

import { useCallback, useEffect, useState } from "react";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import type { PublicCampaign } from "@/lib/campaigns/campaign-types";

interface CampaignsResponse {
  campaigns: PublicCampaign[];
  serverTime?: string;
}

export function useCampaigns(status?: "active" | "upcoming" | "completed" | "paused" | "all") {
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = status && status !== "all" ? `?status=${status}` : "";
      const res = await fetchWithSession(`/api/campaigns${qs}`);
      if (!res.ok) throw new Error("Failed to load campaigns");
      const data: CampaignsResponse = await res.json();
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
    } catch {
      setError("Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { campaigns, loading, error, refresh };
}
