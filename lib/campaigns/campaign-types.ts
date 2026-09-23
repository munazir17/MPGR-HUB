// lib/campaigns/campaign-types.ts
//
// Type contract for the Campaigns feature — temporary, operator-launched
// events (competitions, challenges) that are fully config-driven.
//
// Campaigns are deliberately SEPARATE from the global XP / Season Points
// system: every campaign owns its own points ledger, its own leaderboard,
// and its own historical records. Nothing in this module writes to the
// global XP ledger (lib/rewards/xp-ledger.ts) or the global leaderboard.
//
// Adding a campaign never requires a type change: put one definition
// file under lib/campaigns/campaigns/ and register it in that folder's
// index.ts. New *kinds* of campaigns (event types) get a new adapter
// under lib/campaigns/adapters/ — the Campaign page and the APIs only
// ever consume these normalized shapes.

/** Lifecycle shown on the Campaigns UI. Resolved from dates unless the
 *  definition pins an explicit status (e.g. "paused"). */
export type CampaignStatus = "upcoming" | "active" | "completed" | "paused";

/** Explicit `status` field on a definition: "auto" (default) derives the
 *  status from startAt/endAt; anything else pins it. */
export type CampaignStatusConfig = CampaignStatus | "auto";

/**
 * What kind of activity a campaign tracks. The built-ins map 1:1 to
 * built-in adapters, but the field is an open string so future campaign
 * types work without touching the Campaign page — an unknown eventType
 * falls back to the generic adapter (config-driven manual actions only).
 */
export type CampaignEventType = "game" | "trading" | "agent" | "social" | (string & {});

/** Free-form metric descriptor, e.g. "score", "volume", "activity". */
export type CampaignTrackingMetric = string;

/**
 * Free-form reward type — deliberately NOT an enum so operators can
 * reward MPGR, tokenized stocks, NFTs, or anything future without a
 * code change. Examples: "MPGR", "Tokenized Stock", "NFT", "Custom".
 */
export type CampaignRewardType = string;

export interface CampaignEligibility {
  /** Join always requires an authenticated wallet session; this flag is
   *  explicit documentation of that requirement (default true). */
  requiresAuthentication?: boolean;
  /** Optional gate: wallet must hold at least this much global XP in the
   *  server ledger. Checked server-side at join; never mixed into
   *  campaign points. */
  minAccountXp?: number;
  /** Human-readable eligibility note shown on the campaign page. */
  description?: string;
}

/**
 * One earnable action inside a campaign. Points are ALWAYS computed
 * server-side from this config (+ adapter validation) — clients submit
 * only an action id, an idempotency event id, and (for manual actions
 * with a numeric input) a single bounded number.
 */
export interface CampaignActionConfig {
  id: string;
  label: string;
  description?: string;
  /** Flat points granted per validated occurrence. */
  points: number;
  /**
   * Server-evidence source id. When set, the client cannot submit the
   * value at all — the campaign's adapter resolves evidence from trusted
   * server data (e.g. "game-run" reads the verified RunRecord for a
   * session id). The evidence id doubles as the idempotency event id.
   */
  evidence?: string;
  /**
   * Optional numeric input for manual actions. The submitted value must
   * be an integer within [min, max]; it is passed to the adapter as
   * evidence and never trusted beyond those bounds.
   */
  numericInput?: { label: string; field: string; min: number; max: number };
  /**
   * Bonus points derived from a numeric evidence field:
   *   bonus = min(floor(value / divisor), maxBonus)
   * The adapter must have validated the field before this is applied.
   */
  bonus?: { field: string; divisor: number; maxBonus: number };
  /** Max occurrences of THIS action per participant per UTC day. */
  maxPerDay?: number;
}

export interface CampaignPointsConfig {
  /** Campaign points granted when a wallet joins (0 for none). */
  participation: number;
  actions: CampaignActionConfig[];
  /** Max campaign points a single participant can earn per UTC day. */
  dailyCap?: number;
  /** Hard ceiling on a participant's total campaign points. */
  maxPoints?: number;
}

export interface CampaignDefinition {
  /** Stable unique id — part of every storage key; never reuse. */
  id: string;
  slug: string;
  title: string;
  description: string;
  /** Optional banner image path (local /public file). */
  banner?: string;
  /** ISO 8601 timestamps. */
  startAt: string;
  endAt: string;
  /** "auto" (or omitted) derives status from the dates above. */
  status?: CampaignStatusConfig;
  eventType: CampaignEventType;
  trackingMetric: CampaignTrackingMetric;
  /** Human-readable rules shown on the campaign detail page. */
  rules: string[];
  /** Reward pool as displayed (e.g. "1000000", "Top 3 split", "1 NFT"). */
  rewardPool: string;
  rewardType: CampaignRewardType;
  /** Optional token symbol / asset id / contract hint for display. */
  rewardSymbol?: string;
  rewardAsset?: string;
  rewardDescription?: string;
  /** e.g. "Top 10 split 60/30/10", "Top 3 flat". Display-only. */
  rewardDistribution?: string;
  /** When false, no leaderboard is rendered or served for this campaign. */
  leaderboardEnabled: boolean;
  eligibility?: CampaignEligibility;
  points: CampaignPointsConfig;
  featured?: boolean;
}

// --- Runtime (persisted) shapes -------------------------------------------

export type CampaignEligibilityStatus = "eligible" | "ineligible" | "pending";

/**
 * Reward bookkeeping — recorded, never auto-executed. The operator
 * identifies winners from the finalized leaderboard and distributes
 * separately, then records the outcome here (via the admin API).
 */
export type CampaignRewardStatus = "pending" | "distributed" | "ineligible";

/**
 * Server-persisted participant record (source of truth in Redis, NEVER
 * localStorage). One record per (campaignId, wallet); campaign-scoped —
 * historical records are namespaced by campaign id and never overwritten
 * when a new campaign starts.
 */
export interface CampaignParticipantRecord {
  campaignId: string;
  /** Lowercased wallet — the authoritative identity for ranking/rewards. */
  wallet: string;
  /** Farcaster fid when available (display metadata; unverified). */
  farcasterId: string | null;
  /** Display name when available (sanitized display metadata only). */
  displayName: string | null;
  joinedAt: string;
  lastActivityAt: string;
  /** Cached copy of campaign points — the score ZSET is authoritative
   *  and is merged in on every read. */
  points: number;
  /** Adapter-tracked metric value (e.g. best verified score). */
  trackedValue: number;
  /** actionId → number of accepted occurrences (display counter). */
  completedActions: Record<string, number>;
  eligibility: CampaignEligibilityStatus;
  eligibilityReason: string | null;
  rewardStatus: CampaignRewardStatus;
  rewardType: string | null;
  rewardAmount: string | null;
  rewardTxHash: string | null;
  /** Rank assigned when the campaign was finalized (1-based). */
  rank: number | null;
  updatedAt: string;
}

export interface CampaignLeaderboardEntry {
  rank: number;
  wallet: string;
  displayName: string | null;
  farcasterId: string | null;
  points: number;
  trackedValue: number;
  eligibility: CampaignEligibilityStatus;
  rewardStatus: CampaignRewardStatus;
  joinedAt: string | null;
  lastActivityAt: string | null;
}

/** Frozen end-of-campaign snapshot — written once (SET NX), served for
 *  all later reads so the final ranking is preserved forever. */
export interface CampaignFinalSnapshot {
  campaignId: string;
  finalizedAt: string;
  entries: CampaignLeaderboardEntry[];
}

/** The authenticated viewer's per-campaign standing (server-computed). */
export interface CampaignViewerStanding {
  joined: boolean;
  points: number;
  rank: number | null;
  trackedValue: number;
  eligibility: CampaignEligibilityStatus | null;
  completedActions: Record<string, number>;
}

/** Normalized public shape the Campaign UI consumes (API-assembled). */
export interface PublicCampaign {
  id: string;
  slug: string;
  title: string;
  description: string;
  banner: string | null;
  startAt: string;
  endAt: string;
  status: CampaignStatus;
  eventType: string;
  trackingMetric: string;
  rules: string[];
  rewardPool: string;
  rewardType: string;
  rewardSymbol: string | null;
  rewardAsset: string | null;
  rewardDescription: string | null;
  rewardDistribution: string | null;
  leaderboardEnabled: boolean;
  eligibility: CampaignEligibility | null;
  points: {
    participation: number;
    dailyCap: number | null;
    maxPoints: number | null;
    actions: Array<{
      id: string;
      label: string;
      description: string | null;
      points: number;
      evidence: string | null;
      numericInput: CampaignActionConfig["numericInput"] | null;
      maxPerDay: number | null;
    }>;
  };
  featured: boolean;
  participantCount: number;
  finalized: boolean;
  viewer: CampaignViewerStanding | null;
}
