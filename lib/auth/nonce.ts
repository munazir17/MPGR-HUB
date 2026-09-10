import { randomBytes } from "node:crypto";
import { authRedis, consumeAuthNonce } from "./redis";
import { NONCE_COOKIE, NONCE_TTL_SECONDS } from "./config";

export interface AuthNonce {
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export function getAuthNonceKey(nonce: string): string {
  return `mpgrhub:auth:nonce:${nonce}`;
}

export function generateAuthNonce(): AuthNonce {
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = new Date();
  const expirationTime = new Date(issuedAt.getTime() + NONCE_TTL_SECONDS * 1000);
  return { nonce, issuedAt: issuedAt.toISOString(), expirationTime: expirationTime.toISOString() };
}

export async function issueNonce(): Promise<AuthNonce> {
  const value = generateAuthNonce();
  const stored = await authRedis.set(getAuthNonceKey(value.nonce), "unused", {
    ex: NONCE_TTL_SECONDS,
    nx: true,
  });
  if (stored === null) throw new Error("Unable to issue authentication nonce.");
  return value;
}

export async function isNonceActive(nonce: string): Promise<boolean> {
  if (!nonce || nonce.length > 128) return false;
  return (await authRedis.get<string>(getAuthNonceKey(nonce))) === "unused";
}

export async function consumeNonce(nonce: string): Promise<boolean> {
  if (!nonce || nonce.length > 128) return false;
  return consumeAuthNonce(nonce);
}

export { NONCE_COOKIE };
