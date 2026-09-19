export const AGENT_GENERIC_USER_ERROR = "Something went wrong. Please try again.";
export const AGENT_REQUEST_TOO_LARGE_USER_ERROR =
  "Your request is too large. Please try again with a shorter request.";
export const AGENT_AUTH_USER_ERROR = "Wallet session expired. Please reconnect your wallet.";
export const AGENT_PROVIDER_USER_ERROR =
  "Trading service is temporarily unavailable. Please try again shortly.";
export const AGENT_NETWORK_USER_ERROR = "Unable to reach the trading service. Please try again.";

export type AgentUserErrorKind = "auth" | "quote" | "provider" | "network" | "too_large" | "generic";
export type AgentFailureSource = "primary" | "secondary";

export interface PresentedAgentUserError {
  message: string;
  kind: AgentUserErrorKind;
  retryable: boolean;
}

export interface PresentAgentUserErrorContext {
  lastUserMessage?: string;
}

export interface AgentChatErrorState<TMessage> {
  messages: TMessage[];
  error: string | null;
  thinking: boolean;
}

const SIZE_RE =
  /too large|payload too large|request entity too large|body too large|content.?length|\b413\b/i;

const NETWORK_RE =
  /failed to fetch|networkerror|network error|load failed|err_network|err_internet|typeerror/i;

const INTERNAL_RE =
  /gemini|nvidia|openai|on-device|provider|upstream|rate limit|resource_exhausted|quota|\b429\b|\b500\b|\b502\b|\b503\b|provider_unreachable|provider_error|provider_rate_limited|request id|falling back|cross-site request rejected/i;

const RAW_INTERNAL_RE =
  /request id|x-request-id|stack(?:trace)?|at \w+\.|vercel|function invocation|internal server error|trace id|ECONN|ENOENT|EPERM|{\s*"|\/workspace\/|\/app\/|\.ts:\d+/i;

const B20_TICKER_RE = /\b([A-Za-z]{2,5}c)\b/;

const UNDERLYING_TO_B20: Record<string, string> = {
  aapl: "AAPLc",
  apple: "AAPLc",
  tsla: "TSLAc",
  tesla: "TSLAc",
  nvda: "NVDAc",
  googl: "GOOGLc",
  goog: "GOOGLc",
  google: "GOOGLc",
  amzn: "AMZNc",
  amazon: "AMZNc",
  msft: "MSFTc",
  microsoft: "MSFTc",
  meta: "METAc",
  coin: "COINc",
  crcl: "CRCLc",
  intc: "INTCc",
  intel: "INTCc",
  mstr: "MSTRc",
  sndk: "SNDKc",
  spcx: "SPCXc",
};

const AUTH_CODES = new Set(["AUTH_REQUIRED", "WALLET_REQUIRED", "WALLET_NOT_CONNECTED"]);
const QUOTE_CODES = new Set([
  "LIQUIDITY_UNAVAILABLE",
  "EXECUTION_UNAVAILABLE",
  "QUOTE_EXPIRED",
  "QUOTE_CHANGED",
]);
const PROVIDER_CODES = new Set(["CREDENTIALS_MISSING"]);

function extractExplicitHttpStatus(raw: string): 401 | 502 | 503 | null {
  const match = raw.match(/\b(?:HTTP\s+|status\s+|failed with\s+)?(401|502|503)\b/i);
  if (!match) return null;
  const status = Number(match[1]) as 401 | 502 | 503;
  return status;
}

function extractExplicitApiCode(raw: string): string | null {
  const match = raw.match(
    /\b(AUTH_REQUIRED|WALLET_REQUIRED|WALLET_NOT_CONNECTED|LIQUIDITY_UNAVAILABLE|EXECUTION_UNAVAILABLE|QUOTE_EXPIRED|QUOTE_CHANGED|CREDENTIALS_MISSING)\b/,
  );
  return match ? match[1] : null;
}

export function extractTickerForUserError(_raw: string, lastUserMessage?: string): string | null {
  const prompt = lastUserMessage?.trim() ?? "";
  if (!prompt) return null;

  const promptB20 = prompt.match(B20_TICKER_RE);
  if (promptB20) return normalizeB20Ticker(promptB20[1]);

  const promptLower = prompt.toLowerCase();
  for (const [needle, ticker] of Object.entries(UNDERLYING_TO_B20)) {
    if (needle === "meta" || needle === "coin" || needle === "goog") {
      if (new RegExp(`\\b${needle}\\b`, "i").test(promptLower)) return ticker;
      continue;
    }
    if (promptLower.includes(needle)) return ticker;
  }
  return null;
}

function normalizeB20Ticker(value: string): string {
  return value.slice(0, -1).toUpperCase() + "c";
}

function quoteUnavailableMessage(ticker: string | null): string {
  return `${ticker ?? "This tokenized-stock"} quote is currently unavailable. Please try again.`;
}

function looksLikeRawInternal(message: string): boolean {
  return RAW_INTERNAL_RE.test(message);
}

/**
 * Flatten a caught Error into a string the banner sanitizer can classify.
 * Only copies status/code when they already exist on the error object —
 * never infers HTTP status from message text.
 */
export function serializeAgentFailure(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & { code?: unknown; status?: unknown };
    const status = typeof extra.status === "number" ? String(extra.status) : "";
    const code = typeof extra.code === "string" ? extra.code.trim() : "";
    return [status, code, extra.message].filter(Boolean).join(" ");
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  return "";
}

/**
 * EventBus `ai_provider_error` is always a secondary/background hop.
 * It must never become AgentErrorBanner copy — including CSRF bodies
 * that have a message and no `code`.
 */
export function userFacingErrorFromAiProviderEvent(_payload: {
  code?: string;
  message?: string;
}): string | null {
  return null;
}

/**
 * User-facing AgentErrorBanner is only for a failed PRIMARY request that
 * did not produce a usable assistant reply. Secondary/background failures
 * (provider hops, CSRF on a follow-up fetch, fallback recovery) stay in
 * logs and must not replace a successful reply with a red banner.
 */
export function shouldSurfaceAgentUserError(input: {
  source: AgentFailureSource;
  hasUsableAssistantResponse: boolean;
}): boolean {
  return input.source === "primary" && !input.hasUsableAssistantResponse;
}

/**
 * Pure UI-state transition for Agent chat errors. Messages are never
 * removed. Secondary failures leave thinking/error untouched so a
 * successful reply stays on screen without Retry.
 */
export function applyAgentFailureToChatState<TMessage>(
  state: AgentChatErrorState<TMessage>,
  failure: {
    source: AgentFailureSource;
    rawError: string;
    hasUsableAssistantResponse: boolean;
  },
): AgentChatErrorState<TMessage> & { showRetry: boolean } {
  if (
    !shouldSurfaceAgentUserError({
      source: failure.source,
      hasUsableAssistantResponse: failure.hasUsableAssistantResponse,
    })
  ) {
    return { ...state, showRetry: false };
  }

  return {
    messages: state.messages,
    error: failure.rawError,
    thinking: false,
    showRetry: presentAgentUserError(failure.rawError).retryable,
  };
}

/**
 * Display-only sanitizer for the Agent red error banner.
 * Server/Vercel logs keep the original provider error.
 *
 * HTTP 401/502/503 copy is used only when that status (or an equivalent
 * API code) is already present. If the frontend cannot reliably determine
 * the status, the existing generic fallback is preserved.
 */
export function presentAgentUserError(
  raw: string,
  context?: PresentAgentUserErrorContext,
): PresentedAgentUserError {
  const message = raw.trim();
  const ticker = extractTickerForUserError(message, context?.lastUserMessage);
  const status = extractExplicitHttpStatus(message);
  const code = extractExplicitApiCode(message);

  if (SIZE_RE.test(message)) {
    return { message: AGENT_REQUEST_TOO_LARGE_USER_ERROR, kind: "too_large", retryable: false };
  }

  if (status === 401 || (code !== null && AUTH_CODES.has(code))) {
    return { message: AGENT_AUTH_USER_ERROR, kind: "auth", retryable: false };
  }

  if (code !== null && QUOTE_CODES.has(code)) {
    return { message: quoteUnavailableMessage(ticker), kind: "quote", retryable: true };
  }

  if (status === 502 || status === 503 || (code !== null && PROVIDER_CODES.has(code))) {
    return { message: AGENT_PROVIDER_USER_ERROR, kind: "provider", retryable: true };
  }

  if (NETWORK_RE.test(message)) {
    return { message: AGENT_NETWORK_USER_ERROR, kind: "network", retryable: true };
  }

  if (
    !message ||
    INTERNAL_RE.test(message) ||
    looksLikeRawInternal(message) ||
    /\b(required|failed|error|unable|could not|unavailable|unauthorized|forbidden|denied|rejected)\b/i.test(
      message,
    )
  ) {
    return { message: AGENT_GENERIC_USER_ERROR, kind: "generic", retryable: true };
  }

  return { message, kind: "generic", retryable: true };
}

export function sanitizeAgentUserError(
  raw: string,
  context?: PresentAgentUserErrorContext,
): string {
  return presentAgentUserError(raw, context).message;
}
