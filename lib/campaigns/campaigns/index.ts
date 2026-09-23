// lib/campaigns/campaigns/index.ts
//
// The campaign registry — the ONLY place that knows which campaign
// definition files exist. Launching a new campaign is:
//
//   1. add campaigns/<your-campaign>.ts (default-export a CampaignDefinition)
//   2. add one import + one array entry below
//
// Nothing else changes: the Campaigns page, detail page, APIs, store,
// and adapters all read from this list at runtime.

import type { CampaignDefinition } from "@/lib/campaigns/campaign-types";

import agentCompetition from "./agent-example";
import mpgrRunWeekly from "./mpgr-run-example";
import tradingCompetition from "./trading-example";

export const CAMPAIGN_DEFINITIONS: CampaignDefinition[] = [
  mpgrRunWeekly,
  tradingCompetition,
  agentCompetition,
];
