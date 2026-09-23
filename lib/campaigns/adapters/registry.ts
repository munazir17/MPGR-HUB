// lib/campaigns/adapters/registry.ts
//
// Adapter registry + the shared, campaign-agnostic validation pipeline.
// The API route calls resolveCampaignAction(); everything campaign- or
// eventType-specific happens behind this boundary.
//
// eventType → adapter:
//   "game"      → gameCampaignAdapter   (server RunRecord evidence)
//   "trading"   → tradingCampaignAdapter
//   "agent"     → agentCampaignAdapter
//   anything else → the generic adapter (config-driven manual actions)
//
// The generic fallback is what makes future campaign types addable
// without a rewrite: a new campaign with a new eventType works on day
// one via its config; only when it needs custom evidence validation do
// you register one more adapter file here.

import type {
  CampaignActionConfig,
  CampaignDefinition,
} from "@/lib/campaigns/campaign-types";
import { resolveCampaignStatus } from "@/lib/campaigns/campaign-registry";

import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";
import { agentCampaignAdapter } from "./agent-adapter";
import { gameCampaignAdapter } from "./game-adapter";
import { tradingCampaignAdapter } from "./trading-adapter";
import { collectNumericEvidence } from "./shared";

const ADAPTERS: CampaignEventAdapter[] = [
  gameCampaignAdapter,
  tradingCampaignAdapter,
  agentCampaignAdapter,
];

export function getAdapterForEventType(eventType: string): CampaignEventAdapter | null {
  return ADAPTERS.find((a) => a.eventType === eventType) ?? null;
}

/** Generic adapter: config-driven manual actions only. */
const genericAdapter: CampaignEventAdapter = {
  eventType: "*",
  validate(context: AdapterContext): AdapterValidation {
    const { action, payload } = context;
    if (action.evidence) {
      // An evidence source with no registered adapter must never fall
      // back to trusting the client.
      return { ok: false, reason: "This action requires a server evidence source that is not available." };
    }
    const evidence = collectNumericEvidence(action, payload);
    if (!evidence) {
      return { ok: false, reason: "Missing or out-of-range input." };
    }
    return {
      ok: true,
      evidence,
      evidenceId: null,
    };
  },
};

export type ResolveActionFailure = {
  ok: false;
  code:
    | "campaign-not-active"
    | "unknown-action"
    | "invalid-payload"
    | "adapter-rejected";
  reason: string;
};

export type ResolveActionResult = {
  ok: true;
  action: CampaignActionConfig;
  /** Server-computed campaign points for this occurrence. */
  points: number;
  metricDelta: number;
  /** Server-derived idempotency id, or null when the route should use
   *  the client-supplied event id / a generated UUID. */
  evidenceId: string | null;
};

export type ResolveActionResults = ResolveActionResult | ResolveActionFailure;

/**
 * Full server-side resolution of one campaign action submission:
 * window check → action lookup → shared payload checks → adapter
 * validation → point math. Never accepts a client-submitted total.
 */
export async function resolveCampaignAction(
  campaign: CampaignDefinition,
  actionId: string,
  wallet: string,
  payload: Record<string, unknown> | undefined,
  now: Date = new Date(),
): Promise<ResolveActionResults> {
  const status = resolveCampaignStatus(campaign, now);
  if (status !== "active") {
    return { ok: false, code: "campaign-not-active", reason: `Campaign is ${status}.` };
  }

  const action = campaign.points.actions.find((a) => a.id === actionId);
  if (!action) {
    return { ok: false, code: "unknown-action", reason: "Unknown campaign action." };
  }

  const adapter = getAdapterForEventType(campaign.eventType) ?? genericAdapter;
  const context: AdapterContext = { campaign, action, wallet, now, payload };

  let validation: AdapterValidation;
  try {
    validation = await adapter.validate(context);
  } catch {
    // Adapter/store failures fail closed — never award on uncertainty.
    return { ok: false, code: "adapter-rejected", reason: "Activity could not be verified." };
  }
  if (!validation.ok) {
    return { ok: false, code: "adapter-rejected", reason: validation.reason };
  }

  // Point math (shared): base + bounded bonus from evidence. All numbers
  // come from config + adapter-validated evidence — never raw totals.
  let points = Math.max(0, Math.floor(action.points));
  if (action.bonus) {
    const raw = validation.evidence[action.bonus.field];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      const divisor = action.bonus.divisor > 0 ? action.bonus.divisor : 1;
      const bonus = Math.floor(raw / divisor);
      points += Math.min(bonus, Math.max(0, Math.floor(action.bonus.maxBonus)));
    }
  }

  return {
    ok: true,
    action,
    points,
    metricDelta: Math.max(0, Math.floor(validation.metricDelta ?? 0)),
    evidenceId: validation.evidenceId,
  };
}
