import { createHmac, timingSafeEqual } from "node:crypto";
import type { Address } from "viem";
import { SESSION_TTL_SECONDS, SESSION_COOKIE, getSessionSecret } from "./config";
import { readCookieValue } from "@/lib/api/cookies";
import { CHAIN_ID } from "@/lib/chain/base";

export interface AuthSession {
  wallet: Address;
  chainId: 8453;
  issuedAt: number;
  expiresAt: number;
  sessionId: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
function sign(payload: string): string {
  return createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

function signaturesMatch(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", getSessionSecret()).update(left).digest();
  const rightDigest = createHmac("sha256", getSessionSecret()).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

export function createSession(wallet: Address): { value: string; session: AuthSession } {
  const now = Math.floor(Date.now() / 1000);
  const session: AuthSession = {
    wallet: wallet.toLowerCase() as Address,
    chainId: CHAIN_ID,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
    sessionId: crypto.randomUUID().replace(/-/g, ""),
  };
  const payload = encode(JSON.stringify(session));
  return { value: `${payload}.${sign(payload)}`, session };
}

export function readSession(cookieValue: string | undefined): AuthSession | null {
  if (!cookieValue) return null;
  const [payload, signature] = cookieValue.split(".");
  if (!payload || !signature) return null;
  if (!signaturesMatch(signature, sign(payload))) return null;
  try {
    const session = JSON.parse(decode(payload)) as AuthSession;
    const now = Math.floor(Date.now() / 1000);
    if (session.chainId !== CHAIN_ID || typeof session.wallet !== "string" || session.expiresAt <= now || session.issuedAt > now + 30) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(request: Request): AuthSession | null {
  return readSession(readCookieValue(request.headers.get("cookie") ?? "", SESSION_COOKIE));
}
