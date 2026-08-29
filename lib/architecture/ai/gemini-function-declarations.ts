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
  return JSON.stringify({
    toolCall: {
      toolId: functionCall.name,
      arguments: normalizeFunctionCallArgs(functionCall.args),
    },
  });
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

/**
 * Reads Gemini's generateContent response.
 *
 * A functionCall part (native tool selection) is preferred over text so
 * a thinking/thought part cannot hide the call. Text parts skip
 * `thought: true` entries used by Gemini 2.5/3.5 thinking models.
 */
export function extractGeminiResponseContent(data: unknown): string | null {
  const parts = (
    data as {
      candidates?: Array<{
        content?: { parts?: Array<Record<string, unknown>> };
      }>;
    }
  )?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts) || parts.length === 0) return null;

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const functionCall = part.functionCall as GeminiFunctionCall | undefined;
    if (functionCall && typeof functionCall.name === "string" && functionCall.name.trim().length > 0) {
      return serializeGeminiFunctionCall(functionCall);
    }
  }

  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.thought === true) continue;
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      texts.push(part.text);
    }
  }

  if (texts.length === 0) return null;
  return unwrapPossiblyFencedJson(texts.join(""));
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
