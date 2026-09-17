import { createHash } from "node:crypto";
import { getRedis } from "@/lib/api/redis";

// Cumulative unique Agent visitors. No TTL — this set must not reset daily.
export const AGENT_VISITOR_SET_KEY = "mpgrhub:agent:unique-visitors";
export const AGENT_VISITOR_COOKIE = "mpgr_agent_visitor";
export const AGENT_VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const VISITOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAgentVisitorId(value: string): boolean {
  return VISITOR_ID_RE.test(value.trim());
}

export function hashAgentVisitorId(raw: string): string {
  return createHash("sha256").update(`mpgr-agent-visitor:${raw.trim().toLowerCase()}`).digest("hex");
}

function tryRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

export async function getAgentVisitorCount(): Promise<number | null> {
  const redis = tryRedis();
  if (!redis) return null;
  try {
    const count = await redis.scard(AGENT_VISITOR_SET_KEY);
    const numeric = typeof count === "number" ? count : Number(count);
    return Number.isFinite(numeric) ? numeric : 0;
  } catch {
    return null;
  }
}

export async function recordAgentVisitor(rawId: string): Promise<number | null> {
  const id = rawId.trim();
  if (!id) return getAgentVisitorCount();
  const redis = tryRedis();
  if (!redis) return null;
  try {
    await redis.sadd(AGENT_VISITOR_SET_KEY, hashAgentVisitorId(id));
    const count = await redis.scard(AGENT_VISITOR_SET_KEY);
    const numeric = typeof count === "number" ? count : Number(count);
    return Number.isFinite(numeric) ? numeric : 0;
  } catch {
    return null;
  }
}
