// lib/architecture/tools/agent-tool-schema-validator.ts
//
// P0.1 — a small, dependency-free runtime validator for AgentToolSchema
// (agent-tool.ts). The project has no JSON-Schema library today and the
// spec explicitly says not to add one unless unnecessary — every P0.1
// placeholder tool's input schema is simple enough (flat objects, a few
// primitive/enum fields) that a full validator would be pure overhead.
//
// This is intentionally NOT a complete JSON-Schema implementation: it
// checks type, enum membership, required fields, and recurses into
// object/array shapes, but does not support numeric ranges, string
// patterns/formats, oneOf/anyOf, or additionalProperties constraints. If
// a P0.2+ tool needs any of that, replace this file's internals (the
// exported function signature can stay the same) — nothing else in the
// registry/runtime needs to change.

import type { AgentToolParameterSchema, AgentToolSchema } from "./agent-tool";

export interface SchemaValidationResult {
  valid: boolean;
  /** Human-readable, non-sensitive reasons — safe to surface in an AgentToolError's message. */
  errors: string[];
}

export function validateAgainstSchema(input: unknown, schema: AgentToolSchema): SchemaValidationResult {
  const errors: string[] = [];
  validateObject(input, schema.properties, schema.required ?? [], "input", errors);
  return { valid: errors.length === 0, errors };
}

function validateObject(
  value: unknown,
  properties: Record<string, AgentToolParameterSchema>,
  required: string[],
  path: string,
  errors: string[]
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const record = value as Record<string, unknown>;

  for (const key of required) {
    if (!(key in record) || record[key] === undefined) {
      errors.push(`${path}.${key} is required`);
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in record) || record[key] === undefined) continue; // optional and absent — fine
    validateValue(record[key], propSchema, `${path}.${key}`, errors);
  }
}

function validateValue(value: unknown, schema: AgentToolParameterSchema, path: string, errors: string[]): void {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path} must be a string`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
      } else if (schema.items) {
        value.forEach((item, i) => validateValue(item, schema.items!, `${path}[${i}]`, errors));
      }
      break;
    case "object":
      validateObject(value, schema.properties ?? {}, schema.required ?? [], path, errors);
      break;
  }

  if (schema.enum && schema.enum.length > 0 && !schema.enum.includes(value as string | number)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
}
