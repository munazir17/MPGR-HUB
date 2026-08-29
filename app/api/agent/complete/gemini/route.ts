import { NextResponse } from "next/server";
import {
  buildGeminiGenerateContentRequest,
  extractGeminiResponseContent,
  isGeminiFunctionDeclarationArray,
  type GeminiFunctionDeclaration,
} from "@/lib/architecture/ai/gemini-function-declarations";

// Phase 3C Gemini addendum — server-side Route Handler for the Gemini
// provider.
//
// P3 function-calling addendum:
// This route now accepts the production read/prepare tool catalog from
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
//
// Important Gemini constraint:
// When native function declarations are present, responseMimeType:
// "application/json" must NOT be sent. Gemini function calling and JSON
// response mode use incompatible output constraints.

const DEFAULT_MODEL = "gemini-3.5-flash";

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

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "GEMINI_API_KEY is not configured on the server.",
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

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

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
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);

    return NextResponse.json(
      {
        error: `Failed to reach Gemini: ${message}`,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const errorText = await upstream
      .text()
      .catch(() => upstream.statusText);

    return NextResponse.json(
      {
        error:
          `Gemini returned ${upstream.status}: ${errorText}`,
      },
      { status: 502 },
    );
  }

  let data: unknown;

  try {
    data = await upstream.json();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);

    return NextResponse.json(
      {
        error:
          `Gemini response body was not valid JSON: ${message}`,
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
    return NextResponse.json(
      {
        error:
          "Gemini response contained no usable text or function call.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ content });
}
