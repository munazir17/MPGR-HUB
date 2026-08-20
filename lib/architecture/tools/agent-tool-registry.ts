// lib/architecture/tools/agent-tool-registry.ts
//
// P0.1 — the Tool Registry. Mirrors lib/agent-commands/command-registry.ts's
// overall shape (Map-backed, register/get/list) but with stricter
// semantics, per the spec: register() REJECTS (throws) rather than
// silently overwriting a duplicate ID or accepting an invalid
// definition — CommandRegistry's `register()` intentionally allows a
// later registration to replace an earlier one (useful for slash
// commands during development); a tool registry is a security boundary
// (see agent-tool-runtime.ts's header comment) and must not have that
// same permissiveness.
//
// list()/listByCategory() return frozen shallow copies of the internal
// array so a caller can never mutate the registry's internal state by
// holding a reference to what list() returned.

import {
  AGENT_TOOL_CATEGORIES,
  AGENT_TOOL_MODES,
  AGENT_TOOL_RISK_LEVELS,
  type AgentToolCategory,
  type AnyAgentTool,
} from "./agent-tool";

export class DuplicateToolError extends Error {
  constructor(public readonly toolId: string) {
    super(`A tool with id "${toolId}" is already registered — refusing to silently overwrite it.`);
    this.name = "DuplicateToolError";
  }
}

export class InvalidToolDefinitionError extends Error {
  constructor(public readonly toolId: string | undefined, public readonly reasons: string[]) {
    super(`Invalid tool definition${toolId ? ` for "${toolId}"` : ""}: ${reasons.join("; ")}`);
    this.name = "InvalidToolDefinitionError";
  }
}

function validateToolDefinition(tool: AnyAgentTool): string[] {
  const reasons: string[] = [];
  if (!tool.id || typeof tool.id !== "string" || tool.id.trim().length === 0) {
    reasons.push("id must be a non-empty string");
  }
  if (!tool.name || typeof tool.name !== "string" || tool.name.trim().length === 0) {
    reasons.push("name must be a non-empty string");
  }
  if (!tool.description || typeof tool.description !== "string" || tool.description.trim().length === 0) {
    reasons.push("description must be a non-empty string");
  }
  if (!(AGENT_TOOL_CATEGORIES as readonly string[]).includes(tool.category)) {
    reasons.push(`category "${String(tool.category)}" is not one of: ${AGENT_TOOL_CATEGORIES.join(", ")}`);
  }
  if (!(AGENT_TOOL_MODES as readonly string[]).includes(tool.mode)) {
    reasons.push(`mode "${String(tool.mode)}" is not one of: ${AGENT_TOOL_MODES.join(", ")}`);
  }
  if (!(AGENT_TOOL_RISK_LEVELS as readonly string[]).includes(tool.riskLevel)) {
    reasons.push(`riskLevel "${String(tool.riskLevel)}" is not one of: ${AGENT_TOOL_RISK_LEVELS.join(", ")}`);
  }
  if (typeof tool.requiresWallet !== "boolean") reasons.push("requiresWallet must be a boolean");
  if (typeof tool.requiresConfirmation !== "boolean") reasons.push("requiresConfirmation must be a boolean");
  if (!tool.inputSchema || tool.inputSchema.type !== "object" || typeof tool.inputSchema.properties !== "object") {
    reasons.push("inputSchema must be an object schema with a properties map");
  }
  if (typeof tool.execute !== "function") reasons.push("execute must be a function");
  return reasons;
}

export class AgentToolRegistry {
  private tools = new Map<string, AnyAgentTool>();

  /** Throws DuplicateToolError or InvalidToolDefinitionError rather than returning a boolean/result — a rejected registration is a programming error (a duplicate id, a malformed definition), not a runtime condition callers are expected to branch on. */
  register(tool: AnyAgentTool): void {
    const reasons = validateToolDefinition(tool);
    if (reasons.length > 0) throw new InvalidToolDefinitionError(tool?.id, reasons);
    if (this.tools.has(tool.id)) throw new DuplicateToolError(tool.id);
    this.tools.set(tool.id, tool);
  }

  get(toolId: string): AnyAgentTool | undefined {
    return this.tools.get(toolId);
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /** Deterministic order: insertion order, matching Map's own iteration guarantee — never re-sorted, so repeated calls are stable. */
  list(): readonly AnyAgentTool[] {
    return Object.freeze([...this.tools.values()]);
  }

  listByCategory(category: AgentToolCategory): readonly AnyAgentTool[] {
    return Object.freeze([...this.tools.values()].filter((t) => t.category === category));
  }

  /** Not part of the spec's required capability list (explicitly optional there) — included because tests need a clean-slate registry between cases, and a future hot-reload/dev-tool path benefits from it. Does not throw if the id isn't present. */
  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }
}
