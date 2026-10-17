import { tradeCommandInputError } from "@/lib/agent-intelligence/trade-command-guard";
import { isExecutableRouteRequest } from "@/lib/agent-intelligence/swap-intent";
import { extractBaseSwapIntent, extractUnresolvedSwapOrder, extractTradeSymbol, isTradeExecutionPrompt, isTransferPrompt } from "@/lib/agent-intelligence";
import type { AIProvider } from "./ai-provider";
import type { AIProviderKind } from "./ai-provider-config";
import { createAIProvider } from "./ai-provider-factory";
import { resolveConfiguredProviderKind } from "./ai-provider-config";
import { DiagnosticsAIProvider, type AIProviderStats } from "./ai-provider-diagnostics";
import { GuardrailAIProvider } from "./ai-provider-guardrails";
import { CircuitBreakerAIProvider } from "./circuit-breaker-ai-provider";
import { FallbackAIProvider } from "./fallback-ai-provider";
import { isConditionalTradeSentence, parseTradeSentence } from "@/lib/autonomy/trade-sentence-parser";
import { buildAutonomyResponse, resolveAmountOnlyFollowUp, DeterministicAIProvider } from "./deterministic-ai-provider";
import { TimeoutAIProvider } from "./ai-provider-timeout";
import {
  ProviderChainAIProvider,
  classifyAgentTask,
  resolveProviderKindOrder,
} from "./ai-provider-router";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";

const decoratedNetworkProviders = new Map<AIProviderKind, AIProvider>();

function decorateNetworkProvider(kind: AIProviderKind): AIProvider {
  const existing = decoratedNetworkProviders.get(kind);
  if (existing) return existing;
  const base = createAIProvider(kind);
  const guarded = new GuardrailAIProvider(base, logger);
  const timed = new TimeoutAIProvider(guarded);
  const circuitBroken = new CircuitBreakerAIProvider(timed, agentEventBus, logger);
  const diagnosed = new DiagnosticsAIProvider(circuitBroken, agentPerformanceMonitor, logger);
  decoratedNetworkProviders.set(kind, diagnosed);
  return diagnosed;
}

const safetyNet = new DeterministicAIProvider();

class TaskRoutedAIProvider implements AIProvider {
  readonly name = "routed";
  readonly requiresNetwork = true;
  lastChain: ProviderChainAIProvider | null = null;

  async generateReply(request: Parameters<AIProvider["generateReply"]>[0]) {
    // Resolve these before every spot-swap/provider/tool route. The extraction
    // model sees no tools and can only propose fields validated by code.
    const inputError = tradeCommandInputError(request.prompt);
    if (inputError) return { intent: "general_help" as const, reply: inputError, actions: [], highlights: [], followUps: [] };
    const followUp = resolveAmountOnlyFollowUp(request);
    if (followUp) return followUp;
    if (isConditionalTradeSentence(request.prompt)) {
      const parsed = await parseTradeSentence(request.prompt);
      if (parsed.match) return buildAutonomyResponse(request, parsed.match);
      return {
        intent: "general_help" as const,
        reply: parsed.error,
        actions: [], highlights: [], followUps: [],
      };
    }
    // Clear execution intents take the existing deterministic prepare-only path.
    // No model capability/list/balance loop is needed to parse a sized order.
    const swapIntent = extractBaseSwapIntent(request.prompt);
    if (!isTransferPrompt(request.prompt) && (isTradeExecutionPrompt(request.prompt) || isExecutableRouteRequest(request.prompt) || (swapIntent?.quoteOnly && swapIntent.amount)) &&
      (swapIntent || extractUnresolvedSwapOrder(request.prompt) || extractTradeSymbol(request.prompt))) {
      return safetyNet.generateReply(request);
    }
    if (isExecutableRouteRequest(request.prompt)) return { intent: "general_help" as const, reply: "Specify a sell amount and two exact Base assets, for example: Show me the best available route for 100 USDC to ETH. Routes use provider priority; executable alternatives are not compared.", actions: [], highlights: [], followUps: [] };
    const task = classifyAgentTask(request.prompt);
    const order = resolveProviderKindOrder(task);
    const networkProviders = order
      .filter((kind) => kind !== "deterministic")
      .map((kind) => decorateNetworkProvider(kind));
    const chain = new ProviderChainAIProvider(
      [...networkProviders, safetyNet],
      agentEventBus,
      logger,
    );
    this.lastChain = chain;
    logger.debug("AI provider route selected", {
      task,
      order,
      configured: resolveConfiguredProviderKind(),
    });
    return chain.generateReply(request);
  }
}

function buildDefaultProvider(): AIProvider {
  return new TaskRoutedAIProvider();
}

let activeProvider: AIProvider = buildDefaultProvider();

export function getAIProvider(): AIProvider {
  return activeProvider;
}

export function setAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}

function findDiagnostics(provider: AIProvider): AIProviderStats | null {
  if (provider instanceof DiagnosticsAIProvider) return provider.getStats();
  if (provider instanceof FallbackAIProvider) return findDiagnostics(provider.primary);
  if (provider instanceof ProviderChainAIProvider) {
    for (const inner of provider.providers) {
      const stats = findDiagnostics(inner);
      if (stats) return stats;
    }
  }
  if (provider instanceof TaskRoutedAIProvider && provider.lastChain) {
    return findDiagnostics(provider.lastChain);
  }
  for (const inner of decoratedNetworkProviders.values()) {
    const stats = findDiagnostics(inner);
    if (stats) return stats;
  }
  return null;
}

export function getAIProviderDiagnostics(): AIProviderStats | null {
  return findDiagnostics(activeProvider);
}

export function getConfiguredAIProviderKind() {
  return resolveConfiguredProviderKind();
}
