import { NextResponse } from "next/server";

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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No key configured — a clear, fast 503 rather than a hung request.
    // The client-side provider throws on any non-OK response, which
    // CircuitBreakerAIProvider and FallbackAIProvider (already wired in
    // Phase 3C Part 5's default composition) turn into a fast, seamless
    // fallback to the deterministic engine — so an unconfigured key
    // degrades gracefully rather than breaking the Agent.
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isCompleteRequestBody(body)) {
    return NextResponse.json(
      { error: "Request body must include systemPrompt and userPrompt strings." },
      { status: 400 }
    );
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: body.systemPrompt },
          { role: "user", content: body.userPrompt },
        ],
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to reach OpenAI: ${message}` }, { status: 502 });
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => upstream.statusText);
    return NextResponse.json({ error: `OpenAI returned ${upstream.status}: ${errorText}` }, { status: 502 });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `OpenAI response body was not valid JSON: ${message}` }, { status: 502 });
  }

  const content: string | undefined = (data as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;

  if (!content) {
    return NextResponse.json({ error: "OpenAI response contained no content." }, { status: 502 });
  }

  return NextResponse.json({ content });
}
