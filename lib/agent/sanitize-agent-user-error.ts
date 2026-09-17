export const AGENT_GENERIC_USER_ERROR = "Something went wrong. Please try again.";
export const AGENT_REQUEST_TOO_LARGE_USER_ERROR =
  "Your request is too large. Please try again with a shorter request.";

const SIZE_RE =
  /too large|payload too large|request entity too large|body too large|content.?length|\b413\b/i;

const INTERNAL_RE =
  /gemini|nvidia|openai|on-device|provider|upstream|rate limit|resource_exhausted|quota|\b429\b|\b500\b|\b502\b|\b503\b|provider_unreachable|provider_error|provider_rate_limited|request id|falling back/i;

/**
 * Display-only sanitizer for the Agent red error banner.
 * Server/Vercel logs keep the original provider error.
 */
export function sanitizeAgentUserError(raw: string): string {
  const message = raw.trim();
  if (!message) return AGENT_GENERIC_USER_ERROR;
  if (SIZE_RE.test(message)) return AGENT_REQUEST_TOO_LARGE_USER_ERROR;
  if (INTERNAL_RE.test(message)) return AGENT_GENERIC_USER_ERROR;
  return message;
}
