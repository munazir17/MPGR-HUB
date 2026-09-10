import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { enforceRateLimit, requestIdFromRequest, withRequestId, readJsonBody } from "@/lib/api/request-guard";
import { AI_PROMPT_LIMITS, SERVER_AI_POLICY, buildTrustedUserPrompt, validatePromptInputs } from "@/lib/architecture/ai/server-policy";
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
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const auth = getSessionFromRequest(request);
  if (!auth) return respond({ error: "Authentication required" }, { status: 401 });
  const rateError = await enforceRateLimit(request, "ai", 20, 60);
  if (rateError) return withRequestId(rateError, requestId);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return respond(
      {
        error: "GEMINI_API_KEY is not configured on the server.",
      },
      { status: 503 },
    );
  }

  const parsedBody = await readJsonBody<unknown>(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;

  if (!isCompleteRequestBody(body)) {
    console.error("[gemini-complete] request_invalid", {
      requestId,
      bodyType: typeof body,
      hasSystemPrompt:
        typeof (body as Record<string, unknown> | null)?.systemPrompt === "string",
      hasUserPrompt:
        typeof (body as Record<string, unknown> | null)?.userPrompt === "string",
      hasFunctionDeclarations: Array.isArray(
        (body as Record<string, unknown> | null)?.functionDeclarations,
      ),
      functionDeclarationCount: Array.isArray(
        (body as Record<string, unknown> | null)?.functionDeclarations,
      )
        ? ((body as Record<string, unknown>).functionDeclarations as unknown[]).length
        : 0,
    });

    return respond(
      {
        error:
          "Request body must include systemPrompt and userPrompt strings, with an optional valid functionDeclarations array.",
        code: "INVALID_REQUEST_BODY",
        requestId,
      },
      { status: 400 },
    );
  }

  const promptError = validatePromptInputs(body.systemPrompt, body.userPrompt);
  if (promptError) {
    console.error("[gemini-complete] prompt_invalid", {
      requestId,
      errorType: "PROMPT_VALIDATION",
      systemChars: body.systemPrompt.length,
      userChars: body.userPrompt.length,
      systemLimit: AI_PROMPT_LIMITS.systemChars,
      userLimit: AI_PROMPT_LIMITS.userChars,
    });

    return respond(
      { error: promptError, code: "INVALID_PROMPT", requestId },
      { status: 400 },
    );
  }

  const functionDeclarations =
    body.functionDeclarations ?? [];

  const model = resolveGeminiModel();

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const geminiPayload = buildGeminiGenerateContentRequest({
    systemPrompt: SERVER_AI_POLICY,
    userPrompt: buildTrustedUserPrompt(body.systemPrompt, body.userPrompt),
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
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify(geminiPayload),
    });
  } catch {
    logGeminiEvent("upstream_unreachable", {
      code: "PROVIDER_UNREACHABLE",
    });

    return respond(
      {
        error:
          "Gemini is temporarily unavailable. Please retry shortly.",
        code: "PROVIDER_UNREACHABLE",
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    logGeminiEvent("upstream_status", {
      requestId,
      status: upstream.status,
      model,
    });

    // Drain the body so the socket is not left hanging, but never
    // forward the raw Google payload (quota JSON, keys, request ids)
    // to the browser.
    await upstream.text().catch(() => "");

    const classified = classifyGeminiUpstreamFailure(upstream.status);

    logGeminiEvent("upstream_error", {
      code: classified.code,
      upstreamStatus: upstream.status,
    });

    return respond(
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

    return respond(
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

    return respond(
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

  const usage = (data as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
  logGeminiEvent("success", {
    requestId,
    wallet: auth.wallet,
    model,
    promptChars: body.userPrompt.length,
    promptTokens: usage?.promptTokenCount ?? null,
    completionTokens: usage?.candidatesTokenCount ?? null,
    totalTokens: usage?.totalTokenCount ?? null,
  });
  return respond({ content });
}
