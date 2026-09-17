import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  enforceRateLimit,
  requestIdFromRequest,
  withRequestId,
  readJsonBody,
  verifyTrustedOrigin,
} from "@/lib/api/request-guard";
import {
  SERVER_AI_POLICY,
  buildTrustedUserPrompt,
  validatePromptInputs,
} from "@/lib/architecture/ai/server-policy";
import {
  classifyNvidiaUpstreamFailure,
  extractNvidiaResponseContent,
  isNvidiaToolArray,
  nvidiaChatCompletionsUrl,
  readNvidiaUsage,
  resolveNvidiaBaseUrl,
  resolveNvidiaModel,
  type NvidiaTool,
} from "@/lib/architecture/ai/nvidia-function-calling";

// Server-side Route Handler for NVIDIA NIM.
//
// This is the ONLY place NVIDIA_API_KEY is read. It is never prefixed
// with NEXT_PUBLIC_. The browser only talks to THIS route; this route
// is the only thing that talks to integrate.api.nvidia.com (or a
// configured NVIDIA_BASE_URL).
//
// Native OpenAI-compatible tool_calls are translated into the existing
// {"toolCall":...} protocol. This route never executes tools, never
// signs, and never broadcasts.

interface CompleteRequestBody {
  systemPrompt: string;
  userPrompt: string;
  tools?: NvidiaTool[];
}

function isCompleteRequestBody(value: unknown): value is CompleteRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.systemPrompt !== "string" || typeof body.userPrompt !== "string") {
    return false;
  }
  if (body.tools === undefined) return true;
  return isNvidiaToolArray(body.tools);
}

function logNvidiaEvent(event: string, details: Record<string, unknown>): void {
  console.error("[nvidia-complete]", event, details);
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) =>
    withRequestId(NextResponse.json(body, init), requestId);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = getSessionFromRequest(request);
  if (!auth) return respond({ error: "Authentication required" }, { status: 401 });
  const rateError = await enforceRateLimit(request, "ai", 20, 60);
  if (rateError) return withRequestId(rateError, requestId);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    // Missing key is a skip, not a crash: the provider chain falls
    // through to OpenAI then the deterministic engine.
    return respond(
      { error: "NVIDIA_API_KEY is not configured on the server.", code: "PROVIDER_UNREACHABLE" },
      { status: 503 },
    );
  }

  const parsedBody = await readJsonBody<unknown>(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;

  if (!isCompleteRequestBody(body)) {
    return respond(
      {
        error:
          "Request body must include systemPrompt and userPrompt strings, with an optional valid tools array.",
        code: "INVALID_REQUEST_BODY",
      },
      { status: 400 },
    );
  }

  const promptError = validatePromptInputs(body.systemPrompt, body.userPrompt);
  if (promptError) {
    return respond({ error: promptError, code: "INVALID_PROMPT" }, { status: 400 });
  }

  let baseUrl: string;
  try {
    baseUrl = resolveNvidiaBaseUrl();
  } catch {
    return respond(
      { error: "NVIDIA_BASE_URL is not configured correctly.", code: "PROVIDER_UNREACHABLE" },
      { status: 503 },
    );
  }

  const model = resolveNvidiaModel();
  const tools = (body.tools ?? []).filter(
    (tool) => tool.type === "function" && !tool.function.name.toLowerCase().includes("execute"),
  );

  const payload: Record<string, unknown> = {
    model,
    temperature: 0.4,
    max_tokens: 700,
    messages: [
      { role: "system", content: SERVER_AI_POLICY },
      { role: "user", content: buildTrustedUserPrompt(body.systemPrompt, body.userPrompt) },
    ],
  };
  if (tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  let upstream: Response;
  try {
    upstream = await fetch(nvidiaChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify(payload),
    });
  } catch {
    logNvidiaEvent("upstream_unreachable", { code: "PROVIDER_UNREACHABLE", requestId });
    return respond(
      {
        error: "NVIDIA NIM is temporarily unavailable. Please retry shortly.",
        code: "PROVIDER_UNREACHABLE",
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => "");
    const classified = classifyNvidiaUpstreamFailure(upstream.status);
    logNvidiaEvent("upstream_error", {
      code: classified.code,
      upstreamStatus: upstream.status,
      requestId,
    });
    return respond(
      { error: classified.error, code: classified.code },
      { status: classified.httpStatus },
    );
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    logNvidiaEvent("upstream_invalid_json", { code: "PROVIDER_INVALID_JSON", requestId });
    return respond(
      {
        error: "NVIDIA NIM response was temporarily unavailable. Please retry shortly.",
        code: "PROVIDER_INVALID_JSON",
      },
      { status: 502 },
    );
  }

  const content = extractNvidiaResponseContent(data);
  if (!content) {
    logNvidiaEvent("empty_response", { code: "PROVIDER_EMPTY_RESPONSE", requestId });
    return respond(
      {
        error: "NVIDIA NIM response contained no usable text or tool call.",
        code: "PROVIDER_EMPTY_RESPONSE",
      },
      { status: 502 },
    );
  }

  const usage = readNvidiaUsage(data);
  console.info("[nvidia-complete]", {
    requestId,
    wallet: auth.wallet,
    model,
    promptChars: body.userPrompt.length,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  });
  return respond({ content });
}
