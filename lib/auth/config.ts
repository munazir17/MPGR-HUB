export const SUPPORTED_CHAIN_ID = 8453;
export const SESSION_COOKIE = "mpgr_session";
export const NONCE_COOKIE = "mpgr_auth_nonce";
export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const NONCE_TTL_SECONDS = 5 * 60;

export function getAppOrigin(requestUrl?: string): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_ORIGIN must be configured in production.");
  }
  if (requestUrl) {
    const url = new URL(requestUrl);
    return url.origin;
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
