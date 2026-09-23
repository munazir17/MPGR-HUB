// lib/campaigns/campaign-store.ts
//
// SERVER-ONLY persistence for Campaign participation — Upstash Redis via
// the project's existing getRedis() (same store as XP/referrals/games).
// localStorage is NEVER the source of truth; it is not read at all here.
//
// Key layout (namespaced per campaign id — campaigns never share state,
// starting a new campaign can never touch old records, and historical
// records are kept indefinitely):
//
//   mpgrhub:campaign:score:{campaignId}                    -> ZSET wallet => campaign points (authoritative ranking)
//   mpgrhub:campaign:participant:{campaignId}:{wallet}     -> JSON  CampaignParticipantRecord (durable)
//   mpgrhub:campaign:event:{campaignId}:{wallet}:{eventId} -> idempotency flag (durable, SET NX)
//   mpgrhub:campaign:cap:{campaignId}:{wallet}:{action}:{day} -> per-action daily occurrence counter (48 h TTL)
//   mpgrhub:campaign:daypts:{campaignId}:{wallet}:{day}    -> per-day points counter for dailyCap (48 h TTL)
//   mpgrhub:campaign:final:{campaignId}                    -> frozen end-of-campaign snapshot (SET NX, written once)
//
// Anti-cheat posture (mirrors lib/rewards/xp-ledger.ts):
//   - the client never submits a total; points are computed server-side
//     by resolveCampaignAction() from config + adapter-validated evidence;
//   - one atomic Lua script gates the write: participant must exist,
//     event id is consumed exactly once, per-action and per-day caps and
//     the campaign point ceiling are enforced BEFORE ZINCRBY;
//   - ranking reads come from the ZSET (never from client state), and
//     once a campaign ends the frozen snapshot is served forever.

import { getRedis } from "@/lib/api/redis";
import type {
  CampaignDefinition,
  CampaignFinalSnapshot,
  CampaignLeaderboardEntry,
  CampaignParticipantRecord,
  CampaignRewardStatus,
} from "@/lib/campaigns/campaign-types";

const kv = () => getRedis();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function campaignScoreKey(campaignId: string): string {
  return `mpgrhub:campaign:score:${campaignId}`;
}
export function campaignParticipantKey(campaignId: string, wallet: string): string {
  return `mpgrhub:campaign:participant:${campaignId}:${wallet.toLowerCase()}`;
}
export function campaignEventKey(campaignId: string, wallet: string, eventId: string): string {
  return `mpgrhub:campaign:event:${campaignId}:${wallet.toLowerCase()}:${eventId}`;
}
function campaignActionCapKey(campaignId: string, wallet: string, actionId: string, day: string): string {
  return `mpgrhub:campaign:cap:${campaignId}:${wallet.toLowerCase()}:${actionId}:${day}`;
}
function campaignDayPointsKey(campaignId: string, wallet: string, day: string): string {
  return `mpgrhub:campaign:daypts:${campaignId}:${wallet.toLowerCase()}:${day}`;
}
export function campaignFinalKey(campaignId: string): string {
  return `mpgrhub:campaign:final:${campaignId}`;
}

const DAY_COUNTER_TTL_SECONDS = 60 * 60 * 48;

function utcDayId(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalize(wallet: string): string {
  return wallet.toLowerCase();
}

/** Display metadata is sanitized, bounded, and NEVER used for ranking. */
export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\p{L}\p{N} _.\-()]/gu, "").trim().slice(0, 32);
  return cleaned.length >= 2 ? cleaned : null;
}

/** Bounded free-text for operator-supplied reward notes/amounts. */
function sanitizeRewardText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\p{L}\p{N} _./:-]/gu, "").trim().slice(0, 64);
  return cleaned.length >= 1 ? cleaned : null;
}

export function sanitizeFarcasterId(value: unknown): string | null {
  if (typeof (value as { toString?: unknown })?.toString !== "function") return null;
  const raw = String(value).trim();
  return /^\d{1,15}$/.test(raw) ? raw : null;
}

// Atomic join: creates the durable participant record (NX — a replay can
// never overwrite the original joinedAt/eligibility) and inserts the
// wallet into the score ZSET with the participation points.
// KEYS: participant record, score zset.
// ARGV: record JSON, participation points, wallet.
// Returns 1 when this call created the record, 0 when already joined.
const JOIN_SCRIPT = `
local created = redis.call("SET", KEYS[1], ARGV[1], "NX")
if not created then return 0 end
redis.call("ZINCRBY", KEYS[2], tonumber(ARGV[2]), ARGV[3])
return 1
`;

// Atomic action award (see header). Returns:
//   1  awarded
//   0  duplicate event id (already counted)
//  -1  not a participant
//  -2  per-action daily cap reached
//  -3  campaign daily points cap reached
//  -4  campaign total points ceiling reached
// KEYS: participant, score zset, event idempotency, action-day cap, day-points.
// ARGV: ttl, action daily limit, points, wallet, campaign maxPoints, campaign dailyCap.
const RECORD_ACTION_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end
local created = redis.call("SET", KEYS[3], "1", "NX")
if not created then return 0 end
local ttl = tonumber(ARGV[1])
local actionLimit = tonumber(ARGV[2])
local points = tonumber(ARGV[3])
local wallet = ARGV[4]
local maxTotal = tonumber(ARGV[5])
local dayLimit = tonumber(ARGV[6])
local actionCounted = 0
if actionLimit > 0 then
  local used = redis.call("INCR", KEYS[4])
  if used == 1 then redis.call("EXPIRE", KEYS[4], ttl) end
  if used > actionLimit then
    redis.call("DECR", KEYS[4])
    redis.call("DEL", KEYS[3])
    return -2
  end
  actionCounted = 1
end
local rollback = function()
  redis.call("DEL", KEYS[3])
  if actionCounted == 1 then redis.call("DECR", KEYS[4]) end
end
if maxTotal > 0 then
  local raw = redis.call("ZSCORE", KEYS[2], wallet)
  local cur = 0
  if raw then cur = tonumber(raw) end
  if cur + points > maxTotal then
    rollback()
    return -4
  end
end
if dayLimit > 0 then
  local used = redis.call("INCRBY", KEYS[5], points)
  if used == points then redis.call("EXPIRE", KEYS[5], ttl) end
  if used > dayLimit then
    redis.call("DECRBY", KEYS[5], points)
    rollback()
    return -3
  end
end
redis.call("ZINCRBY", KEYS[2], points, wallet)
return 1
`;

export type RecordActionResult =
  | { status: "awarded"; points: number }
  | { status: "duplicate" }
  | { status: "not-participant" }
  | { status: "ineligible" }
  | { status: "action-daily-cap" }
  | { status: "daily-cap" }
  | { status: "total-cap" }
  | { status: "error" };

function parseParticipant(raw: unknown, campaignId: string, wallet: string): CampaignParticipantRecord | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CampaignParticipantRecord>;
  if (typeof candidate.wallet !== "string" || normalize(candidate.wallet) !== wallet) return null;
  return {
    campaignId,
    wallet,
    farcasterId: typeof candidate.farcasterId === "string" ? candidate.farcasterId : null,
    displayName: typeof candidate.displayName === "string" ? candidate.displayName : null,
    joinedAt: typeof candidate.joinedAt === "string" ? candidate.joinedAt : new Date(0).toISOString(),
    lastActivityAt: typeof candidate.lastActivityAt === "string" ? candidate.lastActivityAt : (typeof candidate.joinedAt === "string" ? candidate.joinedAt : new Date(0).toISOString()),
    points: Number.isFinite(Number(candidate.points)) ? Number(candidate.points) : 0,
    trackedValue: Number.isFinite(Number(candidate.trackedValue)) ? Number(candidate.trackedValue) : 0,
    completedActions:
      candidate.completedActions && typeof candidate.completedActions === "object"
        ? { ...candidate.completedActions }
        : {},
    eligibility: candidate.eligibility === "ineligible" || candidate.eligibility === "pending" ? candidate.eligibility : "eligible",
    eligibilityReason: typeof candidate.eligibilityReason === "string" ? candidate.eligibilityReason : null,
    rewardStatus: candidate.rewardStatus === "distributed" || candidate.rewardStatus === "ineligible" ? candidate.rewardStatus : "pending",
    rewardType: typeof candidate.rewardType === "string" ? candidate.rewardType : null,
    rewardAmount: typeof candidate.rewardAmount === "string" ? candidate.rewardAmount : null,
    rewardTxHash: typeof candidate.rewardTxHash === "string" ? candidate.rewardTxHash : null,
    rank: Number.isInteger(candidate.rank) ? Number(candidate.rank) : null,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function snapshotParticipantRecord(
  campaign: CampaignDefinition,
  identity: {
    wallet: string;
    farcasterId: string | null;
    displayName: string | null;
    eligibility: CampaignParticipantRecord["eligibility"];
    eligibilityReason: string | null;
  },
  now: Date,
): CampaignParticipantRecord {
  return {
    campaignId: campaign.id,
    wallet: identity.wallet,
    farcasterId: identity.farcasterId,
    displayName: identity.displayName,
    joinedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    points: 0,
    trackedValue: 0,
    completedActions: {},
    eligibility: identity.eligibility,
    eligibilityReason: identity.eligibilityReason,
    rewardStatus: "pending",
    rewardType: campaign.rewardType,
    rewardAmount: null,
    rewardTxHash: null,
    rank: null,
    updatedAt: now.toISOString(),
  };
}

async function readZsetRange(
  campaignId: string,
  start: number,
  stop: number,
): Promise<Array<{ wallet: string; points: number }>> {
  const members = await kv().zrange<string[]>(campaignScoreKey(campaignId), start, stop, { rev: true });
  if (!members?.length) return [];
  const rows = await Promise.all(
    members.map(async (wallet) => {
      const score = await kv().zscore(campaignScoreKey(campaignId), wallet);
      return { wallet, points: Number(score ?? 0) };
    }),
  );
  return rows;
}

function toEntry(
  rank: number,
  wallet: string,
  points: number,
  record: CampaignParticipantRecord | null,
): CampaignLeaderboardEntry {
  return {
    rank,
    wallet,
    displayName: record?.displayName ?? null,
    farcasterId: record?.farcasterId ?? null,
    points: Math.round(points),
    trackedValue: record?.trackedValue ?? 0,
    eligibility: record?.eligibility ?? "pending",
    rewardStatus: record?.rewardStatus ?? "pending",
    joinedAt: record?.joinedAt ?? null,
    lastActivityAt: record?.lastActivityAt ?? null,
  };
}

export const campaignStore = {
  /**
   * Enrolls a wallet in a campaign (idempotent). Eligibility is evaluated
   * by the caller (route) against server data and stored on the record —
   * ineligible joins are still recorded so operators can audit attempts,
   * but they can never earn points (RECORD_ACTION requires eligibility
   * via the route gate).
   */
  async joinCampaign(
    campaign: CampaignDefinition,
    identity: {
      wallet: string;
      farcasterId: string | null;
      displayName: string | null;
      eligibility: CampaignParticipantRecord["eligibility"];
      eligibilityReason: string | null;
    },
    now = new Date(),
  ): Promise<{ alreadyJoined: boolean; record: CampaignParticipantRecord; points: number }> {
    const wallet = normalize(identity.wallet);
    const participation = Math.max(0, Math.floor(campaign.points.participation));
    // Sanitize display metadata at the storage boundary too (defense in
    // depth — routes sanitize first, the store never stores raw input).
    const record = {
      ...snapshotParticipantRecord(
        campaign,
        {
          ...identity,
          displayName: sanitizeDisplayName(identity.displayName),
          farcasterId: sanitizeFarcasterId(identity.farcasterId),
        },
        now,
      ),
      points: participation,
    };

    const created = Number(
      await kv().eval(
        JOIN_SCRIPT,
        [campaignParticipantKey(campaign.id, wallet), campaignScoreKey(campaign.id)],
        [JSON.stringify(record), String(participation), wallet],
      ),
    );

    const existing = await campaignStore.getParticipant(campaign.id, wallet);
    const points = await campaignStore.getPoints(campaign.id, wallet);
    return { alreadyJoined: created !== 1, record: existing ?? record, points };
  },

  async getParticipant(campaignId: string, wallet: string): Promise<CampaignParticipantRecord | null> {
    const raw = await kv().get<unknown>(campaignParticipantKey(campaignId, wallet));
    if (raw === null || raw === undefined) return null;
    return parseParticipant(raw, campaignId, normalize(wallet));
  },

  async getPoints(campaignId: string, wallet: string): Promise<number> {
    const score = await kv().zscore(campaignScoreKey(campaignId), normalize(wallet));
    return Number.isFinite(Number(score)) ? Math.round(Number(score)) : 0;
  },

  async getRank(campaignId: string, wallet: string): Promise<number | null> {
    const final = await campaignStore.getFinalSnapshot(campaignId);
    if (final) {
      const idx = final.entries.findIndex((e) => e.wallet === normalize(wallet));
      return idx === -1 ? null : idx + 1;
    }
    const rank = await kv().zrevrank(campaignScoreKey(campaignId), normalize(wallet));
    return rank === null ? null : rank + 1;
  },

  async getParticipantCount(campaignId: string): Promise<number> {
    const final = await campaignStore.getFinalSnapshot(campaignId);
    if (final) return final.entries.length;
    return await kv().zcard(campaignScoreKey(campaignId));
  },

  /**
   * Records one validated action occurrence atomically (see
   * RECORD_ACTION_SCRIPT), then best-effort refreshes the JSON record's
   * display counters. Ranking always reads the ZSET, so a lost race on
   * the JSON counters can never change standings.
   */
  async recordAction(
    campaign: CampaignDefinition,
    wallet: string,
    options: {
      actionId: string;
      points: number;
      metricDelta: number;
      eventId: string;
    },
    now = new Date(),
  ): Promise<RecordActionResult> {
    const normalized = normalize(wallet);
    const participant = await campaignStore.getParticipant(campaign.id, normalized);
    if (!participant) return { status: "not-participant" };
    if (participant.eligibility !== "eligible") return { status: "ineligible" };

    const points = Math.max(0, Math.floor(options.points));
    const eventId = options.eventId.slice(0, 160);
    if (!eventId) return { status: "error" };

    const action = campaign.points.actions.find((a) => a.id === options.actionId);
    const actionLimit = action?.maxPerDay && action.maxPerDay > 0 ? Math.floor(action.maxPerDay) : 0;
    const day = utcDayId(now);
    const maxTotal = campaign.points.maxPoints && campaign.points.maxPoints > 0 ? Math.floor(campaign.points.maxPoints) : 0;
    const dayLimit = campaign.points.dailyCap && campaign.points.dailyCap > 0 ? Math.floor(campaign.points.dailyCap) : 0;

    let result: number;
    try {
      result = Number(
        await kv().eval(
          RECORD_ACTION_SCRIPT,
          [
            campaignParticipantKey(campaign.id, normalized),
            campaignScoreKey(campaign.id),
            campaignEventKey(campaign.id, normalized, eventId),
            campaignActionCapKey(campaign.id, normalized, options.actionId, day),
            campaignDayPointsKey(campaign.id, normalized, day),
          ],
          [
            String(DAY_COUNTER_TTL_SECONDS),
            String(actionLimit),
            String(points),
            normalized,
            String(maxTotal),
            String(dayLimit),
          ],
        ),
      );
    } catch (error) {
      console.error("campaignStore.recordAction eval failed", error);
      return { status: "error" };
    }

    if (result === 0) return { status: "duplicate" };
    if (result === -1) return { status: "not-participant" };
    if (result === -2) return { status: "action-daily-cap" };
    if (result === -3) return { status: "daily-cap" };
    if (result === -4) return { status: "total-cap" };
    if (result !== 1) return { status: "error" };

    // Display-counter refresh (read-modify-write; safe under races because
    // points/rank come from the ZSET above, never from this JSON).
    try {
      const fresh = (await campaignStore.getParticipant(campaign.id, normalized)) ?? participant;
      const completedActions = { ...fresh.completedActions };
      completedActions[options.actionId] = (completedActions[options.actionId] ?? 0) + 1;
      const updated: CampaignParticipantRecord = {
        ...fresh,
        lastActivityAt: now.toISOString(),
        points: await campaignStore.getPoints(campaign.id, normalized),
        trackedValue: Math.max(fresh.trackedValue, options.metricDelta),
        completedActions,
        updatedAt: now.toISOString(),
      };
      await kv().set(campaignParticipantKey(campaign.id, normalized), JSON.stringify(updated));
    } catch (error) {
      console.warn("campaignStore.recordAction record refresh failed", error);
    }

    return { status: "awarded", points };
  },

  /**
   * Leaderboard for a campaign. While live it ranks from the score ZSET;
   * once a final snapshot exists the snapshot is served — the ranking
   * recorded at campaign end is preserved exactly, forever.
   */
  async getLeaderboard(campaign: CampaignDefinition, limit = 50): Promise<CampaignLeaderboardEntry[]> {
    const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
    const final = await campaignStore.getFinalSnapshot(campaign.id);
    if (final) return final.entries.slice(0, capped);

    const rows = await readZsetRange(campaign.id, 0, capped - 1);
    const entries = await Promise.all(
      rows.map(async (row, index) => {
        const record = await campaignStore.getParticipant(campaign.id, row.wallet);
        return toEntry(index + 1, row.wallet, row.points, record);
      }),
    );
    return entries;
  },

  /**
   * Full ranked participant list (admin / finalization). The score ZSET
   * contains every joiner (join inserts the member even at 0 points), so
   * this list is complete.
   */
  async listAllParticipants(campaignId: string, hardLimit = 5_000): Promise<CampaignLeaderboardEntry[]> {
    const final = await campaignStore.getFinalSnapshot(campaignId);
    if (final) return final.entries;

    const rows = await readZsetRange(campaignId, 0, Math.max(0, hardLimit - 1));
    const entries: CampaignLeaderboardEntry[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const record = await campaignStore.getParticipant(campaignId, row.wallet);
      entries.push(toEntry(i + 1, row.wallet, row.points, record));
    }
    return entries;
  },

  async getFinalSnapshot(campaignId: string): Promise<CampaignFinalSnapshot | null> {
    const raw = await kv().get<unknown>(campaignFinalKey(campaignId));
    if (raw === null || raw === undefined) return null;
    let value: unknown = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<CampaignFinalSnapshot>;
    if (candidate.campaignId !== campaignId || !Array.isArray(candidate.entries)) return null;
    return {
      campaignId,
      finalizedAt: String(candidate.finalizedAt ?? ""),
      entries: candidate.entries as CampaignLeaderboardEntry[],
    };
  },

  /**
   * Freezes the final leaderboard for an ended campaign. Idempotent and
   * write-once (SET NX): concurrent/repeat calls converge on the first
   * snapshot, which is then immutable — old campaign data is never
   * overwritten. Returns null while the campaign is still active.
   */
  async finalizeCampaign(campaign: CampaignDefinition, now = new Date()): Promise<CampaignFinalSnapshot | null> {
    const existing = await campaignStore.getFinalSnapshot(campaign.id);
    if (existing) return existing;

    const end = Date.parse(campaign.endAt);
    const pinnedStatus = campaign.status && campaign.status !== "auto" ? campaign.status : null;
    const notEndedYet =
      Number.isFinite(end) && now < new Date(end) && pinnedStatus !== "completed" && pinnedStatus !== "paused";
    if (notEndedYet) return null;

    const rows = await readZsetRange(campaign.id, 0, 4_999);
    const entries: CampaignLeaderboardEntry[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const record = await campaignStore.getParticipant(campaign.id, row.wallet);
      entries.push(toEntry(i + 1, row.wallet, row.points, record));
    }

    const snapshot: CampaignFinalSnapshot = {
      campaignId: campaign.id,
      finalizedAt: now.toISOString(),
      entries,
    };
    try {
      await kv().set(campaignFinalKey(campaign.id), JSON.stringify(snapshot), { nx: true });
    } catch (error) {
      console.warn("campaignStore.finalizeCampaign write failed", error);
    }
    // Whoever wins the NX race, everyone reads the same stored snapshot.
    return (await campaignStore.getFinalSnapshot(campaign.id)) ?? snapshot;
  },

  /**
   * Admin-only reward bookkeeping (recorded, never executed): marks a
   * participant's reward outcome. Updates only the reward fields — scores,
   * ranks, and joinedAt are untouched.
   */
  async setRewardOutcome(
    campaignId: string,
    wallet: string,
    outcome: {
      rewardStatus: CampaignRewardStatus;
      rewardAmount?: string | null;
      rewardTxHash?: string | null;
    },
    now = new Date(),
  ): Promise<CampaignParticipantRecord | null> {
    const normalized = normalize(wallet);
    if (!ADDRESS_RE.test(normalized)) return null;
    const record = await campaignStore.getParticipant(campaignId, normalized);
    if (!record) return null;
    const updated: CampaignParticipantRecord = {
      ...record,
      rewardStatus: outcome.rewardStatus,
      rewardAmount:
        outcome.rewardAmount !== undefined
          ? sanitizeRewardText(outcome.rewardAmount) ?? record.rewardAmount
          : record.rewardAmount,
      rewardTxHash:
        outcome.rewardTxHash !== undefined
          ? outcome.rewardTxHash && /^0x[0-9a-fA-F]{6,128}$/.test(outcome.rewardTxHash)
            ? outcome.rewardTxHash
            : record.rewardTxHash
          : record.rewardTxHash,
      updatedAt: now.toISOString(),
    };
    await kv().set(campaignParticipantKey(campaignId, normalized), JSON.stringify(updated));
    return updated;
  },
};
