import "server-only";
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import {
  enforceAiDailyBudget,
  enforceRateLimit,
  recordAiTokenUsage,
  requestIdFromRequest,
  withRequestId,
  readJsonBody,
  verifyTrustedOrigin,
} from "@/lib/api/request-guard";
import { composeTrustedPromptParts, compactPromptInputs, validatePromptInputs } from "./server-policy";
import { isRetryableProviderStatus, readApiKeys, rotateApiKeys } from "./api-key-pool";

export async function handleOpenAICompatibleChat(
  request: Request,
  options: {
    poolId: string;
    singleEnv: string;
    listEnv: string;
    url: string;
    modelEnv: string;
    defaultModel: string;
    missingKeyError: string;
    unavailableError: string;
    logTag: string;
    jsonMode?: boolean;
    extraHeaders?: Record<string, string>;
  },
): Promise<Response> {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await authenticateRequest(request);
  if (!auth) return respond({ error: "Authentication required" }, { status: 401 });
  const rateError = await enforceRateLimit(request, "ai", 20, 60);
  if (rateError) return withRequestId(rateError, requestId);
  const budgetError = await enforceAiDailyBudget(request);
  if (budgetError) return withRequestId(budgetError, requestId);

  const keys = rotateApiKeys(options.poolId, readApiKeys(options.singleEnv, options.listEnv));
  if (keys.length === 0) return respond({ error: options.missingKeyError, code: "PROVIDER_UNREACHABLE" }, { status: 503 });

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = parsedBody.value as { systemPrompt?: unknown; userPrompt?: unknown } | null;
  if (!body || typeof body.systemPrompt !== "string" || typeof body.userPrompt !== "string") {
    return respond({ error: "Request body must include systemPrompt and userPrompt strings." }, { status: 400 });
  }

  const parts = composeTrustedPromptParts(body.systemPrompt, body.userPrompt);
  const bounded = compactPromptInputs(parts.systemPrompt, parts.userPrompt);
  const promptError = validatePromptInputs(bounded.systemPrompt, bounded.userPrompt);
  if (promptError) return respond({ error: promptError }, { status: 400 });

  const model = process.env[options.modelEnv]?.trim() || options.defaultModel;
  const payload: Record<string, unknown> = {
    model,
    temperature: 0.4,
    max_tokens: 700,
    messages: [
      { role: "system", content: bounded.systemPrompt },
      { role: "user", content: bounded.userPrompt },
    ],
  };
  if (options.jsonMode) payload.response_format = { type: "json_object" };

  let upstream: Response | undefined;
  for (const apiKey of keys) {
    try {
      upstream = await fetch(options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...options.extraHeaders,
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify(payload),
      });
    } catch {
      upstream = undefined;
      continue;
    }
    if (upstream.ok || !isRetryableProviderStatus(upstream.status)) break;
    await upstream.text().catch(() => "");
    upstream = undefined;
  }
  if (!upstream) return respond({ error: options.unavailableError, code: "PROVIDER_UNREACHABLE" }, { status: 502 });
  if (!upstream.ok) {
    await upstream.text().catch(() => "");
    return respond({ error: options.unavailableError, code: "PROVIDER_UNREACHABLE" }, { status: 502 });
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    console.error(`[${options.logTag}]`, "upstream_invalid_json", { requestId, model });
    return respond({ error: options.unavailableError, code: "PROVIDER_INVALID_JSON" }, { status: 502 });
  }
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (!content) return respond({ error: options.unavailableError, code: "PROVIDER_INVALID_JSON" }, { status: 502 });

  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
  const total = usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
  if (Number.isFinite(total) && total > 0) await recordAiTokenUsage(request, total);
  console.info(`[${options.logTag}]`, { requestId, model, promptChars: body.userPrompt.length });
  return respond({ content });
}
