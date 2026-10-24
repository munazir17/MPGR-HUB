// lib/campaigns/adapters/agent-adapter.ts
//
// eventType "agent". Points are refused until a server task ledger
// exists. A client POST is not evidence that an agent task completed.

import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";

export const agentCampaignAdapter: CampaignEventAdapter = {
  eventType: "agent",

  validate(context: AdapterContext): AdapterValidation {
    const { action } = context;

    // No server agent-task ledger is wired. A missing evidence source used
    // to return ok with a null evidence id, and the route then minted a
    // fresh UUID per POST — so "complete an agent task" was a client claim.
    // Fail closed until a real task id can be checked.
    if (action.evidence) {
      return { ok: false, reason: "Unsupported agent evidence source." };
    }

    return {
      ok: false,
      reason: "Agent task points require a server-verified task. Client claims are not accepted.",
    };
  },
};
