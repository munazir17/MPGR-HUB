// app/api/campaigns/[slug]/admin/route.ts
//
// Internal campaign results endpoint — winner identification and reward
// bookkeeping AFTER a campaign ends. Protected exactly like the game
// settlement route: Bearer CRON_SECRET only (timing-safe compare,
// fail-closed when unset). Never cookie/session authenticated, never
// publicly reachable, and returns no provider/Redis internals.
//
// GET  -> full ranked participant list with wallet, display identity,
//         points, eligibility, and reward status: enough to answer
//         WHO WON / WHAT SCORE / WHICH WALLET / WHAT REWARD.
// POST -> record a manual reward-distribution outcome for one wallet
//         (status/amount/tx hash). This RECORDS facts only — it never
//         transfers tokens or calls a contract.

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { findCampaignBySlug, resolveCampaignStatus } from "@/lib/campaigns/campaign-registry";
import { campaignStore } from "@/lib/campaigns/campaign-store";
import type { CampaignRewardStatus } from "@/lib/campaigns/campaign-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const REWARD_STATUSES = new Set<CampaignRewardStatus>(["pending", "distributed", "ineligible"]);
const HASH_RE = /^0x[0-9a-fA-F]{6,128}$/;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // unconfigured endpoint never opens
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deny() {
  return NextResponse.json({ error: "Not authorized" }, { status: 401, headers });
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const requestId = requestIdFromRequest(request);
  if (!isAuthorized(request)) return deny();

  const { slug } = await context.params;
  const campaign = findCampaignBySlug(typeof slug === "string" ? slug : "");
  if (!campaign) {
    return withRequestId(NextResponse.json({ error: "Campaign not found" }, { status: 404, headers }), requestId);
  }

  try {
    const now = new Date();
    const status = resolveCampaignStatus(campaign, now);
    // Ended campaigns: make sure the final ranking is frozen before an
    // operator reads results (idempotent write-once snapshot).
    let finalized = false;
    if (status === "completed") {
      try {
        finalized = (await campaignStore.finalizeCampaign(campaign, now)) !== null;
      } catch {
        finalized = false;
      }
    }
    const participants = await campaignStore.listAllParticipants(campaign.id);
    const top = participants.slice(0, 10);

    return withRequestId(
      NextResponse.json(
        {
          campaign: {
            id: campaign.id,
            slug: campaign.slug,
            title: campaign.title,
            status,
            startAt: campaign.startAt,
            endAt: campaign.endAt,
            finalized,
            leaderboardEnabled: campaign.leaderboardEnabled,
            trackingMetric: campaign.trackingMetric,
            rewardPool: campaign.rewardPool,
            rewardType: campaign.rewardType,
            rewardSymbol: campaign.rewardSymbol ?? null,
            rewardAsset: campaign.rewardAsset ?? null,
            rewardDescription: campaign.rewardDescription ?? null,
            rewardDistribution: campaign.rewardDistribution ?? null,
          },
          participantCount: participants.length,
          top,
          participants,
        },
        { headers },
      ),
      requestId,
    );
  } catch (error) {
    console.error(`GET /api/campaigns/${slug}/admin failed`, error);
    return withRequestId(
      NextResponse.json({ error: "Failed to load campaign results" }, { status: 500, headers }),
      requestId,
    );
  }
}

interface RewardOutcomeBody {
  wallet: string;
  rewardStatus: CampaignRewardStatus;
  rewardAmount?: string;
  rewardTxHash?: string;
}

function parseOutcome(value: unknown): RewardOutcomeBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.wallet !== "string" || !ADDRESS_RE.test(body.wallet)) return null;
  if (typeof body.rewardStatus !== "string" || !REWARD_STATUSES.has(body.rewardStatus as CampaignRewardStatus)) {
    return null;
  }
  if (body.rewardAmount !== undefined && typeof body.rewardAmount !== "string") return null;
  if (body.rewardTxHash !== undefined && (typeof body.rewardTxHash !== "string" || !HASH_RE.test(body.rewardTxHash))) {
    return null;
  }
  return {
    wallet: body.wallet,
    rewardStatus: body.rewardStatus as CampaignRewardStatus,
    rewardAmount: body.rewardAmount as string | undefined,
    rewardTxHash: body.rewardTxHash as string | undefined,
  };
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const requestId = requestIdFromRequest(request);
  if (!isAuthorized(request)) return deny();

  const { slug } = await context.params;
  const campaign = findCampaignBySlug(typeof slug === "string" ? slug : "");
  if (!campaign) {
    return withRequestId(NextResponse.json({ error: "Campaign not found" }, { status: 404, headers }), requestId);
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > 4 * 1024) {
      return withRequestId(NextResponse.json({ error: "Request body too large" }, { status: 413, headers }), requestId);
    }
    raw = JSON.parse(text) as unknown;
  } catch {
    return withRequestId(NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers }), requestId);
  }

  const body = parseOutcome(raw);
  if (!body) {
    return withRequestId(
      NextResponse.json(
        { error: "Body must be { wallet, rewardStatus: pending|distributed|ineligible, rewardAmount?, rewardTxHash? }" },
        { status: 400, headers },
      ),
      requestId,
    );
  }

  try {
    const updated = await campaignStore.setRewardOutcome(campaign.id, body.wallet, {
      rewardStatus: body.rewardStatus,
      rewardAmount: body.rewardAmount,
      rewardTxHash: body.rewardTxHash,
    });
    if (!updated) {
      return withRequestId(
        NextResponse.json({ error: "Participant not found" }, { status: 404, headers }),
        requestId,
      );
    }
    return withRequestId(
      NextResponse.json(
        {
          ok: true,
          participant: updated,
          recordedAt: new Date().toISOString(),
        },
        { headers },
      ),
      requestId,
    );
  } catch (error) {
    console.error(`POST /api/campaigns/${slug}/admin failed`, error);
    return withRequestId(
      NextResponse.json({ error: "Failed to record reward outcome" }, { status: 500, headers }),
      requestId,
    );
  }
}
