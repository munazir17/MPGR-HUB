// app/api/campaigns/route.ts
//
// GET /api/campaigns — public read of every configured campaign with
// server-side participant counts and (when a wallet session cookie is
// present) the viewer's per-campaign standing.
//
// Campaign data is config + server state only; nothing here trusts or
// echoes client-supplied ranking data. Writes live on
// POST /api/campaigns/[slug].

import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { getAllCampaigns, resolveCampaignStatus, toPublicCampaign } from "@/lib/campaigns/campaign-registry";
import { campaignStore } from "@/lib/campaigns/campaign-store";
import { getViewerStanding } from "@/lib/campaigns/standing";
import type { PublicCampaign } from "@/lib/campaigns/campaign-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
const headers = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const STATUS_FILTERS = new Set(["active", "upcoming", "completed", "paused"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  if (statusFilter && !STATUS_FILTERS.has(statusFilter)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400, headers });
  }

  try {
    const session = await authenticateRequest(request);
    const now = new Date();
    const all = getAllCampaigns();

    const campaigns: PublicCampaign[] = [];
    for (const campaign of all) {
      const status = resolveCampaignStatus(campaign, now);

      // Ended campaigns: lazily freeze the final leaderboard (idempotent
      // SET NX in the store) so the ranking recorded at campaign end is
      // preserved from the first read onward.
      let finalized = false;
      if (status === "completed") {
        try {
          finalized = (await campaignStore.finalizeCampaign(campaign, now)) !== null;
        } catch {
          finalized = false;
        }
      }

      const [participantCount, viewer] = await Promise.all([
        campaignStore.getParticipantCount(campaign.id).catch(() => 0),
        session ? getViewerStanding(campaign, session.wallet).catch(() => null) : Promise.resolve(null),
      ]);

      const publicCampaign = toPublicCampaign(campaign, {
        now,
        participantCount,
        finalized,
        viewer,
      });
      if (!statusFilter || status === statusFilter) {
        campaigns.push(publicCampaign);
      }
    }

    return NextResponse.json({ campaigns, serverTime: now.toISOString() }, { headers });
  } catch (error) {
    console.error("GET /api/campaigns failed", error);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500, headers });
  }
}
