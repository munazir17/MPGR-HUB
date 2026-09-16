import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";

export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 25_000;

export class AIProviderTimeoutError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly timeoutMs: number,
  ) {
    super(`AI provider "${providerName}" timed out after ${timeoutMs}ms`);
    this.name = "AIProviderTimeoutError";
  }
}

export class TimeoutAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  constructor(
    public readonly inner: AIProvider,
    private readonly timeoutMs: number = DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  ) {
    this.name = inner.name;
    this.requiresNetwork = inner.requiresNetwork;
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.inner.generateReply(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new AIProviderTimeoutError(this.inner.name, this.timeoutMs));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
