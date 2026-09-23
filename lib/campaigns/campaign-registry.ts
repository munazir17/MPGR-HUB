// lib/campaigns/campaign-registry.ts
//
// Pure, storage-free campaign registry logic: status resolution, lookup,
// validation, and the normalized PublicCampaign serialization the UI
// consumes. Server-only state (participant counts, leaderboards) is
// layered on by the API routes via lib/campaigns/campaign-store.ts —
// this module never touches Redis and is safe to unit-test directly.

import type {
  CampaignDefinition,
  CampaignStatus,
  PublicCampaign,
} from "@/lib/campaigns/campaign-types";

import { CAMPAIGN_DEFINITIONS } from "./campaigns";

/** All registered campaign definitions (source list is never mutated). */
export function getAllCampaigns(): CampaignDefinition[] {
  return [...CAMPAIGN_DEFINITIONS];
}

function parseDate(iso: string): Date | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Resolves the status shown on the UI for a definition at `now`:
 *   - an explicit pinned status ("paused", or a forced state) wins;
 *   - otherwise "auto" derives from startAt/endAt.
 * Throws on definitions with unparseable dates — a bad config should
 * fail tests/build, not render a silently broken campaign.
 */
export function resolveCampaignStatus(
  campaign: CampaignDefinition,
  now: Date = new Date(),
): CampaignStatus {
  if (campaign.status && campaign.status !== "auto") {
    return campaign.status;
  }
  const start = parseDate(campaign.startAt);
  const end = parseDate(campaign.endAt);
  if (!start || !end) {
    throw new Error(`Campaign "${campaign.id}" has invalid startAt/endAt dates.`);
  }
  if (now < start) return "upcoming";
  if (now >= end) return "completed";
  return "active";
}

/** True when the campaign is inside its active window AND not pinned
 *  to another status (paused/completed overrides block participation). */
export function isCampaignActive(
  campaign: CampaignDefinition,
  now: Date = new Date(),
): boolean {
  return resolveCampaignStatus(campaign, now) === "active";
}

export function findCampaignById(id: string): CampaignDefinition | null {
  return getAllCampaigns().find((c) => c.id === id) ?? null;
}

export function findCampaignBySlug(slug: string): CampaignDefinition | null {
  return getAllCampaigns().find((c) => c.slug === slug) ?? null;
}

/** Accepts either identifier so APIs and deep links stay forgiving. */
export function findCampaignByIdOrSlug(key: string): CampaignDefinition | null {
  return findCampaignById(key) ?? findCampaignBySlug(key);
}

export function getCampaignsByStatus(
  status: CampaignStatus | "all",
  now: Date = new Date(),
): CampaignDefinition[] {
  return getAllCampaigns().filter(
    (c) => status === "all" || resolveCampaignStatus(c, now) === status,
  );
}

/**
 * Config validation used by tests (and available to tooling): unique
 * ids/slugs, ordered window, parseable dates, non-empty title/description,
 * at least one reward field, and well-formed action configs.
 * Returns a list of human-readable problems (empty = valid).
 */
export function validateCampaignDefinitions(
  definitions: CampaignDefinition[] = getAllCampaigns(),
): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const c of definitions) {
    const label = c.id || c.slug || "<unknown>";
    if (!c.id || typeof c.id !== "string") problems.push(`${label}: missing id`);
    if (!c.slug || !/^[a-z0-9-]+$/.test(c.slug)) {
      problems.push(`${label}: slug must be kebab-case ([a-z0-9-])`);
    }
    if (seenIds.has(c.id)) problems.push(`${label}: duplicate id`);
    if (seenSlugs.has(c.slug)) problems.push(`${label}: duplicate slug`);
    seenIds.add(c.id);
    seenSlugs.add(c.slug);

    if (!c.title?.trim()) problems.push(`${label}: missing title`);
    if (!c.description?.trim()) problems.push(`${label}: missing description`);
    if (!c.rewardPool?.trim()) problems.push(`${label}: missing rewardPool`);
    if (!c.rewardType?.trim()) problems.push(`${label}: missing rewardType`);
    if (!Array.isArray(c.rules)) problems.push(`${label}: rules must be an array`);

    const start = parseDate(c.startAt);
    const end = parseDate(c.endAt);
    if (!start) problems.push(`${label}: startAt is not a valid ISO date`);
    if (!end) problems.push(`${label}: endAt is not a valid ISO date`);
    if (start && end && end <= start) problems.push(`${label}: endAt must be after startAt`);

    if (!c.points || !Number.isFinite(c.points.participation) || c.points.participation < 0) {
      problems.push(`${label}: points.participation must be a non-negative number`);
    }
    const actions = c.points?.actions ?? [];
    const actionIds = new Set<string>();
    for (const action of actions) {
      if (!action.id) problems.push(`${label}: action missing id`);
      if (actionIds.has(action.id)) problems.push(`${label}: duplicate action id "${action.id}"`);
      actionIds.add(action.id);
      if (!Number.isFinite(action.points) || action.points < 0) {
        problems.push(`${label}: action "${action.id}" points must be >= 0`);
      }
      if (action.maxPerDay !== undefined && (!Number.isInteger(action.maxPerDay) || action.maxPerDay < 1)) {
        problems.push(`${label}: action "${action.id}" maxPerDay must be a positive integer`);
      }
      if (action.bonus && (!Number.isFinite(action.bonus.divisor) || action.bonus.divisor <= 0 || action.bonus.maxBonus < 0)) {
        problems.push(`${label}: action "${action.id}" bonus requires divisor > 0 and maxBonus >= 0`);
      }
    }
  }
  return problems;
}

/**
 * Serialized, normalized campaign shape for the client. Participant
 * count / viewer standing are filled in by the API (they live in Redis);
 * defaults here keep the pure function usable in isolation.
 */
export function toPublicCampaign(
  campaign: CampaignDefinition,
  options: {
    now?: Date;
    participantCount?: number;
    finalized?: boolean;
    viewer?: PublicCampaign["viewer"];
  } = {},
): PublicCampaign {
  const now = options.now ?? new Date();
  return {
    id: campaign.id,
    slug: campaign.slug,
    title: campaign.title,
    description: campaign.description,
    banner: campaign.banner ?? null,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    status: resolveCampaignStatus(campaign, now),
    eventType: campaign.eventType,
    trackingMetric: campaign.trackingMetric,
    rules: campaign.rules,
    rewardPool: campaign.rewardPool,
    rewardType: campaign.rewardType,
    rewardSymbol: campaign.rewardSymbol ?? null,
    rewardAsset: campaign.rewardAsset ?? null,
    rewardDescription: campaign.rewardDescription ?? null,
    rewardDistribution: campaign.rewardDistribution ?? null,
    leaderboardEnabled: campaign.leaderboardEnabled,
    eligibility: campaign.eligibility ?? null,
    points: {
      participation: campaign.points.participation,
      dailyCap: campaign.points.dailyCap ?? null,
      maxPoints: campaign.points.maxPoints ?? null,
      actions: campaign.points.actions.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description ?? null,
        points: action.points,
        evidence: action.evidence ?? null,
        numericInput: action.numericInput ?? null,
        maxPerDay: action.maxPerDay ?? null,
      })),
    },
    featured: Boolean(campaign.featured),
    participantCount: options.participantCount ?? 0,
    finalized: options.finalized ?? false,
    viewer: options.viewer ?? null,
  };
}
