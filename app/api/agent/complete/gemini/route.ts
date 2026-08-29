import { NextResponse } from "next/server";
import {
  buildGeminiGenerateContentRequest,
  classifyGeminiUpstreamFailure,
  extractGeminiResponseContent,
  inspectGeminiResponse,
  isGeminiFunctionDeclarationArray,
  resolveGeminiModel,
  type GeminiFunctionDeclaration,
} from "@/lib/architecture/ai/gemini-function-declarations";

// Phase 3C Gemini addendum — server-side Route Handler for the Gemini
// provider.
//
// P3 function-calling addendum:
// This route accepts the production read/prepare tool catalog from
// GeminiAIProvider, forwards it to Google's native function-calling API,
// and translates a native Gemini functionCall back into the vendor-neutral
// {"toolCall": ...} JSON protocol consumed by agent-tool-calling.ts.
//
// Security:
// - GEMINI_API_KEY remains server-side only.
// - Only read/prepare declarations are accepted by the client-side adapter.
// - This route never executes tools.
// - This route never signs or submits payments.
// - x402 execution remains behind the existing Confirm & Pay boundary.
// - Upstream Google error bodies, API keys, and prompts are never
//   forwarded to the browser. Safe diagnostics are HTTP status,
//   finishReason, and whether a functionCall / usable text was present.
//
// Important Gemini constraint:
// When native function declarations are present, responseMimeType:
// "application/json" must NOT be sent. Gemini function calling and JSON
// response mode use incompatible output constraints.
//
// Quota:
// This route cannot manufacture Google quota. GEMINI_MODEL is already
// configurable (see resolveGeminiModel). Production still needs a
// billed Gemini key or a model with remaining quota — the free-tier
// generate_content_free_tier_requests limit of 20/day for
// gemini-3.5-flash is an ops/billing change, not a code change.

interface CompleteRequestBody {
  systemPrompt: string;
  userPrompt: string;
  functionDeclarations?: GeminiFunctionDeclaration[];
}

function isCompleteRequestBody(
  value: unknown,
): value is CompleteRequestBody {
  if (!value || typeof value !== "object") return false;

  const body = value as Record<string, unknown>;

  if (
    typeof body.systemPrompt !== "string" ||
    typeof body.userPrompt !== "string"
  ) {
    return false;
  }

  if (body.functionDeclarations === undefined) {
    return true;
  }

  return isGeminiFunctionDeclarationArray(body.functionDeclarations);
}

function logGeminiEvent(
  event: string,
  details: Record<string, unknown>,
): void {
  console.error("[gemini-complete]", event, details);
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "GEMINI_API_KEY is not configured on the server.",
      },
      { status: 503 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (!isCompleteRequestBody(body)) {
    return NextResponse.json(
      {
        error:
          "Request body must include systemPrompt and userPrompt strings, with an optional valid functionDeclarations array.",
      },
      { status: 400 },
    );
  }

  const functionDeclarations =
    body.functionDeclarations ?? [];

  const model = resolveGeminiModel();

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const geminiPayload = buildGeminiGenerateContentRequest({
    systemPrompt: body.systemPrompt,
    userPrompt: body.userPrompt,
    functionDeclarations,
  });

  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiPayload),
    });
  } catch {
    logGeminiEvent("upstream_unreachable", {
      code: "PROVIDER_UNREACHABLE",
    });

    return NextResponse.json(
      {
        error:
          "Gemini is temporarily unavailable. Please retry shortly.",
        code: "PROVIDER_UNREACHABLE",
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // Drain the body so the socket is not left hanging, but never
    // forward the raw Google payload (quota JSON, keys, request ids)
    // to the browser.
    await upstream.text().catch(() => "");

    const classified = classifyGeminiUpstreamFailure(upstream.status);

    logGeminiEvent("upstream_error", {
      code: classified.code,
      upstreamStatus: upstream.status,
    });

    return NextResponse.json(
      {
        error: classified.error,
        code: classified.code,
      },
      { status: classified.httpStatus },
    );
  }

  let data: unknown;

  try {
    data = await upstream.json();
  } catch {
    logGeminiEvent("upstream_invalid_json", {
      code: "PROVIDER_INVALID_JSON",
    });

    return NextResponse.json(
      {
        error:
          "Gemini response was temporarily unavailable. Please retry shortly.",
        code: "PROVIDER_INVALID_JSON",
      },
      { status: 502 },
    );
  }

  // extractGeminiResponseContent handles both:
  //
  // 1. native Gemini functionCall parts
  //    -> {"toolCall":{"toolId":"...","arguments":{...}}}
  //
  // 2. normal text parts
  //    -> existing {"intent":"...","reply":"..."} JSON
  //
  // It also ignores Gemini thinking/thought parts when looking for
  // normal text and prefers functionCall when one is present.
  const content = extractGeminiResponseContent(data);

  if (!content) {
    const diagnostics = inspectGeminiResponse(data);

    logGeminiEvent("empty_response", {
      code: "PROVIDER_EMPTY_RESPONSE",
      finishReason: diagnostics.finishReason,
      hasFunctionCall: diagnostics.hasFunctionCall,
      hasUsableText: diagnostics.hasUsableText,
      blocked: diagnostics.blocked,
    });

    return NextResponse.json(
      {
        error:
          "Gemini response contained no usable text or function call.",
        code: "PROVIDER_EMPTY_RESPONSE",
        diagnostics: {
          finishReason: diagnostics.finishReason,
          hasFunctionCall: diagnostics.hasFunctionCall,
          hasUsableText: diagnostics.hasUsableText,
        },
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ content });
}
