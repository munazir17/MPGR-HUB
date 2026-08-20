// lib/architecture/tools/agent-tool.ts
//
// P0.1 — Agent Tool Runtime + Registry Foundation.
//
// This is the tool contract itself: what a tool declares about itself
// (category, mode, risk, wallet/confirmation requirements, input schema)
// and the one method it implements (`execute`). No tool is implemented
// against this contract yet in P0.1 — see tool-definitions.ts for the
// five placeholder registrations, all of which return
// TOOL_NOT_IMPLEMENTED.
//
// Style: every enumerable value here is a `readonly [...] as const` array
// with a derived union type, matching this codebase's existing
// convention for closed, compile-time-checked string sets (see
// lib/agent-intelligence.ts's AGENT_INTENTS, checked in
// lib/architecture/ai/ai-provider-guardrails.ts's isValidIntent). This
// is also what lets AgentToolRegistry validate a tool definition's
// category/mode/riskLevel at registration time without a schema library.

import type { AgentToolContext } from "./agent-tool-context";
import type { AgentToolResult } from "./agent-tool-result";

// --- Mode ---------------------------------------------------------------
//
// HARD SAFETY RULE (see agent-tool-runtime.ts):
//   read    -> may run automatically, no confirmation required
//   prepare -> produces a structured proposal only; never itself sends
//              a transaction
//   execute -> NEVER runnable through AgentToolRuntime.executeTool() in
//              P0.1. The runtime refuses every "execute" tool
//              unconditionally, regardless of what a caller passes as
//              context/permissions — this is enforced in code, not just
//              documented, so the LLM cannot talk its way past it.
export const AGENT_TOOL_MODES = ["read", "prepare", "execute"] as const;
export type AgentToolMode = (typeof AGENT_TOOL_MODES)[number];

// --- Risk -----------------------------------------------------------------

export const AGENT_TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type AgentToolRisk = (typeof AGENT_TOOL_RISK_LEVELS)[number];

// --- Category ---------------------------------------------------------------
//
// Deliberately a plain string union, not a nested taxonomy — adding a
// new category later (e.g. "nft") is a one-line addition to this array;
// nothing in AgentToolRegistry/AgentToolRuntime switches on specific
// category values, so neither needs to change.
export const AGENT_TOOL_CATEGORIES = [
  "wallet",
  "token",
  "portfolio",
  "market",
  "research",
  "defi",
  "payment",
  "execution",
] as const;
export type AgentToolCategory = (typeof AGENT_TOOL_CATEGORIES)[number];

// --- Input schema -----------------------------------------------------------
//
// A minimal, JSON-Schema-compatible parameter description — enough for
// AgentToolRuntime to do real (if basic) input validation now, and
// structured so a future adapter can lower it into an OpenAI
// tools/functions schema, a Gemini functionDeclaration, or an
// MCP-compatible tool definition without this shape changing. No schema
// library dependency: the project doesn't have one, and this shape is
// simple enough not to need one (see agent-tool-schema-validator.ts).
export type AgentToolParameterType = "string" | "number" | "boolean" | "array" | "object";

export interface AgentToolParameterSchema {
  type: AgentToolParameterType;
  description?: string;
  /** Allowed literal values, if this parameter is a closed set. */
  enum?: readonly (string | number)[];
  /** Required when type is "array" — the schema every element must satisfy. */
  items?: AgentToolParameterSchema;
  /** Required when type is "object" — nested property schemas. */
  properties?: Record<string, AgentToolParameterSchema>;
  /** Required when type is "object" — which of `properties` are mandatory. */
  required?: string[];
}

export interface AgentToolSchema {
  type: "object";
  properties: Record<string, AgentToolParameterSchema>;
  required?: string[];
}

// --- Tool contract -----------------------------------------------------------

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** Stable, unique identifier — e.g. "wallet_analyzer". Never shown to end users. */
  id: string;
  /** Short human-readable name, e.g. "Wallet Analyzer". */
  name: string;
  /** What this tool does — this is what a future LLM tool-calling adapter would send as the function description. */
  description: string;

  category: AgentToolCategory;
  mode: AgentToolMode;
  riskLevel: AgentToolRisk;

  requiresWallet: boolean;
  requiresConfirmation: boolean;

  inputSchema: AgentToolSchema;

  execute(input: TInput, context: AgentToolContext): Promise<AgentToolResult<TOutput>>;
}

/** Registry/runtime internals work with tools generically — most call sites don't need to know a specific tool's TInput/TOutput. */
export type AnyAgentTool = AgentTool<unknown, unknown>;
