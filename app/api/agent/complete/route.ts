import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { enforceRateLimit, requestIdFromRequest, withRequestId, readJsonBody } from "@/lib/api/request-guard";
import { SERVER_AI_POLICY, buildTrustedUserPrompt, validatePromptInputs } from "@/lib/architecture/ai/server-policy";

// Phase 3C Part 6 — server-side Route Handler for the OpenAI provider.
//
// This is the ONLY place OPENAI_API_KEY is read. It is never prefixed
// with NEXT_PUBLIC_, so it is never bundled into client JS and never
// visible in the browser's network tab — the browser only ever talks to
// THIS route, over the app's own origin, and this route is the only
// thing that talks to OpenAI. lib/architecture/ai/openai-ai-provider.ts
// (the client-side AIProvider implementation) only ever calls
// POST /api/agent/complete — it has no knowledge of the API key, the
// model name, or OpenAI's endpoint at all.
//
// Runs on Node (default runtime, no `export const runtime = "edge"`) —
// no reason to opt into Edge for a single outbound fetch per turn.
//
// Deliberately thin: parses and forwards the model's raw JSON string
// content back to the client. Validating/sanitizing THAT content into
// { intent, reply } is lib/architecture/ai/openai-ai-provider.ts's job,
// which then flows through lib/architecture/ai/ai-provider-guardrails.ts
// (Phase 3C Part 4) exactly like every other provider's output — this
// route doesn't duplicate that validation.

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

interface CompleteRequestBody {
  systemPrompt: string;
  userPrompt: string;
}

function isCompleteRequestBody(value: unknown): value is CompleteRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.systemPrompt === "string" && typeof body.userPrompt === "string";
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const auth = getSessionFromRequest(request);
  if (!auth) return respond({ error: "Authentication required" }, { status: 401 });
  const rateError = await enforceRateLimit(request, "ai", 20, 60);
  if (rateError) return withRequestId(rateError, requestId);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No key configured — a clear, fast 503 rather than a hung request.
    // The client-side provider throws on any non-OK response, which
    // CircuitBreakerAIProvider and FallbackAIProvider (already wired in
    // Phase 3C Part 5's default composition) turn into a fast, seamless
    // fallback to the deterministic engine — so an unconfigured key
    // degrades gracefully rather than breaking the Agent.
    return respond({ error: "OPENAI_API_KEY is not configured on the server." }, { status: 503 });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;

  if (!isCompleteRequestBody(body)) {
    return respond(
      { error: "Request body must include systemPrompt and userPrompt strings." },
      { status: 400 }
    );
  }

  const promptError = validatePromptInputs(body.systemPrompt, body.userPrompt);
  if (promptError) return respond({ error: promptError }, { status: 400 });

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SERVER_AI_POLICY },
          { role: "user", content: buildTrustedUserPrompt(body.systemPrompt, body.userPrompt) },
        ],
      }),
    });
  } catch (err) {
    return respond({ error: "Failed to reach OpenAI. Please retry shortly." }, { status: 502 });
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => "");
    return respond({ error: "OpenAI is temporarily unavailable." }, { status: 502 });
  }

  // The fetch succeeding and upstream.ok being true only means OpenAI
  // sent back a 2xx status line — it does not guarantee the body that
  // follows is well-formed JSON by the time we read it (truncated
  // stream, proxy/CDN interstitial, partial write). Previously this
  // call was unguarded, so a malformed body here threw *outside* any
  // try/catch and crashed the Route Handler's invocation outright —
  // which Vercel reports as a raw 502 (FUNCTION_INVOCATION_FAILED)
  // that never reaches the NextResponse.json(...) below, and is
  // indistinguishable in Observability from the deliberate 502 two
  // lines above. Guarding it means every failure path in this file now
  // always returns a real JSON response instead of ever crashing the
  // function.
  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    console.error("[openai-complete]", "upstream_invalid_json", { requestId, wallet: auth.wallet, model });
    return respond({ error: "OpenAI response was temporarily unavailable. Please retry shortly." }, { status: 502 });
  }

  const content: string | undefined = (data as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;

  if (!content) {
    return respond({ error: "OpenAI response contained no content." }, { status: 502 });
  }

  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
  console.info("[openai-complete]", { requestId, wallet: auth.wallet, model, promptChars: body.userPrompt.length, completionTokens: usage?.completion_tokens ?? null, promptTokens: usage?.prompt_tokens ?? null });
  return respond({ content });
}
