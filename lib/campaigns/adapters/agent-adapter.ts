// lib/campaigns/adapters/agent-adapter.ts
//
// eventType "agent" — manual actions around MPGR Agent activity.
// Same fail-closed shape as the trading adapter: shared validation
// clamps any numeric input; a future evidence source (e.g. a server
// agent-task ledger) plugs in here without frontend changes.

import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";
import { collectNumericEvidence } from "./shared";

export const agentCampaignAdapter: CampaignEventAdapter = {
  eventType: "agent",

  validate(context: AdapterContext): AdapterValidation {
    const { action, payload } = context;

    if (action.evidence) {
      return { ok: false, reason: "Unsupported agent evidence source." };
    }

    const evidence = collectNumericEvidence(action, payload);
    if (!evidence) {
      return { ok: false, reason: "Missing or out-of-range agent input." };
    }

    return {
      ok: true,
      evidence,
      evidenceId: null,
    };
  },
};
