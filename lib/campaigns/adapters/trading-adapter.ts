// lib/campaigns/adapters/trading-adapter.ts
//
// eventType "trading". Client-reported volume is not a trade.
// Points stay refused until a server trade record is the evidence source.

import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";

export const tradingCampaignAdapter: CampaignEventAdapter = {
  eventType: "trading",

  validate(_context: AdapterContext): AdapterValidation {
    // No server trade ledger is wired. Client volume (volumeUsd or any
    // other numeric field) must not become campaign points.
    return {
      ok: false,
      reason: "Trading points require a server trade record. Client-reported volume is not accepted.",
    };
  },
};
