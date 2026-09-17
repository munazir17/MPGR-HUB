import { CHAIN_ID } from "@/lib/chain/base";

export const SUPPORTED_CHAIN_ID = CHAIN_ID;
export const SESSION_COOKIE = "mpgr_session";
export const NONCE_COOKIE = "mpgr_auth_nonce";
export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const NONCE_TTL_SECONDS = 5 * 60;

/**
 * True when it is safe to derive the app origin from the incoming
 * request URL because APP_ORIGIN is unset.
 *
 * Production (`VERCEL_ENV=production`, or `NODE_ENV=production` off
 * Vercel) must still set APP_ORIGIN explicitly — never derive there.
 * Vercel Preview/development deployments run with NODE_ENV=production
 * but typically do not receive Production-scoped APP_ORIGIN; deriving
 * from the request keeps same-origin browser POSTs verifiable without
 * weakening production.
 */
export function shouldDeriveOriginFromRequest(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "preview" || vercelEnv === "development") return true;
  if (vercelEnv === "production") return false;
  return process.env.NODE_ENV !== "production";
}

export function getAppOrigin(requestUrl?: string): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (shouldDeriveOriginFromRequest() && requestUrl) {
    return new URL(requestUrl).origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_ORIGIN must be configured in production.");
  }
  throw new Error("APP_ORIGIN is required when request origin is unavailable.");
}

export function getSessionSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must be configured with at least 32 characters.");
  }
  return secret;
}

/**
 * Cookie flags for `mpgr_session` / `mpgr_auth_nonce`.
 *
 * Production and Vercel Preview both run HTTPS with NODE_ENV=production.
 * SameSite=None; Secure is required so the HttpOnly session cookie is
 * sent from the Farcaster/Base Mini App webview (a third-party context
 * where SameSite=Lax cookies are dropped). CSRF is enforced by
 * verifyTrustedOrigin, not by SameSite.
 *
 * Local HTTP dev keeps SameSite=Lax because SameSite=None requires Secure.
 * Host-only (no Domain) so Preview and production cannot share cookies.
 */
export function getAuthCookieAttributes(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "none" | "lax";
  path: "/";
} {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
  };
}
