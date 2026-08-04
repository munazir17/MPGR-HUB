import { NextResponse } from "next/server";

// Phase 3C Gemini addendum — server-side Route Handler for the Gemini
// provider, added alongside app/api/agent/complete/route.ts (the OpenAI
// route), not replacing it. Same shape and same defensive pattern as
// that file: this is the ONLY place GEMINI_API_KEY is read — never
// prefixed with NEXT_PUBLIC_, never bundled into client JS. The browser
// only ever talks to THIS route, over the app's own origin;
// lib/architecture/ai/gemini-ai-provider.ts (the client-side provider)
// has no knowledge of the API key, the model name, or Google's endpoint.
//
// Runs on Node (default runtime) — no reason to opt into Edge for a
// single outbound fetch per turn.
//
// Deliberately thin, same division of responsibility as the OpenAI
// route: parses and forwards the model's raw JSON string content back to
// the client. Validating/sanitizing THAT content into { intent, reply }
// is lib/architecture/ai/gemini-ai-provider.ts's job, which then flows
// through lib/architecture/ai/ai-provider-guardrails.ts exactly like
// every other provider's output — this route doesn't duplicate that
// validation.

const DEFAULT_MODEL = "gemini-2.5-flash";

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // No key configured — a clear, fast 503 rather than a hung request.
    // The client-side provider throws on any non-OK response, which
    // CircuitBreakerAIProvider and FallbackAIProvider (already wired in
    // ai-provider-registry.ts's default composition, provider-agnostically)
    // turn into a fast, seamless fallback to the deterministic engine —
    // so an unconfigured key degrades gracefully rather than breaking
    // the Agent.
    return NextResponse.json({ error: "GEMINI_API_KEY is not configured on the server." }, { status: 503 });
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

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          role: "system",
          parts: [{ text: body.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: body.userPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to reach Gemini: ${message}` }, { status: 502 });
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => upstream.statusText);
    return NextResponse.json({ error: `Gemini returned ${upstream.status}: ${errorText}` }, { status: 502 });
  }

  // Same defensive guard as app/api/agent/complete/route.ts: upstream.ok
  // being true only means Gemini sent back a 2xx status line — it does
  // not guarantee the body that follows is well-formed JSON by the time
  // we read it. Guarded so a malformed body here always returns a real
  // JSON response instead of crashing the Route Handler's invocation.
  let data: unknown;
  try {
    data = await upstream.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gemini response body was not valid JSON: ${message}` }, { status: 502 });
  }

  // Gemini's response shape: candidates[0].content.parts[0].text
  const content: string | undefined = (
    data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }
  )?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!content) {
    return NextResponse.json({ error: "Gemini response contained no content." }, { status: 502 });
  }

  return NextResponse.json({ content });
}
