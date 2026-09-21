import type { AgentIntent } from "@/lib/agent-intelligence";
import { isValidIntent, normalizeTradeToolArguments, normalizeX402ToolArguments } from "./tool-call-normalization";

export interface ToolCallDirective {
  kind: "tool_call";
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface FinalAnswerDirective {
  kind: "final";
  intent: AgentIntent;
  reply: string;
}

export type ModelDirective =
  | ToolCallDirective
  | FinalAnswerDirective;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function tryParseJsonValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * NVIDIA Nemotron (and sometimes Gemini) return a 200 with markdown fences,
 * a reasoning preamble + JSON, or plain prose. The HTTP route already
 * succeeded — throwing here would incorrectly fall through to OpenAI and
 * 502 the whole turn.
 */
export function coerceJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const direct = tryParseJsonValue(trimmed);
  if (isPlainObject(direct)) return direct;
  if (typeof direct === "string" && direct.trim()) {
    const nested = tryParseJsonValue(direct.trim());
    if (isPlainObject(nested)) return nested;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = tryParseJsonValue(fenced[1].trim());
    if (isPlainObject(inner)) return inner;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = tryParseJsonValue(trimmed.slice(start, end + 1));
    if (isPlainObject(sliced)) return sliced;
  }

  return null;
}

export function looksLikeProtocolObject(record: Record<string, unknown>): boolean {
  return "toolCall" in record || "reply" in record || "intent" in record;
}

export function parseModelDirective(
  content: string,
  previousIntent: AgentIntent | null,
): ModelDirective {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(
      "AI provider response was missing a non-empty reply.",
    );
  }

  const record = coerceJsonObject(trimmed);

  if (record) {
    const rawToolCall = record.toolCall;

    if (isPlainObject(rawToolCall)) {
      if (
        typeof rawToolCall.toolId === "string" &&
        rawToolCall.toolId.trim().length > 0
      ) {
        const args =
          rawToolCall.arguments &&
          typeof rawToolCall.arguments === "object" &&
          !Array.isArray(rawToolCall.arguments)
            ? (rawToolCall.arguments as Record<string, unknown>)
            : {};

        const toolId = rawToolCall.toolId.trim();

        return {
          kind: "tool_call",
          toolId,
          arguments: normalizeTradeToolArguments(
            toolId,
            normalizeX402ToolArguments(toolId, args),
          ),
        };
      }
    }

    const reply =
      typeof record.reply === "string"
        ? record.reply
        : typeof record.reply === "number"
          ? String(record.reply)
          : "";

    if (reply.trim()) {
      const intent = isValidIntent(record.intent)
        ? record.intent
        : previousIntent ?? "general_help";

      return {
        kind: "final",
        intent,
        reply,
      };
    }

    if (looksLikeProtocolObject(record)) {
      throw new Error(
        "AI provider response was missing a non-empty reply.",
      );
    }
  }

  return {
    kind: "final",
    intent: previousIntent ?? "general_help",
    reply: trimmed,
  };
}
