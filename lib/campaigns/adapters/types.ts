// lib/campaigns/adapters/types.ts
//
// Campaign tracking adapter contract.
//
// Different campaigns validate different kinds of activity. The Campaign
// page and the API routes never contain campaign-specific tracking logic —
// they call resolveCampaignAction() (adapters/registry.ts), which:
//
//   1. applies the SHARED checks (campaign window, action exists,
//      numeric input bounds, idempotency/event id shape);
//   2. delegates extra validation to the adapter registered for the
//      campaign's eventType;
//   3. returns a fully server-computed point award.
//
// Adapters may resolve trusted evidence from existing server stores
// (e.g. the game adapter reads verified RunRecords) so clients can never
// submit a leaderboard total directly.

import type {
  CampaignActionConfig,
  CampaignDefinition,
} from "@/lib/campaigns/campaign-types";

export interface AdapterContext {
  campaign: CampaignDefinition;
  action: CampaignActionConfig;
  /** Authenticated session wallet (lowercased) the action is recorded for. */
  wallet: string;
  now: Date;
  /** Raw client payload (already size-limited by the route). */
  payload: Record<string, unknown> | undefined;
}

export type AdapterValidation =
  | {
      ok: true;
      /**
       * Evidence object the shared bonus math reads numeric fields from.
       * For evidence-backed actions this is server-derived (client payload
       * never seeds trusted numbers); for manual actions it is the
       * bounds-checked numeric input.
       */
      evidence: Record<string, number | string>;
      /**
       * Idempotency key for this occurrence. Server-evidence adapters
       * derive it from trusted data (e.g. a game sessionId) so the same
       * real-world event can never be counted twice. `null` means "no
       * server evidence id — the route falls back to the client-supplied
       * event id (validated) or a server-generated UUID".
       */
      evidenceId: string | null;
      /** Optional extra metric increment recorded on the participant
       *  (e.g. best score). Defaults to 0. */
      metricDelta?: number;
    }
  | { ok: false; reason: string };

export interface CampaignEventAdapter {
  /** Matches CampaignDefinition.eventType this adapter serves. */
  eventType: string;
  /** Extra, eventType-specific validation after the shared checks. */
  validate(context: AdapterContext): AdapterValidation | Promise<AdapterValidation>;
}
