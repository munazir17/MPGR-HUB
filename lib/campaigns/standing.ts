// lib/campaigns/standing.ts
//
// Server-computed viewer standing for one campaign — used by both the
// list and detail APIs. Reads only from campaignStore (Redis); never
// accepts client state.

import type {
  CampaignDefinition,
  CampaignViewerStanding,
} from "@/lib/campaigns/campaign-types";
import { campaignStore } from "@/lib/campaigns/campaign-store";

export async function getViewerStanding(
  campaign: CampaignDefinition,
  wallet: string,
): Promise<CampaignViewerStanding> {
  const normalized = wallet.toLowerCase();
  const record = await campaignStore.getParticipant(campaign.id, normalized);
  if (!record) {
    return {
      joined: false,
      points: 0,
      rank: null,
      trackedValue: 0,
      eligibility: null,
      completedActions: {},
    };
  }
  const [points, rank] = await Promise.all([
    campaignStore.getPoints(campaign.id, normalized),
    campaignStore.getRank(campaign.id, normalized),
  ]);
  return {
    joined: true,
    points,
    rank,
    trackedValue: record.trackedValue,
    eligibility: record.eligibility,
    completedActions: record.completedActions,
  };
}
