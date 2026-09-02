// lib/x402/x402-proposal-store.ts
//
// SERVER-ONLY short-lived store for confirmed x402 proposals.
//
// Namespace (do not reuse games/leaderboard/referral keys):
//   mpgrhub:x402:confirmed:{registrationId}
//
// Same Upstash env as leaderboard / allocation:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   fallback KV_REST_API_URL / KV_REST_API_TOKEN
//
// Claim ownership:
//   claim() writes a random claimToken onto the processing record.
//   consume(id, claimToken) succeeds only if that token is still current.
//   A reclaimed lease issues a new token; the old claimant cannot consume.
//
// This module never stores X-PAYMENT, signatures, or wallet secrets.

import { Redis } from "@upstash/redis";

export const X402_CONFIRMED_KEY_PREFIX = "mpgrhub:x402:confirmed:";

export const X402_MIN_TTL_SECONDS = 60;
export const X402_MAX_TTL_SECONDS = 300;
export const X402_PROCESSING_LEASE_SECONDS = 30;

/**
 * Hard cap for the upstream paid GET. Must stay strictly below the
 * processing lease so a slow request is aborted before another caller
 * can reclaim the registration.
 */
export const X402_PAID_GET_TIMEOUT_MS = 20_000;

export type ConfirmedX402ProposalStatus =
  | "pending"
  | "processing"
  | "consumed";

export interface ConfirmedX402Proposal {
  registrationId: string;
  proposalId: string;
  resource: string;
  scheme: "exact";
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  eip712Name: string;
  eip712Version: string;
  createdAt: string;
  expiresAt: string;
  status: ConfirmedX402ProposalStatus;
  processingUntil?: number;
  claimToken?: string;
}

export type ProposalStoreFailure = {
  ok: false;
  code: "UNAVAILABLE" | "CONFLICT" | "NOT_FOUND" | "CONSUMED" | "BUSY" | "STALE_CLAIM";
  message: string;
};

export type ProposalStoreResult<T> =
  | { ok: true; record: T }
  | ProposalStoreFailure;

export type ProposalClaimResult =
  | { ok: true; record: ConfirmedX402Proposal; claimToken: string }
  | ProposalStoreFailure;

const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

function getRedis(): Redis {
  if (!redisUrl || !redisToken) {
    throw new Error("X402_STORE_UNAVAILABLE");
  }
  return new Redis({ url: redisUrl, token: redisToken });
}

export function confirmedProposalKey(registrationId: string): string {
  return `\( {X402_CONFIRMED_KEY_PREFIX} \){registrationId}`;
}

export function computeRegistrationTtlSeconds(
  maxTimeoutSeconds: number | undefined,
): number {
  const requested =
    typeof maxTimeoutSeconds === "number" && Number.isFinite(maxTimeoutSeconds)
      ? Math.floor(maxTimeoutSeconds)
      : X402_MAX_TTL_SECONDS;
  return Math.min(
    X402_MAX_TTL_SECONDS,
    Math.max(X402_MIN_TTL_SECONDS, requested),
  );
}

function clampLeaseSeconds(leaseSeconds: number): number {
  if (!Number.isFinite(leaseSeconds)) {
    return X402_PROCESSING_LEASE_SECONDS;
  }
  const requested = Math.floor(leaseSeconds);
  if (requested < 1) {
    return 1;
  }
  return Math.min(X402_PROCESSING_LEASE_SECONDS, requested);
}

function normalizeRecord(value: unknown): ConfirmedX402Proposal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ConfirmedX402Proposal;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    return value as ConfirmedX402Proposal;
  }
  return null;
}

function publicRecord(record: ConfirmedX402Proposal): ConfirmedX402Proposal {
  const { claimToken: _ignored, ...rest } = record;
  return rest;
}

export async function createConfirmedProposal(
  record: ConfirmedX402Proposal,
  ttlSeconds: number,
): Promise<ProposalStoreResult<ConfirmedX402Proposal>> {
  try {
    const kv = getRedis();
    const key = confirmedProposalKey(record.registrationId);
    const stored: ConfirmedX402Proposal = {
      ...record,
      status: "pending",
    };
    delete stored.claimToken;
    delete stored.processingUntil;
    const result = await kv.set(key, JSON.stringify(stored), {
      nx: true,
      ex: ttlSeconds,
    });
    if (result === null) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "That payment registration already exists.",
      };
    }
    return { ok: true, record: stored };
  } catch {
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "Payment registration is temporarily unavailable.",
    };
  }
}

const CLAIM_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if raw == false then
  return {"missing"}
end
local rec = cjson.decode(raw)
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local token = ARGV[3]
if rec.status == "consumed" then
  return {"consumed"}
end
if rec.status == "processing" then
  local untilts = tonumber(rec.processingUntil or "0")
  if untilts > now then
    return {"busy"}
  end
end
rec.status = "processing"
rec.processingUntil = now + lease
rec.claimToken = token
local encoded = cjson.encode(rec)
local ttl = redis.call("TTL", KEYS[1])
redis.call("SET", KEYS[1], encoded)
if ttl and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return {"ok", encoded}
`;

const CONSUME_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if raw == false then
  return {"missing"}
end
local rec = cjson.decode(raw)
local token = ARGV[1]
if rec.status == "consumed" then
  return {"consumed"}
end
if rec.status \~= "processing" then
  return {"busy"}
end
if rec.claimToken == nil or rec.claimToken \~= token then
  return {"stale"}
end
rec.status = "consumed"
rec.processingUntil = nil
rec.claimToken = nil
local encoded = cjson.encode(rec)
local ttl = redis.call("TTL", KEYS[1])
redis.call("SET", KEYS[1], encoded)
if ttl and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return {"ok", encoded}
`;

export async function claimConfirmedProposal(
  registrationId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  leaseSeconds = X402_PROCESSING_LEASE_SECONDS,
): Promise<ProposalClaimResult> {
  const claimToken = crypto.randomUUID();
  const boundedLease = clampLeaseSeconds(leaseSeconds);
  try {
    const kv = getRedis();
    const key = confirmedProposalKey(registrationId);
    const result = (await kv.eval(
      CLAIM_SCRIPT,
      [key],
      [String(nowSeconds), String(boundedLease), claimToken],
    )) as unknown[] | null;
    if (!Array.isArray(result) || result.length === 0) {
      return { ok: false, code: "UNAVAILABLE", message: "Payment registration is temporarily unavailable." };
    }
    const code = String(result[0]);
    if (code === "missing") {
      return { ok: false, code: "NOT_FOUND", message: "This payment registration was not found or has expired." };
    }
    if (code === "consumed") {
      return { ok: false, code: "CONSUMED", message: "This payment registration has already been used." };
    }
    if (code === "busy") {
      return { ok: false, code: "BUSY", message: "This payment is already being submitted." };
    }
    const record = normalizeRecord(result[1]);
    if (!record) {
      return { ok: false, code: "UNAVAILABLE", message: "Payment registration is temporarily unavailable." };
    }
    return { ok: true, record: publicRecord(record), claimToken };
  } catch {
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "Payment registration is temporarily unavailable.",
    };
  }
}

export async function consumeConfirmedProposal(
  registrationId: string,
  claimToken: string,
): Promise<ProposalStoreResult<ConfirmedX402Proposal>> {
  if (typeof claimToken !== "string" || claimToken.length < 8) {
    return {
      ok: false,
      code: "STALE_CLAIM",
      message: "This payment submission is no longer the active claimant.",
    };
  }
  try {
    const kv = getRedis();
    const key = confirmedProposalKey(registrationId);
    const result = (await kv.eval(CONSUME_SCRIPT, [key], [claimToken])) as unknown[] | null;
    if (!Array.isArray(result) || result.length === 0) {
      return { ok: false, code: "UNAVAILABLE", message: "Payment registration is temporarily unavailable." };
    }
    const code = String(result[0]);
    if (code === "missing") {
      return { ok: false, code: "NOT_FOUND", message: "This payment registration was not found or has expired." };
    }
    if (code === "consumed") {
      return { ok: false, code: "CONSUMED", message: "This payment registration has already been used." };
    }
    if (code === "stale") {
      return {
        ok: false,
        code: "STALE_CLAIM",
        message: "This payment submission is no longer the active claimant.",
      };
    }
    if (code === "busy") {
      return { ok: false, code: "BUSY", message: "This payment registration could not be finalized." };
    }
    const record = normalizeRecord(result[1]);
    if (!record) {
      return { ok: false, code: "UNAVAILABLE", message: "Payment registration is temporarily unavailable." };
    }
    return { ok: true, record: publicRecord(record) };
  } catch {
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "Payment registration is temporarily unavailable.",
    };
  }
}
