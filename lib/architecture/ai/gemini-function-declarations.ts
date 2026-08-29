// lib/architecture/ai/gemini-function-declarations.ts
//
// P3 tool-calling adapter — the missing Gemini-native wiring.
//
// AgentTool.inputSchema was designed so a later adapter could lower it
// into a Gemini functionDeclaration (see agent-tool.ts) without changing
// the tool contract. That adapter did not exist: the Gemini route sent
// only systemInstruction + contents + JSON mime type, so Gemini never
// received tools and could not emit functionCall parts. Combined with
// JSON mode (which Google documents as incompatible with function
// calling) the model fell back to asking the user for a URL instead of
// selecting x402_discover_resource / x402_prepare_payment.
//
// This module is deliberately dependency-light so the Gemini Route
// Handler can import the payload builder / response extractor without
// pulling AgentToolRuntime or wagmi into a server bundle:
//   - lowers a read/prepare catalog into Gemini functionDeclarations
//   - builds the generateContent payload (tools + AUTO function calling,
//     and NO responseMimeType JSON mode when tools are present)
//   - translates a Gemini functionCall part back into the
//     {"toolCall":{toolId,arguments}} JSON that
//     agent-tool-calling.ts's parseModelDirective already understands
//
// Execute-mode tools are never advertised. Signing/submission remains
// unreachable — this adapter does not add an execute tool, does not
// change AgentToolRuntime, and does not bypass runRegisteredTool.
//
// P3 robustness addendum:
// Gemini 2.5/3.5 thinking models may emit thought parts, mixed
// text/functionCall parts, snake_case function_call, empty text, or
// args vs arguments. A valid native functionCall always wins over
// ordinary text so x402_discover_resource is not dropped.

import type {
  AgentToolParameterSchema,
  AgentToolSchema,
  AnyAgentTool,
} from "@/lib/architecture/tools/agent-tool";

const GEMINI_SCHEMA_TYPES = {
  string: "STRING",
  number: "NUMBER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
} as const;

const X402_RESOURCE_URL_TOOL_IDS = new Set([
  "x402_discover_resource",
  "x402_prepare_payment",
]);

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiObjectSchema;
}

export interface GeminiObjectSchema {
  type: "OBJECT";
  properties: Record<string, GeminiParameterSchema>;
  required?: string[];
}

export interface GeminiParameterSchema {
  type: (typeof GEMINI_SCHEMA_TYPES)[keyof typeof GEMINI_SCHEMA_TYPES];
  description?: string;
  enum?: readonly (string | number)[];
  items?: GeminiParameterSchema;
  properties?: Record<string, GeminiParameterSchema>;
  required?: string[];
}

export interface GeminiFunctionCall {
  name: string;
  args?: unknown;
}

export interface GeminiResponseDiagnostics {
  finishReason: string | null;
  hasFunctionCall: boolean;
  hasUsableText: boolean;
  candidateCount: number;
  blocked: boolean;
}

export interface GeminiUpstreamFailure {
  httpStatus: number;
  code: string;
  error: string;
}

export function toGeminiFunctionDeclarations(
  tools: readonly AnyAgentTool[],
): GeminiFunctionDeclaration[] {
  return tools
    .filter((tool) => tool.mode === "read" || tool.mode === "prepare")
    .map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: toGeminiObjectSchema(tool.inputSchema),
    }));
}

export function toGeminiObjectSchema(schema: AgentToolSchema): GeminiObjectSchema {
  const parameters: GeminiObjectSchema = {
    type: "OBJECT",
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        toGeminiParameterSchema(value),
      ]),
    ),
  };
  if (schema.required && schema.required.length > 0) {
    parameters.required = [...schema.required];
  }
  return parameters;
}

function toGeminiParameterSchema(schema: AgentToolParameterSchema): GeminiParameterSchema {
  const converted: GeminiParameterSchema = {
    type: GEMINI_SCHEMA_TYPES[schema.type],
  };
  if (schema.description) converted.description = schema.description;
  if (schema.enum && schema.enum.length > 0) converted.enum = schema.enum;
  if (schema.type === "array" && schema.items) {
    converted.items = toGeminiParameterSchema(schema.items);
  }
  if (schema.type === "object") {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        toGeminiParameterSchema(value),
      ]),
    );
    if (schema.required && schema.required.length > 0) {
      converted.required = [...schema.required];
    }
  }
  return converted;
}

export function serializeGeminiFunctionCall(functionCall: GeminiFunctionCall): string {
  const rawArgs = normalizeFunctionCallArgs(functionCall.args);
  const argumentsForTool = coerceX402ResourceUrlArgs(
    functionCall.name,
    rawArgs,
  );

  return JSON.stringify({
    toolCall: {
      toolId: functionCall.name,
      arguments: argumentsForTool,
    },
  });
}

function coerceX402ResourceUrlArgs(
  toolId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!X402_RESOURCE_URL_TOOL_IDS.has(toolId)) {
    return args;
  }

  const resourceUrl = pickResourceUrl(args);
  if (resourceUrl === null) {
    return args;
  }

  const next: Record<string, unknown> = {
    ...args,
    resourceUrl,
  };
  delete next.url;
  delete next.resource;
  return next;
}

function pickResourceUrl(args: Record<string, unknown>): string | null {
  if (typeof args.resourceUrl === "string" && args.resourceUrl.trim()) {
    return args.resourceUrl.trim();
  }
  if (typeof args.url === "string" && args.url.trim()) {
    return args.url.trim();
  }
  if (typeof args.resource === "string" && args.resource.trim()) {
    return args.resource.trim();
  }
  return null;
}

function normalizeFunctionCallArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

export function unwrapPossiblyFencedJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFunctionCall(value: unknown): GeminiFunctionCall | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return readFunctionCall(parsed);
    } catch {
      return null;
    }
  }

  if (!isPlainRecord(value)) return null;

  const name = value.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }

  return {
    name: name.trim(),
    args: value.args ?? value.arguments,
  };
}

function readFunctionCallFromPart(
  part: Record<string, unknown>,
): GeminiFunctionCall | null {
  return (
    readFunctionCall(part.functionCall) ??
    readFunctionCall(part.function_call)
  );
}

function collectCandidateParts(data: unknown): Array<Record<string, unknown>> {
  if (!isPlainRecord(data)) return [];

  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const parts: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    if (!isPlainRecord(candidate)) continue;
    const content = candidate.content;
    if (!isPlainRecord(content)) continue;
    const rawParts = content.parts;
    if (!Array.isArray(rawParts)) continue;
    for (const part of rawParts) {
      if (isPlainRecord(part)) parts.push(part);
    }
  }

  return parts;
}

export function inspectGeminiResponse(data: unknown): GeminiResponseDiagnostics {
  const parts = collectCandidateParts(data);
  const record = isPlainRecord(data) ? data : null;
  const candidates = Array.isArray(record?.candidates)
    ? record.candidates
    : [];
  const firstCandidate = isPlainRecord(candidates[0]) ? candidates[0] : null;
  const promptFeedback = isPlainRecord(record?.promptFeedback)
    ? record.promptFeedback
    : null;

  const finishReason =
    (typeof firstCandidate?.finishReason === "string" &&
      firstCandidate.finishReason) ||
    (typeof firstCandidate?.finish_reason === "string" &&
      firstCandidate.finish_reason) ||
    null;

  const blockReason =
    (typeof promptFeedback?.blockReason === "string" &&
      promptFeedback.blockReason) ||
    (typeof promptFeedback?.block_reason === "string" &&
      promptFeedback.block_reason) ||
    null;

  let hasFunctionCall = false;
  let hasUsableText = false;

  for (const part of parts) {
    if (readFunctionCallFromPart(part)) {
      hasFunctionCall = true;
    }
    if (
      part.thought !== true &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      hasUsableText = true;
    }
  }

  return {
    finishReason,
    hasFunctionCall,
    hasUsableText,
    candidateCount: candidates.length,
    blocked:
      Boolean(blockReason) ||
      finishReason === "SAFETY" ||
      finishReason === "BLOCKLIST" ||
      finishReason === "PROHIBITED_CONTENT",
  };
}

/**
 * Reads Gemini's generateContent response.
 *
 * A functionCall part (native tool selection) is preferred over text so
 * a thinking/thought part cannot hide the call. Text parts skip
 * `thought: true` entries and empty strings used by Gemini 2.5/3.5
 * thinking models.
 */
export function extractGeminiResponseContent(data: unknown): string | null {
  const parts = collectCandidateParts(data);
  if (parts.length === 0) return null;

  for (const part of parts) {
    const functionCall = readFunctionCallFromPart(part);
    if (functionCall) {
      return serializeGeminiFunctionCall(functionCall);
    }
  }

  const texts: string[] = [];
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      texts.push(part.text);
    }
  }

  if (texts.length === 0) return null;
  return unwrapPossiblyFencedJson(texts.join(""));
}

export function classifyGeminiUpstreamFailure(
  status: number,
): GeminiUpstreamFailure {
  if (status === 429) {
    return {
      httpStatus: 429,
      code: "PROVIDER_RATE_LIMITED",
      error: "Gemini is temporarily rate-limited. Please retry shortly.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      httpStatus: 502,
      code: "PROVIDER_AUTH_ERROR",
      error: "Gemini authentication failed.",
    };
  }

  return {
    httpStatus: 502,
    code: "PROVIDER_ERROR",
    error: "Gemini is temporarily unavailable. Please retry shortly.",
  };
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/**
 * GEMINI_MODEL is already configurable via env. Code cannot manufacture
 * Google quota — a billed key or a model with remaining quota is still
 * required in production.
 */
export function resolveGeminiModel(
  model: string | undefined = process.env.GEMINI_MODEL,
): string {
  if (typeof model === "string" && model.trim().length > 0) {
    return model.trim();
  }
  return DEFAULT_GEMINI_MODEL;
}

export function isGeminiFunctionDeclarationArray(
  value: unknown,
): value is GeminiFunctionDeclaration[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record.name === "string" &&
      record.name.trim().length > 0 &&
      typeof record.description === "string" &&
      record.parameters !== null &&
      typeof record.parameters === "object" &&
      !Array.isArray(record.parameters)
    );
  });
}

export function buildGeminiGenerateContentRequest(input: {
  systemPrompt: string;
  userPrompt: string;
  functionDeclarations: readonly GeminiFunctionDeclaration[];
}): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.4,
  };

  const payload: Record<string, unknown> = {
    systemInstruction: {
      role: "system",
      parts: [{ text: input.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: input.userPrompt }],
      },
    ],
    generationConfig,
  };

  if (input.functionDeclarations.length > 0) {
    payload.tools = [{ functionDeclarations: input.functionDeclarations }];
    payload.toolConfig = {
      functionCallingConfig: { mode: "AUTO" },
    };
    // Intentionally omit responseMimeType: "application/json".
    // Google's JSON mode cannot be combined with function calling; if
    // it stays on, Gemini will never emit functionCall parts and will
    // answer in {intent, reply} text instead (e.g. asking for a URL).
  } else {
    generationConfig.responseMimeType = "application/json";
  }

  return payload;
}
