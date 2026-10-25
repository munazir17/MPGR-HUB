import { OpenAIAIProvider } from "./openai-ai-provider";

/** OpenRouter, including its free-model routes. The key stays on the server route. */
export class OpenRouterAIProvider extends OpenAIAIProvider {
  constructor() {
    super("openrouter", "/api/agent/complete/openrouter");
  }
}
