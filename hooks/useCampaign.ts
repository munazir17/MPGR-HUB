"use client";

// hooks/useCampaign.ts
//
// Client fetch + write helpers for one campaign (detail page):
//   - GET  /api/campaigns/:slug          -> campaign + leaderboard
//   - POST /api/campaigns/:slug join     -> enroll the session wallet
//   - POST /api/campaigns/:slug track    -> record one configured action
//
// The hook ensures a SIWE session first (existing useWalletAuth flow),
// sends credentials for Mini App webviews, and never computes points
// locally — every number shown comes back from the server.

import { useCallback, useEffect, useState } from "react";
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import type {
  CampaignLeaderboardEntry,
  CampaignViewerStanding,
  PublicCampaign,
} from "@/lib/campaigns/campaign-types";

interface CampaignDetailResponse {
  campaign: PublicCampaign;
  leaderboard: CampaignLeaderboardEntry[];
}

interface ActionResult {
  ok: boolean;
  status?: string;
  error?: string;
  standing?: CampaignViewerStanding;
  pointsAwarded?: number;
}

async function postAction(
  slug: string,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  try {
    const res = await fetchWithSession(`/api/campaigns/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
      standing?: CampaignViewerStanding;
      pointsAwarded?: number;
    };
    if (!res.ok) {
      return { ok: false, error: data.error ?? "Request failed" };
    }
    return {
      ok: true,
      status: data.status,
      standing: data.standing,
      pointsAwarded: data.pointsAwarded,
    };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export function useCampaign(slug: string | null | undefined) {
  const [campaign, setCampaign] = useState<PublicCampaign | null>(null);
  const [leaderboard, setLeaderboard] = useState<CampaignLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { authenticate, authenticated } = useWalletAuth();

  const refresh = useCallback(async () => {
    if (!slug) {
      setLoading(false);
      setError("not-found");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSession(`/api/campaigns/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        setCampaign(null);
        setLeaderboard([]);
        setError("not-found");
        return;
      }
      if (!res.ok) throw new Error("Failed to load campaign");
      const data: CampaignDetailResponse = await res.json();
      setCampaign(data.campaign);
      setLeaderboard(Array.isArray(data.leaderboard) ? data.leaderboard : []);
    } catch {
      setError("failed");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (authenticated) return true;
    return authenticate();
  }, [authenticated, authenticate]);

  /** Enroll the connected wallet (authenticates first when needed). */
  const join = useCallback(
    async (identity: { displayName?: string; farcasterId?: string } = {}): Promise<ActionResult> => {
      if (!slug) return { ok: false, error: "Campaign not found" };
      setBusy(true);
      try {
        if (!(await ensureSession())) {
          return { ok: false, error: "Sign in with your wallet to join." };
        }
        const result = await postAction(slug, { action: "join", ...identity });
        if (result.ok) await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [slug, ensureSession, refresh],
  );

  /** Record one configured campaign action (server-computed points). */
  const track = useCallback(
    async (actionId: string, options: { eventId?: string; payload?: Record<string, unknown> } = {}): Promise<ActionResult> => {
      if (!slug) return { ok: false, error: "Campaign not found" };
      setBusy(true);
      try {
        if (!(await ensureSession())) {
          return { ok: false, error: "Sign in with your wallet first." };
        }
        const result = await postAction(slug, {
          action: "track",
          actionId,
          eventId: options.eventId ?? crypto.randomUUID(),
          payload: options.payload,
        });
        if (result.ok) await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [slug, ensureSession, refresh],
  );

  return { campaign, leaderboard, loading, error, busy, refresh, join, track };
}
