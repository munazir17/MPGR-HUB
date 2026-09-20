// lib/auth/session-store.ts
//
// Server-side session registry (Task 6).
//
// The `mpgr_session` cookie is still an HMAC-signed, self-describing value
// (see ./session.ts — format unchanged), but on its own that made sessions
// unrevocable: POST /api/auth/logout only deleted the browser copy, and a
// captured cookie stayed valid for the remainder of its 8 h lifetime.
//
// This module adds the missing server state:
//
//   mpgrhub:auth:session:{sessionId} -> {"wallet": "...", "issuedAt": n}
//       written on issue with EX = remaining cookie lifetime, deleted on
//       logout/revoke. Same TTL as the cookie so nothing orphans.
//
// `authenticateRequest()` is the drop-in async replacement for the
// synchronous `getSessionFromRequest()`: it performs every stateless check
// first (signature, expiry, chain) and only then consults Redis. A cookie
// whose sessionId has no live record — including every cookie minted
// before this change — is simply treated as "not signed in", so existing
// users are routed to a fresh SIWE sign-in rather than an error. Redis
// unavailability fails closed (null), matching how enforceRateLimit
// already treats it.

import type { Address } from "viem";

import { getRedis } from "@/lib/api/redis";
import { SESSION_TTL_SECONDS } from "./config";
import { createSession, getSessionFromRequest, type AuthSession } from "./session";

interface SessionRecord {
  wallet: string;
  issuedAt: number;
}

export function sessionRecordKey(sessionId: string): string {
  return `mpgrhub:auth:session:${sessionId}`;
}

const SESSION_ID_RE = /^[a-f0-9]{32}$/;

/**
 * Mints a new session cookie AND registers it server-side. Throws if the
 * registry write fails so a caller never hands out a cookie that cannot be
 * validated (and cannot be revoked).
 */
export async function issueSession(wallet: Address): Promise<{ value: string; session: AuthSession }> {
  const created = createSession(wallet);
  const record: SessionRecord = { wallet: created.session.wallet, issuedAt: created.session.issuedAt };
  const ttl = Math.max(1, Math.min(SESSION_TTL_SECONDS, created.session.expiresAt - Math.floor(Date.now() / 1000)));
  const stored = await getRedis().set(sessionRecordKey(created.session.sessionId), JSON.stringify(record), {
    ex: ttl,
    nx: true,
  });
  if (stored === null) {
    // 128-bit random collision is not a realistic event; treat as a hard
    // failure rather than silently binding to someone else's record.
    throw new Error("Unable to register session.");
  }
  return created;
}

/** Deletes the server record; the cookie becomes unusable immediately. Idempotent. */
export async function revokeSession(session: Pick<AuthSession, "sessionId">): Promise<void> {
  if (!SESSION_ID_RE.test(session.sessionId)) return;
  await getRedis().del(sessionRecordKey(session.sessionId));
}

/**
 * Full validation: stateless checks (signature, expiry, chain id) then the
 * server registry. Returns null for anything that is not a live, registered
 * session for the wallet named in the cookie.
 */
export async function authenticateRequest(request: Request): Promise<AuthSession | null> {
  const session = getSessionFromRequest(request);
  if (!session) return null;
  if (typeof session.sessionId !== "string" || !SESSION_ID_RE.test(session.sessionId)) return null;

  let raw: unknown;
  try {
    raw = await getRedis().get<unknown>(sessionRecordKey(session.sessionId));
  } catch {
    // Fail closed: no registry, no session.
    return null;
  }
  const record = parseRecord(raw);
  if (!record) return null;
  // The record and the signed cookie must name the same wallet. A mismatch
  // means the registry entry does not belong to this cookie.
  if (record.wallet !== session.wallet.toLowerCase()) return null;
  return session;
}

function parseRecord(raw: unknown): SessionRecord | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.wallet !== "string") return null;
  return { wallet: candidate.wallet.toLowerCase(), issuedAt: Number(candidate.issuedAt) };
}
