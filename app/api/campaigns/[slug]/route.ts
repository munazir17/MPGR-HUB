// app/api/campaigns/[slug]/route.ts
//
// GET  /api/campaigns/:slug — one campaign + its leaderboard + the
//      viewer's standing (session cookie optional).
// POST /api/campaigns/:slug — participant writes:
//        { action: "join", displayName?, farcasterId? }
//        { action: "track", actionId, eventId?, payload? }
//
// Trust model (see AGENTS.md "never trust score/XP claims from a
// browser"): the client never submits points or totals. It names an
// action; the server resolves it through the campaign config + the
// eventType adapter (existing server evidence where available), computes
// the award, and writes it through one idempotent, cap-enforced Lua
// script in campaign-store.ts. The session wallet is the identity —
// never a wallet address from the body.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { authenticateRequest } from "@/lib/auth/session-store";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import { getTotalXP } from "@/lib/rewards/xp-ledger";
import { findCampaignBySlug, resolveCampaignStatus, toPublicCampaign } from "@/lib/campaigns/campaign-registry";
import { campaignStore, sanitizeDisplayName, sanitizeFarcasterId } from "@/lib/campaigns/campaign-store";
import { resolveCampaignAction } from "@/lib/campaigns/adapters/registry";
import { getViewerStanding } from "@/lib/campaigns/standing";
import type { CampaignLeaderboardEntry } from "@/lib/campaigns/campaign-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const EVENT_ID_RE = /^[A-Za-z0-9:_-]{6,160}$/;
const LEADERBOARD_LIMIT_MAX = 100;

function notFound() {
  return NextResponse.json({ error: "Campaign not found" }, { status: 404, headers });
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const campaign = findCampaignBySlug(typeof slug === "string" ? slug : "");
  if (!campaign) return notFound();

  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), LEADERBOARD_LIMIT_MAX)
    : 50;

  try {
    const now = new Date();
    const status = resolveCampaignStatus(campaign, now);

    // Freeze the final leaderboard on first read after the campaign ends
    // (idempotent write-once snapshot inside the store).
    let finalized = false;
    if (status === "completed") {
      try {
        finalized = (await campaignStore.finalizeCampaign(campaign, now)) !== null;
      } catch {
        finalized = false;
      }
    }

    const session = await authenticateRequest(request);
    const [participantCount, viewer] = await Promise.all([
      campaignStore.getParticipantCount(campaign.id),
      session ? getViewerStanding(campaign, session.wallet) : Promise.resolve(null),
    ]);

    let leaderboard: CampaignLeaderboardEntry[] = [];
    if (campaign.leaderboardEnabled) {
      leaderboard = await campaignStore.getLeaderboard(campaign, limit);
    }

    return NextResponse.json(
      {
        campaign: toPublicCampaign(campaign, { now, participantCount, finalized, viewer }),
        leaderboard,
        serverTime: now.toISOString(),
      },
      { headers },
    );
  } catch (error) {
    console.error(`GET /api/campaigns/${slug} failed`, error);
    return NextResponse.json({ error: "Failed to load campaign" }, { status: 500, headers });
  }
}

interface TrackBody {
  actionId: string;
  eventId?: string;
  payload?: Record<string, unknown>;
}

function isTrackBody(value: unknown): value is TrackBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.actionId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(body.actionId)) return false;
  if (body.eventId !== undefined && (typeof body.eventId !== "string" || !EVENT_ID_RE.test(body.eventId))) return false;
  if (body.payload !== undefined) {
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return false;
    if (Object.keys(body.payload).length > 8) return false;
  }
  return true;
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const guard = await protectApiRequest(request, "campaign", 30, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) =>
    withRequestId(NextResponse.json(body, init), guard.requestId);

  const { slug } = await context.params;
  const campaign = findCampaignBySlug(typeof slug === "string" ? slug : "");
  if (!campaign) return notFound();

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, { status: 400 });
  const value = body as Record<string, unknown>;
  const kind = value.action;
  if (kind !== "join" && kind !== "track") {
    return json({ error: "Body must include action: \"join\" | \"track\"" }, { status: 400 });
  }

  const session = await authenticateRequest(request);
  if (!session) return json({ error: "Authentication required" }, { status: 401 });
  const wallet = session.wallet.toLowerCase();
  const now = new Date();

  try {
    if (kind === "join") {
      const status = resolveCampaignStatus(campaign, now);
      if (status !== "active") {
        return json({ error: `Campaign is ${status}`, code: "campaign-not-active" }, { status: 409 });
      }

      // Eligibility evaluated here, server-side, against server data.
      let eligibility: "eligible" | "ineligible" = "eligible";
      let eligibilityReason: string | null = null;
      const minAccountXp = campaign.eligibility?.minAccountXp;
      if (typeof minAccountXp === "number" && minAccountXp > 0) {
        const accountXp = await getTotalXP(session.wallet);
        if (accountXp < minAccountXp) {
          eligibility = "ineligible";
          eligibilityReason = `Requires at least ${minAccountXp} account XP.`;
        }
      }

      const result = await campaignStore.joinCampaign(
        campaign,
        {
          wallet,
          farcasterId: sanitizeFarcasterId(value.farcasterId),
          displayName: sanitizeDisplayName(value.displayName),
          eligibility,
          eligibilityReason,
        },
        now,
      );
      const standing = await getViewerStanding(campaign, wallet);
      return json(
        {
          status: result.alreadyJoined ? "already-joined" : "joined",
          eligibility,
          eligibilityReason,
          standing,
        },
        { headers },
      );
    }

    // --- track ----------------------------------------------------------
    if (!isTrackBody(value)) {
      return json({ error: "Body must be { action:\"track\", actionId, eventId?, payload? }" }, { status: 400 });
    }
    const participant = await campaignStore.getParticipant(campaign.id, wallet);
    if (!participant) {
      return json({ error: "Join the campaign first", code: "not-participant" }, { status: 403 });
    }
    if (participant.eligibility !== "eligible") {
      return json(
        { error: participant.eligibilityReason ?? "Not eligible for this campaign", code: "ineligible" },
        { status: 403 },
      );
    }

    const resolved = await resolveCampaignAction(
      campaign,
      value.actionId,
      wallet,
      value.payload,
      now,
    );
    if (!resolved.ok) {
      const status =
        resolved.code === "campaign-not-active" ? 409 : resolved.code === "unknown-action" ? 400 : 422;
      return json({ error: resolved.reason, code: resolved.code }, { status });
    }

    // Server-evidence actions key idempotency on the evidence id (e.g.
    // the game sessionId); manual actions use the client event id (so a
    // retried click stays idempotent) or a server-generated UUID.
    const clientEventId =
      typeof value.eventId === "string" && EVENT_ID_RE.test(value.eventId) ? value.eventId : null;
    const eventId = resolved.evidenceId ?? clientEventId ?? `${resolved.action.id}:${randomUUID()}`;

    const result = await campaignStore.recordAction(
      campaign,
      wallet,
      {
        actionId: resolved.action.id,
        points: resolved.points,
        metricDelta: resolved.metricDelta,
        eventId,
      },
      now,
    );
    const standing = await getViewerStanding(campaign, wallet);

    switch (result.status) {
      case "awarded":
        return json({ status: "recorded", pointsAwarded: result.points, standing }, { headers });
      case "duplicate":
        return json({ status: "duplicate", pointsAwarded: 0, standing }, { headers });
      case "not-participant":
        return json({ error: "Join the campaign first", code: "not-participant" }, { status: 403 });
      case "ineligible":
        return json({ error: "Not eligible for this campaign", code: "ineligible" }, { status: 403 });
      case "action-daily-cap":
        return json(
          { error: "Daily limit reached for this action. Try again tomorrow.", code: "action-daily-cap" },
          { status: 429 },
        );
      case "daily-cap":
        return json(
          { error: "Daily campaign points cap reached. Try again tomorrow.", code: "daily-cap" },
          { status: 429 },
        );
      case "total-cap":
        return json(
          { error: "Campaign point limit reached for this campaign.", code: "total-cap" },
          { status: 429 },
        );
      default:
        return json({ error: "Could not record activity" }, { status: 500 });
    }
  } catch (error) {
    console.error(`POST /api/campaigns/${slug} failed`, error);
    return json({ error: "Failed to update campaign participation" }, { status: 500 });
  }
}
