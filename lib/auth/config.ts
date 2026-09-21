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

/**
 * Explicit opt-in for preview / self-hosted deployments that terminate TLS
 * upstream and cannot know their public origin at build time (for example an
 * ephemeral sandbox preview host). When set to "1"/"true" — and never on
 * Vercel production — the CSRF origin check may derive the app origin from
 * the incoming request instead of failing every POST with 503
 * "Origin verification is not configured".
 *
 * This does not weaken deployments that set APP_ORIGIN: a configured value
 * always wins.
 */
export function allowRequestDerivedOrigin(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  const flag = process.env.APP_ORIGIN_ALLOW_REQUEST_DERIVED?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Origin used by the CSRF check in verifyTrustedOrigin.
 *
 * Resolution order:
 *  1. APP_ORIGIN when configured (always wins — production behaviour
 *     unchanged).
 *  2. Otherwise the request's own origin, when derivation is allowed
 *     (non-production, Vercel Preview/development, or the explicit
 *     APP_ORIGIN_ALLOW_REQUEST_DERIVED opt-in). The scheme honours
 *     `x-forwarded-proto`, because previews and Vercel terminate TLS in
 *     front of an HTTP server: without that, a browser's `https://…` Origin
 *     would never match the derived `http://…` and every same-origin POST
 *     would be rejected as cross-site.
 *  3. Otherwise throw, so the caller fails closed.
 */
export function resolveTrustedAppOrigin(request: Request): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (shouldDeriveOriginFromRequest() || allowRequestDerivedOrigin()) {
    const url = new URL(request.url);
    // Behind a TLS-terminating proxy (Vercel Preview, an ephemeral sandbox
    // preview host) `request.url` carries the server's own bind address and a
    // plain-http scheme — deriving from it would never match the browser's
    // Origin. Use the public host the proxy forwarded in `Host` and the scheme
    // from `x-forwarded-proto`. Browsers cannot set `Host`, so a cross-site
    // page's Origin still never matches the derived app origin.
    const hostHeader = request.headers.get("host")?.split(",")[0]?.trim();
    const forwardedProto = (request.headers.get("x-forwarded-proto") ?? "")
      .split(",")[0]
      ?.trim()
      .toLowerCase();
    const scheme = forwardedProto === "https" ? "https:" : url.protocol;
    const host = hostHeader || url.host;
    // new URL(...) also validates the host — a malformed value throws and the
    // caller fails closed.
    return new URL(`${scheme}//${host}`).origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_ORIGIN must be configured in production.");
  }
  throw new Error("APP_ORIGIN is required when request origin is unavailable.");
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
