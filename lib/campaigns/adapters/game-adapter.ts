// lib/campaigns/adapters/game-adapter.ts
//
// eventType "game" — the strongest validation path in the campaign
// system: evidence-backed scoring against EXISTING server game data.
//
// An action with `evidence: "game-run"` accepts only `{ sessionId }`.
// The adapter loads the server-side RunRecord written by
// POST /api/games/mpgr-run/reward (which already re-validates the run
// and, when enabled, replays it authoritatively) and derives the score
// from that record — never from the client. The sessionId doubles as
// the idempotency key, so one verified run can only ever be counted
// toward one campaign once.

import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";
import type { AdapterContext, AdapterValidation, CampaignEventAdapter } from "./types";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const GAME_RUN_EVIDENCE = "game-run";

export const gameCampaignAdapter: CampaignEventAdapter = {
  eventType: "game",

  async validate(context: AdapterContext): Promise<AdapterValidation> {
    const { action, campaign, wallet, now, payload } = context;

    if (action.evidence !== GAME_RUN_EVIDENCE) {
      // Configured evidence this adapter does not know — fail closed
      // rather than falling back to trusting the payload.
      return { ok: false, reason: "Unsupported game evidence source." };
    }

    const sessionId =
      typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!SESSION_ID_RE.test(sessionId)) {
      return { ok: false, reason: "A valid game session id is required." };
    }

    const run = await kvAllocationStore.getRunRecord(sessionId);
    if (!run) {
      return { ok: false, reason: "No server-verified run found for that session." };
    }
    if (run.wallet.toLowerCase() !== wallet) {
      return { ok: false, reason: "That run belongs to a different wallet." };
    }
    if (!run.serverValidated) {
      return { ok: false, reason: "That run did not pass server validation." };
    }
    const submittedAt = Date.parse(run.submittedAt);
    if (!Number.isFinite(submittedAt)) {
      return { ok: false, reason: "Run record is malformed." };
    }
    const start = Date.parse(campaign.startAt);
    const end = Date.parse(campaign.endAt);
    if (submittedAt < start || submittedAt >= end || submittedAt > now.getTime()) {
      return { ok: false, reason: "That run happened outside the campaign window." };
    }

    const score = run.result?.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
      return { ok: false, reason: "Run score is missing or invalid." };
    }

    return {
      ok: true,
      evidence: { score: Math.floor(score) },
      evidenceId: `run:${sessionId}`,
      metricDelta: Math.floor(score),
    };
  },
};
