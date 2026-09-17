// lib/api/authenticated-fetch.ts
//
// Browser helper for same-origin calls that must send the HttpOnly
// `mpgr_session` cookie. Default fetch credentials are "same-origin",
// which is not enough in the Farcaster/Base Mini App webview — that
// context often drops the session unless credentials is explicitly
// "include".
//
// This does not bypass auth: the server still reads the cookie via
// getSessionFromRequest and still enforces verifyTrustedOrigin.

export function fetchWithSession(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: "include",
    cache: init?.cache ?? "no-store",
  });
}
