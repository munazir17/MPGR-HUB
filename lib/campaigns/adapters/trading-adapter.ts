// lib/campaigns/adapters/trading-adapter.ts
//
// eventType "trading" — manual actions with a bounded numeric input
// (e.g. reported session volume). The shared validation already clamps
// the value to the configured [min, max] integer range and enforces
// per-day caps; this adapter exists so trading-specific rules (hooks
// into a future server trade ledger, stricter bounds, allow-lists) can
// be added WITHOUT touching the Campaign page or the core engine.

import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";
import { collectNumericEvidence } from "./shared";

export const tradingCampaignAdapter: CampaignEventAdapter = {
  eventType: "trading",

  validate(context: AdapterContext): AdapterValidation {
    const { action, payload } = context;

    if (action.evidence) {
      // No trading evidence source is wired yet — fail closed instead of
      // trusting whatever the client sent.
      return { ok: false, reason: "Unsupported trading evidence source." };
    }

    const evidence = collectNumericEvidence(action, payload);
    if (!evidence) {
      return { ok: false, reason: "Missing or out-of-range trading input." };
    }

    return {
      ok: true,
      evidence,
      evidenceId: null,
    };
  },
};
