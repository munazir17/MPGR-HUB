import { agentCommandRegistry } from "./command-registry";
import { parseCommand } from "./parser";
import type { AgentContext } from "@/lib/agent-context";
import type { CommandResult } from "./types";

// Phase 3A.6 — Action Execution Layer + Smart Command Routing.
//
// Single entry point for turning raw input into a CommandResult. Never
// touches persistence or the event bus itself — hooks/useAgentChat.ts
// calls this, then hands the result to
// lib/architecture/ai/agent-ai-service.ts's runCommand(), which owns
// persistence + event emission, exactly mirroring how
// lib/agent-intelligence.ts's generateIntelligentReply() is a pure
// function that lib/agent-engine.ts's appendAssistantReply() calls.
export interface ExecutedCommand {
  commandName: string;
  result: CommandResult;
}

export function executeCommandInput(input: string, context: AgentContext): ExecutedCommand | null {
  const parsed = parseCommand(input);
  if (!parsed) return null;

  const command = agentCommandRegistry.get(parsed.name);
  if (!command) {
    return {
      commandName: parsed.name,
      result: { kind: "error", text: `Unknown command "/${parsed.name}". Try /help for the full list.` },
    };
  }

  if (command.requiresWallet && !context.isConnected) {
    return {
      commandName: command.name,
      result: { kind: "error", text: "Connect your wallet first — this command needs your on-chain data." },
    };
  }

  return { commandName: command.name, result: command.execute(context, parsed.args) };
}
