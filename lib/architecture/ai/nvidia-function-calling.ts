// lib/architecture/ai/nvidia-function-calling.ts
//
// NVIDIA NIM adapter for the hosted OpenAI-compatible API
// (https://integrate.api.nvidia.com/v1/chat/completions).
//
// Lowers the existing read/prepare AgentTool catalog into OpenAI `tools`
// (the same catalog Gemini/OpenAI already use — no second schema) and
// translates NIM `tool_calls` back into the vendor-neutral
// {"toolCall":{toolId,arguments}} JSON that runToolCallingLoop parses.
//
// Execute-mode tools are never advertised. This module never signs,
// submits, or broadcasts a transaction.

import { compactToolDescription } from "./gemini-function-declarations";
import type {
  AgentToolParameterSchema,
  AgentToolSchema,
  AnyAgentTool,
} from "@/lib/architecture/tools/agent-tool";

export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Hosted NIM model with documented tool calling / agent workflows.
 * Nemotron 3 Super 120B is on the current integrate.api.nvidia.com
 * catalog and is NVIDIA's agent/tool-calling default (NemoClaw,
 * OpenHands). The previous Llama 3.3 Nemotron Super 49B v1.5 id is
 * no longer hosted. Override with NVIDIA_MODEL.
 */
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b";

const X402_RESOURCE_URL_TOOL_IDS = new Set([
  "x402_discover_resource",
  "x402_prepare_payment",
]);

export interface NvidiaJsonSchema {
  type: string;
  description?: string;
  enum?: readonly (string | number)[];
  properties?: Record<string, NvidiaJsonSchema>;
  items?: NvidiaJsonSchema;
  required?: string[];
}

export interface NvidiaToolFunction {
  name: string;
  description: string;
  parameters: NvidiaJsonSchema;
}

export interface NvidiaTool {
  type: "function";
  function: NvidiaToolFunction;
}

export interface NvidiaUpstreamFailure {
  httpStatus: number;
  code: string;
  error: string;
}

export function resolveNvidiaModel(
  model: string | undefined = process.env.NVIDIA_MODEL,
): string {
  if (typeof model === "string" && model.trim().length > 0) {
    return model.trim();
  }
  return DEFAULT_NVIDIA_MODEL;
}

export function resolveNvidiaBaseUrl(
  raw: string | undefined = process.env.NVIDIA_BASE_URL,
): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_NVIDIA_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NVIDIA_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NVIDIA_BASE_URL must be an http or https URL.");
  }
  return url.toString().replace(/\/$/, "");
}

export function nvidiaChatCompletionsUrl(
  baseUrl: string = resolveNvidiaBaseUrl(),
): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function toNvidiaJsonSchema(schema: AgentToolParameterSchema | AgentToolSchema): NvidiaJsonSchema {
  const converted: NvidiaJsonSchema = { type: schema.type };
  if ("description" in schema && schema.description) {
    converted.description = schema.description;
  }
  if ("enum" in schema && schema.enum && schema.enum.length > 0) {
    converted.enum = schema.enum;
  }
  if (schema.type === "array" && "items" in schema && schema.items) {
    converted.items = toNvidiaJsonSchema(schema.items);
  }
  if (schema.type === "object") {
    const properties = "properties" in schema ? schema.properties : undefined;
    converted.properties = Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, value]) => [key, toNvidiaJsonSchema(value)]),
    );
    if (schema.required && schema.required.length > 0) {
      converted.required = [...schema.required];
    }
  }
  return converted;
}

export function toNvidiaTools(tools: readonly AnyAgentTool[]): NvidiaTool[] {
  return tools
    .filter((tool) => tool.mode === "read" || tool.mode === "prepare")
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.id,
        description: compactToolDescription(tool.description),
        parameters: toNvidiaJsonSchema(tool.inputSchema),
      },
    }));
}

export function isNvidiaToolArray(value: unknown): value is NvidiaTool[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.type !== "function") return false;
    const fn = record.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return false;
    const fnRecord = fn as Record<string, unknown>;
    return (
      typeof fnRecord.name === "string" &&
      fnRecord.name.trim().length > 0 &&
      typeof fnRecord.description === "string" &&
      fnRecord.parameters !== null &&
      typeof fnRecord.parameters === "object" &&
      !Array.isArray(fnRecord.parameters)
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainRecord(parsed)) return parsed;
    } catch {
      return {};
    }
    return {};
  }
  if (isPlainRecord(raw)) return raw;
  return {};
}

function coerceX402ResourceUrlArgs(
  toolId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!X402_RESOURCE_URL_TOOL_IDS.has(toolId)) return args;
  const resourceUrl =
    (typeof args.resourceUrl === "string" && args.resourceUrl.trim()) ||
    (typeof args.url === "string" && args.url.trim()) ||
    (typeof args.resource === "string" && args.resource.trim()) ||
    null;
  if (!resourceUrl) return args;
  const next: Record<string, unknown> = { ...args, resourceUrl };
  delete next.url;
  delete next.resource;
  return next;
}

function serializeToolCall(toolId: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    toolCall: {
      toolId,
      arguments: coerceX402ResourceUrlArgs(toolId, args),
    },
  });
}

function unwrapPossiblyFencedJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function readMessage(data: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isPlainRecord(first)) return null;
  const message = first.message;
  return isPlainRecord(message) ? message : null;
}

/**
 * Prefers a native OpenAI-style tool_call over plain text so a reasoning
 * preamble cannot hide the selected MPGR tool. Only the first tool call
 * is returned — runToolCallingLoop executes one tool per turn.
 */
export function extractNvidiaResponseContent(data: unknown): string | null {
  const message = readMessage(data);
  if (!message) return null;

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const first = toolCalls[0];
    if (isPlainRecord(first)) {
      const fn = isPlainRecord(first.function) ? first.function : null;
      const name = typeof fn?.name === "string" ? fn.name.trim() : "";
      if (name) {
        return serializeToolCall(name, parseToolArguments(fn?.arguments));
      }
    }
  }

  const legacy = message.function_call;
  if (isPlainRecord(legacy) && typeof legacy.name === "string" && legacy.name.trim()) {
    return serializeToolCall(legacy.name.trim(), parseToolArguments(legacy.arguments));
  }

  if (typeof message.content === "string" && message.content.trim()) {
    return unwrapPossiblyFencedJson(message.content);
  }
  return null;
}

export function classifyNvidiaUpstreamFailure(status: number): NvidiaUpstreamFailure {
  if (status === 429) {
    return {
      httpStatus: 429,
      code: "PROVIDER_RATE_LIMITED",
      error: "NVIDIA NIM is temporarily rate-limited. Please retry shortly.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      httpStatus: 502,
      code: "PROVIDER_AUTH_ERROR",
      error: "NVIDIA NIM authentication failed.",
    };
  }
  return {
    httpStatus: 502,
    code: "PROVIDER_ERROR",
    error: "NVIDIA NIM is temporarily unavailable. Please retry shortly.",
  };
}

export function readNvidiaUsage(data: unknown): {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} {
  if (!isPlainRecord(data) || !isPlainRecord(data.usage)) {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const usage = data.usage;
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
}
